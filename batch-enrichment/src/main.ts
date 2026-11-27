/**
 * Batch CSV enrichment with the OpenAI Batch API on Render Workflows
 *
 * Enriches every row of a CSV of companies (industry, size bucket, one-line
 * summary) through the OpenAI Batch API, which costs half as much as normal API
 * calls but can take up to 24 hours. One task submits the batch, one waits for
 * it on the flex plan, and one parses, validates and joins the results back to
 * the rows, reporting the rows that failed.
 *
 * The waiting task sleeps between status checks inside a single long attempt.
 * See the README for why this beats "retry until done" on Render.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { parse } from "csv-parse/sync";
import OpenAI, { toFile } from "openai";
import { z } from "zod";

// Read the model from the environment so a retired model is a config change,
// not a code change.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-6.2-sol";

// How long waitForBatch sleeps between status checks. Small batches often
// finish in a few minutes; large ones can take hours.
const POLL_SECONDS = Number(process.env.BATCH_POLL_SECONDS ?? "60");

// The CSV that ships with this example. Pass a csvUrl to enrich your own.
const BUNDLED_CSV = new URL("../companies.csv", import.meta.url);

// OpenAI errors that mean the request itself is wrong: bad key, unknown model,
// invalid input. A retry can't fix them, so tasks return them as results.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 422]);

// Batch statuses after which nothing changes.
const TERMINAL_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);

// Bump this when you change the prompt or schema, so a rerun submits a new
// batch instead of reusing one built with the old prompt.
const PROMPT_VERSION = "v1";

const INSTRUCTIONS =
  "You enrich rows of a company list for a sales team. From the company name, " +
  "website and description, pick the closest industry, estimate the headcount " +
  "bucket, and write a one-sentence summary of what the company does (at most " +
  "25 words, no line breaks). Use only the information given.";

const INDUSTRIES = [
  "Software",
  "Fintech",
  "Healthcare",
  "Logistics",
  "Manufacturing",
  "Energy",
  "Agriculture",
  "Education",
  "Media & Entertainment",
  "Professional Services",
  "Other",
] as const;
const SIZE_BUCKETS = ["1-10", "11-50", "51-200", "201-1000", "1000+"] as const;

// ---- The enrichment schema. The model must answer in this shape (strict JSON
// schema), and collectResults validates every answer against it again. ----

const Enrichment = z.object({
  industry: z.enum(INDUSTRIES),
  size_bucket: z.enum(SIZE_BUCKETS),
  summary: z.string().min(10).max(240).regex(/^[^\n]+$/),
});

const ENRICHMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["industry", "size_bucket", "summary"],
  properties: {
    industry: { type: "string", enum: INDUSTRIES },
    size_bucket: { type: "string", enum: SIZE_BUCKETS },
    summary: { type: "string" },
  },
};

type Row = { id: string; company: string; website?: string; description?: string };
type Failure = { id: string | null; error: string };

// ---- Helpers ----

/**
 * Read the CSV from a URL, or the bundled companies.csv if none is given.
 *
 * Tasks take the URL rather than the rows, so task arguments stay small no
 * matter how big the CSV is (a run's arguments are capped at 4 MB).
 */
async function loadRows(csvUrl?: string | null): Promise<Row[]> {
  let text: string;
  if (csvUrl) {
    const resp = await fetch(csvUrl, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new CsvError(`HTTP ${resp.status} fetching ${csvUrl}`);
    text = await resp.text();
  } else {
    text = readFileSync(BUNDLED_CSV, "utf-8");
  }
  try {
    return parse(text, { columns: true, skip_empty_lines: true }) as Row[];
  } catch (error) {
    throw new CsvError(String(error));
  }
}

class CsvError extends Error {}

/** Separate rows we can send from rows that fail input checks. */
function splitRows(rows: Row[]): { valid: Row[]; invalid: Failure[] } {
  const valid: Row[] = [];
  const invalid: Failure[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = (row.id ?? "").trim();
    if (!id) invalid.push({ id: null, error: "Row has no id" });
    else if (seen.has(id)) invalid.push({ id, error: "Duplicate id" });
    else if (!(row.company ?? "").trim()) invalid.push({ id, error: "Row has no company name" });
    else valid.push(row);
    seen.add(id);
  }
  return { valid, invalid };
}

/**
 * A fingerprint of the rows, model and prompt, stored on the batch.
 *
 * submitBatch looks for an existing batch with this key before creating one,
 * so a retry or a rerun of the same CSV reuses the batch instead of paying for
 * a second one.
 */
function jobKey(rows: Row[]): string {
  const payload = JSON.stringify([MODEL, PROMPT_VERSION, rows]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/** One line of the batch input file: a Responses API request for one row. */
function requestLine(row: Row): string {
  return JSON.stringify({
    custom_id: row.id,
    method: "POST",
    url: "/v1/responses",
    body: {
      model: MODEL,
      instructions: INSTRUCTIONS,
      input: JSON.stringify({
        company: row.company,
        website: row.website ?? "",
        description: row.description ?? "",
      }),
      text: {
        format: { type: "json_schema", name: "company_enrichment", schema: ENRICHMENT_SCHEMA, strict: true },
      },
    },
  });
}

type ResponseBody = {
  status?: string;
  error?: { message?: string };
  output?: { type: string; content?: { type: string; text?: string }[] }[];
};

/** The model's text answer from a Responses API body, if there is one. */
function outputText(body: ResponseBody): string | null {
  for (const item of body.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && part.text !== undefined) return part.text;
    }
  }
  return null;
}

function openaiClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  // Render retries these tasks, so turn off the OpenAI client's own retries to
  // keep one retry policy in charge.
  return new OpenAI({ maxRetries: 0 });
}

