/**
 * Trigger the transcode tasks from another service or script.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to ffmpeg-transcode).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Render } from "@renderinc/sdk";

// The shapes the tasks return. Task results come back untyped, so declare them here.
type TranscodeResult = {
  id: string;
  source?: { duration_seconds: number };
  renditions?: { name: string; resolution: string; segments: number; bytes: number; measured_kbps: number }[];
  thumbnails?: { at_seconds: number; jpeg_base64: string }[];
  seconds?: Record<string, number>;
  error?: string;
};
type BatchResult = {
  total: number;
  transcoded: number;
  failed: TranscodeResult[];
  results: TranscodeResult[];
};

const SLUG = process.env.WORKFLOW_SLUG ?? "ffmpeg-transcode";
const videos = JSON.parse(readFileSync(new URL("../videos.json", import.meta.url), "utf-8"));

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

// One video. Task input is an array of the task's arguments. runTask waits for
// the run to finish and returns its details. The idempotency key makes a
// repeated call within 24 hours return the first run instead of paying for a
// second transcode of the same video.
const video = videos[0];
const one = await render.workflows.runTask(`${SLUG}/transcodeVideo`, [video], {
  idempotencyKey: `transcode-${video.id}`,
});
if (one.status !== "completed") {
  throw new Error(`Run ${one.id} ended as ${one.status}`);
}
// results is an array holding the task's return value.
const result = one.results[0] as TranscodeResult;
if (result.error) throw new Error(`${result.id}: ${result.error}`);
console.log(`${result.id}: ${result.source?.duration_seconds} s, took`, result.seconds);
for (const r of result.renditions ?? []) {
  console.log(`  ${r.name} ${r.resolution}: ${r.segments} segments, ${r.bytes} bytes, ${r.measured_kbps} kbps`);
}

// Thumbnails come back base64-encoded. Write them to the current directory.
result.thumbnails?.forEach((thumb, i) => {
  const path = `${result.id}_${i + 1}.jpg`;
  writeFileSync(path, Buffer.from(thumb.jpeg_base64, "base64"));
  console.log(`  wrote ${path} (frame at ${thumb.at_seconds} s)`);
});

// Every video in videos.json, in parallel. One URL in the file is broken on
// purpose, so expect it under "failed".
const batchRun = await render.workflows.runTask(`${SLUG}/transcodeBatch`, [videos]);
if (batchRun.status !== "completed") {
  throw new Error(`Run ${batchRun.id} ended as ${batchRun.status}`);
}
const batch = batchRun.results[0] as BatchResult;
console.log(`\nTranscoded ${batch.transcoded} of ${batch.total}`);
for (const r of batch.results) {
  const sizes = (r.renditions ?? []).map((x) => `${x.name} ${x.bytes} B`).join(", ");
  console.log(`  ${r.id}: ${sizes}`, r.seconds);
}
for (const failure of batch.failed) console.log("  failed:", failure);
