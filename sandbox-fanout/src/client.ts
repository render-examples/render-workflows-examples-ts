/**
 * Trigger the sandbox tasks from another service or script.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to sandbox-fanout).
 */
import { readFileSync } from "node:fs";
import { Render } from "@renderinc/sdk";

// The shapes the tasks return. Task results come back untyped, so declare them here.
type JobResult = { job_id: string; sandbox_id?: string; output?: unknown; error?: string };
type BatchResult = { total: number; succeeded: number; failed: JobResult[]; results: JobResult[] };

const SLUG = process.env.WORKFLOW_SLUG ?? "sandbox-fanout";
const jobs = JSON.parse(readFileSync(new URL("../jobs.json", import.meta.url), "utf-8"));

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// One job. Task input is an array of the task's arguments. runTask waits for
// the run to finish and returns its details.
const one = await render.workflows.runTask(`${SLUG}/runJob`, [jobs[0]]);
if (one.status !== "completed") {
  throw new Error(`Run ${one.id} ended as ${one.status}`);
}
// results is an array holding the task's return value.
const result = one.results[0] as JobResult;
console.log(`${result.job_id} -> ${JSON.stringify(result.output ?? result)}`);

// All jobs, one sandbox each. One job fails on purpose.
const batchRun = await render.workflows.runTask(`${SLUG}/runBatch`, [jobs]);
if (batchRun.status !== "completed") {
  throw new Error(`Run ${batchRun.id} ended as ${batchRun.status}`);
}
const batch = batchRun.results[0] as BatchResult;
console.log(`\n${batch.succeeded} of ${batch.total} jobs succeeded`);
for (const r of batch.results) console.log(`  ${r.job_id}: ${JSON.stringify(r.output)}`);
for (const f of batch.failed) console.log(`  failed: ${f.job_id}: ${f.error}`);
