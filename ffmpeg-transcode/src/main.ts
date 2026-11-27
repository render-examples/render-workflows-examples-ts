/**
 * ffmpeg transcode on Render Workflows
 *
 * Turns source videos into HLS (three H.264 renditions and a master playlist)
 * plus JPEG thumbnails. One task run per video, each on a 4 CPU / 16 GB compute
 * plan, fanned out by an orchestrator on the default flex plan.
 *
 * ffmpeg and ffprobe come preinstalled on Render's native runtimes, so this is a
 * plain Node workflow service with no Docker image.
 *
 * Videos are too big for task arguments, so inputs are URLs. To stay
 * self-contained, this example returns only small outputs: base64 thumbnails,
 * ffprobe metadata, and measurements of each HLS rendition. The HLS files
 * themselves are discarded when the run ends. A real app would upload them to
 * object storage such as S3 in storeOutputs().
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { task, type TaskContext } from "@renderinc/sdk/workflows";

// Refuse inputs bigger than this. Each task run works on local disk, so the
// source and every output must fit there at once.
const MAX_INPUT_MB = Number(process.env.MAX_INPUT_MB ?? "1024");
// Scratch space for one run. Defaults to the system temp directory.
const WORK_DIR = process.env.WORK_DIR || tmpdir();

// The HLS ladder: name, height, video bitrate in kbps. Rungs taller than the
// source are skipped, so a 720p source gets 720p, 480p and 360p.
const LADDER = [
  { name: "720p", height: 720, kbps: 2800 },
  { name: "480p", height: 480, kbps: 1400 },
  { name: "360p", height: 360, kbps: 800 },
];
const SEGMENT_SECONDS = 6;
const THUMBNAIL_COUNT = 4;
// Thumbnails come back base64-encoded in the result, so keep them small:
// 320 px wide is about 10-25 KB each.
const THUMBNAIL_WIDTH = 320;

type Video = { id: string; url: string };
type SourceInfo = {
  duration_seconds: number;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
  size_bytes?: number;
};
type Rendition = { name: string; height: number; target_video_kbps: number; playlist: string };
type MeasuredRendition = Rendition & {
  segments: number;
  duration_seconds: number;
  bytes: number;
  measured_kbps: number | null;
  resolution: string | null;
};
type TranscodeResult =
  | {
      id: string;
      source: SourceInfo & { url: string };
      master_playlist: string;
      renditions: MeasuredRendition[];
      thumbnails: { at_seconds: number; jpeg_base64: string }[];
      output_bytes: number;
      cpus: number;
      seconds: Record<string, number>;
    }
  | { id: string | null; error: string };

/** A failure a retry can't fix: bad URL, not a video, file too big. */
class PermanentError extends Error {}

// ---- Helpers ----

/**
 * CPUs this run may use.
 *
 * On Render, os.cpus() reports the host's CPUs, not the compute plan's. The
 * plan's limit is in the cgroup's cpu.max ("400000 100000" is 4 CPUs). ffmpeg
 * sizes its thread pools from the CPU count, so pass the real one.
 */
async function availableCpus(): Promise<number> {
  try {
    const [quota, period] = (await readFile("/sys/fs/cgroup/cpu.max", "utf-8")).trim().split(/\s+/);
    if (quota !== "max") return Math.max(1, Math.floor(Number(quota) / Number(period)));
  } catch {
    // Not on Linux with cgroup v2 (for example, local dev on a Mac).
  }
  return cpus().length || 1;
}

/**
 * Run ffmpeg or ffprobe and return stdout.
 *
 * Exit code > 0 means ffmpeg rejected the input or the options: permanent.
 * Killed by a signal (for example, out of memory): throw a plain error so
 * Render retries the run.
 */
