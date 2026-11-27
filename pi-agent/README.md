# Pi coding agent on Render Workflows

Run the [Pi](https://github.com/earendil-works/pi) coding agent inside a Render Workflows task: clone a repository, fix the bug behind a support ticket, and return the change as a patch or a pushed branch.

## What it shows

- An in-memory Pi session (`createAgentSession`) running inside one task run, in its own temporary directory
- Cloning, diffing and pushing with the `git` CLI, which Render's [native runtimes](https://render.com/docs/native-runtimes) include
- Returning a small change as a patch that applies with `git apply`, and pushing a large one to a branch
- Fanning out one task run per ticket with `ctx.run` and `Promise.allSettled`
- Retrying the task that calls the model, and not the task that fans out
- Returning errors a retry can't fix (missing API key, unknown model, bad repository, turn limit, failed push) as results instead of raising

Pi's SDK is TypeScript only, so this example has no Python version.

## Task tree

```
runPiBatch (fans out, no retries)
  └── runPi                        (one per ticket, retries once)
        ├── git clone --depth 1
        ├── Pi session             ← inside the task, run by the SDK
        │     └── tools: read, edit, write, ls
        └── returns one of:
              diff        patch for a small change
              branch      pushed pi/<ticket-id> for a large change
              pushFailed  the push failed; the patch is in the result
              noChanges   the ticket needed no code change
              error       something a retry can't fix
```

## The sample app

[`sample-app/`](sample-app/) is a small, deliberately buggy support backend. Four of the five tickets in `tickets.json` come from a bug in it, and the fifth is a customer question that needs no code change. The tickets are the same ones the other agent examples in this repository triage, so their results are comparable. By default the commands below point Pi at this folder of this repository, so you can try the example without a repository of your own.

## Prerequisites

- Node.js 22.19 or later (required by `@earendil-works/pi-coding-agent`)
- Git
- The [Render CLI](https://render.com/docs/cli)
- An [Anthropic API key](https://console.anthropic.com/settings/keys)
- To push branches: a GitHub token that can write to the target repository, such as a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) with **Contents: Read and write** on that repository only

## Run locally

```bash
npm install
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY. ANTHROPIC_MODEL defaults to claude-sonnet-5-5.
# GITHUB_TOKEN is only needed to push branches and to clone private repositories.
```

Build, then start the local task server. It loads `.env` when it starts:

```bash
npm run build
render workflows dev -- node dist/main.js
```

In another terminal, fix one ticket. Task input is a JSON array of the task's arguments, here one object:

```bash
render workflows tasks runs start runPi --local \
  --input='[{"repoUrl": "https://github.com/render-examples/render-workflows-examples-ts", "subdir": "pi-agent/sample-app", "ticket": {"id": "TCK-1001", "account_id": "ACC-100", "order_id": "ORD-2001", "subject": "Charged twice for my order", "body": "I was charged two times for order ORD-2001 yesterday. Please fix this."}}]'
```

`runPi` takes:

| Field | Required | Meaning |
|---|---|---|
| `repoUrl` | Yes | HTTPS URL of the repository to clone |
| `ticket` | Yes | A ticket in the shape of the ones in `tickets.json` |
| `ref` | No | Branch or tag to clone. Defaults to the repository's default branch |
| `subdir` | No | Folder the agent works in. Defaults to the repository root |

The result holds the patch, the changed files, and Pi's summary of the change:

```json
{
  "ticket_id": "TCK-1001",
  "kind": "diff",
  "files": ["pi-agent/sample-app/src/billing.js"],
  "patch": "--- a/pi-agent/sample-app/src/billing.js\n+++ b/pi-agent/sample-app/src/billing.js\n...",
  "summary": "..."
}
```

Patch paths are relative to the repository root. Save the patch as `fix.patch` and apply it from the root of a clone with `git apply fix.patch`. Then run `node --test` in `sample-app/` to check the fix.

To run Pi on all five tickets at once, start `runPiBatch` with a list of `runPi` inputs as its one argument:

```bash
render workflows tasks runs start runPiBatch --local --input="[$(node -e '
  const tickets = require("./tickets.json");
  const repo = { repoUrl: "https://github.com/render-examples/render-workflows-examples-ts", subdir: "pi-agent/sample-app" };
  console.log(JSON.stringify(tickets.map((ticket) => ({ ...repo, ticket }))));
')]"
```

### Pushing a branch

Changes bigger than `MAX_PATCH_BYTES` (default 20000) are committed to a branch named `pi/<ticket-id>` and pushed to the cloned repository, and the result is `{"kind": "branch", "name": "pi/tck-1001", ...}`. Pushing needs `GITHUB_TOKEN` and a repository you can write to, so point `repoUrl` at your own repository or a fork. To try it with a small change, set `MAX_PATCH_BYTES=0`.

If the push fails, for example because `GITHUB_TOKEN` is missing or can't write to the repository, `runPi` returns `{"kind": "pushFailed", "error": ..., "patch": ...}` so the change isn't lost.

## Deploy to Render

1. Push this folder to a Git repository Render can access.
2. In the Render Dashboard, click **New > Workflow** and connect the repository.
3. Set these fields:

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `pi-agent` (the folder that holds `package.json`). Leave it empty if this folder is the repository root. |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/main.js` |
   | Region | Any |
   | Environment variables | `ANTHROPIC_API_KEY`, and optionally `ANTHROPIC_MODEL`, `AGENT_MAX_TURNS`, `MAX_PATCH_BYTES`, `GITHUB_TOKEN`, `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` |

4. Create the workflow. Once the first version is ready, run `runPi` from the Dashboard with the input from [Run locally](#run-locally): a JSON array holding one object.

## Trigger from another service

`src/client.ts` triggers both tasks with the Render SDK:

```bash
export RENDER_API_KEY=your-render-api-key
export WORKFLOW_SLUG=your-workflow-slug   # defaults to pi-agent
npm run build && npm run client
```

The core of it:

```typescript
import { Render } from "@renderinc/sdk";

const render = new Render(); // reads RENDER_API_KEY

const run = await render.workflows.runTask(`${SLUG}/runPi`, [{ repoUrl, subdir, ticket }]);
if (run.status === "completed") {
  const result = run.results[0] as PiResult; // results holds the return value
  if (result.kind === "diff") console.log(result.patch);
}
```

`runTask` waits for the run to finish. To start a run and check on it later, use `startTask` instead; it returns the run's `taskRunId`.

## Limits and gotchas

- **The agent can't run commands.** `runPi` enables Pi's `read`, `edit`, `write` and `ls` tools, and not `bash`. With `bash`, the model could run any command in the task, including reading `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` from the environment, and instructions in a cloned repository can steer the model. Pi's `grep` and `find` tools are also off: they download ripgrep and fd from GitHub on first use. See Pi's [security notes](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md) before you enable more.
- **Only context files load from the clone.** Pi reads the repository's `AGENTS.md` or `CLAUDE.md` for its conventions. Extensions, skills and prompt templates are off, because they can run code from the cloned repository.
- **A retry reruns the whole agent.** `runPi` retries once, which clones again and repeats every model call. Its one write, the push, is the last step and goes to a fixed branch name, so a rerun overwrites the same branch instead of adding a second one. A failed push is returned, not raised, so it's never retried on its own. See [retries](https://render.com/docs/workflows-defining-tasks#retry-settings).
- **Timeouts apply per attempt.** `timeoutSeconds: 900` bounds each attempt of `runPi`, and a retry gets a fresh 900 seconds. `AGENT_MAX_TURNS` (default 20) stops a run that keeps going. See [timeouts](https://render.com/docs/workflows-defining-tasks#timeout).
- **Arguments are capped at 4 MB.** The combined arguments of a task run can't exceed 4 MB, so pass a repository URL, not its files. See [limits](https://render.com/docs/workflows-limits).
- **Fan-out meets Anthropic rate limits.** `runPiBatch` starts every ticket at once. A 429 or 5xx from Anthropic raises, and Render retries that ticket once. For large batches, fan out in chunks.
- **Errors a retry can't fix are returned, not raised.** A missing `ANTHROPIC_API_KEY`, a model Pi doesn't know, an Anthropic 400/401/403/404/422, a repository that can't be cloned (HTTP 401/403/404), a missing `subdir`, and hitting `AGENT_MAX_TURNS` come back as `{"kind": "error", "error": ...}`.
- **Pi's own retries are off.** Render's retry policy is the only one.
- **Git credentials come from `GITHUB_TOKEN` only.** `runPi` clears any credential helper configured on the machine, then hands `GITHUB_TOKEN` to git through its own helper, so the token never shows up in a command line or a remote URL. Don't put a token in `repoUrl`: Pi could read it from the clone's `.git/config`.

## Links

- [Render Workflows](https://render.com/docs/workflows)
- [Defining tasks](https://render.com/docs/workflows-defining-tasks)
- [Triggering runs](https://render.com/docs/workflows-running)
- [Workflows SDK for TypeScript](https://render.com/docs/workflows-sdk-typescript)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi providers and API keys](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
