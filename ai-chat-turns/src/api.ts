/**
 * AI chat turns: the API service
 *
 * An Express app that stores chat messages in Postgres and runs each turn as a
 * workflow task:
 *
 * 1. POST a message. The API stores it, claims the conversation so only one turn
 *    runs at a time, starts runTurn, and returns 202.
 * 2. runTurn (in the workflow service) writes the reply to Postgres.
 * 3. The API waits for the run to finish, then marks the message done or failed
 *    and releases the claim.
 * 4. GET the conversation to read the reply.
 */
import { ClientError, Render } from "@renderinc/sdk";
import express from "express";
import { applySchema, db } from "./db.js";

const SLUG = process.env.WORKFLOW_SLUG ?? "ai-chat-turns";
const PORT = Number(process.env.PORT ?? "8000");
const TERMINAL = new Set(["completed", "failed", "canceled"]);

// Reads RENDER_API_KEY (or RENDER_USE_LOCAL_DEV for the local task server).
const render = new Render();

type RunDetails = Awaited<ReturnType<typeof render.workflows.getTaskRun>>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Turn lifecycle ----

async function startTurn(conversationId: string, messageId: number, clientMessageId: string): Promise<string> {
  // The idempotency key comes from the message, so starting the same turn twice
  // within 24 hours returns the first run instead of a second one.
  const run = await render.workflows.startTask(`${SLUG}/runTurn`, [conversationId, messageId], {
    idempotencyKey: `turn:${conversationId}:${clientMessageId}`,
  });
  await db().query("UPDATE messages SET status = 'running', task_run_id = $1 WHERE id = $2", [
    run.taskRunId,
    messageId,
  ]);
  void finishWhenDone(conversationId, messageId, run.taskRunId);
  return run.taskRunId;
}

async function finishWhenDone(conversationId: string, messageId: number, taskRunId: string): Promise<void> {
  // The events stream sends one event per run, when it reaches a terminal
  // status. It doesn't stream partial output.
  try {
    for await (const details of render.workflows.taskRunEvents([taskRunId])) {
      if (details.id === taskRunId) return finish(conversationId, messageId, details);
    }
  } catch (error) {
    console.warn(`[API] Lost the event stream for ${taskRunId} (${error}); polling instead`);
  }
  for (;;) {
    let details: RunDetails;
    try {
      details = await render.workflows.getTaskRun(taskRunId);
    } catch (error) {
      if (error instanceof ClientError && error.statusCode === 404) {
        return settleLostRun(conversationId, messageId, taskRunId);
      }
      console.warn(`[API] Couldn't check ${taskRunId} (${error}); retrying`);
      await sleep(5000);
      continue;
    }
    if (TERMINAL.has(details.status)) return finish(conversationId, messageId, details);
    await sleep(2000);
  }
}

async function finish(conversationId: string, messageId: number, details: RunDetails): Promise<void> {
  const result = (details.results?.[0] ?? null) as { error?: string } | null;
  if (details.status === "completed" && result && !result.error) {
    return record(conversationId, messageId, "done");
  }
  if (result?.error) return record(conversationId, messageId, "failed", result.error);
  return record(conversationId, messageId, "failed", `Run ${details.status}`);
}

async function replyExists(messageId: number): Promise<boolean> {
  const { rowCount } = await db().query("SELECT 1 FROM messages WHERE reply_to = $1", [messageId]);
  return Boolean(rowCount);
}

// Render has no record of the run, so go by what's in the database.
async function settleLostRun(conversationId: string, messageId: number, taskRunId: string): Promise<void> {
  if (await replyExists(messageId)) return record(conversationId, messageId, "done");
  return record(conversationId, messageId, "failed", `Run ${taskRunId} not found`);
}

