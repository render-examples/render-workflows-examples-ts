# OpenAI Agents SDK on Render Workflows

Run an agent built with the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) as a Render Workflows task, and fan it out across a batch of support tickets.

## What it shows

- An Agents SDK agent with tools and handoffs, running inside one task run
- Returning the agent's typed output as JSON-safe task results
- Fanning out one task run per ticket with `ctx.run` and `Promise.allSettled`
- Retrying the task that calls the model, and not the task that fans out
- Returning errors a retry can't fix (max turns hit, unknown model, missing API key) as results instead of raising
- Triggering the tasks from another service with the Render SDK client

The SDK runs the agent loop (model calls, tool calls, and handoffs) inside a single task run. For an agent loop where every model call and tool call is its own task, see [openai-agent](../openai-agent/).

## Task tree

```
triageBatch (fans out, no retries)
  └── triageTicket             (one per ticket, retries once)
        └── run(triageAgent)                ← inside the task, run by the SDK
              ├── tools: lookup_order, get_account_status
              └── hands off to: Billing  or  Technical Support
                                   └── returns a Resolution (typed output)
```

## Prerequisites

- Node.js 22+ (required by `openai` 7)
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
   | Root Directory | `openai-agents-sdk` (the folder that holds `package.json`). Leave it empty if this folder is the repository root. |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/main.js` |
   | Region | Any |
   | Environment variables | `OPENAI_API_KEY`, and optionally `OPENAI_MODEL` and `AGENT_MAX_TURNS` |

4. Create the workflow. Once the first version is ready, run `triageTicket` from the Dashboard with a ticket from `tickets.json` wrapped in a JSON array.

## Trigger from another service

`src/client.ts` triggers both tasks with the Render SDK:

```bash
export RENDER_API_KEY=your-render-api-key
export WORKFLOW_SLUG=your-workflow-slug   # defaults to openai-agents-sdk
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

- **A retry reruns the whole agent.** `triageTicket` retries once, which repeats every model call and tool call in the run. That's safe here because both tools only read data. If a tool writes (a refund, an email), make that write idempotent or move it into its own task with retries off. See [retries](https://render.com/docs/workflows-defining-tasks#retry-settings).
- **Timeouts apply per attempt.** `timeoutSeconds: 120` bounds each attempt of `triageTicket`, and a retry gets a fresh 120 seconds. See [timeouts](https://render.com/docs/workflows-defining-tasks#timeout).
- **Arguments are capped at 4 MB.** The combined arguments of a task run can't exceed 4 MB. Pass ticket IDs instead of large payloads if your tickets carry attachments. See [limits](https://render.com/docs/workflows-limits).
- **Fan-out meets OpenAI rate limits.** `triageBatch` starts every ticket at once. A 429 from OpenAI raises, and Render retries that ticket once. For large batches, fan out in chunks.
- **Errors a retry can't fix are returned, not raised.** Hitting `AGENT_MAX_TURNS`, a missing `OPENAI_API_KEY`, or an OpenAI 400/401/403/404/422 comes back as `{"ticket_id": ..., "error": ...}`. `triageBatch` lists those tickets under `failed`.
- **Tracing.** The Agents SDK sends traces of each run to OpenAI by default. See the SDK's [tracing docs](https://openai.github.io/openai-agents-js/guides/tracing/) to turn it off.

## Links

- [Render Workflows](https://render.com/docs/workflows)
- [Defining tasks](https://render.com/docs/workflows-defining-tasks)
- [Triggering runs](https://render.com/docs/workflows-running)
- [Workflows SDK for TypeScript](https://render.com/docs/workflows-sdk-typescript)
- [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/)
