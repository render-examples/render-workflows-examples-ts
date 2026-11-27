/**
 * Resumable Postgres backfill on Render Workflows
 *
 * Fills a new column (orders.amount_usd_cents) across a large table, one keyset
 * chunk at a time. The backfill is a flow, and every chunk is a checkpointed step:
 *
 * - A chunk that fails (a dropped connection, a lock timeout) retries on its own.
 *   Chunks that already finished don't run again.
 * - If the instance running the flow fails, Render replays the flow on a new one.
 *   Finished chunks return their recorded results, and the run carries on from
 *   the first chunk that didn't finish.
 * - If a run ends without finishing (canceled, out of retries, timed out), a new
 *   run started with resumeFrom picks up after the last chunk it committed.
 *
 * Each chunk's write is idempotent (it only fills rows that are still NULL), so a
 * chunk that ran but never got recorded can safely run again.
 */
import { readFileSync } from "node:fs";
import { flow, task, type FlowContext, type Retry, type TaskContext } from "@renderinc/sdk/workflows";
import pg from "pg";

// Postgres bigint (int8) comes back as a string by default. Every bigint here
// (ids, counts, amounts) stays far below 2^53, so read them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf-8");

// Conversion to US cents, in millionths of a cent per minor unit. Integer math
// keeps the result identical across reruns and across the Python and
// TypeScript versions of this example. Static rates for the demo; a real
// backfill would read them from a rates table as of each order's date.
const USD_CENTS_PPM: Record<string, number> = {
  USD: 1_000_000, // 1 cent -> 1 cent
  EUR: 1_080_000,
  GBP: 1_270_000,
  CAD: 730_000,
  AUD: 660_000,
  JPY: 670_000, // 1 yen -> 0.67 cents
};

const MIN_CHUNK_SIZE = 100;
const MAX_CHUNK_SIZE = 50_000;
const MAX_SEED_ROWS = 2_000_000;

// A flow run can record up to 10,000 steps (render.com/docs/workflows-limits).
// The backfill uses one per chunk plus "plan" and "finish", so it checks the
// chunk count up front and leaves some headroom.
const MAX_CHUNKS = 9_900;

// Chunks talk to the database, so a failed chunk retries on its own. Earlier
// chunks don't rerun.
const CHUNK_RETRY: Retry = { maxRetries: 3, waitDurationMs: 2000, backoffScaling: 2 };
const DB_RETRY: Retry = { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 2 };

type ErrorResult = { error: string };
type Plan = {
  rows_total: number;
  rows_missing: number;
  start_after_id: number;
  rows_scanned: number;
  rows_updated: number;
};
type ChunkResult = {
  chunk: number;
  first_id?: number;
  last_id: number;
  scanned: number;
  updated: number;
  skipped: number;
};
type BackfillSummary = {
  flow_run_id: string;
  resumed_from: string | null;
  rows_total: number;
  rows_scanned: number;
  rows_updated: number;
  chunks: number;
  remaining_nulls: number;
};

// One connection per step, committed or rolled back as a unit. After a replay,
// a step can run in a new process, so it doesn't rely on state from earlier
// steps.
async function inTransaction<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
}

function toUsdCents(amountMinor: number, currency: string): number | null {
  const rate = USD_CENTS_PPM[currency];
  if (rate === undefined) return null;
  return Math.floor((amountMinor * rate + 500_000) / 1_000_000); // round half up
}

// ============================================================================
// Steps: plain functions the flow runs with ctx.step. They get no context, and
// their arguments and return values must be JSON-serializable.
// ============================================================================

