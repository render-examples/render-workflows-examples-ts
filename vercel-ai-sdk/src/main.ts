/**
 * Vercel AI SDK on Render Workflows
 *
 * A support-ticket triage agent built with the Vercel AI SDK, running inside a
 * workflow task. The AI SDK runs the tool loop (model calls and tool calls)
 * within one task run. Render runs that task, retries it, and fans it out
 * across many tickets.
 *
 * The AI SDK is provider-agnostic. To use another provider, swap the
 * @ai-sdk/openai import below for that provider's package (for example
 * @ai-sdk/anthropic) and change the model ID. The tools, loop, and tasks stay
 * the same.
 */
import { openai } from "@ai-sdk/openai";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { APICallError, isStepCount, Output, RetryError, tool, ToolLoopAgent } from "ai";
import { z } from "zod";

// Read the model from the environment so a retired model is a config change,
// not a code change.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-6.2-sol";

// Upper bound on loop steps per ticket, so an agent that keeps calling tools
// can't run forever. Each model call is one step, including the last one that
// writes the structured result.
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? "6");

// Provider errors that mean the request itself is wrong: unknown model, bad key,
// invalid input. A retry can't fix them, so triageTicket returns them as a
// result instead of throwing.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 422]);

type Ticket = {
  id: string;
  account_id: string;
  order_id: string | null;
  subject: string;
  body: string;
};

// ---- Sample data the tools read. In production these would query your database. ----

const ORDERS: Record<string, { status: string; amount: number; times_charged: number }> = {
  "ORD-2001": { status: "delivered", amount: 49.0, times_charged: 2 },
  "ORD-2002": { status: "processing", amount: 120.0, times_charged: 1 },
  "ORD-2003": { status: "shipped", amount: 15.5, times_charged: 1 },
};

const ACCOUNTS: Record<string, Record<string, string | number>> = {
  "ACC-100": { plan: "pro", standing: "good", balance_due: 0.0 },
  "ACC-200": { plan: "starter", standing: "good", balance_due: 0.0 },
  "ACC-300": { plan: "pro", standing: "past_due", balance_due: 79.0, card_on_file: "expired" },
};

// ---- Tools. Both only read data, so rerunning the agent on a retry is safe. ----

const lookupOrder = tool({
  description: "Look up an order's status, amount, and how many times it was charged.",
  inputSchema: z.object({
    order_id: z.string().describe("The order ID, such as ORD-2001."),
  }),
  execute: async ({ order_id }) => ORDERS[order_id] ?? { error: `No order ${order_id}` },
});

const getAccountStatus = tool({
  description: "Look up an account's plan, standing, and balance due.",
  inputSchema: z.object({
    account_id: z.string().describe("The account ID, such as ACC-100."),
  }),
  execute: async ({ account_id }) => ACCOUNTS[account_id] ?? { error: `No account ${account_id}` },
});

// ---- Agent ----

