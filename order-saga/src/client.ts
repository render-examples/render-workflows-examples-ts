/**
 * Start one checkout flow run per order in orders.json, then wait for them all.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to order-saga).
 */
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Render } from "@renderinc/sdk";

// The shape the flow returns. Flow results come back untyped, so declare it here.
type CheckoutResult = {
  order_id: string;
  status: "completed" | "compensated" | "rejected";
  failed_step?: string;
  reason?: string;
  compensated: string[];
  steps: Record<string, { process?: string; idempotent_replayed?: boolean }>;
};

// The order steps can run in, for printing. Results come back with sorted keys.
const STEP_ORDER = [
  "reserveInventory", "chargePayment", "simulateCrash", "createShipment", "refundPayment", "releaseInventory",
];

const SLUG = process.env.WORKFLOW_SLUG ?? "order-saga";
const orders: { order_id: string }[] = JSON.parse(readFileSync(new URL("../orders.json", import.meta.url), "utf-8"));

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// One flow run per order. The idempotency key comes from the order ID, so
// running this script again within 24 hours returns the runs it already started
// instead of checking out the same orders twice.
const runIds = new Map<string, string>();
for (const order of orders) {
  const run = await render.workflows.startFlow(`${SLUG}/checkout`, [order], {
    idempotencyKey: `checkout-${order.order_id}`,
  });
  runIds.set(order.order_id, run.id);
  console.log(`${order.order_id}: flow run ${run.id}`);
}

// Poll until every run reaches a final status. runFlow does this for a single
// run; polling getFlowRun lets the runs go in parallel.
const finished = new Map<string, Awaited<ReturnType<typeof render.workflows.getFlowRun>>>();
while (finished.size < runIds.size) {
  await sleep(2000);
  for (const [orderId, runId] of runIds) {
    if (finished.has(orderId)) continue;
    const run = await render.workflows.getFlowRun(runId);
    if (["succeeded", "failed", "canceled"].includes(run.status)) finished.set(orderId, run);
  }
}

console.log();
for (const [orderId, run] of finished) {
  if (run.status !== "succeeded") {
    console.log(`${orderId}: flow run ${run.status}: ${run.error}`);
    continue;
  }
  // results is an array holding the flow's return value.
  const result = run.results[0] as CheckoutResult;
  let line = `${orderId}: ${result.status}`;
  if (result.status !== "completed") {
    const undone = result.compensated.join(", ") || "nothing";
    line += ` after ${result.failed_step} failed (${result.reason}); undid ${undone}`;
  }
  console.log(line);
  console.log(`  flow attempts: ${run.attempts.length}`);
  for (const name of STEP_ORDER) {
    const step = result.steps[name];
    if (!step) continue;
    const note = step.idempotent_replayed ? " (idempotent replay)" : "";
    console.log(`  ${name.padEnd(18)} ran in process ${step.process ?? "-"}${note}`);
  }
}