/** Count the work, find where to start, and create this run's progress row. */
async function planBackfill(
  flowRunId: string,
  chunkSize: number,
  resumeFrom: string | null,
): Promise<Plan | ErrorResult> {
  const plan = await inTransaction<Plan | ErrorResult>(async (db) => {
    let startAfterId = 0;
    let rowsScanned = 0;
    let rowsUpdated = 0;
    if (resumeFrom) {
      const previous = await db.query(
        "SELECT last_id, rows_scanned, rows_updated FROM backfill_runs WHERE flow_run_id = $1",
        [resumeFrom],
      );
      if (previous.rows.length === 0) return { error: `no backfill run ${resumeFrom} to resume from` };
      ({ last_id: startAfterId, rows_scanned: rowsScanned, rows_updated: rowsUpdated } = previous.rows[0]);
    }

    const { rows } = await db.query(
      "SELECT count(*) AS total, count(*) FILTER (WHERE amount_usd_cents IS NULL) AS missing FROM orders",
    );
    const { total, missing } = rows[0];
    // ON CONFLICT: if this step runs again after a replay, keep the first row.
    await db.query(
      `INSERT INTO backfill_runs (flow_run_id, resumed_from, chunk_size, rows_total, rows_missing,
                                  last_id, rows_scanned, rows_updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (flow_run_id) DO NOTHING`,
      [flowRunId, resumeFrom, chunkSize, total, missing, startAfterId, rowsScanned, rowsUpdated],
    );
    return {
      rows_total: total,
      rows_missing: missing,
      start_after_id: startAfterId,
      rows_scanned: rowsScanned,
      rows_updated: rowsUpdated,
    };
  });
  if (!("error" in plan)) {
    console.log(
      `Planned ${flowRunId}: ${plan.rows_total} rows, ${plan.rows_missing} missing amount_usd_cents, ` +
        `starting after id ${plan.start_after_id}, chunks of ${chunkSize}`,
    );
  }
  return plan;
}

/**
 * Fill one keyset chunk: the next chunkSize rows with id > afterId.
 *
 * The chunk boundaries come from the primary key alone, so a chunk covers the
 * same rows every time it runs. The UPDATE only touches rows that are still
 * NULL, so running a chunk twice writes nothing the second time.
 */
async function backfillChunk(
  flowRunId: string,
  chunk: number,
  afterId: number,
  chunkSize: number,
  rowsTotal: number,
  rowsScanned: number,
  rowsUpdated: number,
  failChunk: number | null,
): Promise<ChunkResult> {
  const outcome = await inTransaction(async (db) => {
    // Don't queue behind app traffic for long. A lock timeout throws, and the
    // step retries.
    await db.query("SET LOCAL lock_timeout = '5s'");
    const { rows } = await db.query(
      "SELECT id, amount_minor, currency FROM orders WHERE id > $1 ORDER BY id LIMIT $2",
      [afterId, chunkSize],
    );
    if (rows.length === 0) return null;

    const lastId: number = rows[rows.length - 1].id;
    const ids: number[] = [];
    const values: number[] = [];
    let skipped = 0;
    for (const row of rows) {
      const usd = toUsdCents(row.amount_minor, row.currency);
      if (usd === null) {
        skipped += 1; // unknown currency: leave NULL, report it
        continue;
      }
      ids.push(row.id);
      values.push(usd);
    }

    const update = await db.query(
      `UPDATE orders AS o SET amount_usd_cents = v.usd
       FROM unnest($1::bigint[], $2::bigint[]) AS v(id, usd)
       WHERE o.id = v.id AND o.id > $3 AND o.id <= $4 AND o.amount_usd_cents IS NULL`,
      [ids, values, afterId, lastId],
    );
    const updated = update.rowCount ?? 0;

    const scannedSoFar = rowsScanned + rows.length;
    // Progress is set from totals the flow passes in, not incremented, so a
    // chunk that runs twice doesn't count its rows twice.
    await db.query(
      `UPDATE backfill_runs
       SET last_id = $1, chunks_done = $2, rows_scanned = $3, rows_updated = $4, updated_at = now()
       WHERE flow_run_id = $5`,
      [lastId, chunk + 1, scannedSoFar, rowsUpdated + updated, flowRunId],
    );

    let fail = false;
    if (failChunk === chunk) {
      // Fail at most once per run: the first attempt to get here claims it.
      const claim = await db.query(
        "UPDATE backfill_runs SET failed_once_at = now() WHERE flow_run_id = $1 AND failed_once_at IS NULL",
        [flowRunId],
      );
      fail = claim.rowCount === 1;
    }
    const result: ChunkResult = {
      chunk,
      first_id: rows[0].id,
      last_id: lastId,
      scanned: rows.length,
      updated,
      skipped,
    };
    return { result, scannedSoFar, fail };
  });
  // inTransaction committed the chunk's writes and its progress together.

  if (outcome === null) {
    return { chunk, last_id: afterId, scanned: 0, updated: 0, skipped: 0 };
  }
  const { result, scannedSoFar, fail } = outcome;
  if (fail) {
    // Fail after the chunk's writes committed, like a connection that drops
    // before the result gets back. The step retries, and the retry finds
    // nothing left to write in this chunk.
    throw new Error(`Simulated failure after chunk ${chunk} committed`);
  }

  const pct = rowsTotal ? ((100 * scannedSoFar) / rowsTotal).toFixed(1) : "100.0";
  console.log(
    `Chunk ${chunk}: ids ${result.first_id}-${result.last_id}, scanned ${result.scanned}, ` +
      `updated ${result.updated}, skipped ${result.skipped}. Progress ${scannedSoFar}/${rowsTotal} rows (${pct}%)`,
  );
  return result;
}

