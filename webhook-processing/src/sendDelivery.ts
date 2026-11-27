/**
 * Send a signed test delivery to the receiver, the way GitHub does.
 *
 * GitHub can't reach a receiver on localhost, so use this to try the receiver
 * locally. It sends the same headers GitHub sends, and signs the body with
 * GITHUB_WEBHOOK_SECRET (read from the environment or from .env).
 *
 *   node dist/sendDelivery.js deliveries/issue-opened.json
 *   node dist/sendDelivery.js deliveries/issue-opened.json --delivery-id <id>   # a redelivery
 *   node dist/sendDelivery.js deliveries/push.json --bad-signature              # expect 401
 */
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

function readSecret(): string {
  if (process.env.GITHUB_WEBHOOK_SECRET) return process.env.GITHUB_WEBHOOK_SECRET;
  const envFile = new URL("../.env", import.meta.url);
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf-8").split("\n")) {
      const [key, ...rest] = line.split("=");
      if (key.trim() === "GITHUB_WEBHOOK_SECRET") return rest.join("=").trim().replace(/^['"]|['"]$/g, "");
    }
  }
  console.error("Set GITHUB_WEBHOOK_SECRET in the environment or in .env");
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "http://localhost:8000/webhooks/github" },
    "delivery-id": { type: "string" },
    "bad-signature": { type: "boolean", default: false },
  },
});
if (positionals.length !== 1) {
  console.error('Usage: node dist/sendDelivery.js <file with {"event": ..., "payload": ...}> [--delivery-id <id>] [--bad-signature] [--url <url>]');
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(positionals[0], "utf-8"));
const body = JSON.stringify(fixture.payload);
const secret = values["bad-signature"] ? "wrong-secret" : readSecret();
const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
const deliveryId = values["delivery-id"] ?? randomUUID();

console.log(`delivery ${deliveryId} (${fixture.event})`);
try {
  const response = await fetch(values.url!, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "GitHub-Hookshot/send-delivery",
      "X-GitHub-Event": fixture.event,
      "X-GitHub-Delivery": deliveryId,
      "X-Hub-Signature-256": signature,
    },
    signal: AbortSignal.timeout(10_000),
  });
  console.log(response.status, await response.text());
} catch (error) {
  console.error(`Couldn't reach ${values.url}: ${(error as Error).cause ?? error}`);
  process.exit(1);
}
