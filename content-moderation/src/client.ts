/**
 * Moderate the sample posts from another service or script and print the
 * review queue.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to content-moderation).
 */
import { readFileSync } from "node:fs";
import { Render } from "@renderinc/sdk";

// The shape moderatePosts returns. Task results come back untyped, so declare
// it here.
type Reason = { category: string; score: number; inputs: string[] };
type Item = {
  post_id: string;
  reasons: Reason[];
  text?: string;
  review_note?: string;
  note_error?: string;
  error?: string;
};
type Report = {
  model: string;
  counts?: Record<"approve" | "flag" | "reject" | "error", number>;
  flagged: Item[];
  rejected: Item[];
  errors: Item[];
  error?: string;
};

const SLUG = process.env.WORKFLOW_SLUG ?? "content-moderation";
const posts = JSON.parse(readFileSync(new URL("../posts.json", import.meta.url), "utf-8"));

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// Task input is an array of the task's arguments. runTask waits for the run to
// finish and returns its details.
const run = await render.workflows.runTask(`${SLUG}/moderatePosts`, [posts]);
if (run.status !== "completed") {
  throw new Error(`Run ${run.id} ended as ${run.status}`);
}

// results is an array holding the task's return value.
const report = run.results[0] as Report;
if (report.error || !report.counts) throw new Error(report.error ?? "No counts");

const counts = report.counts;
console.log(`${posts.length} posts, moderated with ${report.model}`);
console.log((["approve", "flag", "reject", "error"] as const).map((d) => `${d}: ${counts[d]}`).join(", "));

console.log("\nReview queue:");
for (const item of report.flagged) {
  const top = item.reasons[0];
  console.log(`  ${item.post_id} (${top.category} ${top.score}): ${item.text}`);
  console.log(`    note: ${item.review_note ?? item.note_error}`);
}

console.log("\nRejected:");
for (const item of report.rejected) {
  const top = item.reasons[0];
  console.log(`  ${item.post_id} (${top.category} ${top.score})`);
}

if (report.errors.length > 0) {
  console.log("\nNot moderated (hold these for review):");
  for (const item of report.errors) console.log(`  ${item.post_id}: ${item.error}`);
}
