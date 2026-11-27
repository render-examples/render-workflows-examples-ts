/**
 * LLM evals on Render Workflows
 *
 * An eval harness that compares models on the same dataset. Every model answers
 * every case in its own task run, an LLM judge scores each answer with a
 * structured verdict, and a parent task returns a scorecard per model: pass rate,
 * average score, latency, tokens, and the cases that failed.
 *
 * The dataset is the support-ticket triage scenario the agent examples use
 * (tickets.json), plus the properties a good answer must have (cases.json).
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

// The models to compare, as provider:model pairs. They're read from the
// environment so you can compare different models without a code change.
const EVAL_MODELS = process.env.EVAL_MODELS ?? "openai:gpt-6.2-sol,anthropic:claude-opus-5-5";

// The model that grades every answer. Pick one that isn't in EVAL_MODELS, so
// no contestant grades its own answers.
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "anthropic:claude-sonnet-5-5";

// Render Workflows has no concurrency cap of its own, so runEval caps how many
// model calls each provider gets at once. Raise it if your rate limits allow.
const MAX_CONCURRENT_PER_PROVIDER = Number(process.env.MAX_CONCURRENT_PER_PROVIDER ?? "4");

// Provider errors that mean the request itself is wrong: unknown model, bad
// key, invalid input. A retry can't fix them, so the tasks return them as
// results instead of throwing. 429s and 5xx errors throw, and Render retries.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 413, 422]);

const API_KEY_ENV = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" } as const;
type Provider = keyof typeof API_KEY_ENV;

type Ticket = {
  id: string;
  account_id: string;
  order_id: string | null;
  subject: string;
  body: string;
};

type Case = {
  ticket_id: string;
  category: "billing" | "technical";
  priorities: string[];
  rubric: string[];
};

// ---- Sample records. Every model sees the same facts for a ticket, so the eval
// compares answers, not lookups. In production these would come from your database. ----

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

// ---- Output schemas. Both providers return JSON that matches these. ----

// What each model under test returns for a ticket.
const TriageAnswer = z.object({
  category: z.enum(["billing", "technical"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  summary: z.string(),
  customer_reply: z.string(),
});
type TriageAnswer = z.infer<typeof TriageAnswer>;

// What the judge returns for one answer.
const Verdict = z.object({
  criteria: z.array(z.object({ criterion: z.string(), met: z.boolean(), explanation: z.string() })),
  score: z.literal([1, 2, 3, 4, 5]),
  reasoning: z.string(),
});
type Verdict = z.infer<typeof Verdict>;

const ANSWER_INSTRUCTIONS =
  "You triage customer support tickets. Read the ticket and the account and " +
  "order records, then classify the ticket and write the reply the customer " +
  "will get. Categories: billing covers charges, refunds, invoices, payment " +
  "methods and balances. technical covers everything else, including sign-in " +
  "problems, API errors, outages, broken links, and shipping or tracking " +
  "problems. Policy: duplicate charges are always refunded within 5 business " +
  "days. Use only facts from the records and the policy. Keep the reply under " +
  "120 words.";

const JUDGE_INSTRUCTIONS =
  "You grade a support agent's reply to a customer ticket. For each criterion, " +
  "decide whether the reply meets it and explain why in one sentence. Then " +
  "score the reply's overall quality from 1 (harmful or wrong) to 5 (accurate, " +
  "complete, and ready to send). Judge only the reply. Don't reward length.";

// Render a ticket and its records as the model's input.
function formatTicket(ticket: Ticket): string {
  const account = ACCOUNTS[ticket.account_id] ?? null;
  const order = ticket.order_id ? (ORDERS[ticket.order_id] ?? null) : null;
  return [
    `Ticket: ${ticket.id}`,
    `Subject: ${ticket.subject}`,
    "",
    ticket.body,
    "",
    `Account ${ticket.account_id}: ${JSON.stringify(account)}`,
    `Order ${ticket.order_id ?? "none"}: ${JSON.stringify(order)}`,
  ].join("\n");
}

// ---- Provider calls ----

// Split "provider:model" into its parts.
function parseModel(spec: string): [Provider, string] {
  const i = spec.indexOf(":");
  const provider = spec.slice(0, i);
  const model = spec.slice(i + 1);
  if (i < 0 || !(provider in API_KEY_ENV) || !model) {
    throw new Error(`Bad model "${spec}". Use provider:model, with provider openai or anthropic.`);
  }
  return [provider as Provider, model];
}

// The model answered, but not with output that matches the schema.
class OutputError extends Error {}

type Usage = { input_tokens: number; output_tokens: number };

// Ask one model for JSON that matches schema. Throws OutputError when the model
// refuses, runs out of tokens, or returns output that doesn't parse. Provider
// API errors propagate.
async function callModel<T extends z.ZodType>(
  spec: string,
  instructions: string,
  prompt: string,
  schema: T,
): Promise<{ parsed: z.infer<T>; usage: Usage; latencyMs: number }> {
  const [provider, model] = parseModel(spec);
  const apiKey = process.env[API_KEY_ENV[provider]];
  const started = performance.now();
  let parsed: z.infer<T> | null;
  let usage: Usage;

  try {
    if (provider === "openai") {
      // Render retries the task, so turn off the client's own retries to keep
      // one retry policy in charge.
      const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 90_000 });
      const response = await client.responses.parse({
        model,
        instructions,
        input: prompt,
        text: { format: zodTextFormat(schema, "output") },
      });
      parsed = response.output_parsed as z.infer<T> | null;
      usage = {
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
      };
      if (parsed == null) throw new OutputError(`No parsed output (status ${response.status})`);
    } else {
      const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 90_000 });
      const response = await client.messages.parse({
        model,
        max_tokens: 8000,
        system: instructions,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: zodOutputFormat(schema) },
      });
      parsed = response.parsed_output ?? null;
      usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
      // A refusal or a truncated answer is the model's result, so it's scored
      // as a failed case. No fallback model: a fallback would score a different
      // model's answer.
      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || parsed == null) {
        throw new OutputError(`No parsed output (stop reason ${response.stop_reason})`);
      }
    }
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw new OutputError(`Output didn't match the schema: ${error.message.slice(0, 200)}`);
    }
    throw error;
  }

  return { parsed, usage, latencyMs: Math.round(performance.now() - started) };
}

// Return a message if error is a provider error a retry can't fix.
function permanentError(error: unknown): string | null {
  let provider: string;
  if (error instanceof OpenAI.APIError) provider = "OpenAI";
  else if (error instanceof Anthropic.APIError) provider = "Anthropic";
  else return null;
  if (!PERMANENT_ERROR_STATUSES.has(error.status ?? 0)) return null;
  // The error body holds the provider's message, wrapped in "error" by Anthropic.
  const body = (error.error ?? {}) as { message?: string; error?: { message?: string } };
  return `${provider} error ${error.status}: ${body.error?.message ?? body.message ?? error.message}`;
}

// Return a message if spec is malformed or its provider's key isn't set.
function missingKey(spec: string): string | null {
  let provider: Provider;
  try {
    [provider] = parseModel(spec);
  } catch (error) {
    return (error as Error).message;
  }
  const env = API_KEY_ENV[provider];
  return process.env[env] ? null : `${env} is not set`;
}

// ---- Tasks ----

type AnswerResult = {
  model: string;
  ticket_id: string;
  answer?: TriageAnswer;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  output_error?: string;
  error?: string;
};

// answerCase calls a model API, so it retries: a 429 or a 5xx gets three more
// attempts, 2, 4 and 8 seconds apart. Calling the model again is safe because
// nothing is written.
const answerCase = task(
  {
    name: "answerCase",
    retry: { maxRetries: 3, waitDurationMs: 2000, backoffScaling: 2 },
    timeoutSeconds: 120,
  },
  async function answerCase(_ctx: TaskContext, model: string, ticket: Ticket): Promise<AnswerResult> {
    const result = { model, ticket_id: ticket.id ?? "unknown" };

    const problem = missingKey(model);
    // A setup problem a retry can't fix, so return it instead of throwing.
    if (problem) return { ...result, error: problem };

    try {
      const { parsed, usage, latencyMs } = await callModel(
        model,
        ANSWER_INSTRUCTIONS,
        formatTicket(ticket),
        TriageAnswer,
      );
      console.log(`[ANSWER] ${model} ${ticket.id}: ${parsed.category}/${parsed.priority} in ${latencyMs} ms`);
      return { ...result, answer: parsed, latency_ms: latencyMs, ...usage };
    } catch (error) {
      if (error instanceof OutputError) {
        // The model's own failure. runEval counts it as a failed case.
        console.warn(`[ANSWER] ${model} ${ticket.id}: ${error.message}`);
        return { ...result, output_error: error.message };
      }
      const message = permanentError(error);
      if (message) {
        console.error(`[ANSWER] ${model} ${ticket.id}: ${message}, not retrying`);
        return { ...result, error: message };
      }
      throw error;
    }
  },
);

type JudgeResult = { judge: string; ticket_id: string; latency_ms?: number; error?: string } & Partial<Verdict>;

// judgeAnswer calls a model API too, so it retries the same way.
const judgeAnswer = task(
  {
    name: "judgeAnswer",
    retry: { maxRetries: 3, waitDurationMs: 2000, backoffScaling: 2 },
    timeoutSeconds: 120,
  },
  async function judgeAnswer(
    _ctx: TaskContext,
    ticket: Ticket,
    evalCase: Case,
    answer: TriageAnswer,
  ): Promise<JudgeResult> {
    const result = { judge: JUDGE_MODEL, ticket_id: ticket.id ?? "unknown" };

    const problem = missingKey(JUDGE_MODEL);
    if (problem) return { ...result, error: problem };

    const prompt = [
      "Ticket and records:",
      formatTicket(ticket),
      "",
      "Reply to grade:",
      answer.customer_reply ?? "",
      "",
      "Criteria:",
      ...(evalCase.rubric ?? []).map((c) => `- ${c}`),
    ].join("\n");

    try {
      const { parsed, latencyMs } = await callModel(JUDGE_MODEL, JUDGE_INSTRUCTIONS, prompt, Verdict);
      console.log(`[JUDGE] ${ticket.id}: score ${parsed.score} in ${latencyMs} ms`);
      return { ...result, ...parsed, latency_ms: latencyMs };
    } catch (error) {
      if (error instanceof OutputError) return { ...result, error: `Judge output unusable: ${error.message}` };
      const message = permanentError(error);
      if (message) {
        console.error(`[JUDGE] ${ticket.id}: ${message}, not retrying`);
        return { ...result, error: message };
      }
      throw error;
    }
  },
);

type CaseResult = AnswerResult & { verdict?: JudgeResult; passed?: boolean; reasons?: string[] };

// Return the reasons an answer fails its case. Empty means it passes.
function checkAnswer(evalCase: Case, answer: TriageAnswer, verdict: JudgeResult): string[] {
  const reasons: string[] = [];
  if (answer.category !== evalCase.category) {
    reasons.push(`category ${answer.category}, expected ${evalCase.category}`);
  }
  if (!evalCase.priorities.includes(answer.priority)) {
    reasons.push(`priority ${answer.priority}, expected one of ${evalCase.priorities.join(", ")}`);
  }
  for (const c of verdict.criteria ?? []) {
    if (!c.met) reasons.push(`not met: ${c.criterion}`);
  }
  return reasons;
}

// A minimal semaphore: at most `size` callers run at once, the rest wait in line.
function semaphore(size: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

// runEval only fans out and adds up, so it doesn't retry: a retry would rerun
// every model call, including the ones that already finished. Each answerCase
// and judgeAnswer run retries on its own.
task(
  {
    name: "runEval",
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 1800,
  },
  async function runEval(ctx: TaskContext, tickets: Ticket[], cases: Case[]) {
    const models = EVAL_MODELS.split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const evalCases = cases.filter((c) => byId.has(c.ticket_id));
    console.log(`[EVAL] ${evalCases.length} cases x ${models.length} models, judge ${JUDGE_MODEL}`);

    // Without a working judge nothing can be scored, so stop before paying for
    // any answers.
    const problem = missingKey(JUDGE_MODEL);
    if (problem) return { judge: JUDGE_MODEL, error: `Judge unavailable: ${problem}` };

    // One semaphore per provider caps the model calls in flight, contestants
    // and judge together.
    const limits = new Map<string, ReturnType<typeof semaphore>>();
    const limit = (spec: string) => {
      const provider = spec.split(":")[0];
      if (!limits.has(provider)) limits.set(provider, semaphore(MAX_CONCURRENT_PER_PROVIDER));
      return limits.get(provider)!;
    };

    async function evaluate(model: string, evalCase: Case): Promise<CaseResult> {
      const ticket = byId.get(evalCase.ticket_id)!;
      // ctx.run starts each call as its own task run on its own compute.
      const answered = await limit(model)(() => ctx.run(answerCase, model, ticket));
      if (!answered.answer) return answered;
      const answer = answered.answer;
      const verdict = await limit(JUDGE_MODEL)(() => ctx.run(judgeAnswer, ticket, evalCase, answer));
      if (verdict.error) return { ...answered, error: verdict.error };
      return { ...answered, verdict };
    }

    const pairs = models.flatMap((model) => evalCases.map((c) => [model, c] as const));
    // allSettled keeps one failed run from failing the eval. A run that threw
    // used up its retries; it's listed as an error, not scored.
    const settled = await Promise.allSettled(pairs.map(([model, c]) => evaluate(model, c)));

    const results: CaseResult[] = settled.map((outcome, i) => {
      const [model, evalCase] = pairs[i];
      if (outcome.status === "rejected") {
        const reason = outcome.reason;
        return { model, ticket_id: evalCase.ticket_id, error: reason instanceof Error ? reason.message : String(reason) };
      }
      const r = outcome.value;
      if (r.answer && r.verdict) {
        const reasons = checkAnswer(evalCase, r.answer, r.verdict);
        return { ...r, passed: reasons.length === 0, reasons };
      }
      if (r.output_error) return { ...r, passed: false, reasons: [r.output_error] };
      return r;
    });

    const scorecard = models.map((model) => summarize(model, results.filter((r) => r.model === model)));
    // Best model first: highest pass rate, then highest average score.
    scorecard.sort((a, b) => (b.pass_rate ?? 0) - (a.pass_rate ?? 0) || (b.avg_score ?? 0) - (a.avg_score ?? 0));

    for (const s of scorecard) {
      console.log(`[EVAL] ${s.model}: ${s.passed}/${s.scored} passed, avg score ${s.avg_score}`);
    }
    return { judge: JUDGE_MODEL, cases: evalCases.length, scorecard, results };
  },
);

const round2 = (n: number) => Math.round(n * 100) / 100;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Add up one model's results.
function summarize(model: string, results: CaseResult[]) {
  const scored = results.filter((r) => r.passed !== undefined);
  const judged = scored.filter((r) => r.verdict?.score !== undefined);
  const latencies = results.flatMap((r) => (r.latency_ms === undefined ? [] : [r.latency_ms]));
  const passed = scored.filter((r) => r.passed).length;
  return {
    model,
    scored: scored.length,
    passed,
    pass_rate: scored.length ? round2(passed / scored.length) : null,
    avg_score: judged.length
      ? round2(judged.reduce((sum, r) => sum + (r.verdict!.score ?? 0), 0) / judged.length)
      : null,
    latency_ms: {
      p50: latencies.length ? Math.round(median(latencies)) : null,
      max: latencies.length ? Math.max(...latencies) : null,
    },
    tokens: {
      input: results.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0),
      output: results.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0),
    },
    failures: scored.filter((r) => !r.passed).map((r) => ({ ticket_id: r.ticket_id, reasons: r.reasons ?? [] })),
    errors: results.filter((r) => r.error).map((r) => ({ ticket_id: r.ticket_id, error: r.error! })),
  };
}
