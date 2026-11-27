# Web Service API on Render Workflows

The smallest correct way to put a web service in front of a workflow: an Express service starts a task run, returns `202 Accepted` with the run ID, and reports the run's status and result when the client asks.

## What it shows

- Starting a task from a web service with the Render SDK and returning `202` right away
- A client-supplied idempotency key, so a retried request returns the run it first started
- Reading a run's status and result by ID, with `404` for unknown IDs
- Rejecting bad input with `400` in the API, so it never becomes a task run
- Keeping `RENDER_API_KEY` on the server, with the web service as the only caller of the workflow
- A task that needs no API keys: it builds a sales report from a bundled dataset and retries if an attempt fails

## How it works

```
client ──POST /jobs──────────────▶ API service (Express)
         Idempotency-Key: k1         1. check region and quarter (400 if bad)
         {"region", "quarter"}       2. startTask("buildReport", { idempotencyKey: k1 })
       ◀── 202 {"run_id": "trn-…"} ──

workflow service
buildReport (retries twice)
  ├── check the input again (runs can also start from the Dashboard or CLI)
  ├── total each month of the quarter from sales.json   ← about 1 second per month
  └── return the report

client ──GET /jobs/trn-…─────────▶ API service
                                     getTaskRun(runId)
       ◀── {"status": "running"}
       ◀── {"status": "completed", "result": {...}}
```

`src/api.ts` is the web service, `src/workflow.ts` is the workflow service, and `src/report.ts` and `sales.json` are shared. Both services deploy from this one folder. The API stores nothing: Render keeps each run's status and result, so the run ID is all a client needs.

## Prerequisites

