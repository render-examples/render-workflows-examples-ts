/**
 * AI chat turns: the workflow service
 *
 * Each chat turn runs as one task run. The API service stores the user's message
 * and starts runTurn with the message's ID. runTurn loads the conversation from
 * Postgres, runs a support agent built with the OpenAI Agents SDK, and writes the
 * reply back to Postgres.
 */
import { createHash } from "node:crypto";
import {
  Agent,
  MaxTurnsExceededError,
  assistant,
  run,
  setDefaultOpenAIClient,
  tool,
  user,
} from "@openai/agents";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import OpenAI from "openai";
import { z } from "zod";
import { db } from "./db.js";

// Read the model from the environment so a retired model is a config change,
// not a code change.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-6.2-sol";
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? "8");

// OpenAI errors that mean the request itself is wrong. A retry can't fix
// them, so runTurn returns them as a result instead of throwing.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 422]);

// ---- Sample data the read-only tools use. In production, query your database. ----

const ORDERS: Record<string, { status: string; amount: number; times_charged: number }> = {
  "ORD-2001": { status: "delivered", amount: 49.0, times_charged: 2 },
  "ORD-2002": { status: "processing", amount: 120.0, times_charged: 1 },
  "ORD-2003": { status: "shipped", amount: 15.5, times_charged: 1 },
};

const ACCOUNTS: Record<string, Record<string, string | number>> = {
  "ACC-100": { plan: "pro", standing: "good", balance_due: 0.0 },
  "ACC-200": { plan: "starter", standing: "good", balance_due: 0.0 },
  "ACC-300": { plan: "pro", standing: "past_due", balance_due: 79.0 },
};

// What the tools need to know about the turn they run in.
type TurnContext = { conversationId: string; messageId: number };

const lookupOrder = tool({
  name: "lookup_order",
  description: "Look up an order's status, amount, and how many times it was charged.",
  parameters: z.object({ order_id: z.string().describe("The order ID, such as ORD-2001.") }),
  execute: async ({ order_id }) => JSON.stringify(ORDERS[order_id] ?? { error: `No order ${order_id}` }),
});

const getAccountStatus = tool({
  name: "get_account_status",
  description: "Look up an account's plan, standing, and balance due.",
  parameters: z.object({ account_id: z.string().describe("The account ID, such as ACC-100.") }),
  execute: async ({ account_id }) =>
    JSON.stringify(ACCOUNTS[account_id] ?? { error: `No account ${account_id}` }),
});

const openRefundRequest = tool({
  name: "open_refund_request",
  description:
    "Open a refund request for an order. If one is already open for the order in this " +
    "conversation, this reports it instead of opening another.",
  parameters: z.object({
    order_id: z.string().describe("The order ID to refund, such as ORD-2001."),
    reason: z.string().describe("Why the customer should get a refund."),
  }),
  execute: async ({ order_id, reason }, runContext) => {
    const turn = runContext!.context as TurnContext;
    // Derive the key from the conversation and the order, not the reason text:
    // a retried turn may phrase the reason differently, and a later message
    // ("is my refund open?") may call the tool again. Both find the request
    // that's already open.
    const key = createHash("sha256").update(`${turn.conversationId}:refund:${order_id}`).digest("hex");
    const { rowCount } = await db().query(
      `INSERT INTO refund_requests (idempotency_key, conversation_id, message_id, order_id, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, turn.conversationId, turn.messageId, order_id, reason],
    );
    return JSON.stringify({ order_id, refund_request: rowCount ? "opened" : "already open" });
  },
});

const supportAgent = new Agent<TurnContext>({
  name: "Support",
  instructions:
    "You are a customer support agent in a chat. Use the tools to check orders " +
    "and accounts before you answer. Open a refund request only when the customer " +
    "was charged in error or an order can't be delivered. Keep replies short.",
  tools: [lookupOrder, getAccountStatus, openRefundRequest],
  model: MODEL,
});

type TurnResult =
  | { message_id: number; reply_id: number; reply: string }
  | { message_id: number; error: string };

// ---- Task ----

// runTurn calls the OpenAI API, so it retries once if an attempt fails. A retry
// reruns the agent, which is safe: the reply insert and the refund tool are
// both idempotent.
task(
  {
    name: "runTurn",
    retry: { maxRetries: 1, waitDurationMs: 1000, backoffScaling: 2 },
    timeoutSeconds: 120,
  },
  async function runTurn(_ctx: TaskContext, conversationId: string, messageId: number): Promise<TurnResult> {
    console.log(`[TURN] conversation ${conversationId}, message ${messageId}`);

    // A previous attempt may have stored the reply before failing to report it.
    // Return that reply instead of answering twice.
    const existing = await db().query("SELECT id, content FROM messages WHERE reply_to = $1", [messageId]);
    if (existing.rows[0]) {
      return { message_id: messageId, reply_id: Number(existing.rows[0].id), reply: existing.rows[0].content };
    }

    const history = await db().query(
      `SELECT role, content FROM messages
       WHERE conversation_id = $1 AND id <= $2
         AND (role = 'assistant' OR status = 'done' OR id = $2)
       ORDER BY id`,
      [conversationId, messageId],
    );

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { message_id: messageId, error: "OPENAI_API_KEY is not set" };

    // Render retries this task, so turn off the OpenAI client's own retries.
    setDefaultOpenAIClient(new OpenAI({ apiKey, maxRetries: 0 }));

    let result;
    try {
      result = await run(
        supportAgent,
        history.rows.map((m) => (m.role === "user" ? user(m.content) : assistant(m.content))),
        { context: { conversationId, messageId }, maxTurns: MAX_TURNS },
      );
    } catch (error) {
      if (error instanceof MaxTurnsExceededError) {
        return { message_id: messageId, error: `Hit the limit of ${MAX_TURNS} agent turns` };
      }
      if (error instanceof OpenAI.APIError && PERMANENT_ERROR_STATUSES.has(error.status ?? 0)) {
        return { message_id: messageId, error: `OpenAI error ${error.status}: ${error.message}` };
      }
      throw error;
    }

    // The unique index on reply_to makes this a no-op if a reply exists.
    let reply = String(result.finalOutput ?? "");
    const inserted = await db().query(
      `INSERT INTO messages (conversation_id, role, content, reply_to)
       VALUES ($1, 'assistant', $2, $3)
       ON CONFLICT (reply_to) WHERE reply_to IS NOT NULL DO NOTHING
       RETURNING id`,
      [conversationId, reply, messageId],
    );
    let replyId = inserted.rows[0]?.id;
    if (replyId === undefined) {
      const row = (await db().query("SELECT id, content FROM messages WHERE reply_to = $1", [messageId])).rows[0];
      replyId = row.id;
      reply = row.content;
    }

    console.log(`[TURN] message ${messageId} answered by reply ${replyId}`);
    return { message_id: messageId, reply_id: Number(replyId), reply };
  },
);
