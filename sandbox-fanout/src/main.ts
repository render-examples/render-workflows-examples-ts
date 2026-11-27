/**
 * Sandbox fan-out on Render Workflows
 *
 * Runs a batch of untrusted jobs in parallel, one Render Sandbox per job. Each
 * job is a Python script and an input CSV. A workflow task creates a sandbox,
 * copies the job in, runs it, copies the result out, and terminates the sandbox.
 * A second task fans the batch out and caps how many sandboxes run at once.
 *
 * The job code never runs on the workflow service itself. It runs in a sandbox
 * with outbound network access turned off.
 */
import { ClientError, Render, SandboxCreateWaitError } from "@renderinc/sdk";
import { task, type TaskContext } from "@renderinc/sdk/workflows";

// How many sandboxes runBatch keeps running at once. The default sandbox group
// allows 1,000 concurrent sandboxes on Pro workspaces and 100 on Hobby, and you
// can create at most 100 sandboxes per minute.
const MAX_SANDBOXES = Number(process.env.MAX_SANDBOXES ?? "2");

// How long one job's script may run inside its sandbox before it's stopped.
const JOB_TIMEOUT_SECONDS = Number(process.env.JOB_TIMEOUT_SECONDS ?? "60");

// Sandbox timeouts. The runtime timeout terminates the sandbox even if this
// task never reaches its finally block (for example, if the attempt is killed).
// It's set a little above the task timeout below. The minimums are 60 seconds
// for the runtime timeout and 300 seconds for the idle timeout.
const SANDBOX_TIMEOUT_SECONDS = 180;
const SANDBOX_IDLE_TIMEOUT_SECONDS = 300;

// Sandboxes API errors that mean the request itself is wrong: a bad API key, a
// workspace the key can't access, an invalid setting. A retry can't fix them,
// so runJob returns them as a result instead of throwing.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 422]);

type Job = {
  id: string;
  script: string;
  input_csv: string;
};

// What runJob returns: the job's output, or an error a retry can't fix.
type JobResult =
  | { job_id: string; sandbox_id: string; output: unknown; stdout: string }
  | { job_id: string; error: string };

// Keep the end of a long output, where errors usually are.
function tail(text: string, limit = 2000): string {
  return text.length <= limit ? text : "..." + text.slice(-limit);
}

// ---- Tasks ----

