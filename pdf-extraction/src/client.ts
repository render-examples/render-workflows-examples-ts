/**
 * Extract every invoice in invoices.json and save the results to Postgres.
 *
 * Requires RENDER_API_KEY and DATABASE_URL, and the table from schema.sql.
 * Set WORKFLOW_SLUG to your workflow service's slug (it defaults to
 * pdf-extraction).
 */
import { readFileSync } from "node:fs";
import { Render } from "@renderinc/sdk";
import pg from "pg";

// The shape extractDocument returns. Task results come back untyped, so declare it here.
type ExtractionResult = {
  document_id: string;
  record: Record<string, unknown> | null;
  exceptions: { code: string; field: string | null; message: string }[];
};
type DocRef = { document_id: string; source: string };

const SLUG = process.env.WORKFLOW_SLUG ?? "pdf-extraction";
const documents: DocRef[] = JSON.parse(
  readFileSync(new URL("../invoices.json", import.meta.url), "utf-8"),
);

const UPSERT = `
INSERT INTO invoice_extractions (document_id, record, exceptions, task_run_id, updated_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (document_id) DO UPDATE SET
    record = EXCLUDED.record,
    exceptions = EXCLUDED.exceptions,
    task_run_id = EXCLUDED.task_run_id,
    updated_at = now()
`;

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// One task run per document, in parallel. runTask waits for each run to finish.
// allSettled keeps one failed run from stopping the rest.
const runs = await Promise.allSettled(
  documents.map((doc) =>
    render.workflows.runTask(`${SLUG}/extractDocument`, [doc], {
      // One idempotency key per document. If this script stops halfway and you
      // run it again within 24 hours, Render returns the runs it already started
      // instead of extracting those documents (and paying for the model) again.
      idempotencyKey: `extract-${doc.document_id}`,
    }),
  ),
);

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  for (const [i, outcome] of runs.entries()) {
    if (outcome.status === "rejected") {
      console.log(`${documents[i].document_id}: run failed: ${outcome.reason}`);
      continue;
    }
    // results is an array holding the task's return value.
    const run = outcome.value;
    const result = run.results[0] as ExtractionResult;
    // pg sends objects as JSON, but arrays as Postgres arrays, so stringify both.
    await db.query(UPSERT, [
      result.document_id,
      result.record === null ? null : JSON.stringify(result.record),
      JSON.stringify(result.exceptions),
      run.id,
    ]);
    const codes = result.exceptions.map((e) => e.code);
    console.log(`${result.document_id}: saved, exceptions: ${codes.length ? codes.join(", ") : "none"}`);
  }
} finally {
  await db.end();
}