function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(args[0], args.slice(1));
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject); // binary not found
    proc.on("close", (code, signal) => {
      if (signal) return reject(new Error(`${args[0]} killed by signal ${signal}`));
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        return reject(new PermanentError(`${args[0]} exited ${code}: ${tail}`));
      }
      resolve(stdout);
    });
  });
}

/** Stream url to dest. Returns the size in bytes. */
async function download(url: string, dest: string): Promise<number> {
  const limit = MAX_INPUT_MB * 1024 * 1024;
  // fetch also accepts data: and blob: URLs. Only fetch from the web.
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    throw new PermanentError(`Bad URL: ${url}`);
  }
  if (scheme !== "http:" && scheme !== "https:") {
    throw new PermanentError("url must start with http:// or https://");
  }
  const response = await fetch(url, {
    headers: { "User-Agent": "render-workflows-ffmpeg-example" },
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!response.ok || !response.body) {
    // 4xx (other than timeouts and rate limits) won't change on a retry.
    if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
      throw new PermanentError(`Download failed: HTTP ${response.status}`);
    }
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > limit) throw new PermanentError(`Input is ${length} bytes, over MAX_INPUT_MB=${MAX_INPUT_MB}`);

  let size = 0;
  // Count bytes as they stream to disk and stop past the limit.
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > limit) throw new PermanentError(`Input is over MAX_INPUT_MB=${MAX_INPUT_MB}`);
        yield chunk;
      }
    },
    createWriteStream(dest),
  );
  return size;
}

/** Read duration, size and the first video and audio streams. */
async function probe(path: string): Promise<SourceInfo> {
  const out = await runFfmpeg([
    "ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path,
  ]);
  const info = JSON.parse(out);
  const video = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const audio = info.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  if (!video) throw new PermanentError("Input has no video stream");
  return {
    duration_seconds: Math.round(Number(info.format.duration ?? 0) * 100) / 100,
    width: video.width,
    height: video.height,
    video_codec: video.codec_name,
    audio_codec: audio ? audio.codec_name : null,
  };
}

/** Grab THUMBNAIL_COUNT frames spread across the video, THUMBNAIL_WIDTH px wide. */
async function makeThumbnails(src: string, outDir: string, duration: number) {
  const thumbs: { file: string; at_seconds: number }[] = [];
  for (let i = 0; i < THUMBNAIL_COUNT; i++) {
    const at = Math.round(((duration * (i + 1)) / (THUMBNAIL_COUNT + 1)) * 100) / 100;
    const file = `thumb_${i + 1}.jpg`;
    // -ss before -i seeks quickly to the nearest keyframe.
    await runFfmpeg([
      "ffmpeg", "-v", "error", "-y", "-ss", String(at), "-i", src,
      "-frames:v", "1", "-vf", `scale=${THUMBNAIL_WIDTH}:-2`, "-q:v", "4", join(outDir, file),
    ]);
    thumbs.push({ file, at_seconds: at });
  }
  return thumbs;
}

