/**
 * Content moderation on Render Workflows
 *
 * A moderation pipeline for user-generated posts. A parent task fans out one
 * task run per post. Each run sends the post's text and image to the OpenAI
 * moderation endpoint and applies a two-threshold policy: approve, flag for
 * human review, or reject. Flagged posts get a short note for the reviewer from
 * a chat model. The parent returns counts per decision and the review queue.
 */
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import OpenAI from "openai";

// The moderation model. A dated snapshot keeps scores stable, so the thresholds
// below keep meaning the same thing. omni-moderation-latest follows OpenAI's
// newest model instead.
const MODERATION_MODEL = process.env.MODERATION_MODEL ?? "omni-moderation-2024-09-26";

// The model that writes notes for human reviewers. Only flagged posts use it.
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-6.2-sol";

// The policy. The moderation endpoint scores each category from 0 to 1. A post
// is rejected if any category scores at or above REJECT_THRESHOLD, flagged for
// review if any scores at or above FLAG_THRESHOLD, and approved otherwise.
const FLAG_THRESHOLD = Number(process.env.FLAG_THRESHOLD ?? "0.4");
const REJECT_THRESHOLD = Number(process.env.REJECT_THRESHOLD ?? "0.9");

// Render Workflows has no concurrency cap of its own, so moderatePosts caps how
// many runs it has in flight. Raise it if your OpenAI rate limits allow.
const MAX_CONCURRENT_POSTS = Number(process.env.MAX_CONCURRENT_POSTS ?? "8");

// This example's own cap on image downloads, to keep requests small. The image
// is sent base64-encoded, which adds about a third.
const MAX_IMAGE_BYTES = 5_000_000;

// Some image hosts reject downloads without a User-Agent that says who is
// asking. Wikimedia's robot policy asks for a contact URL or email in it.
const USER_AGENT = "render-workflows-content-moderation/1.0 (+https://github.com/render-examples)";

// OpenAI errors that mean the request itself is wrong: unknown model, bad key,
// an image it can't read. A retry can't fix them, so the tasks return them as
// results instead of throwing. 429s and 5xx errors throw, and Render retries.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 413, 422]);

type Post = { id: string; author?: string; text?: string; image_url?: string };
type Decision = "approve" | "flag" | "reject";
type Reason = { category: string; score: number; inputs: string[] };
type ModerationResult = { post_id: string; decision?: Decision; reasons?: Reason[]; error?: string };
type NoteResult = { post_id: string; note?: string; error?: string };

// A problem with the post itself that a retry can't fix.
class PermanentError extends Error {}

// Return a message if error is an OpenAI error a retry can't fix.
function openaiError(error: unknown): string | null {
  if (!(error instanceof OpenAI.APIError) || !PERMANENT_ERROR_STATUSES.has(error.status ?? 0)) return null;
  const body = (error.error ?? {}) as { message?: string };
  return `OpenAI error ${error.status}: ${body.message ?? error.message}`;
}

// Render retries the task, so turn off the client's own retries to keep one
// retry policy in charge.
const client = () => new OpenAI({ maxRetries: 0, timeout: 30_000 });

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---- Image download ----

// Download an image and return it as a data URL.
//
// The task downloads the image itself instead of passing the URL to OpenAI, so
// it can tell a missing image (permanent) from a host that's slow or down
// (worth a retry). Throws PermanentError for the first kind; network errors and
// 408, 429 and 5xx responses throw plain errors, so Render retries.
async function fetchImage(url: string): Promise<string> {
  if (!/^https?:\/\//.test(url)) throw new PermanentError(`Not an http(s) URL: ${url}`);

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  const status = response.status;
  if (status === 408 || status === 429 || status >= 500) {
    throw new Error(`Image URL returned HTTP ${status}`);
  }
  if (status >= 400) throw new PermanentError(`Image URL returned HTTP ${status}`);

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!contentType.startsWith("image/")) {
    throw new PermanentError(`Image URL returned ${contentType || "no content type"}, not an image`);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body!) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new PermanentError(`Image is larger than ${MAX_IMAGE_BYTES} bytes`);
    chunks.push(chunk);
  }
  return `data:${contentType};base64,${Buffer.concat(chunks).toString("base64")}`;
}

