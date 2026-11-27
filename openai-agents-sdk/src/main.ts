/**
 * OpenAI Agents SDK on Render Workflows
 *
 * A support-ticket triage agent built with the OpenAI Agents SDK, running inside
 * a workflow task. The SDK runs the agent loop (model calls, tool calls and
 * handoffs) within one task run. Render runs that task, retries it, and fans it
 * out across many tickets.
 *
 * For an agent loop where every model call and tool call is its own task, see
 * the openai-agent example.
 */
import { Agent, MaxTurnsExceededError, run, setDefaultOpenAIClient, tool } from "@openai/agents";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import OpenAI from "openai";
import { z } from "zod";

// Read the model from the environment so a retired model is a config change,
// not a code change.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-6.2-sol";

// Upper bound on model turns per ticket, so an agent that keeps calling tools
// or handing off can't run forever.
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? "6");

// OpenAI errors that mean the request itself is wrong: unknown model, bad key,
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
  name: "lookup_order",
  description: "Look up an order's status, amount, and how many times it was charged.",
  parameters: z.object({
    order_id: z.string().describe("The order ID, such as ORD-2001."),
  }),
  execute: async ({ order_id }) =>
    JSON.stringify(ORDERS[order_id] ?? { error: `No order ${order_id}` }),
});

const getAccountStatus = tool({
  name: "get_account_status",
  description: "Look up an account's plan, standing, and balance due.",
  parameters: z.object({
    account_id: z.string().describe("The account ID, such as ACC-100."),
  }),
  execute: async ({ account_id }) =>
    JSON.stringify(ACCOUNTS[account_id] ?? { error: `No account ${account_id}` }),
});

// ---- Agents ----

// The structured result a specialist returns for a ticket.
const Resolution = z.object({
  category: z.enum(["billing", "technical"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  summary: z.string(),
  next_steps: z.array(z.string()),
  customer_reply: z.string(),
});

const billingAgent = new Agent({
  name: "Billing",
  handoffDescription: "Charges, refunds, invoices, payment methods, and account balances.",
  instructions:
    "You resolve billing support tickets. Check the order or account with the " +
    "tools before you answer. Set category to billing.",
  tools: [lookupOrder, getAccountStatus],
  outputType: Resolution,
  model: MODEL,
});

const technicalAgent = new Agent({
  name: "Technical Support",
  handoffDescription: "Sign-in problems, API errors, outages, and broken links.",
  instructions:
    "You resolve technical support tickets. Use the tools if the account or " +
    "order matters to the problem. Set category to technical.",
  tools: [lookupOrder, getAccountStatus],
  outputType: Resolution,
  model: MODEL,
});

const triageAgent = Agent.create({
  name: "Triage",
  instructions:
    "Read the support ticket and hand it off to the right specialist. If the " +
    "right team isn't clear, check the order or account with the tools first. " +
    "Always hand off. Don't answer the customer yourself.",
  tools: [lookupOrder, getAccountStatus],
  handoffs: [billingAgent, technicalAgent],
  model: MODEL,
});

// What triageTicket returns: the specialist's result, or an error a retry can't fix.
type TriageResult =
  | { ticket_id: string; handled_by: string; final_output: z.infer<typeof Resolution> | { text: string } }
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
// A retry reruns the whole agent. That's safe here because the tools only read.
const triageTicket = task(
  {
    name: "triageTicket",
    retry: { maxRetries: 1, waitDurationMs: 1000, backoffScaling: 2 },
    timeoutSeconds: 120,
  },
  async function triageTicket(_ctx: TaskContext, ticket: Ticket): Promise<TriageResult> {
    const ticketId = ticket.id ?? "unknown";
    console.log(`[TRIAGE] ${ticketId}: ${ticket.subject}`);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // A setup problem a retry can't fix, so return it instead of throwing.
      return { ticket_id: ticketId, error: "OPENAI_API_KEY is not set" };
    }

    // Render retries this task, so turn off the OpenAI client's own retries to
    // keep one retry policy in charge.
    setDefaultOpenAIClient(new OpenAI({ apiKey, maxRetries: 0 }));

    let result;
    try {
      result = await run(triageAgent, formatTicket(ticket), { maxTurns: MAX_TURNS });
    } catch (error) {
      if (error instanceof MaxTurnsExceededError) {
        console.warn(`[TRIAGE] ${ticketId}: stopped after ${MAX_TURNS} turns`);
        return { ticket_id: ticketId, error: `Hit the limit of ${MAX_TURNS} agent turns` };
      }
      if (error instanceof OpenAI.APIError && PERMANENT_ERROR_STATUSES.has(error.status ?? 0)) {
        console.error(`[TRIAGE] ${ticketId}: OpenAI error ${error.status}, not retrying`);
        return { ticket_id: ticketId, error: `OpenAI error ${error.status}: ${error.message}` };
      }
      throw error;
    }

    // The SDK's run result isn't JSON-serializable, and task results must be.
    // Return the agent that finished the run and its output as plain data.
    const output = result.finalOutput;
    const handledBy = result.lastAgent?.name ?? "unknown";
    console.log(`[TRIAGE] ${ticketId}: handled by ${handledBy}`);
    return {
      ticket_id: ticketId,
      handled_by: handledBy,
      final_output: typeof output === "object" && output !== null ? output : { text: String(output ?? "") },
    };
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
