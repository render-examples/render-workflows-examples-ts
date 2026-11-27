/**
 * Trigger the triage tasks from another service or script.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to claude-agent-sdk).
 */
import { readFileSync } from "node:fs";
import { Render } from "@renderinc/sdk";

// The shapes the tasks return. Task results come back untyped, so declare them here.
type TriageResult = {
  ticket_id: string;
  final_output?: { category: string; priority: string; customer_reply: string } & Record<string, unknown>;
  num_turns?: number;
  total_cost_usd?: number;
  error?: string;
};
type BatchResult = {
  total: number;
  triaged: number;
  by_category: Record<string, number>;
  total_cost_usd: number;
  failed: TriageResult[];
  results: TriageResult[];
};

const SLUG = process.env.WORKFLOW_SLUG ?? "claude-agent-sdk";
const tickets = JSON.parse(readFileSync(new URL("../tickets.json", import.meta.url), "utf-8"));

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// One ticket. Task input is an array of the task's arguments. runTask waits for
// the run to finish and returns its details.
const one = await render.workflows.runTask(`${SLUG}/triageTicket`, [tickets[0]]);
if (one.status !== "completed") {
  throw new Error(`Run ${one.id} ended as ${one.status}`);
}
// results is an array holding the task's return value.
const result = one.results[0] as TriageResult;
console.log(`${result.ticket_id} -> ${result.final_output?.category}`);
console.log(JSON.stringify(result.final_output ?? result, null, 2));

// All tickets, triaged in parallel.
const batchRun = await render.workflows.runTask(`${SLUG}/triageBatch`, [tickets]);
if (batchRun.status !== "completed") {
  throw new Error(`Run ${batchRun.id} ended as ${batchRun.status}`);
}
const batch = batchRun.results[0] as BatchResult;
console.log(`\nTriaged ${batch.triaged} of ${batch.total}:`, batch.by_category);
console.log(`Model cost: $${batch.total_cost_usd}`);
for (const failure of batch.failed) console.log("  failed:", failure);
