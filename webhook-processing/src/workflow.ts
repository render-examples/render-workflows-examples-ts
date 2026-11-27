/**
 * Webhook processing: the workflow service
 *
 * Two tasks:
 *
 * - processDelivery applies one stored GitHub delivery to the repo_activity
 *   table. It retries on failure, and it applies each delivery at most once:
 *   the counters and the "processed" mark commit in one transaction.
 * - replayPending finds deliveries that were stored but never processed (the
 *   task server was down, or every attempt failed) and processes them again.
 *
 * The receiver (src/receiver.ts) stores each delivery and starts processDelivery.
 */
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import type pg from "pg";
import { applySchema, db } from "./db.js";

type Payload = {
  action?: string;
  ref?: string;
  commits?: unknown[];
  issue?: { title?: string };
  repository?: { full_name?: string };
};

type Summary = Record<string, unknown>;

let schemaApplied = false;

/** Return the pool, and create the tables on first use in this process. */
async function connect(): Promise<pg.Pool> {
  if (!schemaApplied) {
    await applySchema();
    schemaApplied = true;
  }
  return db();
}

/** Add one event to its repository's counters. Returns what changed. */
async function applyEvent(client: pg.PoolClient, event: string, payload: Payload): Promise<Summary> {
  const repo = payload.repository?.full_name;
  if (!repo) return { event, counted: false, note: "No repository in the payload" };

  if (event === "push") {
    const commits = payload.commits?.length ?? 0;
    await client.query(
      `INSERT INTO repo_activity (repo, pushes, commits) VALUES ($1, 1, $2)
       ON CONFLICT (repo) DO UPDATE SET
         pushes = repo_activity.pushes + 1,
         commits = repo_activity.commits + EXCLUDED.commits,
         updated_at = now()`,
      [repo, commits],
    );
    return { repo, event: "push", ref: payload.ref, commits };
  }

  if (event === "issues" && (payload.action === "opened" || payload.action === "closed")) {
    const column = payload.action === "opened" ? "issues_opened" : "issues_closed";
    await client.query(
      `INSERT INTO repo_activity (repo, ${column}) VALUES ($1, 1)
       ON CONFLICT (repo) DO UPDATE SET
         ${column} = repo_activity.${column} + 1,
         updated_at = now()`,
      [repo],
    );
    return { repo, event: "issues", action: payload.action, counted: true };
  }

  // Other issue actions (edited, labeled, ...) change no counter.
  return { repo, event, action: payload.action, counted: false };
}

/** Demo switch: fail the first attempt for an issue titled "[fail-once] ...". */
function failOnPurpose(event: string, payload: Payload, attempts: number): boolean {
  return event === "issues" && (payload.issue?.title ?? "").includes("[fail-once]") && attempts === 1;
}

// processDelivery may retry: its writes commit together with the "processed"
// mark, so an attempt that fails leaves nothing behind and the next attempt
// starts clean. Each attempt gets its own 60 seconds.
const processDelivery = task(
  {
    name: "processDelivery",
    retry: { maxRetries: 3, waitDurationMs: 2000, backoffScaling: 2 },
    timeoutSeconds: 60,
  },
  async function processDelivery(_ctx: TaskContext, deliveryId: string): Promise<Summary> {
    // A retry can't fix a missing setting, so return it instead of throwing.
    if (!process.env.DATABASE_URL) return { delivery_id: deliveryId, error: "DATABASE_URL is not set" };

    // Connection errors throw, so Render retries the attempt.
    const pool = await connect();

    // Count the attempt on its own, so the count survives a failed attempt.
    const counted = await pool.query(
      "UPDATE webhook_deliveries SET attempts = attempts + 1 WHERE delivery_id = $1 RETURNING attempts",
      [deliveryId],
    );
    if (counted.rowCount === 0) return { delivery_id: deliveryId, error: "No such delivery" };
    const attempts: number = counted.rows[0].attempts;

    const client = await pool.connect();
    let summary: Summary;
    try {
      await client.query("BEGIN");
      // FOR UPDATE: if two runs process the same delivery at once, the second
      // waits here and then sees it's already processed.
      const { rows } = await client.query(
        "SELECT event, payload, status FROM webhook_deliveries WHERE delivery_id = $1 FOR UPDATE",
        [deliveryId],
      );
      const delivery = rows[0];
      if (delivery.status === "processed") {
        await client.query("COMMIT");
        console.log(`[PROCESS] ${deliveryId} already processed`);
        return { delivery_id: deliveryId, status: "duplicate" };
      }

      summary = await applyEvent(client, delivery.event, delivery.payload);

      // Stands in for a downstream call that fails for a moment. Throwing
      // here rolls back the counters above, so the retry doesn't count the
      // event twice.
      if (failOnPurpose(delivery.event, delivery.payload, attempts)) {
        throw new Error("Failed on purpose on the first attempt ([fail-once])");
      }

      await client.query(
        `UPDATE webhook_deliveries
         SET status = 'processed', processed_at = now(), result = $1, last_error = NULL
         WHERE delivery_id = $2`,
        [JSON.stringify(summary), deliveryId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      // Keep the error next to the delivery, then throw so Render retries.
      const message = error instanceof Error ? error.message : String(error);
      await pool
        .query("UPDATE webhook_deliveries SET last_error = $1 WHERE delivery_id = $2", [
          message.slice(0, 500),
          deliveryId,
        ])
        .catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    console.log(`[PROCESS] ${deliveryId} processed on attempt ${attempts}:`, summary);
    return { delivery_id: deliveryId, status: "processed", attempts, ...summary };
  },
);

// replayPending only starts subtasks, so it doesn't retry: a retry would start
// every subtask again. Each processDelivery retries on its own.
task(
  {
    name: "replayPending",
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 900,
  },
  async function replayPending(ctx: TaskContext, olderThanMinutes = 10, limit = 100) {
    if (!process.env.DATABASE_URL) return { error: "DATABASE_URL is not set" };

    // Skip recent deliveries: their first run may still be going.
    const pool = await connect();
    const { rows } = await pool.query(
      `SELECT delivery_id FROM webhook_deliveries
       WHERE status = 'pending' AND received_at < now() - make_interval(mins => $1)
       ORDER BY received_at
       LIMIT $2`,
      [olderThanMinutes, limit],
    );
    const deliveryIds: string[] = rows.map((row) => row.delivery_id);

    console.log(`[REPLAY] ${deliveryIds.length} pending deliveries`);
    // ctx.run starts each delivery as its own task run, with its own retries.
    const outcomes = await Promise.allSettled(deliveryIds.map((id) => ctx.run(processDelivery, id)));

    const processed: Summary[] = [];
    const failed: Summary[] = [];
    outcomes.forEach((outcome, i) => {
      const deliveryId = deliveryIds[i];
      if (outcome.status === "rejected") {
        failed.push({ delivery_id: deliveryId, error: String(outcome.reason?.message ?? outcome.reason) });
      } else if ("error" in outcome.value) {
        failed.push({ delivery_id: deliveryId, error: outcome.value.error });
      } else {
        processed.push({ delivery_id: deliveryId, status: outcome.value.status });
      }
    });
    return { pending: deliveryIds.length, processed, failed };
  },
);
