/**
 * Batch OCR on Render Workflows
 *
 * OCR over many scanned PDFs. ocrBatch fans out one ocrDocument run per
 * document. Each ocrDocument run rasterizes its PDF with Poppler (pdftoppm) and
 * reads every page with Tesseract. Both are system binaries, so this workflow
 * service builds from the Dockerfile next to this project.
 *
 * The lesson is error classification:
 * - Bad input (a corrupt PDF, a tool that exits with an error code, a 404) won't
 *   get better on a retry, so ocrDocument returns it as a failed result.
 * - A tool killed by a signal (for example, out of memory) or a network error
 *   might pass on the next attempt, so ocrDocument throws and Render retries it.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { task, type TaskContext } from "@renderinc/sdk/workflows";

// Documents that aren't URLs are looked up in this folder, which the
// Dockerfile copies into the image.
const SAMPLES_DIR = fileURLToPath(new URL("../samples", import.meta.url));

// 300 DPI is the resolution Tesseract reads best at.
const OCR_DPI = Number(process.env.OCR_DPI ?? "300");
const OCR_LANG = process.env.OCR_LANG ?? "eng";
const MAX_PAGES = Number(process.env.OCR_MAX_PAGES ?? "50");
const MAX_PDF_BYTES = Number(process.env.OCR_MAX_PDF_MB ?? "50") * 1024 * 1024;

// ocrDocument runs on the 2c-4g plan (2 CPUs), so it OCRs two pages at a time.
// The Dockerfile sets OMP_THREAD_LIMIT=1 so each Tesseract process uses one CPU.
const PAGE_WORKERS = Number(process.env.OCR_PAGE_WORKERS ?? "2");

// How many ocrDocument runs ocrBatch starts at once. Chained runs are capped
// per workspace and fail instead of queueing when you go over, so the batch
// starts one chunk, waits for it, then starts the next.
const CHUNK_SIZE = Number(process.env.BATCH_CHUNK_SIZE ?? "20");

/** A failure a retry can't fix. ocrDocument returns it instead of throwing. */
class PermanentError extends Error {}

// What ocrDocument returns: the text of each page, or an error a retry can't fix.
type OcrResult =
  | { doc_ref: string; pages: number; chars: number; text: string[] }
  | { doc_ref: string; error: string };

// ---- Fetching a document by reference ----

/**
 * Copy the PDF that docRef points to into dest.
 *
 * docRef is an https:// URL (for example, a presigned object storage URL) or
 * the name of a file in samples/. Task arguments are capped at 4 MB, so
 * documents travel by reference, never as bytes.
 */
async function fetchPdf(docRef: string, dest: string): Promise<void> {
  if (/^https?:\/\//i.test(docRef)) {
    await download(docRef, dest);
    return;
  }

  const file = path.resolve(SAMPLES_DIR, docRef);
  const isFile = await stat(file).then((s) => s.isFile(), () => false);
  if (!file.startsWith(SAMPLES_DIR + path.sep) || !isFile) {
    throw new PermanentError(`No such sample document: ${docRef}`);
  }
  await copyFile(file, dest);
}

async function download(url: string, dest: string): Promise<void> {
  // A connection error or timeout makes fetch throw, and this function throws
  // too: the network might be back on the next attempt.
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    // fetch reports "fetch failed" and keeps the reason (DNS, reset) in cause.
    const reason = error instanceof Error ? (error.cause ?? error) : error;
    throw new Error(`Download failed: ${String(reason)}`);
  }
  if (response.status === 429 || response.status >= 500) {
    // The server is busy or broken right now. Retry.
    throw new Error(`Download failed with HTTP ${response.status}`);
  }
  if (!response.ok || !response.body) {
    // 403, 404 and friends: the reference is wrong or expired.
    throw new PermanentError(`Download failed with HTTP ${response.status}`);
  }

  let size = 0;
  const sizeLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_PDF_BYTES) {
        callback(new PermanentError(`Document is larger than ${MAX_PDF_BYTES / (1024 * 1024)} MB`));
      } else {
        callback(null, chunk);
      }
    },
  });
  // fetch returns a web stream. Convert it to a Node stream to pipe it to a file.
  const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  await pipeline(body, sizeLimit, createWriteStream(dest));
}

// ---- Running Poppler and Tesseract ----

/**
 * Run a command-line tool and classify how it failed.
 *
 * Resolves to stdout. Rejects with PermanentError if the tool is missing or
 * exits with an error code, and with Error if a signal killed it.
 */
function runTool(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        // A setup problem: the image doesn't have the tool. Retrying won't install it.
        reject(new PermanentError(`${command} is not installed`));
      } else {
        reject(error);
      }
    });

    child.on("close", (code, signal) => {
      if (signal) {
        // Killed by a signal, for example SIGKILL from the out-of-memory killer.
        // The input may be fine, so throw and let Render retry the document.
        reject(new Error(`${command} was killed by ${signal}`));
      } else if (code !== 0) {
        // The tool ran and rejected the input. The same input fails the same way.
        const lines = Buffer.concat(stderr).toString().trim().split("\n");
        const detail = lines.at(-1) || "no error output";
        reject(new PermanentError(`${command} exited with code ${code}: ${detail}`));
      } else {
        resolve(Buffer.concat(stdout).toString());
      }
    });
  });
}

