/**
 * Idempotent side effects on Render Workflows
 *
 * A refund flow for support tickets. An LLM reads the ticket and drafts a
 * decision, then the workflow issues a refund credit. The LLM call can be
 * retried as often as needed. The credit must happen once.
 *
 * Render retries a task when an attempt fails, and a retry runs the task again
 * from the top. If an attempt fails after the credit was written, a naive retry
 * writes it again. This example keeps that from happening in two ways:
 *
 * 1. The LLM call and the credit are separate tasks. A retry of one never
 *    reruns the other.
 * 2. The credit is written with an idempotency key derived from the business
 *    input (account and order), with INSERT ... ON CONFLICT DO NOTHING. A retry
 *    finds the credit the failed attempt wrote and doesn't write another.
 *
 * Pass true as handleRefund's second argument to fail issueCredit once, right
 * after the credit is written, and watch the retry skip it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import pg from "pg";
import { z } from "zod";

// Read the model from the environment so a retired model is a config change,
// not a code change.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-6.2-sol";

// OpenAI errors that mean the request itself is wrong: unknown model, bad key,
// invalid input. A retry can't fix them, so draftRefund returns them as a
// result instead of throwing.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 422]);

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf-8");

type Ticket = {
  id: string;
  account_id: string;
  order_id: string | null;
  subject: string;
  body: string;
};

type Order = { status: string; amount_cents: number; times_charged: number };

// ---- Sample orders. In production, read these from your database. The credit
// amount comes from here, not from the model. ----

const ORDERS: Record<string, Order> = {
  "ORD-2001": { status: "delivered", amount_cents: 4900, times_charged: 2 },
  "ORD-2002": { status: "processing", amount_cents: 12000, times_charged: 1 },
  "ORD-2003": { status: "shipped", amount_cents: 1550, times_charged: 1 },
};

// What the model drafts for a ticket.
const RefundDraft = z.object({
  refund: z.boolean(),
  reason: z.string(),
  customer_message: z.string(),
});

type DraftResult = ({ ticket_id: string } & z.infer<typeof RefundDraft>) | { ticket_id: string; error: string };

type CreditResult =
  | {
      order_id: string;
      idempotency_key: string;
      status: "issued" | "already_issued";
      amount_cents: number;
      credits_for_order: number;
    }
  | { order_id: string; error: string };

// ---- Database ----

let pool: pg.Pool | undefined;
let schemaApplied = false;

// A pool runs each query in its own transaction, so a credit written before a
// failure stays written, like a real payment would. The table is created on
// first use in this process.
async function db(): Promise<pg.Pool> {
  if (!pool) pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  if (!schemaApplied) {
    await pool.query(SCHEMA);
    schemaApplied = true;
  }
  return pool;
}

/**
 * The idempotency key for a refund credit.
 *
 * Built from the business input, never from the run ID or attempt: every
 * attempt and every run for the same account and order gets the same key.
 * One credit per account and order is the business rule here. If an order can
 * get several credits, add what tells them apart (a charge ID, say).
 */
function creditKey(accountId: string, orderId: string): string {
  return createHash("sha256").update(`${accountId}:refund:${orderId}`).digest("hex");
}

// ---- Tasks ----

// draftRefund calls the OpenAI API, so it retries if an attempt fails. It only
// reads, so a retry costs another model call and nothing else.
const draftRefund = task(
  {
    name: "draftRefund",
    retry: { maxRetries: 2, waitDurationMs: 1000, backoffScaling: 2 },
    timeoutSeconds: 60,
  },
  async function draftRefund(_ctx: TaskContext, ticket: Ticket, order: Order): Promise<DraftResult> {
    const ticketId = ticket.id ?? "unknown";
    console.log(`[DRAFT] ${ticketId}: ${ticket.subject}`);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // A setup problem a retry can't fix, so return it instead of throwing.
      return { ticket_id: ticketId, error: "OPENAI_API_KEY is not set" };
    }

    // Render retries this task, so turn off the OpenAI client's own retries to
    // keep one retry policy in charge.
    const client = new OpenAI({ apiKey, maxRetries: 0 });

    let response;
    try {
      response = await client.responses.parse({
        model: MODEL,
        instructions:
          "You review support tickets for a refund credit. Approve one only " +
          "when the order data shows the customer was charged more than once, " +
          "or the order can't be delivered. Write a short customer_message " +
          "that tells the customer what happens next. Don't state an amount.",
        input:
          `Ticket ${ticketId} from account ${ticket.account_id}\n` +
          `Subject: ${ticket.subject}\n\n${ticket.body}\n\n` +
          `Order ${ticket.order_id}: ${JSON.stringify(order)}`,
        text: { format: zodTextFormat(RefundDraft, "refund_draft") },
      });
    } catch (error) {
      if (error instanceof OpenAI.APIError && PERMANENT_ERROR_STATUSES.has(error.status ?? 0)) {
        console.error(`[DRAFT] ${ticketId}: OpenAI error ${error.status}, not retrying`);
        return { ticket_id: ticketId, error: `OpenAI error ${error.status}: ${error.message}` };
      }
      throw error;
    }

    const draft = response.output_parsed;
    if (!draft) {
      // No parsed output, for example a refusal. Throw so Render retries.
      throw new Error(`${ticketId}: the model returned no draft`);
    }

    console.log(`[DRAFT] ${ticketId}: refund=${draft.refund}`);
    return { ticket_id: ticketId, ...draft };
  },
);

