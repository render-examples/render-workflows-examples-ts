/**
 * Trigger the Pi tasks from another service or script.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to pi-agent). By default the agent works on the sample app in
 * this repository. Set REPO_URL, REPO_REF and REPO_SUBDIR to point it at your
 * own repository.
 */
import { readFileSync } from "node:fs";
import { Render } from "@renderinc/sdk";

// The shape runPi returns. Task results come back untyped, so declare it here.
type PiResult = {
  ticket_id: string;
  kind: "diff" | "branch" | "pushFailed" | "noChanges" | "error";
  patch?: string;
  name?: string;
  files?: string[];
  summary?: string;
  error?: string;
};
type BatchResult = { total: number; by_kind: Record<string, number>; results: PiResult[] };

const SLUG = process.env.WORKFLOW_SLUG ?? "pi-agent";
const repo = {
  repoUrl: process.env.REPO_URL ?? "https://github.com/render-examples/render-workflows-examples-ts",
  ref: process.env.REPO_REF,
  subdir: process.env.REPO_SUBDIR ?? "pi-agent/sample-app",
};
const tickets = JSON.parse(readFileSync(new URL("../tickets.json", import.meta.url), "utf-8"));

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// One ticket. Task input is an array of the task's arguments. runTask waits for
// the run to finish and returns its details.
const one = await render.workflows.runTask(`${SLUG}/runPi`, [{ ...repo, ticket: tickets[4] }]);
if (one.status !== "completed") {
  throw new Error(`Run ${one.id} ended as ${one.status}`);
}
// results is an array holding the task's return value.
const result = one.results[0] as PiResult;
console.log(`${result.ticket_id}: ${result.kind}`);
if (result.kind === "diff") console.log(result.patch);
if (result.kind === "branch") console.log(`Pushed ${result.name}`);

// All tickets, each in its own run.
const batchRun = await render.workflows.runTask(`${SLUG}/runPiBatch`, [
  tickets.map((ticket: unknown) => ({ ...repo, ticket })),
]);
if (batchRun.status !== "completed") {
  throw new Error(`Run ${batchRun.id} ended as ${batchRun.status}`);
}
const batch = batchRun.results[0] as BatchResult;
console.log(`\nRan ${batch.total} tickets:`, batch.by_kind);
for (const r of batch.results) console.log(`  ${r.ticket_id}: ${r.kind} ${r.files?.join(", ") ?? r.error ?? ""}`);