// ---- Policy ----

// Turn category scores into a decision and the reasons for it.
function applyPolicy(
  scores: Record<string, number>,
  inputTypes: Record<string, string[]>,
): { decision: Decision; reasons: Reason[] } {
  const reasons = Object.entries(scores)
    .filter(([, score]) => score != null && score >= FLAG_THRESHOLD)
    .map(([category, score]) => ({
      category,
      score: Math.round(score * 1000) / 1000,
      inputs: inputTypes[category] ?? [],
    }))
    .sort((a, b) => b.score - a.score);

  if (reasons.some((r) => r.score >= REJECT_THRESHOLD)) return { decision: "reject", reasons };
  if (reasons.length > 0) return { decision: "flag", reasons };
  return { decision: "approve", reasons };
}

// ---- Tasks ----

// moderatePost calls the moderation endpoint, so it retries: a 429, a 5xx or a
// network error gets three more attempts, 2, 4 and 8 seconds apart. The policy
// decision is the task's result, whatever it is. Nothing is written, so a
// retry is safe.
const moderatePost = task(
  {
    name: "moderatePost",
    retry: { maxRetries: 3, waitDurationMs: 2000, backoffScaling: 2 },
    timeoutSeconds: 60,
  },
  async function moderatePost(_ctx: TaskContext, post: Post): Promise<ModerationResult> {
    const result = { post_id: post.id ?? "unknown" };

    if (!process.env.OPENAI_API_KEY) return { ...result, error: "OPENAI_API_KEY is not set" };
    if (!post.text && !post.image_url) return { ...result, error: "Post has no text or image_url" };

    let moderation: OpenAI.Moderation;
    try {
      // One request covers the text and the image. The endpoint takes at most
      // one image per request.
      const input: OpenAI.ModerationMultiModalInput[] = [];
      if (post.text) input.push({ type: "text", text: post.text });
      if (post.image_url) input.push({ type: "image_url", image_url: { url: await fetchImage(post.image_url) } });

      const response = await client().moderations.create({ model: MODERATION_MODEL, input });
      moderation = response.results[0];
    } catch (error) {
      if (error instanceof PermanentError) {
        console.warn(`[MODERATE] ${result.post_id}: ${error.message}, not retrying`);
        return { ...result, error: error.message };
      }
      const message = openaiError(error);
      if (message) {
        console.error(`[MODERATE] ${result.post_id}: ${message}, not retrying`);
        return { ...result, error: message };
      }
      throw error;
    }

    const { decision, reasons } = applyPolicy(
      moderation.category_scores as unknown as Record<string, number>,
      moderation.category_applied_input_types as unknown as Record<string, string[]>,
    );
    const top = reasons.length > 0 ? ` (${reasons[0].category} ${reasons[0].score})` : "";
    console.log(`[MODERATE] ${result.post_id}: ${decision}${top}`);
    return { ...result, decision, reasons };
  },
);

const NOTE_INSTRUCTIONS =
  "You help a human content moderator. A post was held for review because a " +
  "moderation model scored it above the review threshold in the categories " +
  "listed. In at most two sentences, say what in the post most likely caused " +
  "the hold and whether it reads as a joke, an idiom, a heated opinion, or a " +
  "real attack. Don't decide the outcome. The reviewer does.";

