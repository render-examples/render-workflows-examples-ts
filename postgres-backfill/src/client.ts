/**
 * Seed the table, start the backfill, and follow its progress from another
 * service or script.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to postgres-backfill). Set FAIL_CHUNK to a chunk number to watch
 * that chunk fail once and retry. Set RESUME_FROM to the flow run ID of a run that
 * didn't finish to pick up where it stopped (the table isn't reseeded then).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { Render } from "@renderinc/sdk";

// The shapes the flow and tasks return. Results come back untyped, so declare them here.
type Progress = { rows_scanned?: number; rows_total?: number; percent?: number; chunks_done?: number };

const SLUG = process.env.WORKFLOW_SLUG ?? "postgres-backfill";
const ROW_COUNT = Number(process.env.ROW_COUNT ?? "200000");
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? "5000");
const FAIL_CHUNK = process.env.FAIL_CHUNK ? Number(process.env.FAIL_CHUNK) : null;
const RESUME_FROM = process.env.RESUME_FROM || null;

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

if (!RESUME_FROM) {
  // Fill the demo table. Task input is an array of the task's arguments.
  const seed = await render.workflows.runTask(`${SLUG}/seedOrders`, [ROW_COUNT]);
  if (seed.status !== "completed") {
    throw new Error(`Seed run ${seed.id} ended as ${seed.status}`);
  }
  console.log("Seeded:", seed.results[0]);
}

// Start the backfill flow without waiting for it. An idempotency key makes a
// repeated start (a retried request, a double click) return the same run.
const run = await render.workflows.startFlow(`${SLUG}/backfillOrders`, [CHUNK_SIZE, RESUME_FROM, FAIL_CHUNK], {
  idempotencyKey: `backfill-orders-${Date.now()}`,
});
console.log(`Started flow run ${run.id}`);

// Follow it. Progress lives in the backfill_runs table; backfillStatus reads it.
let details = await render.workflows.getFlowRun(run.id);
while (!["succeeded", "failed", "canceled"].includes(details.status)) {
  await sleep(10_000);
  details = await render.workflows.getFlowRun(run.id);
  if (["succeeded", "failed", "canceled"].includes(details.status)) break;
  const progress = await render.workflows.runTask(`${SLUG}/backfillStatus`, [run.id]);
  const p = (progress.status === "completed" ? progress.results[0] : {}) as Progress;
  console.log(`${details.status}: ${p.rows_scanned}/${p.rows_total} rows (${p.percent}%), chunks ${p.chunks_done}`);
}

if (details.status !== "succeeded") {
  throw new Error(`Flow run ${run.id} ended as ${details.status}`);
}
// results is an array holding the flow's return value.
console.log("Done:", details.results[0]);
