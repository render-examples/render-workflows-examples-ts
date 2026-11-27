# Order Saga on Render Workflows

Check out an order in three steps (reserve inventory, charge the payment, create the shipment) and undo the finished steps in reverse when a later one fails for good, using a Render Workflows flow.

## What it shows

- A [flow](https://render.com/docs/workflows-defining-flows) with `flow()` and `ctx.step`: each step's result is checkpointed
- Replay after a crash: with `SIMULATE_CRASH=1`, the flow kills its own process once, the local task server replays it, and the steps that finished before the crash aren't run again
- The saga pattern: compensating steps (refund, release) that run newest first when a later step fails
- Two kinds of failure: a declined card comes back as a result and isn't retried; a carrier outage is retried, then the flow catches the `StepError` and compensates
- An idempotency key on every call that changes something, so a step retry reuses the charge it already made
- An idempotency key on the flow run itself, when another service starts it

The inventory, payment and shipping services are in-process fakes in `src/fakeServices.ts`, standing in for your own inventory service, a payment provider such as Stripe, and a carrier. They take the same idempotency keys a real provider would. The flow, the checkpoints, the retries and the replays are real Render Workflows behavior.

## Flow

```
checkout (flow: runs on one instance, steps run in its process)
  ├── reserveInventory    (retries 2)    undo: releaseInventory (retries 4)
  ├── chargePayment       (retries 2)    undo: refundPayment    (retries 4)
  ├── simulateCrash       (ORD-3004 only, retries 1)
  └── createShipment      (retries 2)

  A step fails for good → run the undo steps for the steps that succeeded, newest first
```

`orders.json` holds five orders, one per path:

| Order | What happens | Result |
|---|---|---|
| `ORD-3001` | Everything succeeds | `completed` |
| `ORD-3002` | The card is declined (`pm_card_declined`) | `compensated`: inventory released |
| `ORD-3003` | The carrier API is down for all three attempts | `compensated`: payment refunded, then inventory released |
| `ORD-3004` | With `SIMULATE_CRASH=1`, the process exits right after the charge | `completed` after a replay. Reserve and charge ran in the first process, the rest in the second. Without the variable, it completes with no crash |
| `ORD-3005` | The charge goes through but its response is lost | `completed`. The retry sends the same idempotency key and gets the saved charge back, so the card is charged once |

## How the saga works

`checkout` keeps a list of undo steps. After `reserveInventory` succeeds it adds `releaseInventory`, and after `chargePayment` succeeds it adds `refundPayment`. When a later step fails for good, `compensate()` runs that list in reverse, each undo as its own step with its own retries. The undo steps take the recorded result of the step they reverse (the reservation, the charge), so a refund after a replay still uses the charge ID that was recorded before the crash.

"Fails for good" means one of two things:

- **The service said no.** A declined card is an answer, and retrying it gets the same answer. `chargePayment` returns `{ ok: false, reason: "card_declined" }` instead of throwing, so the step isn't retried, and the flow compensates.
- **The service kept failing.** `createShipment` throws `CarrierUnavailable`, the step retries twice, and then `ctx.step` throws `StepError`. The flow catches it and compensates.

If an undo step also runs out of retries, the flow throws, the run fails, and someone fixes the order by hand. Render doesn't replay a flow that threw.

## How checkpointing works

Render records each step's result as it finishes. If the instance running the flow dies, Render replays the flow on a new instance: it calls the `checkout` function again from the top, and each `ctx.step` call that already finished returns its recorded result instead of running. So flow code must make the same `ctx.step` calls in the same order with the same inputs every time. Anything that talks to another service, reads the clock or generates an ID goes inside a step.

`ORD-3004` shows it when the local task server runs with `SIMULATE_CRASH=1`. Every step result carries `process`, an ID made once per process. `simulateCrash` exits the process when it runs in the same process that charged the card. On the replay, `reserveInventory` and `chargePayment` return their recorded results, still with the first process's ID, and `simulateCrash` runs again in a new process, which has a different ID, so it returns:

```
ORD-3004: completed
  reserveInventory   ran in process a182b812
  chargePayment      ran in process a182b812
  simulateCrash      ran in process 16b2212f
  createShipment     ran in process 16b2212f
```

The crash only replays on the local task server. On Render, a process that exits on its own fails the flow run, whether it exits with an error, exits cleanly, or is killed by a signal (the run's error is "Task exited with non-zero exit code", or "Task exited without error but did not report task completion"). Render replays a flow when the instance running it fails, which code can't trigger on purpose. That's why the crash is behind `SIMULATE_CRASH`, which the deployed service leaves unset.

## Prerequisites

- Node.js 22+
- The [Render CLI](https://render.com/docs/cli), version 2.37.0 or later (earlier versions can't run flows locally)
- [jq](https://jqlang.org/), to pick an order out of `orders.json` in the commands below
- No API keys. The services are fakes.

## Run locally

```bash
npm install
npm run build
SIMULATE_CRASH=1 render workflows dev -- node dist/main.js
```

`SIMULATE_CRASH=1` turns on the crash for `ORD-3004`; the local task server passes your shell's environment to the workflow. In another terminal, check out the first order. The local task server runs flows as tasks, so start them with `tasks runs start`. Input is a JSON array of the flow's arguments:

```bash
render workflows tasks runs start checkout --local --input="[$(jq -c '.[0]' orders.json)]"
```

Then the crash and replay:

```bash
render workflows tasks runs start checkout --local --input="[$(jq -c '.[3]' orders.json)]"
```

The dev server's output shows the steps, `Flow Replaying`, and then only `simulateCrash` and `createShipment` running again. To see the run's result:

```bash
render workflows tasks runs show <run-id> --local -o json
```

Use `.[1]`, `.[2]` and `.[4]` for the other orders.

## Deploy to Render

1. Push this folder to a Git repository Render can access.
2. In the Render Dashboard, click **New > Workflow** and connect the repository.
3. Set these fields:

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `order-saga` (the folder that holds `package.json`). Leave it empty if this folder is the repository root. |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/main.js` |
   | Region | Any |
   | Environment variables | None |

4. Create the workflow. Once the first version is ready, open the `checkout` flow and click **Run Flow** with an order from `orders.json` wrapped in a JSON array, or start one with the CLI:

   ```bash
   render workflows flows runs start <workflow-slug>/checkout --input="[$(jq -c '.[2]' orders.json)]"
   render workflows flows runs show <flow-run-id>
   ```

## Trigger from another service

`src/client.ts` starts one flow run per order and waits for them all:

```bash
export RENDER_API_KEY=your-render-api-key
export WORKFLOW_SLUG=your-workflow-slug   # defaults to order-saga
npm run client
```

The core of it:

```typescript
import { Render } from "@renderinc/sdk";

const render = new Render(); // reads RENDER_API_KEY

const run = await render.workflows.startFlow(`${SLUG}/checkout`, [order], {
  idempotencyKey: `checkout-${order.order_id}`,
});
const details = await render.workflows.getFlowRun(run.id); // poll until succeeded, failed or canceled
const result = details.results[0]; // results is an array holding the flow's return value
```

The idempotency key comes from the order ID, so a client that retries after a timeout, or the same script run twice, gets the first run back instead of starting a second checkout. To start and wait in one call, use `runFlow`.

## Limits and gotchas

- **A step cut off by a crash uses up an attempt.** On the replay, the interrupted step resumes at its next attempt. With no retries left, the replay fails the run instead of resuming it. That's why `simulateCrash` has one retry. Give any step that could be cut off (most steps that call a service) at least one retry.
- **An interrupted step runs again.** If the process dies after a service call but before the step's result is recorded, the replay calls the service again. The idempotency key is what stops a second charge. The fakes here keep their keys in memory, so they only dedupe within one process. A real provider keeps them on its side: Stripe saves the response for a key for at least 24 hours. See Stripe's [idempotent requests](https://docs.stripe.com/api/idempotent_requests).
- **Build keys from the business input.** `ORD-3005:charge` is the same on every attempt and replay. A key built from the run ID, the attempt or the time would change between attempts and stop nothing.
- **A charge that times out may still have gone through.** If `chargePayment` runs out of retries on timeouts, this flow releases the inventory but has no charge ID to refund. In production, look the charge up by its idempotency key, or retry it with the same key until you get an answer, before deciding.
- **Replays only happen on infrastructure failures.** Render replays a flow when its instance fails. A process that exits on its own, with any exit code or by a signal, fails the run on Render; the local task server replays it instead, which is what the crash demo uses. An uncaught error, a timeout, running out of memory, a `DeterminismError` or a flow limit fails the run without a replay. Flows don't take a retry policy; steps do. See [flow replay](https://render.com/docs/workflows-defining-flows#flow-replay).
- **Flow code must be deterministic.** A replay that makes a different `ctx.step` call (another name, order or input) throws `DeterminismError` and fails the run. See [determinism and side effects](https://render.com/docs/workflows-defining-flows#determinism-and-side-effects).
- **Steps run one at a time, in the flow's process.** They share the flow's compute plan, and a step retry runs the function again in the same process with the same arguments. Await each `ctx.step` before the next one; `Promise.all` over steps throws. Step arguments and results must be JSON-serializable, so no `Date` objects or class instances.
- **Timeouts apply per attempt.** `timeoutSeconds: 300` bounds each attempt of the flow, and a replay gets a fresh 300 seconds. See [timeouts](https://render.com/docs/workflows-defining-flows#timeout).
- **Size and count limits.** A run's combined arguments and each step's return value are capped at 4 MB. A flow run can execute up to 10,000 steps, with up to 100 attempts per step. See [limits](https://render.com/docs/workflows-limits#additional-limits).
- **Catch only `StepError`.** A step that runs out of retries throws `StepError`, and flow code can catch it, including on a replay. Rethrow anything else: a `DeterminismError` fails the run whether you catch it or not.

## Links

- [Render Workflows](https://render.com/docs/workflows)
- [Defining flows](https://render.com/docs/workflows-defining-flows)
- [Triggering runs](https://render.com/docs/workflows-running)
- [Local development](https://render.com/docs/workflows-local-development)
- [Workflows SDK for TypeScript](https://render.com/docs/workflows-sdk-typescript)
