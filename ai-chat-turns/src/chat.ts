/**
 * Chat with the API from a terminal.
 *
 * Opens a conversation with the first ticket in tickets.json, sends a follow-up,
 * and prints each reply. Set API_URL to your API service's URL (it defaults to
 * http://localhost:8000).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const API_URL = (process.env.API_URL ?? "http://localhost:8000").replace(/\/$/, "");

type Message = { id: number; role: string; content: string; status: string; error: string | null; reply_to: number | null };

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// Send a message and wait for its turn to finish.
async function send(conversationId: string, content: string): Promise<void> {
  console.log(`\nYou: ${content}`);
  // A new ID per message. Resending with the same ID is safe.
  const sent = await call("POST", `/conversations/${conversationId}/messages`, {
    client_message_id: randomUUID(),
    content,
  });
  if (sent.status !== 200 && sent.status !== 202) {
    throw new Error(`POST failed (${sent.status}): ${JSON.stringify(sent.body)}`);
  }
  const messageId: number = sent.body.message_id;

  let messages: Message[];
  let mine: Message;
  for (;;) {
    messages = (await call("GET", `/conversations/${conversationId}/messages`)).body.messages;
    mine = messages.find((m) => m.id === messageId)!;
    if (mine.status === "done" || mine.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (mine.status === "failed") {
    console.log(`Turn failed: ${mine.error}`);
    return;
  }
  const reply = messages.find((m) => m.reply_to === messageId)!;
  console.log(`Support: ${reply.content}`);
}

const ticket = JSON.parse(readFileSync(new URL("../tickets.json", import.meta.url), "utf-8"))[0];
const conversationId = `chat-${randomUUID().slice(0, 8)}`;
console.log(`Conversation ${conversationId}`);
await send(conversationId, `${ticket.subject}. ${ticket.body} My account is ${ticket.account_id}.`);
await send(conversationId, "Thanks. Can you confirm the refund request is open?");
