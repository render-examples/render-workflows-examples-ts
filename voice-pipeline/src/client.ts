/**
 * Send a recorded voice message to the pipeline and save the spoken reply.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to voice-pipeline).
 *
 *   node dist/client.js                     # sends sample-call.mp3, writes reply.mp3
 *   node dist/client.js my-message.wav      # any format the transcription model reads
 */
import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Render } from "@renderinc/sdk";

// The shape handleVoiceMessage returns. Task results come back untyped, so
// declare it here.
type VoiceResult = {
  transcript?: string;
  reply?: string;
  audio_base64?: string;
  audio_format?: string;
  stage?: string;
  error?: string;
};

const SLUG = process.env.WORKFLOW_SLUG ?? "voice-pipeline";

// Audio travels base64-encoded inside the task arguments, which Render caps at
// 4 MB in total. main.ts rejects anything bigger than this, so check first.
const MAX_AUDIO_BYTES = 2_500_000;

const audioPath = process.argv[2] ?? fileURLToPath(new URL("../sample-call.mp3", import.meta.url));
const audio = readFileSync(audioPath);
if (audio.length > MAX_AUDIO_BYTES) {
  throw new Error(`${audioPath} is ${audio.length} bytes; the limit is ${MAX_AUDIO_BYTES}`);
}

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// Task input is an array of the task's arguments. runTask waits for the run to
// finish and returns its details.
const run = await render.workflows.runTask(`${SLUG}/handleVoiceMessage`, [
  audio.toString("base64"),
  extname(audioPath).slice(1).toLowerCase(),
]);
if (run.status !== "completed") {
  throw new Error(`Run ${run.id} ended as ${run.status}`);
}

// results is an array holding the task's return value.
const result = run.results[0] as VoiceResult;
if (result.error) {
  throw new Error(`Failed at ${result.stage}: ${result.error}`);
}

console.log(`Caller: ${result.transcript}`);
console.log(`Agent:  ${result.reply}`);

const out = fileURLToPath(new URL(`../reply.${result.audio_format}`, import.meta.url));
writeFileSync(out, Buffer.from(result.audio_base64!, "base64"));
console.log(`Saved the spoken reply to ${out}`);
