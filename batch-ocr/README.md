# Batch OCR on Render Workflows

Read the text out of many scanned PDFs with [Tesseract](https://github.com/tesseract-ocr/tesseract) and [Poppler](https://poppler.freedesktop.org/), one task run per document, on a Docker-based workflow service.

## What it shows

- A workflow service that builds from a `Dockerfile`, because Tesseract and Poppler are system binaries
- A small orchestrator task on `flex` and a CPU-heavy OCR task on `2c-4g`
- Passing documents by reference (a URL or a file name), not as bytes
- Classifying errors: bad input is returned as a failed result, a killed process or a network error is thrown so Render retries it
- Fanning out in chunks with `ctx.run` and `Promise.allSettled`, without failing the batch on one document
- Triggering the tasks from another service with the Render SDK client

## Task tree

```
ocrBatch             (flex, fans out one chunk at a time, no retries)
  └── ocrDocument    (2c-4g, one per document, retries twice)
        ├── fetch the PDF        ← https:// URL, or a file in samples/
        ├── pdfinfo              ← page count
        ├── pdftoppm             ← one PNG per page
        └── tesseract            ← text of each page, two pages at a time
```

How `ocrDocument` handles each failure:

| What happened | Example | What the task does |
|---|---|---|
| The input is bad | Corrupt PDF, a tool exits with code > 0, HTTP 404, too many pages | Returns `{"doc_ref", "error"}`. No retry |
| The tool isn't installed | `tesseract` missing when you run outside Docker | Returns `{"doc_ref", "error"}`. No retry |
| A tool was killed by a signal | The out-of-memory killer sends SIGKILL to `tesseract` | Throws. Render retries the run |
| The network failed | DNS error, connection reset, timeout, HTTP 429 or 5xx | Throws. Render retries the run |

A task has no "don't retry this error" option: any error it throws uses up an attempt. So errors a retry can't fix are returned as results instead.

## Prerequisites

- Node.js 22+ (the `Dockerfile` uses Node.js 24)
- The [Render CLI](https://render.com/docs/cli)
- Tesseract and Poppler, to run locally (`brew install tesseract poppler`, or `apt-get install tesseract-ocr poppler-utils`). On Render, the `Dockerfile` installs them.
- No API keys

## Run locally

Render's local task server doesn't build Dockerfiles, so run the service with the tools installed on your machine:

```bash
brew install tesseract poppler
npm install
npm run build
render workflows dev -- node dist/main.js
```

In another terminal, OCR one document. Task input is a JSON array of the task's arguments, and a document is a file name in `samples/` or an `https://` URL:

```bash
render workflows tasks runs start ocrDocument --local --input='["invoice-1042.pdf"]'
```

OCR four of the samples at once. `corrupt.pdf` isn't a valid PDF, so it comes back under `failed` after one attempt:

```bash
render workflows tasks runs start ocrBatch --local \
  --input='[["invoice-1042.pdf", "delivery-receipt-2207.pdf", "plan-amendment.pdf", "corrupt.pdf"]]'
```

To see a retry, OCR a URL that can't resolve. The run throws a network error on all three attempts, then fails:

```bash
render workflows tasks runs start ocrDocument --local --input='["https://scans.example.invalid/invoice.pdf"]'
```

Optional settings, with their defaults, are in `.env.example`. Copy it to `.env` to change them.

## Deploy to Render

Docker-based workflow services can only be created in the Render Dashboard, not with the CLI or API. They build from a Dockerfile in your repository; they can't pull a prebuilt image from a registry.

1. Push this folder to a Git repository Render can access.
2. In the Render Dashboard, click **New > Workflow** and connect the repository.
3. Set these fields:

   | Field | Value |
   |---|---|
   | Language | Docker |
   | Root Directory | `batch-ocr` (the folder that holds the `Dockerfile`). Leave it empty if this folder is the repository root. |
   | Dockerfile Path | `./Dockerfile` |
   | Start Command | `node dist/main.js` (required for Docker-based workflows, even though the `Dockerfile` has a `CMD`) |
   | Region | Any |
   | Environment variables | None required. Optionally the settings in `.env.example` |

   There's no Build Command for Docker-based workflows: the `Dockerfile` installs dependencies and runs `npm run build`.

4. Create the workflow. Once the first version is ready, run `ocrBatch` from the Dashboard with `[["invoice-1042.pdf", "delivery-receipt-2207.pdf", "plan-amendment.pdf", "corrupt.pdf"]]`.
5. To see an out-of-memory retry, run `ocrDocument` with `["site-plan-oversized.pdf"]`. That PDF is 3 KB, but its two pages are 60 inches square: at 300 DPI each one is an 18,000 × 18,000 pixel image, and Tesseract needs about 3.5 GB to read it. Two pages at once don't fit in `2c-4g`'s 4 GB, so the kernel kills `tesseract`, the task throws `tesseract was killed by SIGKILL`, and Render retries the run. Every attempt runs out of memory the same way, so the run fails after three attempts. With `OCR_PAGE_WORKERS=1`, the same document fits and returns its text.

`ocrDocument` runs on the `2c-4g` plan, which bills per second of each run. See [compute plans](https://render.com/docs/workflows-limits#compute-plans).

## Trigger from another service

`src/client.ts` triggers both tasks with the Render SDK:

```bash
export RENDER_API_KEY=your-render-api-key
export WORKFLOW_SLUG=your-workflow-slug   # defaults to batch-ocr
npm run build && npm run client
```

The core of it:

```typescript
import { Render } from "@renderinc/sdk";

const render = new Render(); // reads RENDER_API_KEY

const run = await render.workflows.runTask(`${SLUG}/ocrBatch`, [["invoice-1042.pdf", "https://..."]]);
if (run.status === "completed") {
  const batch = run.results[0] as BatchResult; // results holds the return value
  console.log(batch.succeeded, batch.failed);
}
```

In your own app, upload each scan to object storage and pass a presigned `https://` URL. `runTask` waits for the run to finish. To start a run and check on it later, use `startTask` instead; it returns the run's `taskRunId`.

## Limits and gotchas

- **Pass references, not files.** The combined arguments of a task run can't exceed 4 MB, so pass URLs or keys, not PDF bytes. See [limits](https://render.com/docs/workflows-limits#additional-limits).
- **Results stay on Render for 30 days.** `ocrDocument` returns the text of every page, and `ocrBatch` returns all of it. For large documents, write the text to your own storage and return its key. See [state retention](https://render.com/docs/workflows-limits#state-retention).
- **Chained runs are rate limited.** A workspace can start 1,000 chained runs per minute. Over that, `ctx.run` fails instead of queueing. `ocrBatch` starts `BATCH_CHUNK_SIZE` runs (default 20), waits for them, then starts the next chunk. A document whose run couldn't start is listed under `failed`. See [rate limits](https://render.com/docs/workflows-limits#chained-runs).
- **Timeouts apply per attempt.** Each attempt of `ocrDocument` gets 600 seconds and each retry gets a fresh 600. `ocrBatch` gets 3,600 seconds for the whole batch: every chunk lasts as long as its slowest document, retries included. Raise it for bigger batches. See [timeouts](https://render.com/docs/workflows-defining-tasks#timeout).
- **A retry reruns the whole document.** Retries start over on a new instance, so a 50-page PDF that fails on page 49 is OCRed again from page 1. Reading and OCR have no side effects, so that's safe. See [retries](https://render.com/docs/workflows-defining-tasks#retry-settings).
- **Retries only help when the next attempt can pass.** An out-of-memory kill caused by huge pages happens again on the same plan, as `site-plan-oversized.pdf` shows. If a document fails on every attempt with `killed by SIGKILL`, lower `OCR_DPI`, lower `OCR_PAGE_WORKERS` or move `ocrDocument` to a plan with more memory.
- **OCR isn't exact.** Tesseract misreads some characters, especially on noisy scans. Check the fields you depend on.

## Links

- [Render Workflows](https://render.com/docs/workflows)
- [Using Docker with workflows](https://render.com/docs/workflows-tutorial#using-docker)
- [Defining tasks](https://render.com/docs/workflows-defining-tasks)
- [Limits and pricing](https://render.com/docs/workflows-limits)
- [Workflows SDK for TypeScript](https://render.com/docs/workflows-sdk-typescript)
- [Tesseract documentation](https://tesseract-ocr.github.io/)
