/**
 * Start a CSV enrichment from another service or script, and check on it later.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to batch-enrichment). Pass a CSV URL as the first argument, or
 * leave it out to enrich the bundled companies.csv.
 *
 * A batch can take up to 24 hours, so this starts the run, saves its ID, and
 * checks its status instead of holding a connection open.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { Render } from "@renderinc/sdk";

// The shape enrichCsv returns. Task results come back untyped, so declare it here.
type EnrichResult = {
  batch_id: string;
  total: number;
  enriched: number;
  failed: { id: string | null; error: string }[];
  rows: { id: string; industry: string; size_bucket: string; summary: string }[];
  error?: string;
};

// A run is finished once it reaches one of these. While enrichCsv waits on a
// chained run, its status is "paused", so don't treat that as finished.
const FINISHED = new Set(["completed", "failed", "canceled"]);

const SLUG = process.env.WORKFLOW_SLUG ?? "batch-enrichment";
const csvUrl = process.argv[2];

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// Task input is an array of the task's arguments. Starting the same CSV twice
// doesn't pay for two batches: submitBatch reuses the batch it already made.
const started = await render.workflows.startTask(`${SLUG}/enrichCsv`, csvUrl ? [csvUrl] : []);
console.log(`Started run ${started.taskRunId}. Store this ID; you can check it from anywhere.`);

// Check every 30 seconds. In a real app, store the ID and check from a cron
// job or a status page instead of looping.
let details = await render.workflows.getTaskRun(started.taskRunId);
while (!FINISHED.has(details.status)) {
  console.log(`  ${details.status}...`);
  await sleep(30_000);
  details = await render.workflows.getTaskRun(started.taskRunId);
}

if (details.status !== "completed") {
  throw new Error(`Run ${details.id} ended as ${details.status}: ${details.error}`);
}

// results is an array holding the task's return value.
const result = details.results[0] as EnrichResult;
if (result.error) throw new Error(`Enrichment failed: ${JSON.stringify(result)}`);

console.log(`\nEnriched ${result.enriched} of ${result.total} rows (batch ${result.batch_id})`);
for (const row of result.rows) {
  console.log(`  ${row.id}  ${row.industry.padEnd(22)} ${row.size_bucket.padEnd(9)} ${row.summary}`);
}
for (const failure of result.failed) console.log("  failed:", JSON.stringify(failure));