/** Encode every rendition in one ffmpeg pass and write a master playlist. */
async function makeHls(src: string, outDir: string, meta: SourceInfo, threads: number): Promise<Rendition[]> {
  const fits = LADDER.filter((r) => r.height <= meta.height);
  const rungs = fits.length ? fits : [LADDER[LADDER.length - 1]];
  const hasAudio = meta.audio_codec !== null;

  // Decode once, split the picture, scale each copy to its rung.
  const splits = rungs.map((_, i) => `[v${i}]`).join("");
  const scales = rungs.map((r, i) => `[v${i}]scale=-2:${r.height}[v${i}out]`).join(";");
  const args = [
    "ffmpeg", "-v", "error", "-y", "-i", src, "-threads", String(threads),
    "-filter_complex", `[0:v]split=${rungs.length}${splits};${scales}`,
  ];
  const streamMap: string[] = [];
  rungs.forEach((r, i) => {
    args.push(
      "-map", `[v${i}out]`,
      `-c:v:${i}`, "libx264", `-b:v:${i}`, `${r.kbps}k`,
      `-maxrate:v:${i}`, `${Math.floor(r.kbps * 1.1)}k`, `-bufsize:v:${i}`, `${r.kbps * 2}k`,
    );
    if (hasAudio) {
      args.push("-map", "0:a:0", `-c:a:${i}`, "aac", `-b:a:${i}`, "128k", `-ac:a:${i}`, "2");
    }
    streamMap.push(hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`);
  });
  args.push(
    "-preset", "veryfast",
    // A keyframe at every segment boundary, so each segment starts cleanly
    // and all renditions switch at the same points.
    "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, "-sc_threshold", "0",
    "-f", "hls", "-hls_time", String(SEGMENT_SECONDS), "-hls_playlist_type", "vod",
    "-hls_segment_filename", join(outDir, "%v", "segment_%03d.ts"),
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", streamMap.join(" "),
    join(outDir, "%v", "index.m3u8"),
  );
  await runFfmpeg(args);
  return rungs.map((r) => ({ name: r.name, height: r.height, target_video_kbps: r.kbps, playlist: `${r.name}/index.m3u8` }));
}

// ---- Outputs. This is the one place that decides what leaves the run. ----

/** Count a rendition's segments, bytes and duration from its playlist. */
async function measureRendition(outDir: string, r: Rendition) {
  const playlist = join(outDir, r.playlist);
  const duration = (await readFile(playlist, "utf-8"))
    .split("\n")
    .filter((line) => line.startsWith("#EXTINF:"))
    .reduce((sum, line) => sum + parseFloat(line.slice("#EXTINF:".length)), 0);
  const segments = (await readdir(dirname(playlist))).filter((f) => f.endsWith(".ts"));
  let bytes = 0;
  for (const f of segments) bytes += (await stat(join(dirname(playlist), f))).size;
  return {
    ...r,
    segments: segments.length,
    duration_seconds: Math.round(duration * 100) / 100,
    bytes,
    measured_kbps: duration ? Math.round((bytes * 8) / duration / 1000) : null,
  };
}

/**
 * Decide what to keep from outDir before the run's disk goes away.
 *
 * This example keeps only small things: thumbnails as base64, the master
 * playlist's text, and measurements of each rendition. Everything else is
 * deleted with the work directory.
 *
 * In a real app, upload outDir here instead, for example with the AWS SDK:
 *   for (const file of files) {
 *     await s3.send(new PutObjectCommand({ Bucket, Key: `${videoId}/${file}`, Body: await readFile(join(outDir, file)) }));
 *   }
 * and return the object keys. Use the same keys on every attempt so a retry
 * overwrites instead of leaving duplicates.
 */
async function storeOutputs(
  outDir: string,
  _videoId: string,
  renditions: Rendition[],
  thumbnails: { file: string; at_seconds: number }[],
) {
  const master = await readFile(join(outDir, "master.m3u8"), "utf-8");
  // The master playlist lists each rendition's real size after scaling.
  const lines = master.split("\n");
  const resolutions: Record<string, string> = {};
  lines.forEach((line, i) => {
    const match = line.startsWith("#EXT-X-STREAM-INF:") && line.match(/RESOLUTION=([0-9x]+)/);
    if (match && lines[i + 1]) resolutions[lines[i + 1]] = match[1];
  });

  let outputBytes = 0;
  for (const e of await readdir(outDir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) outputBytes += (await stat(join(e.parentPath, e.name))).size;
  }

  return {
    master_playlist: master,
    renditions: await Promise.all(
      renditions.map(async (r) => ({ ...(await measureRendition(outDir, r)), resolution: resolutions[r.playlist] ?? null })),
    ),
    thumbnails: await Promise.all(
      thumbnails.map(async (t) => ({
        at_seconds: t.at_seconds,
        jpeg_base64: (await readFile(join(outDir, t.file))).toString("base64"),
      })),
    ),
    output_bytes: outputBytes,
  };
}

// ---- Tasks ----

// transcodeVideo is the heavy task. It runs on 4c-16g: 4 CPUs and 16 GB just
// for this run, billed per second while it runs. Each attempt may take up to
// 3 hours. It retries twice for transient failures (network, out of memory).
// A retry redoes the whole video. That's safe here because the task writes
// nothing outside its own disk; see storeOutputs() if you add uploads.
const transcodeVideo = task(
  {
    name: "transcodeVideo",
    plan: "4c-16g",
    timeoutSeconds: 3 * 60 * 60,
    retry: { maxRetries: 2, waitDurationMs: 10_000, backoffScaling: 2 },
  },
  async function transcodeVideo(_ctx: TaskContext, video: Video): Promise<TranscodeResult> {
    const videoId = String(video?.id ?? "").trim();
    const url = String(video?.url ?? "").trim();
    if (!videoId || !url) return { id: videoId || null, error: "Each video needs an id and a url" };
    if (videoId.includes("/") || videoId.startsWith(".")) {
      return { id: videoId, error: "id can't contain '/' or start with '.'" };
    }

    const threads = await availableCpus();
    console.log(`[TRANSCODE] ${videoId}: ${url} (${threads} CPUs)`);
    const seconds: Record<string, number> = {};
    const elapsed = (start: number) => Math.round((performance.now() - start) / 100) / 10;
    const work = await mkdtemp(join(WORK_DIR, `${videoId}-`));
    try {
      let start = performance.now();
      const src = join(work, "source");
      const size = await download(url, src);
      seconds.download = elapsed(start);

      const meta = { ...(await probe(src)), size_bytes: size };
      console.log(`[TRANSCODE] ${videoId}: ${JSON.stringify(meta)}`);

      const out = join(work, "out");
      await mkdir(out);
      start = performance.now();
      const thumbnails = await makeThumbnails(src, out, meta.duration_seconds);
      const renditions = await makeHls(src, out, meta, threads);
      seconds.transcode = elapsed(start);

      const outputs = await storeOutputs(out, videoId, renditions, thumbnails);
      console.log(
        `[TRANSCODE] ${videoId}: done, ${outputs.output_bytes} bytes of HLS and thumbnails, ${JSON.stringify(seconds)}`,
      );
      return {
        id: videoId,
        source: { url, ...meta },
        ...outputs,
        cpus: threads,
        seconds,
      };
    } catch (error) {
      if (error instanceof PermanentError) {
        console.error(`[TRANSCODE] ${videoId}: ${error.message} (not retrying)`);
        return { id: videoId, error: error.message };
      }
      throw error;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

// transcodeBatch only fans out and waits, so it runs on the default flex plan
// and never retries: a retry would re-transcode every video, including the ones
// that finished. Its timeout covers the slowest video's attempts and retries.
task(
  {
    name: "transcodeBatch",
    timeoutSeconds: 12 * 60 * 60,
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
  },
  async function transcodeBatch(ctx: TaskContext, videos: Video[]) {
    console.log(`[BATCH] Transcoding ${videos.length} videos`);

    // ctx.run starts each video as its own task run on its own 4c-16g instance.
    // allSettled keeps one failed video from failing the batch.
    const settled = await Promise.allSettled(videos.map((video) => ctx.run(transcodeVideo, video)));

    const done: Exclude<TranscodeResult, { error: string }>[] = [];
    const failed: { id: string | null; error: string }[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === "rejected") {
        // The run threw on every attempt (retries used up).
        failed.push({ id: videos[i]?.id ?? null, error: String(outcome.reason) });
      } else if ("error" in outcome.value) {
        failed.push(outcome.value);
      } else {
        done.push(outcome.value);
      }
    });

    console.log(`[BATCH] ${done.length} transcoded, ${failed.length} failed`);
    return { total: videos.length, transcoded: done.length, failed, results: done };
  },
);
