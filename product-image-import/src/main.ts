/**
 * Product image import on Render Workflows
 *
 * Imports product images from a list of URLs. For each image, one task run
 * downloads it, makes resized JPEG, WebP and AVIF variants with sharp, and
 * computes a blurhash placeholder. A second task run asks an OpenAI vision
 * model for alt text, with structured output. An orchestrator fans out over
 * the list and returns a manifest. A bad URL or a file that isn't an image
 * comes back as a failed row, not a failed batch.
 *
 * To stay self-contained, this example needs no bucket. Variants are built in
 * a temporary directory and discarded; the manifest keeps their sizes, a
 * blurhash and one tiny base64 thumbnail per image. A real app would upload
 * the variants to object storage such as S3 in storeVariants().
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { encode as encodeBlurhash } from "blurhash";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import sharp, { type Metadata, type Sharp } from "sharp";
import { z } from "zod";

// Vision model for alt text. Any OpenAI model that accepts image input works.
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-6.2-sol";
// Refuse downloads bigger than this, and images with more pixels than this.
const MAX_INPUT_MB = Number(process.env.MAX_INPUT_MB ?? "25");
const MAX_MEGAPIXELS = Number(process.env.MAX_MEGAPIXELS ?? "50");
// How many images importImages works on at once.
const MAX_CONCURRENT_IMAGES = Number(process.env.MAX_CONCURRENT_IMAGES ?? "8");

// Variant widths in pixels. Widths larger than the source are skipped.
const WIDTHS = [1200, 600, 300];
// Encoder settings per format. Quality 50 for AVIF looks about like 80 for JPEG.
const FORMATS = {
  jpeg: (img: Sharp) => img.flatten({ background: "#ffffff" }).jpeg({ quality: 80, progressive: true, mozjpeg: true }),
  webp: (img: Sharp) => img.webp({ quality: 80, effort: 4 }),
  avif: (img: Sharp) => img.avif({ quality: 50, effort: 4 }),
};
// Returned in the manifest as base64, so keep it tiny (about 2-5 KB).
const THUMBNAIL_WIDTH = 160;
// Sent to the vision model. 512 px is the size OpenAI's "low" detail uses.
const PREVIEW_SIZE = 512;

// Image hosts such as Wikimedia ask clients to send a descriptive User-Agent
// and reject some generic ones.
const USER_AGENT = "render-workflows-product-image-import/1.0 (+https://github.com/render-examples)";

const ALT_TEXT_INSTRUCTIONS = `You write alt text for product photos in an online store.
Describe the product itself: what it is, its color, material and notable parts.
Don't describe the background or the photo ("image of", "photo of").
Keep alt_text under 125 characters. Add 3 to 6 short lowercase search tags.`;

const AltText = z.object({
  alt_text: z.string().describe("One sentence, under 125 characters"),
  tags: z.array(z.string()).describe("3 to 6 short lowercase search tags"),
});
type AltText = z.infer<typeof AltText>;

type Image = { id: string; url: string; name?: string };
type Variant = { format: string; width: number; height: number; bytes: number; key: string };
type ProcessResult =
  | {
      id: string;
      source: { format: string; width: number; height: number; has_alpha: boolean; bytes: number };
      blurhash: string;
      variants: Variant[];
      thumbnail_webp_base64: string;
      preview_jpeg_base64?: string;
      seconds: Record<string, number>;
    }
  | { id: string | null; error: string };
type AltTextResult =
  | ({ id: string; model: string; input_tokens: number; output_tokens: number; seconds: number } & AltText)
  | { id: string; error: string };

/** A failure a retry can't fix: bad URL, not an image, file too big. */
class PermanentError extends Error {}

// ---- Helpers ----

/**
 * CPUs this run may use.
 *
 * On Render, os.cpus() reports the host's CPUs, not the compute plan's. The
 * plan's limit is in the cgroup's cpu.max ("100000 100000" is 1 CPU). libvips,
 * which does sharp's work, sizes its thread pool from the CPU count, so pass
 * the real one.
 */