/** Check what's left and mark the run finished. */
async function finishBackfill(flowRunId: string): Promise<BackfillSummary> {
  return inTransaction(async (db) => {
    const remaining = await db.query("SELECT count(*) AS n FROM orders WHERE amount_usd_cents IS NULL");
    const { rows } = await db.query(
      `UPDATE backfill_runs SET finished_at = coalesce(finished_at, now()), updated_at = now()
       WHERE flow_run_id = $1
       RETURNING resumed_from, rows_total, rows_scanned, rows_updated, chunks_done`,
      [flowRunId],
    );
    const run = rows[0];
    return {
      flow_run_id: flowRunId,
      resumed_from: run.resumed_from,
      rows_total: run.rows_total,
      rows_scanned: run.rows_scanned,
      rows_updated: run.rows_updated,
      chunks: run.chunks_done,
      remaining_nulls: remaining.rows[0].n,
    };
  });
}

// ============================================================================
// The flow
// ============================================================================

/**
 * Backfill orders.amount_usd_cents in keyset chunks, one step per chunk.
 *
 * resumeFrom: the flow run ID of an earlier run that didn't finish. This run
 * starts after the last chunk that run committed.
 * failChunk: make that chunk fail once, after its writes commit, to watch the
 * step retry. Leave it null in real runs.
 */
