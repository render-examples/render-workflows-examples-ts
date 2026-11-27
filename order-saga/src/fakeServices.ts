/**
 * In-process stand-ins for an inventory service, a payment provider such as
 * Stripe, and a shipping carrier.
 *
 * They exist so the example runs with no accounts and no money involved. The
 * point of the example is the orchestration in main.ts, not these functions.
 * Swap each function body for a real API call and keep the same arguments:
 * every call that changes something takes an idempotency key, the way Stripe's
 * Idempotency-Key header works.
 *
 * State lives in this process only. A real provider keeps its idempotency
 * records on its side, so a key keeps working across processes and instances;
 * here it only works within one process, which is enough to show a step retry
 * reusing the key.
 */
import { randomUUID } from "node:crypto";

// One ID per process. Each step result carries it, so a flow's result shows
// which process ran each step. After a replay, steps that finished before the
// crash still show the first process's ID: Render returned their recorded
// results instead of running them again.
export const PROCESS_ID = randomUUID().replace(/-/g, "").slice(0, 8);

const KNOWN_SKUS = new Set(["MUG-BLK", "MUG-WHT", "TEE-M", "TEE-L", "CAP-01"]);
const DECLINED_PAYMENT_METHODS = new Set(["pm_card_declined"]);

export type Item = { sku: string; quantity: number; unit_price_cents: number };
export type Address = { name: string; line1: string; city: string; postal_code: string; country: string };

export type Reservation =
  | { ok: true; reservation_id: string; order_id: string; items: Item[]; process: string; idempotent_replayed?: boolean }
  | { ok: false; reason: string; idempotent_replayed?: boolean };
export type Charge =
  | { ok: true; charge_id: string; order_id: string; amount_cents: number; process: string; idempotent_replayed?: boolean }
  | { ok: false; reason: string; idempotent_replayed?: boolean };
export type Shipment = { shipment_id: string; order_id: string; country: string; process: string; idempotent_replayed?: boolean };
export type Release = { released: true; reservation_id: string; process: string; idempotent_replayed?: boolean };
export type Refund = { refunded: true; refund_id: string; charge_id: string; amount_cents: number; process: string; idempotent_replayed?: boolean };

// Saved responses by idempotency key, like a provider's idempotency store.
const responses = new Map<string, unknown>();
// Fault switches that already fired, so a "fail once" fault fails once.
const firedFaults = new Set<string>();

/** The carrier's API didn't answer. A retry might succeed. */
export class CarrierUnavailable extends Error {
  name = "CarrierUnavailable";
}

/** The payment gateway took the charge but the response never arrived. */
export class GatewayTimeout extends Error {
  name = "GatewayTimeout";
}

function replay<T>(idempotencyKey: string): T | undefined {
  const saved = responses.get(idempotencyKey) as T | undefined;
  if (saved === undefined) return undefined;
  console.log(`[${PROCESS_ID}] idempotency key ${idempotencyKey} seen before, returning the saved response`);
  return { ...saved, idempotent_replayed: true };
}

function save<T>(idempotencyKey: string, response: T): T {
  responses.set(idempotencyKey, response);
  return response;
}

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

// ---- Inventory ----------------------------------------------------------------

export function inventoryReserve(orderId: string, items: Item[], idempotencyKey: string): Reservation {
  const saved = replay<Reservation>(idempotencyKey);
  if (saved) return saved;
  const unknown = items.map((item) => item.sku).filter((sku) => !KNOWN_SKUS.has(sku)).sort();
  if (unknown.length > 0) {
    return save(idempotencyKey, { ok: false, reason: `unknown SKU: ${unknown.join(", ")}` });
  }
  return save(idempotencyKey, {
    ok: true,
    reservation_id: newId("res"),
    order_id: orderId,
    items,
    process: PROCESS_ID,
  });
}

export function inventoryRelease(reservationId: string, idempotencyKey: string): Release {
  const saved = replay<Release>(idempotencyKey);
  if (saved) return saved;
  return save(idempotencyKey, { released: true, reservation_id: reservationId, process: PROCESS_ID });
}

// ---- Payments (stand-in for Stripe or similar) ----------------------------------

export function paymentsCharge(
  orderId: string,
  amountCents: number,
  paymentMethod: string,
  idempotencyKey: string,
  fault: string | null = null,
): Charge {
  const saved = replay<Charge>(idempotencyKey);
  if (saved) return saved;
  if (DECLINED_PAYMENT_METHODS.has(paymentMethod)) {
    // A decline is an answer, not an outage: retrying gets the same answer.
    return save(idempotencyKey, { ok: false, reason: "card_declined" });
  }
  const response = save<Charge>(idempotencyKey, {
    ok: true,
    charge_id: newId("ch"),
    order_id: orderId,
    amount_cents: amountCents,
    process: PROCESS_ID,
  });
  if (fault === "payment_timeout_once" && !firedFaults.has(idempotencyKey)) {
    // The charge went through, then the connection dropped. The caller can't
    // tell, retries, and must not charge the card a second time.
    firedFaults.add(idempotencyKey);
    throw new GatewayTimeout(`no response for charge on ${orderId} (the charge did go through)`);
  }
  return response;
}

export function paymentsRefund(chargeId: string, amountCents: number, idempotencyKey: string): Refund {
  const saved = replay<Refund>(idempotencyKey);
  if (saved) return saved;
  return save(idempotencyKey, {
    refunded: true,
    refund_id: newId("re"),
    charge_id: chargeId,
    amount_cents: amountCents,
    process: PROCESS_ID,
  });
}

// ---- Shipping -------------------------------------------------------------------

export function shippingCreate(
  orderId: string,
  address: Address,
  idempotencyKey: string,
  fault: string | null = null,
): Shipment {
  if (fault === "carrier_outage") {
    throw new CarrierUnavailable(`carrier API unavailable for ${orderId}`);
  }
  const saved = replay<Shipment>(idempotencyKey);
  if (saved) return saved;
  return save(idempotencyKey, {
    shipment_id: newId("shp"),
    order_id: orderId,
    country: address.country,
    process: PROCESS_ID,
  });
}
