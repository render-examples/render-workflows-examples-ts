# LLM evals on Render Workflows

Compare OpenAI and Anthropic models on the same dataset: every model answers every case in its own task run, an LLM judge grades each answer, and a parent task returns a scorecard per model.

## What it shows

- Fanning out one task run per model and case with `ctx.run` and `Promise.allSettled`
- Capping model calls in flight per provider with a semaphore, so the fan-out stays under provider rate limits
- An LLM judge that returns a structured verdict (`messages.parse` / `responses.parse` with a Zod schema)
- Retrying the tasks that call a model, and not the task that fans out
- Returning errors a retry can't fix (unknown model, missing API key) as results, and counting a model's refusal or malformed output as a failed case
- Reading the models under test and the judge from environment variables

The dataset is the support-ticket triage scenario the agent examples use. `tickets.json` holds the tickets; `cases.json` holds what a good answer must do for each one: the right category, an acceptable priority, and a rubric for the reply. The models answer with no tools and the same records in the prompt, so the eval compares the models, not an agent loop.

## Task tree

```
runEval (fans out, no retries)
  ├── answerCase     (one per model × case, retries on 429/5xx)
  │     └── one structured-output call to the model under test
  └── judgeAnswer    (one per answered case, retries on 429/5xx)
        └── one structured-output call to JUDGE_MODEL
→ scorecard per model: pass rate, average score, latency, tokens, failures, errors
```

A case passes when the category matches, the priority is one of the allowed values, and the judge marks every rubric criterion as met. The judge's 1–5 score is reported separately as `avg_score`.

## Prerequisites