export const backfillOrders = flow(
  { name: "backfillOrders", timeoutSeconds: 2 * 60 * 60 },
  async function backfillOrders(
    ctx: FlowContext,
    chunkSize: number = 5000,
    resumeFrom: string | null = null,
    failChunk: number | null = null,
  ): Promise<BackfillSummary | ErrorResult> {
    // Bad input can't be fixed by running again, so it comes back as a result.
    if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
      return { error: `chunkSize must be an integer between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}` };
    }
    if (!process.env.DATABASE_URL) return { error: "DATABASE_URL is not set" };

    // Flow code must be deterministic: it makes the same ctx.step calls in the
    // same order on every replay. All I/O happens inside steps.
    const runId = ctx.metadata.flowRunId;
    const plan = await ctx.step("plan", planBackfill, [runId, chunkSize, resumeFrom], { retry: DB_RETRY });
    if ("error" in plan) return plan;

    const rowsTotal = plan.rows_total;
    if (Math.ceil(rowsTotal / chunkSize) > MAX_CHUNKS) {
      return { error: `${rowsTotal} rows need more than ${MAX_CHUNKS} chunks; raise chunkSize` };
    }

    let chunk = 0;
    let afterId = plan.start_after_id;
    let rowsScanned = plan.rows_scanned;
    let rowsUpdated = plan.rows_updated;
    while (true) {
      // On a replay, finished chunks return their recorded result here without
      // touching the database. Await each step before starting the next.
      const result = await ctx.step(
        `chunk-${chunk}`,
        backfillChunk,
        [runId, chunk, afterId, chunkSize, rowsTotal, rowsScanned, rowsUpdated, failChunk],
        { retry: CHUNK_RETRY },
      );
      if (result.scanned === 0) break;
      chunk += 1;
      afterId = result.last_id;
      rowsScanned += result.scanned;
      rowsUpdated += result.updated;
      if (result.scanned < chunkSize) break; // a short chunk is the last one
    }

    return ctx.step("finish", finishBackfill, [runId], { retry: DB_RETRY });
  },
);

// ============================================================================
// Tasks: set up the demo table and read progress while a backfill runs
// ============================================================================

/**
 * Recreate the tables and fill orders with rowCount rows, amount_usd_cents NULL.
 * Drops any existing orders and backfill_runs tables, so a retry starts over
 * cleanly. Point DATABASE_URL at a database used only for this example.
 */
export const seedOrders = task(
  { name: "seedOrders", retry: DB_RETRY, timeoutSeconds: 900 },
  async function seedOrders(_ctx: TaskContext, rowCount: number = 200_000): Promise<{ rows: number } | ErrorResult> {
    if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > MAX_SEED_ROWS) {
      return { error: `rowCount must be an integer between 1 and ${MAX_SEED_ROWS}` };
    }
    if (!process.env.DATABASE_URL) return { error: "DATABASE_URL is not set" };

    await inTransaction(async (db) => {
      await db.query("DROP TABLE IF EXISTS orders, backfill_runs");
      await db.query(SCHEMA);
      await db.query(
        `INSERT INTO orders (amount_minor, currency, created_at)
         SELECT 100 + (g::bigint * 7919) % 500000,
                (ARRAY['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'])[1 + g % 6],
                now() - make_interval(mins => g)
         FROM generate_series(1, $1::int) AS g`,
        [rowCount],
      );
      // Refresh planner statistics after the bulk load, so the chunk queries
      // get index plans from the first chunk on.
      await db.query("ANALYZE orders");
    });
    console.log(`Seeded ${rowCount} orders`);
    return { rows: rowCount };
  },
);

/** Progress of a backfill run (the latest one if flowRunId is omitted). */
export const backfillStatus = task(
  { name: "backfillStatus", retry: DB_RETRY, timeoutSeconds: 60 },
  async function backfillStatus(_ctx: TaskContext, flowRunId: string | null = null) {
    if (!process.env.DATABASE_URL) return { error: "DATABASE_URL is not set" };

    return inTransaction(async (db) => {
      const { rows } = await db.query(
        `SELECT flow_run_id, resumed_from, chunk_size, rows_total, rows_scanned, rows_updated,
                chunks_done, last_id, failed_once_at, started_at, updated_at, finished_at
         FROM backfill_runs
         WHERE flow_run_id = coalesce($1, flow_run_id)
         ORDER BY started_at DESC
         LIMIT 1`,
        [flowRunId],
      );
      const remaining = (await db.query("SELECT count(*) AS n FROM orders WHERE amount_usd_cents IS NULL")).rows[0].n;
      if (rows.length === 0) return { error: "no backfill run found", remaining_nulls: remaining };
      const run = rows[0];
      return {
        ...run,
        percent: run.rows_total ? Math.round((1000 * run.rows_scanned) / run.rows_total) / 10 : 100,
        remaining_nulls: remaining,
      };
    });
  },
);
