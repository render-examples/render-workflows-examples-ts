# Idempotent Side Effects on Render Workflows

Retry an LLM call as often as you need without repeating a paid side effect: a refund flow drafts its decision with OpenAI, then issues a refund credit exactly once, even when the task that issues it fails and Render retries it.

## What it shows

- Splitting a job into tasks so the LLM call and the side effect retry separately
- An idempotency key derived from the business input (account and order), not from the run or attempt
- Recording the side effect in Postgres with `INSERT ... ON CONFLICT DO NOTHING` on that key
- A switch that fails the side-effect task once, right after the write, so you can watch the retry skip it
- Passing the same key to a provider that accepts one, such as Stripe's `Idempotency-Key` header
- An idempotency key on the task run itself, when another service triggers it
- Returning errors a retry can't fix (missing API key, unknown model, bad input) as results instead of throwing

## Task tree

```
handleRefund (orchestrates, no retries)
  ├── draftRefund    (retries twice)  ← calls OpenAI, only reads
  └── issueCredit    (retries twice)  ← writes the credit, once per account and order
        INSERT INTO refund_credits ... ON CONFLICT (idempotency_key) DO NOTHING
```

## Why a retry doesn't repeat the credit

Render retries a task when an attempt throws or times out, and each retry runs the task again from the start. Code that writes something and then fails writes it again on the retry. Three things stop that here:

1. **Separate tasks.** `draftRefund` and `issueCredit` are their own task runs, started with `ctx.run`. A failed credit retries `issueCredit` alone, so the model isn't called again, and a failed model call retries `draftRefund` alone, so the credit isn't issued again. `handleRefund` only orchestrates and has retries off, because retrying it would rerun both.
2. **A key from the business input.** `issueCredit` builds its key as `sha256("<account>:refund:<order>")`. Every attempt, and every later run for the same order, gets the same key. A key built from the run ID, the attempt, a timestamp, or the model's output would change between attempts and stop nothing.
3. **A write that checks the key.** The key is the table's primary key, and the insert uses `ON CONFLICT (idempotency_key) DO NOTHING`. Only the attempt that wrote the credit inserts a row. Any later attempt inserts nothing and reports `already_issued`.

The credit amount comes from the order data, and the model only decides whether to refund and drafts the message to the customer. A retry can draft different wording, but the stored credit keeps the first one.

### When the side effect is an API call

If the credit goes through a payment provider rather than your own database, pass the same key to the provider. Stripe reads it from the `Idempotency-Key` header on `POST` requests and returns the saved response when it sees the key again, for at least 24 hours. With `stripe-node`:

```ts
await stripe.refunds.create(
  { payment_intent: paymentIntentId, amount: amountCents },
  { idempotencyKey: creditKey(accountId, orderId) },
);
```