- Node.js 22+
- The [Render CLI](https://render.com/docs/cli)
- An [OpenAI API key](https://platform.openai.com/api-keys) and an [Anthropic API key](https://platform.claude.com/settings/keys)

## Run locally

```bash
npm install
cp .env.example .env
# Edit .env and set OPENAI_API_KEY and ANTHROPIC_API_KEY.
```

The models come from `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `EVAL_MODELS` | `openai:gpt-6.2-sol,anthropic:claude-opus-5-5` | Models under test, as comma-separated `provider:model` pairs. Providers: `openai`, `anthropic`. |
| `JUDGE_MODEL` | `anthropic:claude-sonnet-5-5` | The model that grades every answer. Keep it out of `EVAL_MODELS` so no model grades itself. |
| `MAX_CONCURRENT_PER_PROVIDER` | `4` | Model calls in flight per provider, answers and judging together. |

Start the local task server. It loads `.env` when it starts:

```bash
npm run build
render workflows dev -- node dist/main.js
```

In another terminal, run the eval. Task input is a JSON array of the task's arguments, here the tickets and the cases:

```bash
render workflows tasks runs start runEval --local --input="[$(cat tickets.json), $(cat cases.json)]"
```

The result looks like this (trimmed):

```json
{
  "judge": "anthropic:claude-sonnet-5-5",
  "cases": 5,
  "scorecard": [
    {
      "model": "anthropic:claude-opus-5-5",
      "scored": 5, "passed": 4, "pass_rate": 0.8, "avg_score": 4.4,
      "latency_ms": {"p50": 5129, "max": 5397},
      "tokens": {"input": 2861, "output": 1113},
      "failures": [{"ticket_id": "TCK-1002", "reasons": ["not met: Gives at least one concrete step to try other than clearing cookies"]}],
      "errors": []
    }
  ],
  "results": ["… every answer and verdict …"]
}
```

To try one model on one ticket, or the judge on its own:

```bash
render workflows tasks runs start answerCase --local \
  --input='["anthropic:claude-opus-5-5", {"id": "TCK-1003", "account_id": "ACC-300", "order_id": null, "subject": "Why is my account past due?", "body": "I got an email saying my account is past due. What do I owe?"}]'
```

## Deploy to Render

1. Push this folder to a Git repository Render can access.
2. In the Render Dashboard, click **New > Workflow** and connect the repository.
3. Set these fields:

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `llm-evals` (the folder that holds `package.json`). Leave it empty if this folder is the repository root. |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/main.js` |
   | Region | Any |
   | Environment variables | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and optionally `EVAL_MODELS`, `JUDGE_MODEL` and `MAX_CONCURRENT_PER_PROVIDER` |

4. Create the workflow. Once the first version is ready, run `runEval` from the Dashboard with the contents of `tickets.json` and `cases.json` as a two-element JSON array: `[<tickets>, <cases>]`.

To compare other models, change `EVAL_MODELS` or `JUDGE_MODEL` in the service's environment and run the eval again.

## Trigger from another service

`src/client.ts` runs the eval with the Render SDK and prints the scorecard:

```bash
export RENDER_API_KEY=your-render-api-key
export WORKFLOW_SLUG=your-workflow-slug   # defaults to llm-evals
npm run build
npm run client
```

The core of it:

```typescript
import { Render } from "@renderinc/sdk";

const render = new Render(); // reads RENDER_API_KEY

const run = await render.workflows.runTask(`${SLUG}/runEval`, [tickets, cases]);
if (run.status === "completed") {
  const report = run.results[0]; // results is an array holding the return value
  for (const s of report.scorecard) console.log(s.model, s.pass_rate, s.avg_score);
}
```

`runTask` waits for the run to finish. To start a run and check on it later, use `startTask` instead.

## Limits and gotchas

- **Render doesn't cap concurrency for you.** Render queues runs only when they'd exceed your workspace's compute limits, so a large eval can start hundreds of model calls at once. `runEval` holds a semaphore per provider around each `ctx.run`. Set `MAX_CONCURRENT_PER_PROVIDER` to what your rate limits allow. See [limits](https://render.com/docs/workflows-limits).
- **Retries are for the API, not the model.** `answerCase` and `judgeAnswer` raise on 429s, 5xx errors and connection errors, and Render retries them up to three times (2, 4 and 8 seconds apart). A refusal, a truncated answer, or output that doesn't match the schema is the model's result, so it's scored as a failed case and not retried. There's no fallback model either, since it would score a different model's answer. See [retries](https://render.com/docs/workflows-defining-tasks#retry-settings).
- **Errors a retry can't fix are returned, not raised.** A missing API key, an unknown model (404), or another provider 400/401/403/413/422 comes back as `{ error: ... }` and is listed under the model's `errors`, not scored. If the judge's key is missing, `runEval` stops before calling any model.
- **`runEval` doesn't retry.** A retry would rerun every model call. Each answer and verdict is its own run, so one failure costs one call.
- **Chained runs are rate limited.** A workspace can start up to 1,000 chained runs per minute, and `ctx.run` fails past that. Each case is two chained runs (answer and verdict), so keep big datasets under that rate.
- **Latency is measured inside the task**, around the API call. It doesn't include run startup or time spent waiting for the semaphore.
- **Timeouts apply per attempt.** `timeoutSeconds: 120` bounds each attempt of `answerCase` and `judgeAnswer`, and a retry gets a fresh 120 seconds. `runEval` has 30 minutes for the whole eval. See [timeouts](https://render.com/docs/workflows-defining-tasks#timeout).
- **Arguments are capped at 4 MB.** The combined arguments of a run can't exceed 4 MB. For a large dataset, pass a reference (a file in object storage, a table name) and load it in the task.
- **Five cases make a demo, not a benchmark.** Model output varies between runs, and so does the judge's. Use enough cases, and repeat runs, before you trust a difference in pass rate. Read the judge's `explanation` for a sample of verdicts, as a judge can be wrong.

## Links

- [Render Workflows](https://render.com/docs/workflows)
- [Defining tasks](https://render.com/docs/workflows-defining-tasks)
- [Triggering runs](https://render.com/docs/workflows-running)
- [Workflows SDK for TypeScript](https://render.com/docs/workflows-sdk-typescript)
- [OpenAI structured outputs](https://platform.openai.com/docs/guides/structured-outputs)
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
