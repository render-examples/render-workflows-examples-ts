/**
 * Webhook processing: the receiver (web service)
 *
 * An Express app that receives GitHub webhooks and hands each one to a
 * workflow task. For every delivery it:
 *
 * 1. Verifies the X-Hub-Signature-256 header against the raw request body.
 * 2. Stores the payload in Postgres, keyed by the X-GitHub-Delivery ID.
 * 3. Answers 200 without doing anything else if that delivery was already
 *    processed (a redelivery).
 * 4. Otherwise starts processDelivery with the delivery ID and answers 202.
 *
 * It does no processing itself, so it answers in well under GitHub's
 * 10-second limit.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Render } from "@renderinc/sdk";
import express from "express";
import { applySchema, db } from "./db.js";

const SLUG = process.env.WORKFLOW_SLUG ?? "webhook-processing";
const PORT = Number(process.env.PORT ?? "8000");

// The events processDelivery handles. GitHub sends only the events you pick
// in the webhook's settings; anything else gets a 200 and is dropped.
const HANDLED_EVENTS = new Set(["push", "issues"]);

// Without a secret, anyone who finds the URL could send fake events. Refuse
// to start rather than accept unsigned requests.
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
if (!SECRET) throw new Error("GITHUB_WEBHOOK_SECRET is not set");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

// Reads RENDER_API_KEY, or RENDER_USE_LOCAL_DEV to use the local task server.
const render = new Render();

/** Check X-Hub-Signature-256: "sha256=" + the HMAC-SHA256 hex digest of the body. */
function signatureOk(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(body).digest("hex"));
  const received = Buffer.from(header);
  // timingSafeEqual takes the same time wherever the bytes differ, so the
  // response time doesn't leak how much of a forged signature was right.
  return expected.length === received.length && timingSafeEqual(expected, received);
}

const app = express();

app.post(
  "/webhooks/github",
  // Keep the exact bytes GitHub signed. Parsing and re-encoding the JSON
  // first would change them.
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    const started = performance.now();

    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!signatureOk(SECRET, body, req.get("X-Hub-Signature-256"))) {
      console.warn("[RECEIVER] Rejected a request with a missing or bad signature");
      res.status(401).json({ detail: "Bad signature" });
      return;
    }

    const event = req.get("X-GitHub-Event") ?? "";
    const deliveryId = req.get("X-GitHub-Delivery") ?? "";
    if (!event || !deliveryId) {
      res.status(400).json({ detail: "Missing GitHub headers" });
      return;
    }

    // GitHub sends a ping when you create the webhook.
    if (event === "ping") {
      res.json({ ok: true });
      return;
    }
    if (!HANDLED_EVENTS.has(event)) {
      res.json({ ignored: event });
      return;
    }

    if (!(req.get("Content-Type") ?? "").startsWith("application/json")) {
      res.status(415).json({ detail: "Set the webhook's content type to application/json" });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf-8"));
    } catch {
      res.status(400).json({ detail: "Body isn't JSON" });
      return;
    }

    // Store the payload and pass only the delivery ID to the task. GitHub
    // payloads can be up to 25 MB; task arguments are capped at 4 MB.
    const { rows } = await db().query(
      `INSERT INTO webhook_deliveries (delivery_id, event, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (delivery_id)
         DO UPDATE SET receipts = webhook_deliveries.receipts + 1
       RETURNING status, receipts`,
      [deliveryId, event, JSON.stringify(payload)],
    );

    // A redelivery of a delivery that's already processed: acknowledge it and
    // start nothing.
    if (rows[0].status === "processed") {
      console.log(`[RECEIVER] ${deliveryId} (${event}) duplicate, receipt ${rows[0].receipts}`);
      res.json({ delivery_id: deliveryId, duplicate: true });
      return;
    }

    // New, or sent again before it was processed (for example after a failed
    // run): start processing. If two runs end up processing the same delivery,
    // processDelivery applies it only once.
    let runId: string;
    try {
      const run = await render.workflows.startTask(`${SLUG}/processDelivery`, [deliveryId]);
      runId = run.taskRunId;
    } catch (error) {
      // Fail the delivery so it shows as failed in GitHub and can be
      // redelivered. The payload is stored, so replayPending can also pick it up.
      console.error(`[RECEIVER] Couldn't start processDelivery for ${deliveryId}:`, error);
      res.status(503).json({ detail: "Couldn't start processing" });
      return;
    }

    await db().query("UPDATE webhook_deliveries SET last_run_id = $1 WHERE delivery_id = $2", [
      runId,
      deliveryId,
    ]);

    const elapsedMs = Math.round(performance.now() - started);
    console.log(`[RECEIVER] ${deliveryId} (${event}) -> ${runId} in ${elapsedMs} ms`);
    res.status(202).json({ delivery_id: deliveryId, run_id: runId });
  },
);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

await applySchema();
app.listen(PORT, () => {
  console.log(`[RECEIVER] Listening on port ${PORT}`);
});