// writeReviewNote calls a chat model, so it retries the same way.
const writeReviewNote = task(
  {
    name: "writeReviewNote",
    retry: { maxRetries: 3, waitDurationMs: 2000, backoffScaling: 2 },
    timeoutSeconds: 60,
  },
  async function writeReviewNote(_ctx: TaskContext, post: Post, reasons: Reason[]): Promise<NoteResult> {
    const result = { post_id: post.id ?? "unknown" };
    if (!process.env.OPENAI_API_KEY) return { ...result, error: "OPENAI_API_KEY is not set" };

    const flagged = reasons.map((r) => `${r.category} ${r.score} (from ${r.inputs.join("/")})`).join(", ");
    const lines = [`Post text: ${post.text || "(none)"}`];
    if (post.image_url) lines.push("The post also has an image, which isn't shown here.");
    lines.push(`Categories over the threshold: ${flagged}`);

    let response: OpenAI.Responses.Response;
    try {
      response = await client().responses.create({
        model: OPENAI_MODEL,
        instructions: NOTE_INSTRUCTIONS,
        input: lines.join("\n"),
      });
    } catch (error) {
      const message = openaiError(error);
      if (message) {
        console.error(`[NOTE] ${result.post_id}: ${message}, not retrying`);
        return { ...result, error: message };
      }
      throw error;
    }

    if (response.status !== "completed" || !response.output_text) {
      return { ...result, error: `No note (status ${response.status})` };
    }
    console.log(`[NOTE] ${result.post_id}: ${response.output_text.length} characters`);
    return { ...result, note: response.output_text };
  },
);

// A minimal semaphore: at most `size` callers run at once, the rest wait in line.
function semaphore(size: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

type Outcome = ModerationResult & { review_note?: string; note_error?: string };

// moderatePosts only fans out and adds up, so it doesn't retry: a retry would
// moderate every post again. Each moderatePost and writeReviewNote run retries
// on its own.
task(
  {
    name: "moderatePosts",
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 1800,
  },
  async function moderatePosts(ctx: TaskContext, posts: Post[]) {
    console.log(`[BATCH] ${posts.length} posts, model ${MODERATION_MODEL}`);
    const policy = { flag_threshold: FLAG_THRESHOLD, reject_threshold: REJECT_THRESHOLD };

    // Without a key every post would fail the same way, so stop here.
    if (!process.env.OPENAI_API_KEY) return { model: MODERATION_MODEL, error: "OPENAI_API_KEY is not set" };

    const limit = semaphore(MAX_CONCURRENT_POSTS);

    async function moderate(post: Post): Promise<Outcome> {
      // ctx.run starts each call as its own task run on its own compute.
      const outcome = await limit(() => ctx.run(moderatePost, post));
      if (outcome.decision !== "flag") return outcome;
      // A flagged post goes to the review queue either way. The note only helps
      // the reviewer, so a failed note doesn't change the decision.
      let note: NoteResult;
      try {
        note = await limit(() => ctx.run(writeReviewNote, post, outcome.reasons ?? []));
      } catch (error) {
        note = { post_id: outcome.post_id, error: errorMessage(error) };
      }
      return note.note ? { ...outcome, review_note: note.note } : { ...outcome, note_error: note.error };
    }

    // allSettled keeps one failed run from failing the batch. A run that threw
    // used up its retries; it's listed as an error.
    const settled = await Promise.allSettled(posts.map(moderate));

    const report = {
      model: MODERATION_MODEL,
      policy,
      counts: { approve: 0, flag: 0, reject: 0, error: 0 },
      flagged: [] as (Outcome & { author?: string; text?: string })[],
      rejected: [] as Outcome[],
      approved: [] as string[],
      errors: [] as Outcome[],
    };
    settled.forEach((s, i) => {
      const post = posts[i];
      const outcome: Outcome =
        s.status === "fulfilled" ? s.value : { post_id: post.id ?? "unknown", error: errorMessage(s.reason) };
      const decision = outcome.decision ?? "error";
      report.counts[decision] += 1;
      if (decision === "flag") report.flagged.push({ ...outcome, author: post.author, text: post.text });
      else if (decision === "reject") report.rejected.push(outcome);
      else if (decision === "approve") report.approved.push(outcome.post_id);
      else report.errors.push(outcome);
    });

    console.log(`[BATCH] ${JSON.stringify(report.counts)}`);
    return report;
  },
);
