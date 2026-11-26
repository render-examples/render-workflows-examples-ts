# Sandbox Fan-out on Render Workflows

Run a batch of untrusted jobs in parallel from a workflow, each in its own [Render Sandbox](https://render.com/docs/sandboxes).

## What it shows

- Creating, using, and terminating a sandbox from a workflow task with the Render SDK
- Copying a job's script and input into a sandbox, and its result back out
- Blocking all outbound network access for untrusted code
- Raising on a nonzero exit code so Render retries the job in a new sandbox
- Fanning out one task run per job with `ctx.run`, with a cap on how many run at once
- Returning a batch summary that keeps failed jobs instead of failing the batch

Each job is a Python script and an input CSV, passed in as task input. The workflow service never runs the job's code itself. Sandboxes are in public beta.

## Task tree

```
runBatch (fans out, no retries, at most MAX_SANDBOXES jobs at once)
  └── runJob             (one per job, retries once)
        ├── sandboxes.create({ networkPolicy: { type: "deny-all" }, timeouts set })
        ├── upload: job.py, input.csv
        ├── exec: python3 job.py      ← nonzero exit throws, so Render retries
        ├── download: output.json
        └── finally: sandboxes.terminate
```

A retry runs the whole `runJob` again, so it gets a new sandbox. The `finally` block terminates the sandbox from every attempt.

## Prerequisites

- Node.js 18+
- The [Render CLI](https://render.com/docs/cli)
- A [Render API key](https://render.com/docs/api#1-create-an-api-key) for the workspace to create sandboxes in. The tasks need two [permissions](https://render.com/docs/api-keys#permissions) under **Sandboxes**: **Sandbox lifecycle and snapshots** set to **Read & write**, and **Sandbox execution and file transfer** set to **Execute**.
- That workspace's ID. It starts with `tea-` and is at the top of the workspace's **Settings** page.

Sandboxes are billed for the time they run. See [Sandboxes limits and pricing](https://render.com/docs/sandboxes-limits). Each sample job runs on the default `1c-2g` plan and is terminated as soon as it finishes.

## Run locally

```bash
npm install
cp .env.example .env
# Edit .env and set RENDER_API_KEY and RENDER_WORKSPACE_ID.
```

Build, then start the local task server. It loads `.env` when it starts:

```bash
npm run build
render workflows dev -- node dist/main.js
```

The tasks run on your machine, but the sandboxes they create are real ones in your workspace.

In another terminal, run the four sample jobs in `jobs.json`. Task input is a JSON array of the task's arguments, so the list of jobs is wrapped in one more array:

```bash
render workflows tasks runs start runBatch --local --input="[$(cat jobs.json)]"
```

Three jobs succeed. `average-discount` reads a `discount` column the CSV doesn't have, so its script exits with code 1. `runJob` throws, Render retries it once in a new sandbox, the retry fails the same way, and the batch lists the job under `failed`.

To run one job, pass it as the only argument to `runJob`:

```bash
render workflows tasks runs start runJob --local \
  --input='[{"id": "row-count", "input_csv": "a,b\n1,2\n3,4\n", "script": "import csv, json\nrows = list(csv.DictReader(open(\"input.csv\")))\njson.dump({\"rows\": len(rows)}, open(\"output.json\", \"w\"))\n"}]'
```

A job's script reads `input.csv` from its working directory and writes its result to `output.json`. Jobs are Python scripts, which the sandbox's default image runs with `python3`. The workflow itself is TypeScript.

## Deploy to Render

1. Push this folder to a Git repository Render can access.
2. In the Render Dashboard, click **New > Workflow** and connect the repository.
3. Set these fields:

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `sandbox-fanout` (the folder that holds `package.json`). Leave it empty if this folder is the repository root. |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/main.js` |
   | Region | Any. Sandboxes currently run only in Oregon. |
   | Environment variables | `RENDER_API_KEY` and `RENDER_WORKSPACE_ID`, and optionally `MAX_SANDBOXES` and `JOB_TIMEOUT_SECONDS` |

4. Create the workflow. Once the first version is ready, run `runBatch` from the Dashboard with the contents of `jobs.json` wrapped in a JSON array.

## Trigger from another service

`src/client.ts` triggers both tasks with the Render SDK:

```bash
export RENDER_API_KEY=your-render-api-key
export WORKFLOW_SLUG=your-workflow-slug   # defaults to sandbox-fanout
npm run build && npm run client
```

The core of it:

```typescript
import { Render } from "@renderinc/sdk";

const render = new Render(); // reads RENDER_API_KEY

const run = await render.workflows.runTask(`${SLUG}/runBatch`, [jobs]);
if (run.status === "completed") {
  const batch = run.results[0] as BatchResult; // results holds the return value
  console.log(batch.succeeded, batch.failed);
}
```

`runTask` waits for the run to finish. To start a run and check on it later, use `startTask` instead; it returns the run's `taskRunId`.

## Limits and gotchas

- **A nonzero exit code doesn't throw.** The Sandboxes SDK returns it from `exec(...).result()`. `runJob` checks it and throws, because Workflows only retries a task that throws. See [checking for command failure](https://render.com/docs/sandboxes-executing#checking-for-command-failure).
- **A retry reruns the whole job.** Each attempt of `runJob` creates a new sandbox and runs the script from the start. If your jobs write to outside systems, make those writes idempotent. See [retries](https://render.com/docs/workflows-defining-tasks#retry-settings).
- **Copy results out before you terminate.** Terminating a sandbox deletes its filesystem. `runJob` downloads `output.json` inside the `try` and terminates in `finally`.
- **Set both sandbox timeouts.** A new sandbox runs for up to 24 hours and suspends after 15 idle minutes unless you set `timeoutSeconds` and `idleTimeoutSeconds`. `runJob` sets 180 and 300 seconds, so a sandbox whose task attempt never reached `finally` still ends soon. See [timeouts](https://render.com/docs/sandboxes-creating#timeouts).
- **Timeouts apply per attempt.** `timeoutSeconds: 150` bounds each attempt of `runJob`, and a retry gets a fresh 150 seconds. Inside the sandbox, `timeout` stops a script after `JOB_TIMEOUT_SECONDS`. See [task timeouts](https://render.com/docs/workflows-defining-tasks#timeout).
- **No network for jobs.** `networkPolicy: { type: "deny-all" }` blocks all outbound traffic. To let a job reach specific HTTPS hosts, pass `{ type: "allow-list", rules: [{ domain: "api.example.com" }] }`. See [network policy](https://render.com/docs/sandboxes-creating#network-policy).
- **Concurrency and rate limits.** A sandbox group runs up to 1,000 sandboxes at once on Pro workspaces and 100 on Hobby, and you can create up to 100 sandboxes per minute. Over a limit, create fails with a 429, which `runJob` throws so Render retries it. Set `MAX_SANDBOXES` below your limits. See [sandbox limits](https://render.com/docs/sandboxes-limits).
- **Errors a retry can't fix are returned, not thrown.** A missing `RENDER_API_KEY` or `RENDER_WORKSPACE_ID`, or a 400/401/403/404/422 from the Sandboxes API, comes back as `{"job_id": ..., "error": ...}`. `runBatch` lists those jobs under `failed`.
- **Arguments are capped at 4 MB.** The combined arguments of a task run can't exceed 4 MB, and these jobs carry their script and CSV inline. For larger inputs, pass a URL and allow that host in the network policy. See [limits](https://render.com/docs/workflows-limits).
- **No private networking yet.** Sandboxes can't reach your other Render services over the private network. Results leave through the task's return value or public storage.

## Links

- [Render Sandboxes](https://render.com/docs/sandboxes)
- [Creating and configuring sandboxes](https://render.com/docs/sandboxes-creating)
- [Executing commands](https://render.com/docs/sandboxes-executing)
- [Uploading and downloading files](https://render.com/docs/sandboxes-files)
- [Sandboxes SDK for TypeScript](https://render.com/docs/sandboxes-sdk-typescript)
- [Render Workflows](https://render.com/docs/workflows)
- [Defining tasks](https://render.com/docs/workflows-defining-tasks)
