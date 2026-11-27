# Batch CSV enrichment with the OpenAI Batch API

Enrich every row of a CSV (industry, size bucket, one-line summary) through the [OpenAI Batch API](https://platform.openai.com/docs/guides/batch) at half the price of normal API calls, with a Render Workflows task that waits for the batch, for minutes or up to 24 hours.

## What it shows

- A long, cheap wait on an external job: a task on the `flex` plan that sleeps between status checks, with a 24-hour timeout
- Splitting a job into tasks with their own retry policies: submit, wait, collect
- An idempotent submit: a retry or a rerun reuses the batch it already created, so it never pays twice
- Passing a CSV URL between tasks instead of the rows, to stay under the 4 MB argument limit
- Validating every model answer, joining results back to rows by ID, and returning failed rows instead of failing the run
- Starting a long run from another service and checking on it later

## Task tree

```
enrichCsv (orchestrator, flex, 24 h timeout, no retries)
  ├── submitBatch     builds JSONL, uploads it, creates the batch (retries 2×)
  │                    reuses an existing batch for the same rows
  ├── waitForBatch   flex, 24 h timeout: check status, sleep, repeat (retries 1×)
  └── collectResults  downloads output + error files, validates, joins by row ID (retries 2×)
```

## Why the wait is a sleep loop, not "retry until done"

Render Workflows has no durable sleep, so there are two ways to wait on a job that runs for hours:

1. **Sleep loop.** One task attempt checks the batch, sleeps, and checks again, inside a timeout of up to 24 hours.
2. **Retry as poll.** The task raises "not ready", and Render retries it after `waitDurationMs`, up to `maxRetries` times.

We measured both on Render (November 2026):

| | Sleep loop on `flex` | Retry as poll |
|---|---|---|
| What runs during the wait | One idle process: 0.15 CPU-seconds and about 35 MB over 10 minutes with 20 checks | Nothing. Each retry boots a fresh instance about 0.5 seconds before your code runs |
| Cost per check | About nothing: one HTTPS request | A cold start: about 0.5 CPU-seconds of startup, plus imports, every time |
| Cost of a 24-hour wait | About $0.04 at the [flex rates](https://render.com/docs/workflows-limits#the-flex-compute-plan) ($0.20 per CPU-hour, $0.05 per GB-hour) for those measurements | About $0.02 at one check every 5 minutes; more for frequent checks |
| How Render records it | One attempt | Each retry attempt's recorded duration includes the wait before it. The docs don't say whether that wait is billed |
| Limits | Timeout up to 24 hours per attempt | `maxRetries: 1000` and a 24-hour `waitDurationMs` both registered, and we ran 24 retries. The docs state no maximum |
| Side effects | Real errors keep their retries | Every check shows up as a failed attempt, and real errors share the same retry budget. A parent task that awaits it still has an open attempt (status `paused`) for the whole wait |

Both cost cents. The sleep loop is simpler, keeps retries for real failures, and costs about the same, so this example uses it. Retry as poll only gets cheaper when checks are many minutes apart, and it doesn't remove the wait from a parent task that awaits it.

Two details make the 24-hour limit fit. OpenAI's only completion window is 24 hours, so a batch reaches a final status (completed, expired, failed or cancelled) about when `waitForBatch` would time out. Expired batches still return the requests that finished. If a batch runs past that, `enrichCsv` times out. Run it again with the same CSV: `submitBatch` finds the batch it already created, so the rerun waits on that batch and pays for nothing twice.

## Prerequisites

- Node.js 22+
- The [Render CLI](https://render.com/docs/cli)
- An [OpenAI API key](https://platform.openai.com/api-keys) with Batch API access

## Run locally

```bash
npm install
cp .env.example .env
# Edit .env and set OPENAI_API_KEY. OPENAI_MODEL defaults to gpt-6.2-sol.
npm run build
```

Start the local task server. It loads `.env` when it starts:

```bash
render workflows dev -- node dist/main.js
```

In another terminal, enrich the bundled `companies.csv` (12 rows). Task input is a JSON array of the task's arguments, and `enrichCsv` takes an optional CSV URL:

```bash
render workflows tasks runs start enrichCsv --local --input='[]'
```

Small batches often finish within a few minutes, but OpenAI only promises 24 hours. The run returns the enriched rows, plus a `failed` list. Row `C-011` has no company name, so it's reported as failed without being sent.

To enrich your own CSV, host it at a URL the task can reach. It needs `id` and `company` columns; `website` and `description` are optional:

```bash
render workflows tasks runs start enrichCsv --local --input='["https://example.com/leads.csv"]'
```

You can also run the steps one at a time: `submitBatch` returns a `batch_id`, then `waitForBatch` and `collectResults` take it.

## Deploy to Render

1. Push this folder to a Git repository Render can access.
2. In the Render Dashboard, click **New > Workflow** and connect the repository.
3. Set these fields:

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `batch-enrichment` (the folder that holds `package.json`). Leave it empty if this folder is the repository root. |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/main.js` |
   | Region | Any |
   | Environment variables | `OPENAI_API_KEY`, and optionally `OPENAI_MODEL` and `BATCH_POLL_SECONDS` (default 60) |

4. Create the workflow. Once the first version is ready, run `enrichCsv` from the Dashboard with the input `[]`.

## Trigger from another service

`src/client.ts` starts `enrichCsv`, prints the run ID, and checks the run every 30 seconds until it finishes:

```bash
export RENDER_API_KEY=your-render-api-key
export WORKFLOW_SLUG=your-workflow-slug   # defaults to batch-enrichment
npm run build
npm run client                            # or: npm run client -- https://example.com/leads.csv
```

The core of it:

```typescript
import { Render } from "@renderinc/sdk";

const render = new Render(); // reads RENDER_API_KEY

const started = await render.workflows.startTask(`${SLUG}/enrichCsv`, []);
// ...later, from anywhere that has the run ID:
const details = await render.workflows.getTaskRun(started.taskRunId);
if (details.status === "completed") {
  const result = details.results[0]; // results is an array holding the return value
  console.log(result.enriched, result.failed);
}
```

A batch can take hours, so store the run ID and check it later (from a cron job, or when a user opens a status page) instead of holding a request open with `runTask`.

## Limits and gotchas

- **Timeouts apply per attempt, up to 24 hours.** `waitForBatch` and `enrichCsv` use the maximum. A retry gets a fresh timeout. See [timeouts](https://render.com/docs/workflows-defining-tasks#timeout) and [limits](https://render.com/docs/workflows-limits).
- **A retry reruns the task.** `submitBatch` is safe to retry because it looks for a batch with the same job key (a hash of the rows, model and prompt version) before creating one. Change `PROMPT_VERSION` when you change the prompt, or a rerun reuses the old batch. See [retries](https://render.com/docs/workflows-defining-tasks#retry-settings).
- **Arguments are capped at 4 MB.** Tasks pass the CSV URL and the batch ID, never the rows. `enrichCsv` returns the enriched rows inline, which is fine for a few thousand rows; for big files, write the results to your database or object storage in `collectResults` and return a count.
- **Batch API limits.** Up to 50,000 requests and 200 MB per batch, and output order doesn't match input order (results are joined by `custom_id`). See [OpenAI's batch guide](https://platform.openai.com/docs/guides/batch).
- **Errors a retry can't fix are returned, not raised.** A missing `OPENAI_API_KEY`, an unreadable CSV, an OpenAI 400/401/403/404/422, or a batch that fails validation comes back as `{ error: ... }`.
- **Run results are kept for 30 days.** Save enriched rows to your own storage if you need them longer. OpenAI keeps batch output files for 30 days by default.

## Links

- [Render Workflows](https://render.com/docs/workflows)
- [Defining tasks](https://render.com/docs/workflows-defining-tasks)
- [Limits and pricing](https://render.com/docs/workflows-limits)
- [Triggering runs](https://render.com/docs/workflows-running)
- [Workflows SDK for TypeScript](https://render.com/docs/workflows-sdk-typescript)
- [OpenAI Batch API](https://platform.openai.com/docs/guides/batch)