function isPermanent(error: unknown): error is InstanceType<typeof OpenAI.APIError> {
  return error instanceof OpenAI.APIError && PERMANENT_ERROR_STATUSES.has(error.status ?? 0);
}

function batchSummary(batch: OpenAI.Batches.Batch) {
  return {
    batch_id: batch.id,
    status: batch.status,
    request_counts: batch.request_counts ?? null,
    errors: batch.errors?.data ?? [],
  };
}

// ---- Tasks ----

type Submitted = { batch_id: string; rows: number; reused: boolean } | { error: string; invalid?: Failure[] };

// submitBatch uploads the input file and creates the batch. It retries on
// network errors and 5xx. Retrying is safe because it reuses a batch that has
// the same job key instead of creating a second one.
const submitBatch = task(
  {
    name: "submitBatch",
    retry: { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 2 },
    timeoutSeconds: 600,
  },
  async function submitBatch(_ctx: TaskContext, csvUrl?: string | null): Promise<Submitted> {
    const client = openaiClient();
    if (!client) return { error: "OPENAI_API_KEY is not set" };

    let rows: Row[];
    let invalid: Failure[];
    try {
      ({ valid: rows, invalid } = splitRows(await loadRows(csvUrl)));
    } catch (error) {
      if (error instanceof CsvError) return { error: `Could not read the CSV: ${error.message}` };
      throw error;
    }
    if (rows.length === 0) return { error: "No valid rows to enrich", invalid };

    const key = jobKey(rows);
    try {
      // Reuse a batch for these exact rows if one is running or finished.
      // Batches are listed newest first; only look back two days.
      const cutoff = Date.now() / 1000 - 2 * 24 * 3600;
      for await (const batch of client.batches.list({ limit: 100 })) {
        if (batch.created_at < cutoff) break;
        if (
          batch.metadata?.job_key === key &&
          !["failed", "expired", "cancelled", "cancelling"].includes(batch.status)
        ) {
          console.log(`[SUBMIT] Reusing batch ${batch.id} (${batch.status})`);
          return { batch_id: batch.id, rows: rows.length, reused: true };
        }
      }

      const jsonl = rows.map(requestLine).join("\n");
      const inputFile = await client.files.create({
        file: await toFile(Buffer.from(jsonl), "enrichment.jsonl"),
        purpose: "batch",
      });
      const batch = await client.batches.create({
        input_file_id: inputFile.id,
        endpoint: "/v1/responses",
        completion_window: "24h",
        metadata: { job_key: key, source: "render-workflows-batch-enrichment" },
      });
      console.log(`[SUBMIT] Created batch ${batch.id} with ${rows.length} requests`);
      return { batch_id: batch.id, rows: rows.length, reused: false };
    } catch (error) {
      if (isPermanent(error)) return { error: `OpenAI error ${error.status}: ${error.message}` };
      throw error;
    }
  },
);

type Finished =
  | (ReturnType<typeof batchSummary> & { waited_seconds: number })
  | { batch_id: string; error: string };

// waitForBatch is the long wait. It runs on flex, which bills for the CPU and
// memory a run actually uses, and sleeps between checks inside one attempt.
// The 24-hour timeout matches the Batch API's 24-hour completion window.
// Errors while checking are logged and retried on the next check, so one
// network blip doesn't end a wait that has already run for hours.
const waitForBatch = task(
  {
    name: "waitForBatch",
    plan: "flex",
    retry: { maxRetries: 1, waitDurationMs: 5000, backoffScaling: 2 },
    timeoutSeconds: 24 * 3600,
  },
  async function waitForBatch(_ctx: TaskContext, batchId: string): Promise<Finished> {
    const client = openaiClient();
    if (!client) return { batch_id: batchId, error: "OPENAI_API_KEY is not set" };

    const started = Date.now();
    let lastStatus: string | null = null;
    while (true) {
      try {
        const batch = await client.batches.retrieve(batchId);
        if (batch.status !== lastStatus) {
          console.log(`[WAIT] ${batchId}: ${batch.status}`, batch.request_counts);
          lastStatus = batch.status;
        }
        if (TERMINAL_STATUSES.has(batch.status)) {
          return { ...batchSummary(batch), waited_seconds: Math.round((Date.now() - started) / 1000) };
        }
      } catch (error) {
        if (isPermanent(error)) {
          return { batch_id: batchId, error: `OpenAI error ${error.status}: ${error.message}` };
        }
        if (!(error instanceof OpenAI.APIError)) throw error;
        console.warn(`[WAIT] ${batchId}: ${error.message}, checking again later`);
      }
      await sleep(POLL_SECONDS * 1000);
    }
  },
);

