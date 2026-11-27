/**
 * Trigger the OCR tasks from another service or script.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to batch-ocr).
 */
import { Render } from "@renderinc/sdk";

// The shapes the tasks return. Task results come back untyped, so declare them here.
type OcrResult = { doc_ref: string; pages?: number; text?: string[]; error?: string };
type BatchResult = {
  total: number;
  succeeded: number;
  pages: number;
  failed: { doc_ref: string; error: string }[];
  results: OcrResult[];
};

const SLUG = process.env.WORKFLOW_SLUG ?? "batch-ocr";

// References, not file bytes: names of files in samples/ or https:// URLs.
// corrupt.pdf fails on purpose.
const DOCS = ["invoice-1042.pdf", "delivery-receipt-2207.pdf", "plan-amendment.pdf", "corrupt.pdf"];

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// One document. Task input is an array of the task's arguments. runTask waits
// for the run to finish and returns its details.
const one = await render.workflows.runTask(`${SLUG}/ocrDocument`, [DOCS[0]]);
if (one.status !== "completed") {
  throw new Error(`Run ${one.id} ended as ${one.status}`);
}
// results is an array holding the task's return value.
const doc = one.results[0] as OcrResult;
console.log(`${doc.doc_ref}: ${doc.pages} pages`);
console.log(doc.text?.[0] ?? doc.error);

// All documents, OCRed in parallel.
const batchRun = await render.workflows.runTask(`${SLUG}/ocrBatch`, [DOCS]);
if (batchRun.status !== "completed") {
  throw new Error(`Run ${batchRun.id} ended as ${batchRun.status}`);
}
const batch = batchRun.results[0] as BatchResult;
console.log(`\nOCRed ${batch.succeeded} of ${batch.total} documents (${batch.pages} pages)`);
for (const failure of batch.failed) console.log(`  failed: ${failure.doc_ref}: ${failure.error}`);
