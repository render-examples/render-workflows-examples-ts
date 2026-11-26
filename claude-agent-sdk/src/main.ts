/**
 * Claude Agent SDK on Render Workflows
 *
 * A support-ticket triage agent built with the Claude Agent SDK, running inside
 * a workflow task. The SDK runs the agent loop (model calls and tool calls)
 * within one task run. Render runs that task, retries it, and fans it out
 * across many tickets.
 *
 * The SDK drives a Claude Code process that it starts for each query(). npm
 * installs that process as a native binary for your platform (an optional
 * dependency of the SDK), so the service needs no separate install.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { z } from "zod";

// Read the model from the environment so a retired model is a config change,
// not a code change.
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";

// Upper bound on agent turns per ticket, so an agent that keeps calling tools
// can't run forever. Each model response counts as one turn.
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? "8");

// Anthropic API errors that mean the request itself is wrong: unknown model,
// bad key, invalid input. A retry can't fix them, so triageTicket returns them
// as a result instead of throwing.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 422]);

// Run results a retry can't fix: the agent ran out of turns, or couldn't
// produce output that matches the Resolution schema.
const PERMANENT_RESULT_SUBTYPES = new Set(["error_max_turns", "error_max_structured_output_retries"]);

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
// They run in this Node process, served to Claude by an in-process MCP server.

const lookupOrder = tool(
  "lookup_order",
  "Look up an order's status, amount, and how many times it was charged.",
  { order_id: z.string().describe("The order ID, such as ORD-2001.") },
  async ({ order_id }) => {
    const order = ORDERS[order_id];
    if (!order) {
      return { content: [{ type: "text", text: `No order ${order_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(order) }] };
  },
  { annotations: { readOnlyHint: true } },
);

const getAccountStatus = tool(
  "get_account_status",
  "Look up an account's plan, standing, and balance due.",
  { account_id: z.string().describe("The account ID, such as ACC-100.") },
  async ({ account_id }) => {
    const account = ACCOUNTS[account_id];
    if (!account) {
      return { content: [{ type: "text", text: `No account ${account_id}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(account) }] };
  },
  { annotations: { readOnlyHint: true } },
);

const supportServer = createSdkMcpServer({
  name: "support",
  version: "1.0.0",
  tools: [lookupOrder, getAccountStatus],
});

// ---- Agent ----

// The structured result the agent returns for a ticket.
const Resolution = z.object({
  category: z.enum(["billing", "technical"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  summary: z.string(),
  next_steps: z.array(z.string()),
  customer_reply: z.string(),
});

const SYSTEM_PROMPT =
  "You triage customer support tickets. Decide whether each ticket is a " +
  "billing issue (charges, refunds, invoices, payment methods, balances) or a " +
  "technical issue (sign-in problems, API errors, outages, broken links). " +
  "Check the order or account with the tools before you answer. Then return " +
  "a resolution with the next steps for the support team and a reply to the " +
  "customer.";

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

// Options for one agent run, isolated in its own working directory.
function agentOptions(workdir: string): Options {
  return {
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: MAX_TURNS,
    // Serve the custom tools in-process and pre-approve them.
    mcpServers: { support: supportServer },
    allowedTools: ["mcp__support__lookup_order", "mcp__support__get_account_status"],
    // No built-in tools (Bash, Read, Edit, ...). This agent only needs the
    // two lookups, so it gets nothing that can touch the machine.
    tools: [],
    // Return a Resolution as validated JSON on the result message.
    outputFormat: { type: "json_schema", schema: z.toJSONSchema(Resolution, { target: "draft-7" }) },
    // Each run gets its own working directory and Claude Code config
    // directory, so concurrent runs on one instance share no files and
    // session transcripts are deleted with the directory.
    cwd: workdir,
    settingSources: [],
    // env replaces the Claude Code process's environment, so pass ours through.
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(workdir, ".claude"),
      // Render retries this task, so turn off Claude Code's own API retries
      // to keep one retry policy in charge.
      CLAUDE_CODE_MAX_RETRIES: "0",
    },
  };
}

// What triageTicket returns: the agent's resolution, or an error a retry can't fix.
type TriageResult =
  | {
      ticket_id: string;
      final_output: z.infer<typeof Resolution>;
      num_turns: number;
      total_cost_usd: number;
    }
  | { ticket_id: string; error: string };

// Returns an error result for a failed run that a retry can't fix, or null if
// a retry might help.
function permanentError(ticketId: string, result: SDKResultMessage): TriageResult | null {
  if (PERMANENT_RESULT_SUBTYPES.has(result.subtype)) {
    console.warn(`[TRIAGE] ${ticketId}: run ended as ${result.subtype}`);
    return { ticket_id: ticketId, error: `Agent run ended as ${result.subtype}` };
  }
  if (result.subtype === "success" && PERMANENT_ERROR_STATUSES.has(result.api_error_status ?? 0)) {
    console.error(`[TRIAGE] ${ticketId}: Anthropic error ${result.api_error_status}, not retrying`);
    return { ticket_id: ticketId, error: `Anthropic error ${result.api_error_status}: ${result.result}` };
  }
  return null;
}

// ---- Tasks ----

// triageTicket calls the Anthropic API, so it retries once if an attempt fails.
// A retry reruns the whole agent. That's safe here because the tools only read.
const triageTicket = task(
  {
    name: "triageTicket",
    retry: { maxRetries: 1, waitDurationMs: 1000, backoffScaling: 2 },
    timeoutSeconds: 180,
  },
  async function triageTicket(_ctx: TaskContext, ticket: Ticket): Promise<TriageResult> {
    const ticketId = ticket.id ?? "unknown";
    console.log(`[TRIAGE] ${ticketId}: ${ticket.subject}`);

    if (!process.env.ANTHROPIC_API_KEY) {
      // A setup problem a retry can't fix, so return it instead of throwing.
      return { ticket_id: ticketId, error: "ANTHROPIC_API_KEY is not set" };
    }

    let result: SDKResultMessage | undefined;
    const workdir = await mkdtemp(join(tmpdir(), `triage-${ticketId}-`));
    try {
      for await (const message of query({ prompt: formatTicket(ticket), options: agentOptions(workdir) })) {
        if (message.type === "result") result = message;
      }
    } catch (error) {
      // query() throws after it yields an error result. Return the errors a
      // retry can't fix; throw the rest (rate limits, overloads, timeouts) so
      // Render retries.
      const permanent = result && permanentError(ticketId, result);
      if (permanent) return permanent;
      throw error;
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }

    if (result?.subtype !== "success" || result.structured_output === undefined) {
      // The run ended without a Resolution. Throw so Render retries once.
      throw new Error(`Agent returned no structured output for ${ticketId}`);
    }

    // Validate the agent's output and return it as plain JSON.
    const resolution = Resolution.parse(result.structured_output);
    const cost = Number(result.total_cost_usd.toFixed(6));
    console.log(`[TRIAGE] ${ticketId}: ${resolution.category}, ${result.num_turns} turns, $${cost}`);
    return { ticket_id: ticketId, final_output: resolution, num_turns: result.num_turns, total_cost_usd: cost };
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

    const triaged: Extract<TriageResult, { final_output: unknown }>[] = [];
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

    const byCategory: Record<string, number> = {};
    for (const r of triaged) byCategory[r.final_output.category] = (byCategory[r.final_output.category] ?? 0) + 1;
    const totalCost = Number(triaged.reduce((sum, r) => sum + r.total_cost_usd, 0).toFixed(6));

    console.log(`[BATCH] ${triaged.length} triaged, ${failed.length} failed`);
    return {
      total: tickets.length,
      triaged: triaged.length,
      by_category: byCategory,
      total_cost_usd: totalCost,
      failed,
      results: triaged,
    };
  },
);