// The structured result the agent returns for a ticket. category picks the team.
const Resolution = z.object({
  category: z.enum(["billing", "technical"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  summary: z.string(),
  next_steps: z.array(z.string()),
  customer_reply: z.string(),
});

const TEAMS = { billing: "Billing", technical: "Technical Support" } as const;

const triageAgent = new ToolLoopAgent({
  model: openai(MODEL),
  instructions:
    "You triage support tickets. Check the order or account with the tools " +
    "before you answer. Set category to billing for charges, refunds, " +
    "invoices, payment methods, and account balances. Set category to " +
    "technical for sign-in problems, API errors, outages, and broken links. " +
    "Then resolve the ticket.",
  tools: { lookup_order: lookupOrder, get_account_status: getAccountStatus },
  output: Output.object({ schema: Resolution }),
  stopWhen: isStepCount(MAX_STEPS),
  // Render retries this task, so turn off the AI SDK's own retries to keep one
  // retry policy in charge.
  maxRetries: 0,
});

// What triageTicket returns: the agent's result, or an error a retry can't fix.
type TriageResult =
  | { ticket_id: string; handled_by: string; steps: number; final_output: z.infer<typeof Resolution> }
  | { ticket_id: string; error: string };

function formatTicket(ticket: Ticket): string {
  return [
    `Ticket: ${ticket.id}`,
    `Account: ${ticket.account_id}`,
    `Order: ${ticket.order_id ?? "none"}`,
    `Subject: ${ticket.subject}`,
    "",
    ticket.body,
  ].join("\n");
}

// ---- Tasks ----

// triageTicket calls the OpenAI API, so it retries once if an attempt fails.
// A retry reruns the whole tool loop. That's safe here because the tools only read.
const triageTicket = task(
  {
    name: "triageTicket",
    retry: { maxRetries: 1, waitDurationMs: 1000, backoffScaling: 2 },
    timeoutSeconds: 120,
  },
  async function triageTicket(_ctx: TaskContext, ticket: Ticket): Promise<TriageResult> {
    const ticketId = ticket.id ?? "unknown";
    console.log(`[TRIAGE] ${ticketId}: ${ticket.subject}`);

    if (!process.env.OPENAI_API_KEY) {
      // A setup problem a retry can't fix, so return it instead of throwing.
      return { ticket_id: ticketId, error: "OPENAI_API_KEY is not set" };
    }

    let result;
    try {
      result = await triageAgent.generate({ prompt: formatTicket(ticket) });
    } catch (error) {
      // With maxRetries: 0 the SDK throws the provider error itself. Unwrap a
      // RetryError anyway, in case retries are turned back on.
      const cause = RetryError.isInstance(error) ? error.lastError : error;
      if (APICallError.isInstance(cause) && PERMANENT_ERROR_STATUSES.has(cause.statusCode ?? 0)) {
        console.error(`[TRIAGE] ${ticketId}: OpenAI error ${cause.statusCode}, not retrying`);
        return { ticket_id: ticketId, error: `OpenAI error ${cause.statusCode}: ${cause.message}` };
      }
      throw error;
    }

    // The step limit ended the loop before the model wrote its result.
    if (result.stoppedBy === "stop-condition") {
      console.warn(`[TRIAGE] ${ticketId}: stopped after ${MAX_STEPS} steps`);
      return { ticket_id: ticketId, error: `Hit the limit of ${MAX_STEPS} agent steps` };
    }

    // The SDK's result object isn't JSON-serializable, and task results must
    // be. Return the parsed output and a few plain fields.
    const output = result.output;
    const handledBy = TEAMS[output.category];
    console.log(`[TRIAGE] ${ticketId}: handled by ${handledBy} in ${result.steps.length} steps`);
    return { ticket_id: ticketId, handled_by: handledBy, steps: result.steps.length, final_output: output };
  },
);

// triageBatch only fans out, so it doesn't retry: a retry would rerun every
// ticket, including the ones that already finished. Each triageTicket run
// retries on its own.
task(
  {
    name: "triageBatch",
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 600,
  },
  async function triageBatch(ctx: TaskContext, tickets: Ticket[]) {
    console.log(`[BATCH] Triaging ${tickets.length} tickets`);

    // ctx.run starts each ticket as its own task run on its own compute.
    // allSettled keeps one failed ticket from failing the batch.
    const settled = await Promise.allSettled(tickets.map((ticket) => ctx.run(triageTicket, ticket)));

    const triaged: Extract<TriageResult, { handled_by: string }>[] = [];
    const failed: Extract<TriageResult, { error: string }>[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === "rejected") {
        failed.push({ ticket_id: tickets[i].id, error: String(outcome.reason) });
      } else if ("error" in outcome.value) {
        failed.push(outcome.value);
      } else {
        triaged.push(outcome.value);
      }
    });

    const byTeam: Record<string, number> = {};
    for (const r of triaged) byTeam[r.handled_by] = (byTeam[r.handled_by] ?? 0) + 1;

    console.log(`[BATCH] ${triaged.length} triaged, ${failed.length} failed`);
    return { total: tickets.length, triaged: triaged.length, by_team: byTeam, failed, results: triaged };
  },
);
