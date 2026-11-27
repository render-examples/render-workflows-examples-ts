/**
 * Order saga on Render Workflows
 *
 * A checkout flow: reserve inventory, charge the payment, create the shipment.
 * If a later step fails for good, the flow undoes the earlier ones in reverse
 * order (refund the payment, release the inventory). This is the saga pattern.
 *
 * It's built as a flow, so every step is checkpointed. If the instance running
 * the flow dies, Render replays the flow on a new instance, and steps that
 * already finished return their recorded results instead of running again. A
 * card isn't charged twice because the process crashed after charging it.
 *
 * The inventory, payment and shipping services are in-process fakes (see
 * fakeServices.ts). The orchestration is real.
 */
import { flow, StepError, type FlowContext, type Retry } from "@renderinc/sdk/workflows";
import * as svc from "./fakeServices.js";

type Order = {
  order_id: string;
  customer_id: string;
  items: svc.Item[];
  payment_method: string;
  shipping_address: svc.Address;
  simulate: string | null;
};

type CheckoutResult = {
  order_id: string;
  status: "completed" | "compensated" | "rejected";
  failed_step?: string;
  reason?: string;
  amount_cents?: number;
  compensated: string[];
  steps: Record<string, unknown>;
};

// Forward steps call other services, so they retry a couple of times on errors
// like timeouts. Each retry runs in this process, with the same arguments.
const SERVICE_RETRY: Retry = { maxRetries: 2, waitDurationMs: 500, backoffScaling: 2 };
// Compensating steps retry harder: giving up on a refund leaves a customer
// charged for an order that won't ship.
const UNDO_RETRY: Retry = { maxRetries: 4, waitDurationMs: 1000, backoffScaling: 2 };
// The simulated crash uses up one attempt of its step, so it needs one retry.
const CRASH_RETRY: Retry = { maxRetries: 1, waitDurationMs: 1000, backoffScaling: 2 };

/**
 * One key per order and action, the same on every attempt and replay. A key
 * built from the run ID, the attempt or the time would change between attempts
 * and stop nothing.
 */
const idempotencyKey = (orderId: string, action: string) => `${orderId}:${action}`;

const orderTotalCents = (order: Order) =>
  order.items.reduce((sum, item) => sum + item.quantity * item.unit_price_cents, 0);

// ============================================================================
// Steps. Each is a plain function that ctx.step runs inside the flow's process.
// They get no context, and their arguments and results must be JSON-safe.
// ============================================================================

function reserveInventory(order: Order): svc.Reservation {
  console.log(`[${svc.PROCESS_ID}] reserveInventory ${order.order_id}`);
  return svc.inventoryReserve(order.order_id, order.items, idempotencyKey(order.order_id, "reserve"));
}

function chargePayment(order: Order, amountCents: number): svc.Charge {
  console.log(`[${svc.PROCESS_ID}] chargePayment ${order.order_id} ${amountCents}`);
  return svc.paymentsCharge(
    order.order_id,
    amountCents,
    order.payment_method,
    idempotencyKey(order.order_id, "charge"),
    order.simulate,
  );
}

function createShipment(order: Order): svc.Shipment {
  console.log(`[${svc.PROCESS_ID}] createShipment ${order.order_id}`);
  return svc.shippingCreate(
    order.order_id,
    order.shipping_address,
    idempotencyKey(order.order_id, "ship"),
    order.simulate,
  );
}

function releaseInventory(reservation: Extract<svc.Reservation, { ok: true }>): svc.Release {
  console.log(`[${svc.PROCESS_ID}] releaseInventory ${reservation.reservation_id}`);
  return svc.inventoryRelease(reservation.reservation_id, idempotencyKey(reservation.order_id, "release"));
}

function refundPayment(charge: Extract<svc.Charge, { ok: true }>): svc.Refund {
  console.log(`[${svc.PROCESS_ID}] refundPayment ${charge.charge_id}`);
  return svc.paymentsRefund(charge.charge_id, charge.amount_cents, idempotencyKey(charge.order_id, "refund"));
}

/**
 * Kill this process once, right after the charge, to force a replay.
 *
 * Only with SIMULATE_CRASH=1, for the local task server: it replays a flow
 * whose process exits. On Render, a process that exits on its own fails the
 * run; Render replays a flow when the instance running it fails.
 *
 * The first time, this runs in the same process that charged the card, so it
 * exits without reporting back, and the flow replays in a new process. In the
 * replay, reserveInventory and chargePayment return their recorded results
 * (with the first process's ID), and this step runs again in the new process,
 * which has a different ID, so it returns.
 */
