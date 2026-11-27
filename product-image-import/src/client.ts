/**
 * Trigger the import from another service or script.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to product-image-import).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Render } from "@renderinc/sdk";

// The shape importImages returns. Task results come back untyped, so declare it here.
type Row = {
  id: string;
  status: "imported" | "failed";
  error?: string;
  source?: { format: string; width: number; height: number };
  blurhash?: string;
  variants?: { format: string; width: number; bytes: number; key: string }[];
  thumbnail_webp_base64?: string;
  alt_text?: string | null;
  alt_text_error?: string;
};
type Manifest = { total: number; imported: number; failed: number; missing_alt_text: number; images: Row[] };

const SLUG = process.env.WORKFLOW_SLUG ?? "product-image-import";
const images = JSON.parse(readFileSync(new URL("../images.json", import.meta.url), "utf-8"));

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// Task input is an array of the task's arguments; importImages takes one, the
// list of images. runTask waits for the run to finish and returns its details.
// The idempotency key makes a repeated call within 24 hours return the first
// run instead of importing the same list again.
const run = await render.workflows.runTask(`${SLUG}/importImages`, [images], {
  idempotencyKey: "import-sample-images-v1",
});
if (run.status !== "completed") {
  throw new Error(`Run ${run.id} ended as ${run.status}`);
}

// results is an array holding the task's return value: the manifest.
const manifest = run.results[0] as Manifest;
console.log(
  `Imported ${manifest.imported} of ${manifest.total}, ` +
    `${manifest.failed} failed, ${manifest.missing_alt_text} missing alt text`,
);
for (const row of manifest.images) {
  if (row.status === "failed") {
    console.log(`  ${row.id}: failed: ${row.error}`);
    continue;
  }
  const avif = (row.variants ?? []).filter((v) => v.format === "avif");
  const smallest = Math.min(...avif.map((v) => v.bytes));
  console.log(
    `  ${row.id}: ${row.source?.width}x${row.source?.height} ${row.source?.format}, ` +
      `${row.variants?.length} variants, smallest AVIF ${smallest} bytes`,
  );
  console.log(`    blurhash ${row.blurhash}`);
  console.log(row.alt_text ? `    alt text ${JSON.stringify(row.alt_text)}` : `    alt text missing: ${row.alt_text_error}`);

  // Each row carries a 160 px WebP thumbnail. Write it to the current directory.
  const path = `${row.id}_thumb.webp`;
  writeFileSync(path, Buffer.from(row.thumbnail_webp_base64 ?? "", "base64"));
  console.log(`    wrote ${path}`);
}
