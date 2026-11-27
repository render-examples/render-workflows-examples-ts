/**
 * Trigger handleRefund from another service or script.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to idempotent-side-effects).
 */
import { readFileSync } from "node:fs";
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
let run;
for (const call of [1, 2]) {
  run = await render.workflows.runTask(`${SLUG}/handleRefund`, [ticket], {
    idempotencyKey: `handleRefund:${ticket.id}`,
  });
  console.log(`Call ${call}: run ${run.id} ended as ${run.status}`);
}

if (run!.status !== "completed") {
  throw new Error(`Run ${run!.id} ended as ${run!.status}`);
}

// results is an array holding the task's return value.
console.log(JSON.stringify(run!.results[0], null, 2));
