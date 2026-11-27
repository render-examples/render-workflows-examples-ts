# Vercel AI SDK on Render Workflows

Run a tool-calling agent built with the [Vercel AI SDK](https://ai-sdk.dev/docs/introduction) as a Render Workflows task, and fan it out across a batch of support tickets.

## What it shows

- An AI SDK `ToolLoopAgent` with tools and a structured output (`Output.object`), running inside one task run
- A step limit (`stopWhen: isStepCount(...)`) that bounds the tool loop, returned as a result when it's hit
- Fanning out one task run per ticket with `ctx.run` and `Promise.allSettled`
- Retrying the task that calls the model, and not the task that fans out, with the AI SDK's own retries turned off
- Returning errors a retry can't fix (step limit hit, unknown model, missing API key) as results instead of raising
- Triggering the tasks from another service with the Render SDK client

The AI SDK runs the tool loop (model calls and tool calls) inside a single task run. For an agent loop where every model call and tool call is its own task, see [openai-agent](../openai-agent/).

### How this differs from `openai-agents-sdk`

This example solves the same problem as [openai-agents-sdk](../openai-agents-sdk/), with the same tickets, tools, result shape and tasks, so you can compare the two.

- **Provider-agnostic.** The AI SDK talks to OpenAI through `@ai-sdk/openai`. To use another provider, install its package and change one import and the model ID, for example `import { anthropic } from "@ai-sdk/anthropic"` and `model: anthropic("<model-id>")`. The tools, loop, and tasks stay the same. See [AI SDK providers](https://ai-sdk.dev/providers/ai-sdk-providers).
- **One agent instead of handoffs.** The Agents SDK example hands each ticket from a triage agent to a Billing or Technical Support agent. The AI SDK has no handoffs, so one agent checks the order or account and fills in a `category` field, and the task maps it to a team.
- **A step limit instead of a turn limit.** `AGENT_MAX_STEPS` caps model calls per ticket. The call that writes the structured result counts as a step.
- **No tracing by default.** The AI SDK sends no telemetry unless you register an OpenTelemetry integration. See [telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry).

## Task tree

```
triageBatch (fans out, no retries)
  └── triageTicket             (one per ticket, retries once)
        └── triageAgent.generate()          ← inside the task, run by the AI SDK
              ├── tools: lookup_order, get_account_status
              └── returns a Resolution (structured output)
                    └── category → Billing  or  Technical Support
```

## Prerequisites

- Node.js 22+ (required by `ai` 7)
- The [Render CLI](https://render.com/docs/cli)
- An [OpenAI API key](https://platform.openai.com/api-keys)

## Run locally

```bash
npm install
cp .env.example .env
# Edit .env and set OPENAI_API_KEY. OPENAI_MODEL defaults to gpt-6.2-sol.
```

Build, then start the local task server. It loads `.env` when it starts:

```bash
npm run build
render workflows dev -- node dist/main.js
```

In another terminal, triage one ticket. Task input is a JSON array of the task's arguments:

```bash
render workflows tasks runs start triageTicket --local \
  --input='[{"id": "TCK-1001", "account_id": "ACC-100", "order_id": "ORD-2001", "subject": "Charged twice for my order", "body": "I was charged two times for order ORD-2001 yesterday."}]'
```

To triage the five sample tickets in `tickets.json` at once, start `triageBatch` with the whole list as its one argument:

```bash
render workflows tasks runs start triageBatch --local --input="[$(cat tickets.json)]"
```

## Deploy to Render

1. Push this folder to a Git repository Render can access.
2. In the Render Dashboard, click **New > Workflow** and connect the repository.
3. Set these fields:

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `vercel-ai-sdk` (the folder that holds `package.json`). Leave it empty if this folder is the repository root. |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/main.js` |
   | Region | Any |
   | Environment variables | `OPENAI_API_KEY`, and optionally `OPENAI_MODEL` and `AGENT_MAX_STEPS` |

4. Create the workflow. Once the first version is ready, run `triageTicket` from the Dashboard with a ticket from `tickets.json` wrapped in a JSON array.

## Trigger from another service

`src/client.ts` triggers both tasks with the Render SDK:

```bash
export RENDER_API_KEY=your-render-api-key
export WORKFLOW_SLUG=your-workflow-slug   # defaults to vercel-ai-sdk
npm run build && npm run client
```

The core of it:

```typescript
import { Render } from "@renderinc/sdk";

const render = new Render(); // reads RENDER_API_KEY

const run = await render.workflows.runTask(`${SLUG}/triageTicket`, [tickets[0]]);
if (run.status === "completed") {
  const result = run.results[0] as TriageResult; // results holds the return value
  console.log(result.handled_by, result.final_output);
}
```

`runTask` waits for the run to finish. To start a run and check on it later, use `startTask` instead; it returns the run's `taskRunId`.

## Limits and gotchas

- **A retry reruns the whole tool loop.** `triageTicket` retries once, which repeats every model call and tool call in the run. That's safe here because both tools only read data. If a tool writes (a refund, an email), make that write idempotent or move it into its own task with retries off. See [retries](https://render.com/docs/workflows-defining-tasks#retry-settings).
- **Turn off the AI SDK's retries.** The AI SDK retries failed model calls twice by default. The agent sets `maxRetries: 0` so Render's retry policy is the only one, and a failing model call is sent once per attempt, not three times.
- **Timeouts apply per attempt.** `timeoutSeconds: 120` bounds each attempt of `triageTicket`, and a retry gets a fresh 120 seconds. See [timeouts](https://render.com/docs/workflows-defining-tasks#timeout).
- **Arguments are capped at 4 MB.** The combined arguments of a task run can't exceed 4 MB. Pass ticket IDs instead of large payloads if your tickets carry attachments. See [limits](https://render.com/docs/workflows-limits).
- **Fan-out meets provider rate limits.** `triageBatch` starts every ticket at once. A 429 from OpenAI raises, and Render retries that ticket once. For large batches, fan out in chunks.
- **Errors a retry can't fix are returned, not raised.** Hitting `AGENT_MAX_STEPS`, a missing `OPENAI_API_KEY`, or a provider 400/401/403/404/422 comes back as `{"ticket_id": ..., "error": ...}`. `triageBatch` lists those tickets under `failed`.
- **Plan the step limit for the structured output.** The model call that writes the `Resolution` is a step. With `AGENT_MAX_STEPS=1`, a ticket that needs a tool call stops before the result is written. See [loop control](https://ai-sdk.dev/docs/agents/loop-control).

## Links

- [Render Workflows](https://render.com/docs/workflows)
- [Defining tasks](https://render.com/docs/workflows-defining-tasks)
- [Triggering runs](https://render.com/docs/workflows-running)
- [Workflows SDK for TypeScript](https://render.com/docs/workflows-sdk-typescript)
- [AI SDK: building agents](https://ai-sdk.dev/docs/agents/building-agents)
- [AI SDK: structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
- [AI SDK: OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)