function availableCpus(): number {
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf-8").trim().split(/\s+/);
    if (quota !== "max") return Math.max(1, Math.floor(Number(quota) / Number(period)));
  } catch {
    // Not on Linux with cgroup v2 (for example, local dev on a Mac).
  }
  return cpus().length || 1;
}
sharp.concurrency(availableCpus());

/** Download url into memory. Images are small enough, and capped at MAX_INPUT_MB. */
async function download(url: string): Promise<Buffer> {
  const limit = MAX_INPUT_MB * 1024 * 1024;
  // fetch also accepts data: and blob: URLs. Only fetch from the web.
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    throw new PermanentError(`Bad URL: ${url}`);
  }
  if (scheme !== "http:" && scheme !== "https:") {
    throw new PermanentError("url must start with http:// or https://");
  }
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) {
    // 4xx (other than timeouts and rate limits) won't change on a retry.
    if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
      throw new PermanentError(`Download failed: HTTP ${response.status}`);
    }
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  if (contentType.startsWith("text/")) {
    await response.body.cancel();
    throw new PermanentError(`Not an image: the URL returned ${contentType}`);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > limit) {
    await response.body.cancel();
    throw new PermanentError(`Image is ${length} bytes, over MAX_INPUT_MB=${MAX_INPUT_MB}`);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new PermanentError(`Image is over MAX_INPUT_MB=${MAX_INPUT_MB}`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Read the image header and check it before decoding any pixels. */
async function describeSource(input: Buffer) {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new PermanentError("Not an image sharp can read");
  }
  if (meta.width * meta.height > MAX_MEGAPIXELS * 1_000_000) {
    throw new PermanentError(`Image is ${meta.width}x${meta.height}, over MAX_MEGAPIXELS=${MAX_MEGAPIXELS}`);
  }
  // Phones store photos sideways plus an EXIF rotation tag. autoOrient gives
  // the upright size, and every pipeline below applies the rotation.
  return {
    format: meta.format,
    width: meta.autoOrient.width,
    height: meta.autoOrient.height,
    has_alpha: meta.hasAlpha,
  };
}

/** A sharp pipeline for input: upright, and refusing images over the pixel limit. */
function load(input: Buffer): Sharp {
  return sharp(input, { autoOrient: true, limitInputPixels: MAX_MEGAPIXELS * 1_000_000 });
}

/** Write every width in every format to outDir. Returns one entry per file. */
async function makeVariants(input: Buffer, sourceWidth: number, outDir: string, imageId: string) {
  const widths = WIDTHS.filter((w) => w <= sourceWidth);
  if (widths.length === 0) widths.push(sourceWidth);
  const variants: (Variant & { path: string })[] = [];
  for (const width of widths) {
    for (const [ext, encoder] of Object.entries(FORMATS)) {
      const path = join(outDir, `${width}.${ext}`);
      // sharp converts to sRGB and drops metadata by default.
      const info = await encoder(load(input).resize({ width })).toFile(path);
      variants.push({
        format: ext,
        width: info.width,
        height: info.height,
        bytes: info.size,
        path,
        // Where a real app would store it. Derived from the image id, so a
        // retry overwrites instead of adding a copy.
        key: `products/${imageId}/${width}.${ext}`,
      });
    }
  }
  return variants;
}

/**
 * A blurhash string: a ~30 character placeholder the frontend can paint while
 * the real image loads. Computed from a tiny copy, which is plenty.
 */
async function makeBlurhash(input: Buffer, width: number, height: number): Promise<string> {
  const { data, info } = await load(input)
    .flatten({ background: "#ffffff" })
    .resize(32, 32, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const [x, y] = width >= height ? [4, 3] : [3, 4];
  return encodeBlurhash(new Uint8ClampedArray(data), info.width, info.height, x, y);
}

// ---- Outputs. This is the one place that decides what leaves the run. ----

/**
 * Decide what to keep from the variant files before the run's disk goes away.
 *
 * This example keeps only each file's format, size and intended key. The files
 * themselves are deleted with the work directory.
 *
 * In a real app, upload them here instead, for example with @aws-sdk/client-s3:
 *   for (const v of variants) {
 *     await s3.send(new PutObjectCommand({
 *       Bucket: BUCKET, Key: v.key, Body: await readFile(v.path), ContentType: `image/${v.format}`,
 *     }));
 *   }
 * and return each key or URL. The keys come from the image id, so a retry
 * overwrites its earlier upload.
 */
function storeVariants(variants: (Variant & { path: string })[]): Variant[] {
  return variants.map(({ path: _path, ...variant }) => variant);
}

// ---- Alt text ----

// HTTP statuses a retry can't fix: bad request, bad key, no access, no such
// model, invalid input. 408, 429 and 5xx throw so Render retries.
const PERMANENT_OPENAI_STATUSES = new Set([400, 401, 403, 404, 422]);

async function askForAltText(name: string | null, previewJpegBase64: string) {
  // Render retries the task, so turn off the client's own retries to keep one
  // retry policy in charge.
  const client = new OpenAI({ maxRetries: 0, timeout: 60_000 });
  const response = await client.responses.parse({
    model: OPENAI_MODEL,
    instructions: ALT_TEXT_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: `Product name: ${name || "unknown"}` },
          { type: "input_image", image_url: `data:image/jpeg;base64,${previewJpegBase64}`, detail: "low" },
        ],
      },
    ],
    text: { format: zodTextFormat(AltText, "alt_text") },
  });
  if (response.output_parsed == null) {
    // A refusal or a cut-off answer. Asking again rarely changes it.
    throw new PermanentError(`No alt text in the response (status ${response.status})`);
  }
  return {
    answer: response.output_parsed,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}