function simulateCrash(chargedInProcess: string) {
  if (process.env.SIMULATE_CRASH !== "1") {
    return { crashed: false, process: svc.PROCESS_ID };
  }
  if (chargedInProcess === svc.PROCESS_ID) {
    console.warn(`[${svc.PROCESS_ID}] simulateCrash: exiting the process mid-flow`);
    process.exit(1);
  }
  return { crashed: true, charged_in: chargedInProcess, process: svc.PROCESS_ID };
}

// ============================================================================
// The flow
// ============================================================================

type Undo = { name: string; run: () => Promise<unknown> };

/** Run the compensating steps, newest first, and report the order as undone. */
async function compensate(
  orderId: string,
  steps: Record<string, unknown>,
  undo: Undo[],
  failedStep: string,
  reason: string,
): Promise<CheckoutResult> {
  console.log(`${orderId}: ${failedStep} failed (${reason}), compensating`);
  const failed: string[] = [];
  for (const { name, run } of [...undo].reverse()) {
    try {
      steps[name] = await run();
    } catch (error) {
      // Only a step that ran out of retries is ours to handle. Rethrow the
      // rest, such as a DeterminismError, which fails the run anyway.
      if (!(error instanceof StepError)) throw error;
      // Keep going: one failed undo shouldn't leave the others undone.
      failed.push(`${name}: ${error.message}`);
    }
  }
  if (failed.length > 0) {
    // Throwing fails the flow run, so it shows as failed in the Dashboard and
    // someone can fix the order by hand. Render doesn't replay a flow that threw.
    throw new Error(`${orderId}: ${failedStep} failed (${reason}), then compensation failed: ${failed.join("; ")}`);
  }
  return {
    order_id: orderId,
    status: "compensated",
    failed_step: failedStep,
    reason,
    compensated: [...undo].reverse().map((u) => u.name),
    steps,
  };
}

const stepFailure = (error: unknown): string => {
  // Only a step that ran out of retries is ours to handle.
  if (!(error instanceof StepError)) throw error;
  // The message names the step and the original error.
  return error.message;
};

/**
 * Reserve, charge, ship. Undo what's done if a later step fails for good.
 *
 * Flow code must make the same ctx calls in the same order on every replay, so
 * anything that talks to another service happens inside a step.
 */
export const checkout = flow(
  { name: "checkout", timeoutSeconds: 300 },
  async function checkout(ctx: FlowContext, order: Order): Promise<CheckoutResult> {
    const orderId = order.order_id;
    const steps: Record<string, unknown> = {};
    // Compensations for the steps that succeeded so far, oldest first.
    const undo: Undo[] = [];

    const reservation = await ctx.step("reserveInventory", reserveInventory, [order], { retry: SERVICE_RETRY });
    steps.reserveInventory = reservation;
    if (!reservation.ok) {
      // Nothing happened yet, so there's nothing to undo.
      return { order_id: orderId, status: "rejected", failed_step: "reserveInventory", reason: reservation.reason, compensated: [], steps };
    }
    undo.push({
      name: "releaseInventory",
      run: () => ctx.step("releaseInventory", releaseInventory, [reservation], { retry: UNDO_RETRY }),
    });

    const amountCents = orderTotalCents(order);
    let charge: svc.Charge;
    try {
      charge = await ctx.step("chargePayment", chargePayment, [order, amountCents], { retry: SERVICE_RETRY });
    } catch (error) {
      // Still failing after its retries, such as a gateway that keeps timing out.
      return compensate(orderId, steps, undo, "chargePayment", stepFailure(error));
    }
    steps.chargePayment = charge;
    if (!charge.ok) {
      // A decline comes back as a result, not an error, so it isn't retried.
      return compensate(orderId, steps, undo, "chargePayment", charge.reason);
    }
    const settled = charge;
    undo.push({
      name: "refundPayment",
      run: () => ctx.step("refundPayment", refundPayment, [settled], { retry: UNDO_RETRY }),
    });

    if (order.simulate === "crash_after_charge") {
      // A step cut off by a crash counts as a failed attempt. With no retries
      // left, the replay would fail the run instead of resuming it.
      steps.simulateCrash = await ctx.step("simulateCrash", simulateCrash, [charge.process], { retry: CRASH_RETRY });
    }

    try {
      steps.createShipment = await ctx.step("createShipment", createShipment, [order], { retry: SERVICE_RETRY });
    } catch (error) {
      return compensate(orderId, steps, undo, "createShipment", stepFailure(error));
    }

    return { order_id: orderId, status: "completed", amount_cents: amountCents, compensated: [], steps };
  },
);