// runJob calls the Sandboxes API and runs code that might fail, so it retries
// once. Each attempt creates its own sandbox, so a retry starts clean.
const runJob = task(
  {
    name: "runJob",
    retry: { maxRetries: 1, waitDurationMs: 2000, backoffScaling: 2 },
    timeoutSeconds: 150,
  },
  async function runJob(_ctx: TaskContext, job: Job): Promise<JobResult> {
    const jobId = job.id ?? "unknown";

    // Render() reads RENDER_API_KEY, and the sandbox client needs the workspace
    // to create sandboxes in from RENDER_WORKSPACE_ID. A missing setting is a
    // problem a retry can't fix, so return it instead of throwing.
    const missing = ["RENDER_API_KEY", "RENDER_WORKSPACE_ID"].filter((name) => !process.env[name]);
    if (missing.length > 0) {
      return { job_id: jobId, error: `${missing.join(" and ")} not set` };
    }

    const sandboxes = new Render().sandboxes;
    let sandboxId: string | undefined;
    const started = Date.now();

    try {
      try {
        const sandbox = await sandboxes.create({
          name: `job-${jobId}`.slice(0, 64),
          // The job is untrusted code, so it gets no network access. To let it
          // reach specific HTTPS hosts, pass
          // { type: "allow-list", rules: [{ domain: "..." }] }.
          networkPolicy: { type: "deny-all" },
          timeoutSeconds: SANDBOX_TIMEOUT_SECONDS,
          idleTimeoutSeconds: SANDBOX_IDLE_TIMEOUT_SECONDS,
          wait: true,
        });
        sandboxId = sandbox.id;
      } catch (error) {
        if (error instanceof SandboxCreateWaitError) {
          // The sandbox exists but never reached running. Keep its ID so the
          // finally block terminates it, then let Render retry.
          sandboxId = error.sandboxId;
        } else if (error instanceof ClientError && PERMANENT_ERROR_STATUSES.has(error.statusCode)) {
          console.error(`[JOB] ${jobId}: Sandboxes API error ${error.statusCode}, not retrying`);
          return { job_id: jobId, error: `Sandboxes API error ${error.statusCode}: ${error.message}` };
        }
        throw error;
      }
      console.log(`[JOB] ${jobId}: running in sandbox ${sandboxId}`);

      // Relative paths resolve from the sandbox's home directory, which is
      // also where commands start.
      await sandboxes.upload(sandboxId, "job.py", job.script);
      await sandboxes.upload(sandboxId, "input.csv", job.input_csv);

      // result() waits for the command and collects its output.
      const { stdout, stderr, exitCode } = await sandboxes
        .exec(sandboxId, `timeout ${JOB_TIMEOUT_SECONDS} python3 job.py`)
        .result();

      // A nonzero exit code doesn't throw in the Sandboxes SDK. Throw here so
      // Render retries the job (in a new sandbox) and then marks the run failed.
      if (exitCode !== 0) {
        console.warn(`[JOB] ${jobId}: exited with code ${exitCode} in ${sandboxId}`);
        throw new Error(
          `Job ${jobId} exited with code ${exitCode} in sandbox ${sandboxId}: ${tail(stderr, 500)}`,
        );
      }

      // Copy the result out before the sandbox is terminated. Termination
      // deletes the sandbox's filesystem.
      const download = await sandboxes.download(sandboxId, "output.json");
      const output: unknown = JSON.parse(download.data.toString("utf-8"));

      console.log(`[JOB] ${jobId}: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return { job_id: jobId, sandbox_id: sandboxId, output, stdout: tail(stdout) };
    } finally {
      // Terminate on every path: success, a failed job, or an API error.
      if (sandboxId) {
        try {
          await sandboxes.terminate(sandboxId);
          console.log(`[JOB] ${jobId}: terminated sandbox ${sandboxId}`);
        } catch (error) {
          // Don't let a failed cleanup hide the job's own result or error. The
          // sandbox's runtime timeout still ends it.
          console.error(`[JOB] ${jobId}: couldn't terminate ${sandboxId}: ${error}`);
        }
      }
    }
  },
);

// runBatch only fans out, so it doesn't retry: a retry would rerun every job,
// including the ones that already finished. Each runJob run retries on its own.
task(
  {
    name: "runBatch",
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 900,
  },
  async function runBatch(ctx: TaskContext, jobs: Job[]) {
    console.log(`[BATCH] Running ${jobs.length} jobs, at most ${MAX_SANDBOXES} at a time`);

    // Each runJob run holds one sandbox, including while it retries. Start at
    // most MAX_SANDBOXES of them, and start the next job when one finishes.
    const settled: PromiseSettledResult<JobResult>[] = new Array(jobs.length);
    let next = 0;
    async function worker() {
      while (next < jobs.length) {
        const i = next++;
        try {
          settled[i] = { status: "fulfilled", value: await ctx.run(runJob, jobs[i]) };
        } catch (reason) {
          // Keep one failed job from failing the batch.
          settled[i] = { status: "rejected", reason };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_SANDBOXES, jobs.length) }, worker));

    const succeeded: Extract<JobResult, { output: unknown }>[] = [];
    const failed: Extract<JobResult, { error: string }>[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === "rejected") {
        failed.push({ job_id: jobs[i].id, error: String(outcome.reason) });
      } else if ("error" in outcome.value) {
        failed.push(outcome.value);
      } else {
        succeeded.push(outcome.value);
      }
    });

    console.log(`[BATCH] ${succeeded.length} succeeded, ${failed.length} failed`);
    return { total: jobs.length, succeeded: succeeded.length, failed, results: succeeded };
  },
);