Stripe's SDKs add a random key to their own retries, but a Render retry is a new attempt in a new instance, so it gets a new random key. Pass your own. See Stripe's [idempotent requests](https://docs.stripe.com/api/idempotent_requests).

If the provider takes no key, record the call in your database under the key first, and check that record before calling.

## Prerequisites

- Node.js 22+
- A local Postgres (for example `brew install postgresql`)
- The [Render CLI](https://render.com/docs/cli)
- An [OpenAI API key](https://platform.openai.com/api-keys)

## Run locally

```bash
npm install
createdb idempotent_side_effects
cp .env.example .env
# Edit .env: set OPENAI_API_KEY and DATABASE_URL. OPENAI_MODEL defaults to gpt-6.2-sol.
```

Build, then start the local task server. It loads `.env` when it starts:

```bash
npm run build
render workflows dev -- node dist/main.js
```

In another terminal, refund the first ticket and fail once after the credit. Task input is a JSON array of the task's arguments, and the second argument turns on the failure:

```bash
render workflows tasks runs start handleRefund --local \
  --input='[{"id": "TCK-1001", "account_id": "ACC-100", "order_id": "ORD-2001", "subject": "Charged twice", "body": "I was charged twice for ORD-2001."}, true]'
```

`refund-fail-once.json` holds the same kind of input, with the first ticket from `tickets.json`:

```bash
render workflows tasks runs start handleRefund --local --input-file refund-fail-once.json
```

The task server's output shows `issueCredit` failing with `Failed on purpose after issuing the credit`, then running again and completing. The result shows the retry found the credit:

```json
"credit": {
  "order_id": "ORD-2001",
  "status": "already_issued",
  "amount_cents": 4900,
  "credits_for_order": 1
}
```

Check the run's attempts and the table:

```bash
render workflows tasks runs list issueCredit --local            # the last row is the run you just made
render workflows tasks runs show <run-id> --local -o json        # "attempts": failed, then completed
psql idempotent_side_effects -c "SELECT order_id, amount_cents, task_run_id FROM refund_credits"
```

Run the same ticket again without the failure (drop `, true`). The model drafts a new decision, and `issueCredit` reports `already_issued` again: the key matches the credit from the first run. A ticket without an order, like `TCK-1002`, comes back as `{"ticket_id": ..., "error": ...}` without calling the model.

## Deploy to Render

Create two resources in the Render Dashboard, in the same region:

1. **Postgres**: **New > Postgres**. Copy its **Internal Database URL**.
2. **Workflow service**: **New > Workflow**, connected to your repository.

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `idempotent-side-effects` (the folder that holds `package.json`). Leave it empty if this folder is the repository root. |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/main.js` |
   | Region | The database's region |
   | Environment variables | `DATABASE_URL` (internal URL), `OPENAI_API_KEY`, and optionally `OPENAI_MODEL` |

The workflow creates its table on first use. Once the first version is ready, run `handleRefund` from the Dashboard with `[<a ticket from tickets.json>, true]` and open the `issueCredit` run: it shows two attempts, and the table holds one credit.

## Trigger from another service

`src/client.ts` starts `handleRefund` for the first ticket, twice, with the same idempotency key, and waits for the result:

```bash
export RENDER_API_KEY=your-render-api-key
export WORKFLOW_SLUG=your-workflow-slug   # defaults to idempotent-side-effects
npm run build
node dist/client.js
```

The core of it:

```ts
import { Render } from "@renderinc/sdk";

const render = new Render(); // reads RENDER_API_KEY

const run = await render.workflows.startTask(`${SLUG}/handleRefund`, [ticket], {
  idempotencyKey: `handleRefund:${ticket.id}`,
});
console.log(run.taskRunId);
```

This key works one level up from the credit's key. Starting a run again with the same key within 24 hours returns the first run, so both calls print the same run ID and the model runs once. The client then waits by checking the run's status with `getTaskRun`, not with `runTask`: a repeated key can return a run that already finished, and waiting on a finished run's events doesn't return. On the local task server, which doesn't apply these keys, the two calls start two runs, and the credit's key still keeps it to one credit.

## Limits and gotchas

- **Run idempotency keys don't cover retries.** A key on `runTask` or `startTask` stops a second run from starting. It doesn't stop a run's own retries from repeating work, so the side effect needs its own key. See [idempotency keys](https://render.com/docs/workflows-running#idempotency-keys).
- **Run idempotency keys last 24 hours and are scoped to a workflow service.** After 24 hours the same key starts a new run. The credit's key in Postgres has no expiry.
- **Every retry is a new attempt in a new instance.** In-memory state from the failed attempt is gone, so the check has to live in a database or with the provider. See [retry settings](https://render.com/docs/workflows-defining-tasks#retry-settings).
- **The failure comes after the commit.** The pool runs each query on its own, outside a transaction, so the credit is committed as soon as it's inserted, like a real payment would be. If the insert sat in a transaction that the failure rolled back, there would be no credit for the retry to find.
- **Retries rerun the model call.** `draftRefund` retries twice, and each retry is another paid OpenAI request. The OpenAI client's own retries are off (`maxRetries: 0`), so Render's policy is the only one.
- **Timeouts apply per attempt.** `timeoutSeconds: 30` bounds each attempt of `issueCredit`, and a retry gets a fresh 30 seconds. See [timeouts](https://render.com/docs/workflows-defining-tasks#timeout).
- **Arguments are capped at 4 MB.** The combined arguments of a task run can't exceed 4 MB. Pass IDs instead of large payloads. See [limits](https://render.com/docs/workflows-limits).

## Links

- [Render Workflows](https://render.com/docs/workflows)
- [Defining tasks](https://render.com/docs/workflows-defining-tasks)
- [Triggering runs](https://render.com/docs/workflows-running)
- [Workflows SDK for TypeScript](https://render.com/docs/workflows-sdk-typescript)
- [Render Postgres](https://render.com/docs/postgresql)
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