function pageCount(pdfinfoOutput: string): number {
  const match = pdfinfoOutput.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new PermanentError("pdfinfo didn't report a page count");
  return Number(match[1]);
}

/** Return the OCR text of each page of pdf. */
async function ocrPdf(pdf: string, workdir: string): Promise<string[]> {
  const pages = pageCount(await runTool("pdfinfo", [pdf]));
  if (pages > MAX_PAGES) {
    throw new PermanentError(`Document has ${pages} pages, more than the limit of ${MAX_PAGES}`);
  }

  // Rasterize every page to a grayscale PNG: page-1.png, page-2.png, ...
  await runTool("pdftoppm", ["-r", String(OCR_DPI), "-gray", "-png", pdf, path.join(workdir, "page")]);
  const pageNumber = (name: string) => Number(name.slice("page-".length, -".png".length));
  const images = (await readdir(workdir))
    .filter((name) => name.startsWith("page-") && name.endsWith(".png"))
    .sort((a, b) => pageNumber(a) - pageNumber(b))
    .map((name) => path.join(workdir, name));

  // Read PAGE_WORKERS pages at a time, keeping the text in page order.
  const text: string[] = new Array(images.length);
  let next = 0;
  async function worker() {
    while (next < images.length) {
      const i = next++;
      const output = await runTool("tesseract", [images[i], "stdout", "-l", OCR_LANG]);
      // Tesseract ends each page with a form feed. Drop it and the blank lines.
      text[i] = output.trim();
    }
  }
  await Promise.all(Array.from({ length: Math.min(PAGE_WORKERS, images.length) }, worker));
  return text;
}

// ---- Tasks ----

// ocrDocument runs Poppler and Tesseract, which need more CPU than flex's one.
// It retries twice, but only for the errors it throws: a tool killed by a
// signal, or a network error while downloading. Reading a file and running OCR
// have no side effects, so a retry is safe.
const ocrDocument = task(
  {
    name: "ocrDocument",
    plan: "2c-4g",
    retry: { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 2 },
    timeoutSeconds: 600,
  },
  async function ocrDocument(_ctx: TaskContext, docRef: string): Promise<OcrResult> {
    console.log(`[OCR] ${docRef}`);
    const workdir = await mkdtemp(path.join(tmpdir(), "ocr-"));
    try {
      const pdf = path.join(workdir, "input.pdf");
      await fetchPdf(docRef, pdf);
      const text = await ocrPdf(pdf, workdir);
      const chars = text.reduce((sum, page) => sum + page.length, 0);
      console.log(`[OCR] ${docRef}: ${text.length} pages, ${chars} characters`);
      return { doc_ref: docRef, pages: text.length, chars, text };
    } catch (error) {
      if (error instanceof PermanentError) {
        console.warn(`[OCR] ${docRef}: ${error.message}. Not retrying`);
        return { doc_ref: docRef, error: error.message };
      }
      throw error;
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  },
);

// ocrBatch only fans out, so it doesn't retry: a retry would rerun every
// document, including the ones that already finished. Each ocrDocument run
// retries on its own.
//
// Each attempt gets the full timeout. Size it for the whole batch: every chunk
// lasts as long as its slowest document, including that document's retries.
task(
  {
    name: "ocrBatch",
    plan: "flex",
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 3600,
  },
  async function ocrBatch(ctx: TaskContext, docRefs: string[]) {
    console.log(`[BATCH] ${docRefs.length} documents, chunks of ${CHUNK_SIZE}`);

    const succeeded: Extract<OcrResult, { text: string[] }>[] = [];
    const failed: Extract<OcrResult, { error: string }>[] = [];
    for (let start = 0; start < docRefs.length; start += CHUNK_SIZE) {
      const chunk = docRefs.slice(start, start + CHUNK_SIZE);
      // ctx.run starts each document as its own task run on its own compute.
      // allSettled keeps one failed document from failing the batch.
      const settled = await Promise.allSettled(chunk.map((docRef) => ctx.run(ocrDocument, docRef)));
      settled.forEach((outcome, i) => {
        if (outcome.status === "rejected") {
          // ocrDocument threw on every attempt (or the run couldn't start).
          failed.push({ doc_ref: chunk[i], error: String(outcome.reason) });
        } else if ("error" in outcome.value) {
          failed.push(outcome.value);
        } else {
          succeeded.push(outcome.value);
        }
      });
    }

    console.log(`[BATCH] ${succeeded.length} succeeded, ${failed.length} failed`);
    return {
      total: docRefs.length,
      succeeded: succeeded.length,
      pages: succeeded.reduce((sum, r) => sum + r.pages, 0),
      failed,
      results: succeeded,
    };
  },
);