// ---- Tasks ----

// processImage downloads, so it retries: a network error, an HTTP 5xx or a 429
// gets two more attempts, 5 and 10 seconds apart. A retry redoes the whole
// image. That's safe because the task writes nothing outside its own disk.
const processImage = task(
  {
    name: "processImage",
    timeoutSeconds: 5 * 60,
    retry: { maxRetries: 2, waitDurationMs: 5000, backoffScaling: 2 },
  },
  async function processImage(_ctx: TaskContext, image: Image): Promise<ProcessResult> {
    const imageId = String(image?.id ?? "").trim();
    const url = String(image?.url ?? "").trim();
    if (!imageId || !url) return { id: imageId || null, error: "Each image needs an id and a url" };
    // The id becomes part of file names and storage keys.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(imageId)) {
      return { id: imageId, error: "id may only contain letters, digits, '.', '_' and '-'" };
    }

    console.log(`[PROCESS] ${imageId}: ${url}`);
    const seconds: Record<string, number> = {};
    const elapsed = (start: number) => Math.round(performance.now() - start) / 1000;
    const work = await mkdtemp(join(tmpdir(), `${imageId}-`));
    try {
      let start = performance.now();
      const input = await download(url);
      seconds.download = elapsed(start);

      start = performance.now();
      const source = await describeSource(input);
      let variants: Variant[];
      let blurhash: string;
      let thumbnail: Buffer;
      let preview: Buffer;
      try {
        variants = storeVariants(await makeVariants(input, source.width, work, imageId));
        blurhash = await makeBlurhash(input, source.width, source.height);
        thumbnail = await load(input).resize(THUMBNAIL_WIDTH, THUMBNAIL_WIDTH, { fit: "inside" }).webp({ quality: 70 }).toBuffer();
        preview = await load(input)
          .flatten({ background: "#ffffff" })
          .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: "inside" })
          .jpeg({ quality: 80 })
          .toBuffer();
      } catch (error) {
        // sharp throws for corrupt or truncated files. A retry gets the same file.
        throw new PermanentError(`Can't decode image: ${(error as Error).message}`);
      }
      seconds.variants = elapsed(start);

      const total = variants.reduce((sum, v) => sum + v.bytes, 0);
      console.log(
        `[PROCESS] ${imageId}: ${source.width}x${source.height} ${source.format}, ` +
          `${variants.length} variants, ${total} bytes, ${JSON.stringify(seconds)}`,
      );
      return {
        id: imageId,
        source: { ...source, bytes: input.length },
        blurhash,
        variants,
        thumbnail_webp_base64: thumbnail.toString("base64"),
        // For generateAltText. importImages leaves it out of the manifest.
        preview_jpeg_base64: preview.toString("base64"),
        seconds,
      };
    } catch (error) {
      if (error instanceof PermanentError) {
        console.error(`[PROCESS] ${imageId}: ${error.message} (not retrying)`);
        return { id: imageId, error: error.message };
      }
      throw error;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

// generateAltText calls the OpenAI API, so it retries: a 429, a 5xx or a
// connection error gets three more attempts, 2, 4 and 8 seconds apart. Calling
// the model again is safe because nothing is written.
const generateAltText = task(
  {
    name: "generateAltText",
    timeoutSeconds: 2 * 60,
    retry: { maxRetries: 3, waitDurationMs: 2000, backoffScaling: 2 },
  },
  async function generateAltText(
    _ctx: TaskContext,
    imageId: string,
    name: string | null,
    previewJpegBase64: string,
  ): Promise<AltTextResult> {
    if (!process.env.OPENAI_API_KEY) {
      // A setup problem a retry can't fix, so return it instead of throwing.
      return { id: imageId, error: "OPENAI_API_KEY is not set" };
    }

    const start = performance.now();
    try {
      const { answer, usage } = await askForAltText(name, previewJpegBase64);
      const seconds = Math.round(performance.now() - start) / 1000;
      console.log(`[ALT TEXT] ${imageId}: ${JSON.stringify(answer.alt_text)} in ${seconds} s`);
      return { id: imageId, model: OPENAI_MODEL, ...answer, ...usage, seconds };
    } catch (error) {
      if (error instanceof PermanentError) return { id: imageId, error: error.message };
      if (error instanceof OpenAI.APIError && PERMANENT_OPENAI_STATUSES.has(error.status ?? 0)) {
        const body = (error.error ?? {}) as { message?: string };
        const message = `OpenAI error ${error.status}: ${body.message ?? error.message}`;
        console.error(`[ALT TEXT] ${imageId}: ${message} (not retrying)`);
        return { id: imageId, error: message };
      }
      throw error;
    }
  },
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run fn over items, at most `limit` at a time, keeping the input order. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// importImages only fans out and waits, so it runs on the default flex plan
// and never retries: a retry would redo every image, including the ones that
// finished.
task(
  {
    name: "importImages",
    timeoutSeconds: 60 * 60,
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
  },
  async function importImages(ctx: TaskContext, images: Image[]) {
    console.log(`[IMPORT] ${images.length} images, up to ${MAX_CONCURRENT_IMAGES} at a time`);

    const rows = await mapWithLimit(images, MAX_CONCURRENT_IMAGES, async (image) => {
      const base = { id: image?.id ?? null, name: image?.name ?? null, url: image?.url ?? null };
      // Each ctx.run is its own task run with its own retries.
      let processed: ProcessResult;
      try {
        processed = await ctx.run(processImage, image);
      } catch (error) {
        // The run threw on every attempt (retries used up).
        return { ...base, status: "failed", error: errorMessage(error) };
      }
      if ("error" in processed) return { ...base, status: "failed", error: processed.error };

      const { preview_jpeg_base64: preview, ...rest } = processed;
      const row = { ...base, status: "imported", ...rest };
      let alt: AltTextResult;
      try {
        alt = await ctx.run(generateAltText, rest.id, base.name, preview ?? "");
      } catch (error) {
        alt = { id: rest.id, error: errorMessage(error) };
      }
      // The image itself is fine without alt text, so the row stays imported.
      // alt_text_error marks it for a person to review.
      if ("error" in alt) return { ...row, alt_text: null, alt_text_error: alt.error };
      return { ...row, alt_text: alt.alt_text, tags: alt.tags };
    });

    const imported = rows.filter((r) => r.status === "imported");
    const summary = {
      total: rows.length,
      imported: imported.length,
      failed: rows.length - imported.length,
      missing_alt_text: imported.filter((r) => "alt_text" in r && r.alt_text === null).length,
    };
    console.log(`[IMPORT] ${JSON.stringify(summary)}`);
    return { ...summary, images: rows };
  },
);