- Node.js 22+
- The [Render CLI](https://render.com/docs/cli)
- For the deployed API: a [Render API key](https://render.com/docs/api-keys) with the **Workflows: Read** and **Run workflow tasks: Run** permissions

The task itself needs no API keys.

## Run locally

```bash
npm install
npm run build
```

Start the local task server:

```bash
render workflows dev -- node dist/workflow.js
```

In a second terminal, start the API. `RENDER_USE_LOCAL_DEV=true` points its Render client at the local task server, so it needs no Render API key. It listens on port 8000, or on `PORT` if set:

```bash
RENDER_USE_LOCAL_DEV=true node dist/api.js
```

If you started the task server on another port (`render workflows dev --port 8121 ...`), also set `RENDER_LOCAL_DEV_URL=http://localhost:8121`.

In a third terminal, start a job. `job.json` asks for the EMEA report for 2026-Q3:

```bash
curl -i localhost:8000/jobs -H 'Idempotency-Key: demo-1' --json @job.json
```

```
HTTP/1.1 202 Accepted
location: /jobs/trn-d4mdone8m85cmm69gg0
...
{"run_id":"trn-d4mdone8m85cmm69gg0"}
```

Then check it. The run takes about three seconds:

```bash
curl localhost:8000/jobs/trn-d4mdone8m85cmm69gg0
```

```json
{"run_id":"trn-d4mdone8m85cmm69gg0","status":"completed","result":{"region":"emea","quarter":"2026-Q3","revenue":61522,"units":528,"top_product":"team-pack",...}}
```

Bad input returns `400` and starts nothing:

```bash
curl -i localhost:8000/jobs -H 'Idempotency-Key: demo-2' --json '{"region": "mars", "quarter": "2026-Q3"}'
# HTTP/1.1 400 Bad Request
# {"detail":"region must be one of amer, apac, emea"}
```

You can also run the task without the API:

```bash
render workflows tasks runs start buildReport --local --input='["apac", "2026-Q2"]'
```

The local task server doesn't apply idempotency keys: sending the same `Idempotency-Key` twice starts two runs locally. It also drops the connection when asked for a run ID it doesn't know, so `GET /jobs/<unknown>` returns `502` locally and `404` on Render. Both behave as described below once deployed.

## Deploy to Render

Create two services in the Render Dashboard, connected to your repository:

1. **Workflow service**: **New > Workflow**.

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `web-service-api` (leave empty if this folder is the repository root) |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/workflow.js` |

   No environment variables are needed. Note the service's slug, shown on its page.

2. **Web service**: **New > Web Service**.

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `web-service-api` |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/api.js` |
   | Health Check Path | `/healthz` |
   | Environment variables | `RENDER_API_KEY`, `WORKFLOW_SLUG` |

`RENDER_API_KEY` is a [Render API key](https://render.com/docs/api-keys) created in the same workspace as the workflow service. Grant it **Workflows: Read** (to read runs and their results) and **Run workflow tasks: Run** (to start runs), and nothing else. `WORKFLOW_SLUG` is the workflow service's slug; the API starts `<WORKFLOW_SLUG>/buildReport`.

The API key stays on the web service. Anyone holding it can start and read any task run in the workspace, so never ship it to a browser, a mobile app, or a client script. Clients call your API instead, and the API decides what they may start. To try the deployed API:

```bash
API_URL=https://your-web-service.onrender.com
curl -i $API_URL/jobs -H 'Idempotency-Key: demo-1' --json @job.json
curl -i $API_URL/jobs -H 'Idempotency-Key: demo-1' --json @job.json   # same run_id as the first call
curl $API_URL/jobs/<run_id>
```

## Trigger from another service

The web service is the other service. The core of it, from `src/api.ts`:

```typescript
import { Render } from "@renderinc/sdk";

const render = new Render(); // reads RENDER_API_KEY

// POST /jobs
const run = await render.workflows.startTask(`${SLUG}/buildReport`, [region, quarter], {
  // Within 24 hours, the same key returns the run it first started.
  idempotencyKey: `buildReport:${idempotencyKey}`,
});
res.status(202).json({ run_id: run.taskRunId });

// GET /jobs/:runId
const details = await render.workflows.getTaskRun(runId);
details.status;      // "pending", "running", "completed", "failed", ...
details.results[0];  // buildReport's return value, once completed
```

`getTaskRun` throws a `ClientError` with `statusCode === 404` for an unknown run ID.

## Limits and gotchas

- **Results stay on Render for 30 days.** Render keeps each run's arguments and return value for 30 days. After that, the API has nothing to return. If clients need results longer, have the API (or the task) write them to your own database. [`ai-chat-turns`](../ai-chat-turns) shows that pattern with Postgres. See [state retention](https://render.com/docs/workflows-limits#state-retention).
- **Idempotency keys last 24 hours and ignore the body.** Within 24 hours of the first run, the same key returns that run, even if the request asks for a different region or quarter. After 24 hours, the same key starts a new run. Generate a new key for every distinct job. See [idempotency keys](https://render.com/docs/workflows-running#idempotency-keys).
- **The API reads any run its key can read.** Render API key permissions apply to a whole workspace, not to one workflow, so `GET /jobs/{run_id}` returns any task run in the workspace, not only `buildReport` runs. Run IDs are random and the API only hands out its own, but if clients mustn't see each other's jobs, add authentication and record which run belongs to whom, as `ai-chat-turns` does.
- **A retry reruns the whole task.** `buildReport` only reads, so its two retries are safe. A task that writes needs to be idempotent before it retries. See [retries](https://render.com/docs/workflows-defining-tasks#retry-settings).
- **Timeouts apply per attempt.** `timeoutSeconds: 60` bounds each attempt of `buildReport`, and a retry gets a fresh 60 seconds.
- **Arguments are capped at 4 MB.** Pass IDs or small values like the region and quarter here, not large payloads. See [limits](https://render.com/docs/workflows-limits).

## Links

- [Render Workflows](https://render.com/docs/workflows)
- [Triggering runs](https://render.com/docs/workflows-running)
- [Local development](https://render.com/docs/workflows-local-development)
- [Workflows SDK for TypeScript](https://render.com/docs/workflows-sdk-typescript)
- [Render API keys](https://render.com/docs/api-keys)
- [Express](https://expressjs.com/)
