// These tests fail until the bugs behind the sample tickets are fixed.
// Run them from the sample-app folder with: node --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountSummary } from "../src/accounts.js";
import { login, resetPassword, validateSession } from "../src/auth.js";
import { chargeOrder } from "../src/billing.js";
import { revenueReport } from "../src/reports.js";
import { trackingUrl } from "../src/shipping.js";

test("charging the same order twice charges it once (TCK-1001)", async () => {
  const charges = [];
  let calls = 0;
  const provider = {
    charge: async (request) => {
      calls += 1;
      return { id: `ch_${calls}`, ...request };
    },
  };
  const order = { id: "ORD-2001", amount: 49.0 };
  await chargeOrder(order, charges, provider);
  await chargeOrder(order, charges, provider);
  assert.equal(calls, 1);
  assert.equal(charges.length, 1);
});

test("signing in after a password reset gives a valid session (TCK-1002)", () => {
  const user = { id: "u1", sessionVersion: 0 };
  const users = new Map([[user.id, user]]);
  const sessions = new Map();
  resetPassword(user);
  const session = login(user, sessions);
  assert.equal(validateSession(session.id, users, sessions).valid, true);
});

test("a past-due account shows its balance (TCK-1003)", () => {
  const summary = accountSummary({ plan: "pro", balance_due: 79.0, card_on_file: "expired" });
  assert.equal(summary.standing, "past_due");
  assert.equal(summary.balance_due, 79.0);
});

test("the revenue report works before the first order of the day (TCK-1004)", () => {
  assert.deepEqual(revenueReport([]), { currency: "USD", total_cents: 0, orders: 0 });
});

test("the tracking link uses the carrier's tracking number (TCK-1005)", () => {
  const order = { id: "ORD-2003", tracking_number: "1Z999AA10123456784" };
  assert.equal(trackingUrl(order), "https://carrier.example.com/track/1Z999AA10123456784");
});
