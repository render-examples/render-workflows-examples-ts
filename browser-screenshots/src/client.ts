/**
 * Trigger the page checks from another service or script.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to browser-screenshots).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Render } from "@renderinc/sdk";

// The shapes the tasks return. Task results come back untyped, so declare them here.
type PageCheck = {
  url: string;
  ok: boolean;
  problems: string[];
  status: number | null;
  load_ms: number;
  console_errors: string[];
  thumbnail_jpeg_base64: string;
};
type BatchResult = {
  total: number;
  checked: number;
  failed: { url: string; error: string }[];
  pages: PageCheck[];
  error?: string;
};

const SLUG = process.env.WORKFLOW_SLUG ?? "browser-screenshots";
const urls: string[] = JSON.parse(readFileSync(new URL("../urls.json", import.meta.url), "utf-8"));

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// Check every URL in urls.json. Task input is an array of the task's
// arguments, so the URL list is wrapped in another array. runTask waits for
// the run to finish and returns its details.
const run = await render.workflows.runTask(`${SLUG}/checkPages`, [urls]);
if (run.status !== "completed") {
  throw new Error(`Run ${run.id} ended as ${run.status}`);
}

// results is an array holding the task's return value.
const batch = run.results[0] as BatchResult;
if (batch.error) throw new Error(batch.error);
console.log(`Checked ${batch.checked} of ${batch.total} pages`);

mkdirSync("thumbnails", { recursive: true });
for (const page of batch.pages) {
  const verdict = page.ok ? "ok" : page.problems.join(", ");
  console.log(`  ${page.status} ${String(page.load_ms).padStart(5)} ms  ${page.url}  (${verdict})`);
  for (const message of page.console_errors.slice(0, 3)) {
    console.log(`      console: ${message.slice(0, 120)}`);
  }
  // Thumbnails come back base64-encoded. Write them to thumbnails/.
  const { host, pathname } = new URL(page.url);
  const name = `${host}${pathname}`.replace(/^\/+|\/+$/g, "").replaceAll("/", "_") || "page";
  writeFileSync(`thumbnails/${name}.jpg`, Buffer.from(page.thumbnail_jpeg_base64, "base64"));
}

for (const failure of batch.failed) console.log(`  failed: ${failure.url}: ${failure.error}`);
console.log(`Wrote ${batch.pages.length} thumbnails to thumbnails/`);
