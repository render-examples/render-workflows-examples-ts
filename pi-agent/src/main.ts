/**
 * Pi coding agent on Render Workflows
 *
 * runPi clones a Git repository, runs an in-memory Pi session that edits the
 * code to fix a support ticket, and returns the change: a patch for a small
 * change, or a pushed branch for a large one. runPiBatch fans it out across
 * many tickets, one task run each.
 *
 * Git work uses the git CLI, which Render's native Node runtime includes.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { task, type TaskContext } from "@renderinc/sdk/workflows";

// Read the model from the environment so a retired model is a config change,
// not a code change. Pi reads the key itself from ANTHROPIC_API_KEY.
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";

// Upper bound on agent turns per ticket. A turn is one model response plus the
// tool calls it makes.
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? "20");

// Patches up to this size come back in the result. Bigger changes are pushed
// to a branch instead.
const MAX_PATCH_BYTES = Number(process.env.MAX_PATCH_BYTES ?? "20000");

// Pi's built-in tools, minus bash. Without bash the agent can read and edit
// files in the clone, but it can't run commands, so it can't read this
// service's environment variables (your API key and push token).
const TOOLS = ["read", "edit", "write", "ls"];

// Provider HTTP statuses that mean the request itself is wrong: bad key,
// unknown model, invalid input. A retry can't fix them, so runPi returns them
// as a result instead of throwing.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 422]);

const INSTRUCTIONS = `You fix support tickets by changing the code in this repository.
Read the relevant code first. Make the smallest change that fixes the problem
the ticket describes, and keep the existing style. You can't run commands or
tests. If the ticket doesn't need a code change, change nothing. Finish with a
short summary of what you changed and why, or why no change was needed.`;

type Ticket = {
  id: string;
  account_id: string;
  order_id: string | null;
  subject: string;
  body: string;
};

type RunPiInput = {
  // HTTPS URL of the repository to clone.
  repoUrl: string;
  ticket: Ticket;
  // Branch or tag to clone. Defaults to the repository's default branch.
  ref?: string;
  // Folder inside the repository the agent works in. Defaults to the root.
  subdir?: string;
};

// What runPi returns. Every kind carries the ticket ID.
type PiResult =
  | { ticket_id: string; kind: "diff"; patch: string; files: string[]; summary: string }
  | { ticket_id: string; kind: "branch"; name: string; files: string[]; summary: string }
  | { ticket_id: string; kind: "pushFailed"; error: string; patch: string; files: string[]; summary: string }
  | { ticket_id: string; kind: "noChanges"; summary: string }
  | { ticket_id: string; kind: "error"; error: string };

function formatTicket(ticket: Ticket): string {
  return [
    `Ticket: ${ticket.id}`,
    `Account: ${ticket.account_id}`,
    `Order: ${ticket.order_id ?? "none"}`,
    `Subject: ${ticket.subject}`,
    "",
    ticket.body,
  ].join("\n");
}

const execFileAsync = promisify(execFile);

// Runs git in `cwd` and returns its output. Credential helpers configured on
// the machine are cleared, so git only ever uses GITHUB_TOKEN. When it's set, a
// helper hands it to git for clones and pushes, so the token never appears in a
// command line or a remote URL. GitHub accepts a token as the password with any
// username.
async function runGit(cwd: string, args: string[]): Promise<string> {
  const auth = ["-c", "credential.helper="];
  if (process.env.GITHUB_TOKEN) {
    auth.push("-c", 'credential.helper=!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f');
  }
  const { stdout } = await execFileAsync("git", [...auth, ...args], {
    cwd,
    // Fail instead of waiting for a username and password on a terminal.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

// git's message for a failed command, without the command line.
function gitError(error: unknown): string {
  const stderr = (error as { stderr?: string })?.stderr?.trim();
  return stderr || String((error as Error)?.message ?? error);
}

// Clone failures a retry can't fix: the repository or ref doesn't exist, or
// the credentials can't read it. Anything else (DNS, connection reset, a 5xx)
// is worth a retry.
const PERMANENT_CLONE_ERROR =
  /not found|could not read Username|Authentication failed|returned error: 40[0134]|not a valid repository/i;

// The HTTP status of a Pi provider error message ("<status> <response body>").
function errorStatus(message: string | undefined): number | undefined {
  const match = /^(\d{3}) /.exec(message ?? "");
  return match ? Number(match[1]) : undefined;
}

// An error a retry can't fix. runPi returns these as results instead of
// throwing, because a thrown error always retries.
class PermanentError extends Error {}

// Runs Pi in `cwd` until it settles and returns its summary. Throws
// PermanentError for errors a retry can't fix, and a plain Error otherwise.
async function runAgent(cwd: string, agentDir: string, prompt: string): Promise<string> {
  // Keep Pi's state (credentials file, settings) in a temporary directory
  // instead of ~/.pi, and nothing on disk outlives the run.
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const model = modelRuntime.getModel("anthropic", MODEL);
  if (!model) throw new PermanentError(`Pi doesn't know the model anthropic/${MODEL}`);

  // Render retries this task, so turn off Pi's own retries to keep one retry
  // policy in charge.
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  // Load the repository's AGENTS.md (or CLAUDE.md) for its conventions, but no
  // extensions, skills or prompt templates: those can run code from the clone.
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [INSTRUCTIONS],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: "low",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: TOOLS,
  });

  let turns = 0;
  let hitTurnLimit = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      console.log(`[PI] ${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`);
    }
    if (event.type === "turn_end" && ++turns >= MAX_TURNS && !hitTurnLimit) {
      hitTurnLimit = true;
      void session.abort();
    }
  });

  try {
    await session.prompt(prompt);
    if (hitTurnLimit) throw new PermanentError(`Hit the limit of ${MAX_TURNS} agent turns`);
    // Pi doesn't throw on provider errors. It ends the run with the error on
    // the last assistant message.
    const last = session.messages.at(-1) as { stopReason?: string; errorMessage?: string } | undefined;
    if (last?.stopReason === "error") {
      const message = `Provider error: ${last.errorMessage ?? "unknown"}`;
      const status = errorStatus(last.errorMessage);
      if (status && PERMANENT_ERROR_STATUSES.has(status)) throw new PermanentError(message);
      // Rate limits, overloaded or unreachable provider: worth a retry.
      throw new Error(message);
    }
    return session.getLastAssistantText() ?? "";
  } finally {
    unsubscribe();
    session.dispose();
  }
}

// Stages every change in the clone and returns the patch against HEAD, with
// paths relative to the repository root. git uses /dev/null for added and
// deleted files, so the patch applies with `git apply`. Ignored files are left
// out.
async function stagedPatch(dir: string): Promise<{ patch: string; files: string[] }> {
  await runGit(dir, ["add", "--all"]);
  const files = (await runGit(dir, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
  const patch = files.length ? await runGit(dir, ["diff", "--cached"]) : "";
  return { patch, files };
}

// Commits the staged changes on a new branch and pushes it. The branch name
// comes from the ticket, so a retried run overwrites the same branch instead of
// creating a second one.
async function pushBranch(dir: string, name: string, ticket: Ticket): Promise<void> {
  if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set, so the branch can't be pushed");
  await runGit(dir, ["checkout", "-b", name]);
  await runGit(dir, [
    "-c",
    `user.name=${process.env.GIT_AUTHOR_NAME ?? "Pi agent"}`,
    "-c",
    `user.email=${process.env.GIT_AUTHOR_EMAIL ?? "pi-agent@example.com"}`,
    "commit",
    "--quiet",
    "--message",
    `Fix ${ticket.id}: ${ticket.subject}`,
  ]);
  await runGit(dir, ["push", "--force", "origin", `HEAD:refs/heads/${name}`]);
}

// ---- Tasks ----

// runPi calls the model provider and clones over the network, so it retries
// once if an attempt fails. A retry reruns the whole agent on a fresh clone.
// Its only write is the push, which is its last step, goes to a fixed branch
// name, and returns failures instead of throwing, so a push is never retried
// on its own.
const runPi = task(
  {
    name: "runPi",
    retry: { maxRetries: 1, waitDurationMs: 5000, backoffScaling: 2 },
    timeoutSeconds: 900,
  },
  async function runPi(_ctx: TaskContext, input: RunPiInput): Promise<PiResult> {
    const ticketId = input?.ticket?.id ?? "unknown";
    if (!input?.repoUrl || !input?.ticket) {
      return { ticket_id: ticketId, kind: "error", error: "Input needs repoUrl and ticket" };
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      // A setup problem a retry can't fix, so return it instead of throwing.
      return { ticket_id: ticketId, kind: "error", error: "ANTHROPIC_API_KEY is not set" };
    }
    console.log(`[PI] ${ticketId}: ${input.ticket.subject} (${input.repoUrl})`);

    // Each run works in its own temporary directory, removed when it ends.
    const workDir = await mkdtemp(join(tmpdir(), "pi-run-"));
    const repoDir = join(workDir, "repo");
    const agentDir = join(workDir, "pi");
    try {
      const branchArgs = input.ref ? ["--branch", input.ref] : [];
      try {
        await runGit(workDir, ["clone", "--quiet", "--depth", "1", ...branchArgs, "--", input.repoUrl, repoDir]);
      } catch (error) {
        const message = gitError(error);
        if (PERMANENT_CLONE_ERROR.test(message)) {
          return { ticket_id: ticketId, kind: "error", error: `Couldn't clone ${input.repoUrl}: ${message}` };
        }
        throw new Error(`git clone failed: ${message}`);
      }

      const cwd = input.subdir ? join(repoDir, input.subdir) : repoDir;
      if (!existsSync(cwd)) {
        return { ticket_id: ticketId, kind: "error", error: `No folder ${input.subdir} in the repository` };
      }

      let summary: string;
      try {
        summary = await runAgent(cwd, agentDir, formatTicket(input.ticket));
      } catch (error) {
        if (error instanceof PermanentError) {
          console.error(`[PI] ${ticketId}: ${error.message}, not retrying`);
          return { ticket_id: ticketId, kind: "error", error: error.message };
        }
        throw error;
      }

      const { patch, files } = await stagedPatch(repoDir);
      if (files.length === 0) {
        console.log(`[PI] ${ticketId}: no changes`);
        return { ticket_id: ticketId, kind: "noChanges", summary };
      }
      if (Buffer.byteLength(patch) <= MAX_PATCH_BYTES) {
        console.log(`[PI] ${ticketId}: returning a patch for ${files.join(", ")}`);
        return { ticket_id: ticketId, kind: "diff", patch, files, summary };
      }

      const branch = `pi/${ticketId.toLowerCase()}`;
      try {
        await pushBranch(repoDir, branch, input.ticket);
      } catch (error) {
        const message = gitError(error);
        console.error(`[PI] ${ticketId}: push failed: ${message}`);
        return { ticket_id: ticketId, kind: "pushFailed", error: message, patch, files, summary };
      }
      console.log(`[PI] ${ticketId}: pushed ${branch}`);
      return { ticket_id: ticketId, kind: "branch", name: branch, files, summary };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

// runPiBatch only fans out, so it doesn't retry: a retry would rerun every
// ticket, including the ones that already finished. Each runPi run retries on
// its own.
task(
  {
    name: "runPiBatch",
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 3600,
  },
  async function runPiBatch(ctx: TaskContext, inputs: RunPiInput[]) {
    console.log(`[BATCH] Running Pi on ${inputs.length} tickets`);

    // ctx.run starts each ticket as its own task run on its own compute.
    // allSettled keeps one failed ticket from failing the batch.
    const settled = await Promise.allSettled(inputs.map((input) => ctx.run(runPi, input)));

    const results: PiResult[] = settled.map((outcome, i) =>
      outcome.status === "fulfilled"
        ? outcome.value
        : { ticket_id: inputs[i]?.ticket?.id ?? "unknown", kind: "error", error: String(outcome.reason) },
    );

    const byKind: Record<string, number> = {};
    for (const r of results) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

    console.log(`[BATCH] Done: ${JSON.stringify(byKind)}`);
    return { total: inputs.length, by_kind: byKind, results };
  },
);