// Mark the message done or failed and release the conversation.
async function record(conversationId: string, messageId: number, status: string, error: string | null = null) {
  console.log(`[API] Message ${messageId}: ${status}`);
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE messages SET status = $1, error = $2 WHERE id = $3", [status, error, messageId]);
    await client.query(
      "UPDATE conversations SET active_message_id = NULL WHERE id = $1 AND active_message_id = $2",
      [conversationId, messageId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Undo a message whose turn never started, so the client can resend it.
async function abandon(conversationId: string, messageId: number): Promise<void> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    // Only this request's own row, and never one that has a reply.
    await client.query(
      "DELETE FROM messages WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM messages WHERE reply_to = $1)",
      [messageId],
    );
    await client.query(
      "UPDATE conversations SET active_message_id = NULL WHERE id = $1 AND active_message_id = $2",
      [conversationId, messageId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Pick up turns that were running when this process last stopped. A deploy or
// restart stops this process mid-turn. The turn itself keeps running on Render;
// this finds it and finishes the bookkeeping.
async function reconcile(): Promise<void> {
  const { rows } = await db().query(
    `SELECT c.id AS conversation_id, m.id AS message_id, m.task_run_id, m.client_message_id
     FROM conversations c JOIN messages m ON m.id = c.active_message_id`,
  );
  for (const row of rows) {
    const messageId = Number(row.message_id);
    if (await replyExists(messageId)) {
      // The turn finished, but this process stopped before recording it.
      await record(row.conversation_id, messageId, "done");
    } else if (!row.task_run_id) {
      // Stopped before the start went through, or before it was saved. Starting
      // again is safe: the idempotency key returns the first run.
      await startTurn(row.conversation_id, messageId, row.client_message_id);
    } else {
      void finishWhenDone(row.conversation_id, messageId, row.task_run_id);
    }
  }
  if (rows.length) console.log(`[API] Reconciled ${rows.length} running turn(s)`);
}

// ---- Routes ----

const app = express();
app.use(express.json());

app.post("/conversations/:conversationId/messages", async (req, res) => {
  const { conversationId } = req.params;
  const { client_message_id: clientMessageId, content } = req.body ?? {};
  if (typeof clientMessageId !== "string" || !clientMessageId || typeof content !== "string" || !content) {
    res.status(422).json({ detail: "client_message_id and content are required strings" });
    return;
  }

  const client = await db().connect();
  let messageId: number;
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO conversations (id) VALUES ($1) ON CONFLICT DO NOTHING", [conversationId]);
    const inserted = await client.query(
      `INSERT INTO messages (conversation_id, role, content, client_message_id, status)
       VALUES ($1, 'user', $2, $3, 'pending')
       ON CONFLICT (conversation_id, client_message_id) DO NOTHING
       RETURNING id`,
      [conversationId, content, clientMessageId],
    );

    if (!inserted.rows[0]) {
      // The client resent a message we already have (a retry after a timeout,
      // say). Report it instead of starting a second turn.
      const existing = (
        await client.query(
          "SELECT id, status, task_run_id FROM messages WHERE conversation_id = $1 AND client_message_id = $2",
          [conversationId, clientMessageId],
        )
      ).rows[0];
      await client.query("COMMIT");
      res.status(200).json({
        message_id: Number(existing.id),
        status: existing.status,
        task_run_id: existing.task_run_id,
        duplicate: true,
      });
      return;
    }

    messageId = Number(inserted.rows[0].id);
    const claimed = await client.query(
      "UPDATE conversations SET active_message_id = $1 WHERE id = $2 AND active_message_id IS NULL RETURNING id",
      [messageId, conversationId],
    );
    if (!claimed.rowCount) {
      // Another turn is running. Rolling back removes only the message this
      // request inserted.
      await client.query("ROLLBACK");
      res.status(409).json({
        detail: "A turn is already running in this conversation. Send again when it finishes.",
      });
      return;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  try {
    const taskRunId = await startTurn(conversationId, messageId, clientMessageId);
    res.status(202).json({ message_id: messageId, status: "running", task_run_id: taskRunId });
  } catch (error) {
    console.error(`[API] Couldn't start the turn for message ${messageId}:`, error);
    await abandon(conversationId, messageId);
    res.status(503).json({ detail: "Couldn't start the turn. Send the message again." });
  }
});

app.get("/conversations/:conversationId/messages", async (req, res) => {
  const { conversationId } = req.params;
  const conversation = (
    await db().query("SELECT active_message_id FROM conversations WHERE id = $1", [conversationId])
  ).rows[0];
  if (!conversation) {
    res.status(404).json({ detail: "No such conversation" });
    return;
  }
  const { rows } = await db().query(
    `SELECT id, role, content, status, error, reply_to, created_at
     FROM messages WHERE conversation_id = $1 ORDER BY id`,
    [conversationId],
  );
  res.json({
    conversation_id: conversationId,
    turn_running: conversation.active_message_id !== null,
    messages: rows.map((m) => ({ ...m, id: Number(m.id), reply_to: m.reply_to === null ? null : Number(m.reply_to) })),
  });
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

await applySchema();
await reconcile();
app.listen(PORT, () => console.log(`[API] Listening on port ${PORT}`));