// issueCredit is the side effect. It retries, which is safe only because the
// write is idempotent: every attempt uses the same key, and the insert does
// nothing if a credit with that key exists. The other safe choice is no
// retries at all (maxRetries: 0), which means a failed credit stays failed
// until someone looks at it.
const issueCredit = task(
  {
    name: "issueCredit",
    retry: { maxRetries: 2, waitDurationMs: 1000, backoffScaling: 2 },
    timeoutSeconds: 30,
  },
  async function issueCredit(
    ctx: TaskContext,
    accountId: string,
    orderId: string,
    amountCents: number,
    customerMessage: string,
    failAfterCredit = false,
  ): Promise<CreditResult> {
    if (!process.env.DATABASE_URL) return { order_id: orderId, error: "DATABASE_URL is not set" };

    const key = creditKey(accountId, orderId);
    const runId = ctx.metadata.taskRunId ?? null;
    const conn = await db();

    const { rowCount } = await conn.query(
      `INSERT INTO refund_credits
         (idempotency_key, account_id, order_id, amount_cents, customer_message, task_run_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, accountId, orderId, amountCents, customerMessage, runId],
    );
    const issued = rowCount === 1;
    console.log(
      `[CREDIT] run ${runId}: ${issued ? "issued" : "already issued, skipped"} ` +
        `credit for ${orderId} (key ${key.slice(0, 12)})`,
    );

    // The demo switch. Fail right after the credit is written, but only on the
    // attempt that wrote it, so the retry can succeed.
    if (failAfterCredit && issued) {
      console.warn(`[CREDIT] run ${runId}: failing on purpose after the credit`);
      throw new Error("Failed on purpose after issuing the credit (failAfterCredit)");
    }

    // If the credit goes through a payment provider instead, pass the same key
    // to the provider. Stripe, for example, reads it from the Idempotency-Key
    // header and replays the first response for a repeated key. With
    // stripe-node:
    //   await stripe.refunds.create(
    //     { payment_intent: paymentIntentId, amount: amountCents },
    //     { idempotencyKey: key },
    //   );

    const count = await conn.query(
      "SELECT count(*)::int AS n FROM refund_credits WHERE account_id = $1 AND order_id = $2",
      [accountId, orderId],
    );

    return {
      order_id: orderId,
      idempotency_key: key,
      status: issued ? "issued" : "already_issued",
      amount_cents: amountCents,
      credits_for_order: count.rows[0].n,
    };
  },
);

// handleRefund only orchestrates, so it doesn't retry: a retry would rerun the
// model call and the credit. Each subtask retries on its own.
task(
  {
    name: "handleRefund",
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 300,
  },
  async function handleRefund(ctx: TaskContext, ticket: Ticket, failAfterCredit = false) {
    const ticketId = ticket.id ?? "unknown";
    const order = ORDERS[ticket.order_id ?? ""];
    if (!order) {
      // Bad input. A retry can't fix it.
      return { ticket_id: ticketId, error: `No known order on ticket ${ticketId}` };
    }

    // ctx.run starts each step as its own task run with its own retries.
    const draft = await ctx.run(draftRefund, ticket, order);
    if ("error" in draft) return { ticket_id: ticketId, error: draft.error };
    if (!draft.refund) return { ticket_id: ticketId, decision: "no_refund", draft };

    const credit = await ctx.run(
      issueCredit,
      ticket.account_id,
      ticket.order_id!,
      order.amount_cents,
      draft.customer_message,
      failAfterCredit,
    );
    if ("error" in credit) return { ticket_id: ticketId, error: credit.error };

    return { ticket_id: ticketId, decision: "refund", draft, credit };
  },
);
