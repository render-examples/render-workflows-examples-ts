/**
 * Web service API: the web service
 *
 * An Express app that puts an HTTP API in front of the buildReport task:
 *
 * 1. POST /jobs with a region, a quarter and an Idempotency-Key header. The API
 *    checks the input, starts buildReport, and returns 202 with the run ID.
 * 2. GET /jobs/:runId to read the run's status, and its result once it's done.
 *
 * The API stores nothing. Render keeps each run's status and result, so the run
 * ID is all a client needs.
 */
import { ClientError, Render } from "@renderinc/sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import { checkRequest } from "./report.js";

const SLUG = process.env.WORKFLOW_SLUG ?? "web-service-api";
const PORT = Number(process.env.PORT ?? "8000");
const RUN_ID = /^trn-[a-z0-9]+$/;

// Reads RENDER_API_KEY, or RENDER_USE_LOCAL_DEV to use the local task server.
const render = new Render();

const app = express();
app.use(express.json());

app.post("/jobs", async (req, res) => {
  const idempotencyKey = req.get("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length > 200) {
    res.status(400).json({ detail: "Send an Idempotency-Key header of 1 to 200 characters" });
    return;
  }
  // Check everything here, so bad input never becomes a task run.
  const { region, quarter } = req.body ?? {};
  const problem = checkRequest(region, quarter);
  if (problem) {
    res.status(400).json({ detail: problem });
    return;
  }

  let runId: string;
  try {
    // Within 24 hours, the same key returns the run it first started, even if
    // the body is different. A client that times out can send the same request
    // again without starting a second run.
    const run = await render.workflows.startTask(`${SLUG}/buildReport`, [region, quarter], {
      idempotencyKey: `buildReport:${idempotencyKey}`,
    });
    runId = run.taskRunId;
  } catch (error) {
    console.error("[API] Couldn't start buildReport:", error);
    res.status(503).json({ detail: "Couldn't start the job. Send the same request again." });
    return;
  }

  console.log(`[API] ${idempotencyKey} -> ${runId}`);
  res.status(202).location(`/jobs/${runId}`).json({ run_id: runId });
});

app.get("/jobs/:runId", async (req, res) => {
  const { runId } = req.params;
  if (!RUN_ID.test(runId)) {
    res.status(404).json({ detail: "No such job" });
    return;
  }

  let details: Awaited<ReturnType<typeof render.workflows.getTaskRun>>;
  try {
    details = await render.workflows.getTaskRun(runId);
  } catch (error) {
    // Render answers 400 for a run ID it doesn't know.
    if (error instanceof ClientError && (error.statusCode === 400 || error.statusCode === 404)) {
      res.status(404).json({ detail: "No such job" });
      return;
    }
    console.error(`[API] Couldn't read ${runId}:`, error);
    res.status(502).json({ detail: "Couldn't read the job. Try again." });
    return;
  }

  const job: Record<string, unknown> = { run_id: details.id, status: details.status };
  if (details.status === "completed") {
    // buildReport returns { error } for input a retry can't fix.
    job.result = details.results?.[0] ?? null;
  } else if (details.status === "failed") {
    job.error = details.error ?? "The run failed";
  }
  res.json(job);
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// express.json() rejects a body that isn't valid JSON. Answer with the same
// 400 shape as other bad input instead of Express's default HTML page.
app.use((error: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
  if (error.status === 400) {
    res.status(400).json({ detail: "The request body must be valid JSON" });
    return;
  }
  next(error);
});

app.listen(PORT, () => console.log(`[API] Listening on port ${PORT}`));
