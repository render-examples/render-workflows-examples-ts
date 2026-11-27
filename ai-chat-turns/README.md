# AI Chat Turns on Render Workflows

A chat app where each turn of a conversation runs as a Render Workflows task: an Express service stores messages in Postgres, a workflow task writes each reply, and the API tells the client when the reply is ready.

## What it shows

- Starting a task from a web service and returning `202 Accepted` right away
- One turn at a time per conversation, enforced with a claim in Postgres
- Idempotency keys at both levels: on the task run (from the message ID) and on a tool's write (from the conversation and order)
- Learning when a run ends from the task-run events stream, with polling as a fallback
- Finishing interrupted turns after the API restarts, for example during a deploy
- Returning errors a retry can't fix as results instead of raising

## How a turn works

```
client ──POST /conversations/{id}/messages──▶ API service (Express)
                                              1. insert the message (unique per conversation + client_message_id)
                                              2. claim the conversation (one turn at a time)
                                              3. startTask("runTurn", { idempotencyKey: from the message })
           ◀────────── 202 Accepted ──────────
                                              4. wait for the run's terminal event, then
                                                 mark the message done or failed and release the claim

workflow service
runTurn (retries once)
  ├── load the conversation from Postgres
  ├── run(supportAgent)                  ← OpenAI Agents SDK, inside the task
  │     ├── lookup_order, get_account_status   (read only)
  │     └── open_refund_request                 (writes, idempotent)
  └── insert the reply (at most one per message)

client ──GET /conversations/{id}/messages──▶ reads the reply when the message is "done"
```

`src/api.ts` is the web service, `src/workflow.ts` is the workflow service, and `src/db.ts` and `schema.sql` are shared. Both services deploy from this one folder.

## Prerequisites

- Node.js 22+ (required by `openai` 7)
- A local Postgres (for example `brew install postgresql`)
- The [Render CLI](https://render.com/docs/cli)
- An [OpenAI API key](https://platform.openai.com/api-keys)
- For the deployed API: a [Render API key](https://render.com/docs/api-keys) with **Workflows: Read** and **Run workflow tasks: Run** permissions

## Run locally

```bash
npm install
createdb ai_chat_turns
cp .env.example .env
# Edit .env: set OPENAI_API_KEY and DATABASE_URL.
npm run build
```

Start the local task server. It loads `.env` when it starts:

```bash
render workflows dev -- node dist/workflow.js
```

In a second terminal, start the API. `RENDER_USE_LOCAL_DEV=true` points its Render client at the local task server, so it needs no Render API key. The API creates the tables when it starts:

```bash
RENDER_USE_LOCAL_DEV=true node --env-file=.env dist/api.js
```

In a third terminal, chat. `src/chat.ts` opens a conversation from the first ticket in `tickets.json` and sends a follow-up:

```bash
node dist/chat.js
```

Or call the API yourself:

```bash
curl -X POST localhost:8000/conversations/demo/messages \
  -H 'Content-Type: application/json' \
  -d '{"client_message_id": "m-1", "content": "Where is order ORD-2003?"}'
curl localhost:8000/conversations/demo/messages
```

Sending the same `client_message_id` again returns the stored message instead of starting a second turn. Sending a new message while a turn is running returns `409`.

## Deploy to Render

Create three resources in the Render Dashboard, all in the same region:

1. **Postgres**: **New > Postgres**. Copy its **Internal Database URL**.
2. **Workflow service**: **New > Workflow**, connected to your repository.

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `ai-chat-turns` (leave empty if this folder is the repository root) |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/workflow.js` |
   | Environment variables | `DATABASE_URL` (internal URL), `OPENAI_API_KEY`, optionally `OPENAI_MODEL` |

3. **Web service**: **New > Web Service**, same repository.

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `ai-chat-turns` |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/api.js` |
   | Health Check Path | `/healthz` |
   | Environment variables | `DATABASE_URL` (internal URL), `RENDER_API_KEY`, `WORKFLOW_SLUG` (the workflow service's slug) |

Task runs reach the database over the private network, like your other services in the same region. Then chat against the web service:

```bash
API_URL=https://your-web-service.onrender.com node dist/chat.js
```

## Trigger from another service

The web service is the other service. The core of it, from `src/api.ts`:

```typescript
import { Render } from "@renderinc/sdk";

const render = new Render(); // reads RENDER_API_KEY

const run = await render.workflows.startTask(`${SLUG}/runTurn`, [conversationId, messageId], {
  // Starting the same turn again within 24 hours returns the first run.
  idempotencyKey: `turn:${conversationId}:${clientMessageId}`,
});

// Later: one event per run, when it reaches a terminal status.
for await (const details of render.workflows.taskRunEvents([run.taskRunId])) {
  // ...
}
```

## Limits and gotchas

- **A retry reruns the whole turn.** `runTurn` retries once. The reply insert (one reply per message) and the refund tool (one request per conversation and order) are idempotent, so a retry doesn't double either. Any tool that writes needs the same treatment. See [retries](https://render.com/docs/workflows-defining-tasks#retry-settings).
- **Idempotency keys expire after 24 hours.** A turn started again with the same key within 24 hours returns the first run. See [idempotency keys](https://render.com/docs/workflows-running#idempotency-keys).
- **No streaming of partial output.** The events stream sends one event per run, when it reaches a terminal status. To stream tokens, have the task write partial output to your own store and relay it from the web service.
- **Deploys stop the API mid-turn.** Turns keep running on Render. When the API starts again, it finds conversations whose turn was in flight and finishes the bookkeeping. See [deploys](https://render.com/docs/deploys).
- **Arguments are capped at 4 MB.** The task gets IDs and loads the conversation from Postgres, so long chats don't hit the cap. See [limits](https://render.com/docs/workflows-limits).
- **Timeouts apply per attempt.** `timeoutSeconds: 120` bounds each attempt of `runTurn`.

## Links

- [Render Workflows](https://render.com/docs/workflows)
- [Triggering runs](https://render.com/docs/workflows-running)
- [Local development](https://render.com/docs/workflows-local-development)
- [Workflows SDK for TypeScript](https://render.com/docs/workflows-sdk-typescript)
- [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/)