type Collected =
  | {
      batch_id: string;
      batch_status: string;
      total: number;
      enriched: number;
      failed: Failure[];
      rows: (Row & z.infer<typeof Enrichment>)[];
    }
  | { batch_id: string; error: string };

type ResultLine = {
  custom_id: string;
  response: { status_code: number; body: ResponseBody } | null;
  error: { code?: string; message?: string } | null;
};

// collectResults downloads the output and error files, validates every answer,
// and joins it back to its row by custom_id (output order isn't guaranteed to
// match input order). It only reads, so a retry is safe.
const collectResults = task(
  {
    name: "collectResults",
    retry: { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 2 },
    timeoutSeconds: 900,
  },
  async function collectResults(_ctx: TaskContext, batchId: string, csvUrl?: string | null): Promise<Collected> {
    const client = openaiClient();
    if (!client) return { batch_id: batchId, error: "OPENAI_API_KEY is not set" };

    let rows: Row[];
    let invalid: Failure[];
    let batch: OpenAI.Batches.Batch;
    let output = "";
    let errors = "";
    try {
      ({ valid: rows, invalid } = splitRows(await loadRows(csvUrl)));
      batch = await client.batches.retrieve(batchId);
      if (batch.output_file_id) output = await (await client.files.content(batch.output_file_id)).text();
      if (batch.error_file_id) errors = await (await client.files.content(batch.error_file_id)).text();
    } catch (error) {
      if (error instanceof CsvError) return { batch_id: batchId, error: `Could not read the CSV: ${error.message}` };
      if (isPermanent(error)) return { batch_id: batchId, error: `OpenAI error ${error.status}: ${error.message}` };
      throw error;
    }

    // One result line per request, from either file. Expired or cancelled
    // batches still return the requests that finished.
    const byId = new Map<string, ResultLine>();
    for (const line of `${output}\n${errors}`.split("\n")) {
      if (!line.trim()) continue;
      const result = JSON.parse(line) as ResultLine;
      byId.set(result.custom_id, result);
    }

    const enriched: (Row & z.infer<typeof Enrichment>)[] = [];
    const failed: Failure[] = [...invalid];
    for (const row of rows) {
      const result = byId.get(row.id);
      if (!result) {
        failed.push({ id: row.id, error: `No result (batch ${batch.status})` });
        continue;
      }
      if (result.error) {
        failed.push({ id: row.id, error: result.error.message ?? JSON.stringify(result.error) });
        continue;
      }
      const body = result.response?.body ?? {};
      if (result.response?.status_code !== 200) {
        failed.push({
          id: row.id,
          error: `HTTP ${result.response?.status_code}: ${body.error?.message ?? "request failed"}`,
        });
        continue;
      }
      const text = outputText(body);
      if (text === null) {
        failed.push({ id: row.id, error: `No answer (response ${body.status})` });
        continue;
      }
      let parsed;
      try {
        parsed = Enrichment.safeParse(JSON.parse(text));
      } catch {
        failed.push({ id: row.id, error: "Invalid answer: not JSON" });
        continue;
      }
      if (!parsed.success) {
        failed.push({ id: row.id, error: `Invalid answer: ${parsed.error.issues[0]?.message}` });
        continue;
      }
      enriched.push({ id: row.id, company: row.company, website: row.website ?? "", ...parsed.data });
    }

    console.log(`[COLLECT] ${batchId}: ${enriched.length} enriched, ${failed.length} failed`);
    return {
      batch_id: batchId,
      batch_status: batch.status,
      total: rows.length + invalid.length,
      enriched: enriched.length,
      failed,
      rows: enriched,
    };
  },
);

// enrichCsv chains the three steps. It doesn't retry: each step has its own
// retry policy. If it fails or times out partway, run it again with the same
// CSV: submitBatch finds the existing batch, so the rerun picks up where the
// last one left off and nothing is paid for twice.
task(
  {
    name: "enrichCsv",
    plan: "flex",
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 24 * 3600,
  },
  async function enrichCsv(ctx: TaskContext, csvUrl?: string | null) {
    const submitted = await ctx.run(submitBatch, csvUrl ?? null);
    if ("error" in submitted) return submitted;

    const batchId = submitted.batch_id;
    const finished = await ctx.run(waitForBatch, batchId);
    if ("error" in finished) return finished;
    if (finished.status === "failed") {
      // The input file failed validation, so no request ran.
      return { batch_id: batchId, error: "Batch failed validation", details: finished.errors };
    }

    const result = await ctx.run(collectResults, batchId, csvUrl ?? null);
    if ("error" in result) return result;
    return { ...result, waited_seconds: finished.waited_seconds, reused_batch: submitted.reused };
  },
);
