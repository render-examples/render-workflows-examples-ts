/**
 * Trigger handleRefund from another service or script.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to idempotent-side-effects).
 */
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Render } from "@renderinc/sdk";

const SLUG = process.env.WORKFLOW_SLUG ?? "idempotent-side-effects";
const tickets = JSON.parse(readFileSync(new URL("../tickets.json", import.meta.url), "utf-8"));
const ticket = tickets[0];

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// The run's idempotency key comes from the ticket, the same way the credit's
// key comes from the account and order. If this script runs again for the
// same ticket within 24 hours (a retried webhook, a double click), Render
// returns the first run instead of starting another one.
const key = `handleRefund:${ticket.id}`;
const first = await render.workflows.startTask(`${SLUG}/handleRefund`, [ticket], { idempotencyKey: key });
const second = await render.workflows.startTask(`${SLUG}/handleRefund`, [ticket], { idempotencyKey: key });
console.log(`Call 1: run ${first.taskRunId}`);
console.log(`Call 2: run ${second.taskRunId}`);

// Wait by checking the run's status. A repeated key can return a run that
// finished earlier, and a finished run has no more events to wait for.
const DONE = new Set(["completed", "succeeded", "failed", "canceled"]);
let run = await render.workflows.getTaskRun(first.taskRunId);
while (!DONE.has(run.status)) {
  await sleep(1000);
  run = await render.workflows.getTaskRun(first.taskRunId);
}

if (run.status !== "completed" && run.status !== "succeeded") {
  throw new Error(`Run ${run.id} ended as ${run.status}`);
}

// results is an array holding the task's return value.
console.log(JSON.stringify(run.results[0], null, 2));
