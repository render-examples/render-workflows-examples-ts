/**
 * Run the eval from another service or script and print the scorecard.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to llm-evals).
 */
import { readFileSync } from "node:fs";
import { Render } from "@renderinc/sdk";

// The shape runEval returns. Task results come back untyped, so declare it here.
type Scorecard = {
  model: string;
  scored: number;
  passed: number;
  pass_rate: number | null;
  avg_score: number | null;
  latency_ms: { p50: number | null; max: number | null };
  failures: { ticket_id: string; reasons: string[] }[];
  errors: { ticket_id: string; error: string }[];
};
type Report = { judge: string; cases?: number; scorecard?: Scorecard[]; error?: string };

const SLUG = process.env.WORKFLOW_SLUG ?? "llm-evals";
const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf-8"));
const tickets = read("tickets.json");
const cases = read("cases.json");

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// Task input is an array of the task's arguments. runTask waits for the run to
// finish and returns its details.
const run = await render.workflows.runTask(`${SLUG}/runEval`, [tickets, cases]);
if (run.status !== "completed") {
  throw new Error(`Run ${run.id} ended as ${run.status}`);
}

// results is an array holding the task's return value.
const report = run.results[0] as Report;
if (report.error || !report.scorecard) throw new Error(report.error ?? "No scorecard");

console.log(`${report.cases} cases, judged by ${report.judge}\n`);
console.log(`${"model".padEnd(36)} ${"pass rate".padStart(9)} ${"score".padStart(6)} ${"p50 ms".padStart(7)} ${"errors".padStart(6)}`);
for (const s of report.scorecard) {
  console.log(
    `${s.model.padEnd(36)} ${String(s.pass_rate ?? "-").padStart(9)} ${String(s.avg_score ?? "-").padStart(6)} ` +
      `${String(s.latency_ms.p50 ?? "-").padStart(7)} ${String(s.errors.length).padStart(6)}`,
  );
  for (const failure of s.failures) console.log(`    ${failure.ticket_id}: ${failure.reasons.join("; ")}`);
}
