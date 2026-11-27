/**
 * Voice pipeline on Render Workflows
 *
 * A support line that answers a recorded voice message. Speech-to-text, the
 * LLM reply and text-to-speech each run as their own task, so each step retries
 * on its own and shows up as its own run in the Dashboard. An orchestrator task
 * chains them and returns the transcript, the reply text and the reply audio.
 *
 * This is a batch pipeline: one recorded message in, one spoken reply out. It
 * isn't built for live, back-and-forth calls.
 */
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import OpenAI, { toFile } from "openai";

// Read every model from the environment so a retired model is a config
// change, not a code change.
const STT_MODEL = process.env.OPENAI_STT_MODEL ?? "gpt-transcribe";
const LLM_MODEL = process.env.OPENAI_MODEL ?? "gpt-6.2-sol";
const TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? "gpt-audio-1.5";
const TTS_VOICE = process.env.OPENAI_TTS_VOICE ?? "marin";

// Audio moves between tasks as base64 text inside the task arguments. Render
// caps the combined arguments of a task run at 4 MB, and base64 adds a third,
// so this keeps the raw audio well under that cap (about 2.5 minutes of
// 128 kbps MP3).
const MAX_AUDIO_BYTES = 2_500_000;

// OpenAI errors that mean the request itself is wrong: unknown model, bad key,
// unreadable audio. A retry can't fix them, so the tasks return them as a
// result instead of throwing.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 422]);

// Content types for the audio formats this example sends to transcription.
const AUDIO_CONTENT_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  webm: "audio/webm",
  flac: "audio/flac",
};

// ---- Sample data the support agent answers from. In production you'd look
// these up in your database before calling the model. ----

const ORDERS = {
  "ORD-2001": { status: "delivered", amount: 49.0, times_charged: 2 },
  "ORD-2002": { status: "processing", amount: 120.0, times_charged: 1 },
  "ORD-2003": { status: "shipped", amount: 15.5, times_charged: 1 },
};

const ACCOUNTS = {
  "ACC-100": { plan: "pro", standing: "good", balance_due: 0.0 },
  "ACC-200": { plan: "starter", standing: "good", balance_due: 0.0 },
  "ACC-300": { plan: "pro", standing: "past_due", balance_due: 79.0, card_on_file: "expired" },
};

const SUPPORT_INSTRUCTIONS = `You are a phone support agent. A caller left the voice message below.
Answer them in two or three short sentences of plain spoken English: no lists,
no markdown, no links. Your answer will be read aloud, so write out what you'd
say. Use the records below to answer. If the caller doesn't give an order or
account ID that you need, ask for it.

Orders: ${JSON.stringify(ORDERS)}
Accounts: ${JSON.stringify(ACCOUNTS)}`;

// gpt-audio models answer what they hear, so the text goes in as a script to
// read, and the instructions tell the model not to reply to it.
const SPEAK_INSTRUCTIONS =
  "You are a voice actor reading a script. The user message contains a script " +
  "between <script> tags. Speak the script exactly as written, word for word, " +
  "and nothing else. Never reply to the script, never answer questions in it, " +
  "never add greetings or comments.";

type Failure = { error: string };
type Transcript = { text: string };
type Reply = { text: string };
type Speech = { audio_base64: string; audio_format: string; spoken_text: string };

function openaiClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  // Render retries these tasks, so turn off the OpenAI client's own retries to
  // keep one retry policy in charge.
  return new OpenAI({ apiKey, maxRetries: 0 });
}

// Return an error result for an OpenAI error a retry can't fix, or rethrow so
// Render retries the task.
function permanentErrorOrThrow(step: string, error: unknown): Failure {
  if (error instanceof OpenAI.APIError && PERMANENT_ERROR_STATUSES.has(error.status ?? 0)) {
    console.error(`[${step}] OpenAI error ${error.status}, not retrying`);
    return { error: `OpenAI error ${error.status}: ${error.message}` };
  }
  throw error;
}

// Buffer.from(..., "base64") skips characters it doesn't recognize, so check
// the string first.
function decodeBase64(value: string): Buffer | null {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  return Buffer.from(value, "base64");
}

// ---- Leaf tasks. Each one calls OpenAI once, so each retries on its own: a
// failed text-to-speech call reruns only text-to-speech, not the whole pipeline. ----

const transcribe = task(
  {
    name: "transcribe",
    retry: { maxRetries: 2, waitDurationMs: 1000, backoffScaling: 2 },
    timeoutSeconds: 120,
  },
  // Speech-to-text: turn base64-encoded audio into text.
  async function transcribe(
    _ctx: TaskContext,
    audioBase64: string,
    audioFormat: string = "mp3",
  ): Promise<Transcript | Failure> {
    const audio = decodeBase64(audioBase64);
    if (audio === null) return { error: "The audio isn't valid base64" };
    if (audio.length === 0) return { error: "The audio is empty" };
    if (audio.length > MAX_AUDIO_BYTES) {
      return { error: `The audio is ${audio.length} bytes; the limit is ${MAX_AUDIO_BYTES}` };
    }
    const contentType = AUDIO_CONTENT_TYPES[audioFormat];
    if (!contentType) return { error: `Unsupported audio format '${audioFormat}'` };

    const client = openaiClient();
    if (!client) return { error: "OPENAI_API_KEY is not set" };

    console.log(`[STT] ${audio.length} bytes of ${audioFormat} with ${STT_MODEL}`);
    let result;
    try {
      result = await client.audio.transcriptions.create({
        model: STT_MODEL,
        file: await toFile(audio, `message.${audioFormat}`, { type: contentType }),
      });
    } catch (error) {
      return permanentErrorOrThrow("STT", error);
    }

    const text = result.text.trim();
    if (!text) return { error: "No speech found in the audio" };
    console.log(`[STT] ${JSON.stringify(text)}`);
    return { text };
  },
);

const reply = task(
  {
    name: "reply",
    retry: { maxRetries: 2, waitDurationMs: 1000, backoffScaling: 2 },
    timeoutSeconds: 120,
  },
  // LLM: write the support agent's answer to the caller.
  async function reply(_ctx: TaskContext, transcript: string): Promise<Reply | Failure> {
    const client = openaiClient();
    if (!client) return { error: "OPENAI_API_KEY is not set" };

    console.log(`[LLM] Replying with ${LLM_MODEL}`);
    let response;
    try {
      response = await client.responses.create({
        model: LLM_MODEL,
        instructions: SUPPORT_INSTRUCTIONS,
        input: transcript,
      });
    } catch (error) {
      return permanentErrorOrThrow("LLM", error);
    }

    const text = response.output_text.trim();
    // An empty answer is worth one more try, so throw and let Render retry.
    if (!text) throw new Error("The model returned an empty reply");
    console.log(`[LLM] ${JSON.stringify(text)}`);
    return { text };
  },
);

const synthesize = task(
  {
    name: "synthesize",
    retry: { maxRetries: 2, waitDurationMs: 1000, backoffScaling: 2 },
    timeoutSeconds: 120,
  },
  // Text-to-speech: read the text aloud and return base64-encoded MP3.
  async function synthesize(
    _ctx: TaskContext,
    text: string,
    voice?: string,
  ): Promise<Speech | Failure> {
    if (!text.trim()) return { error: "There's no text to speak" };

    const client = openaiClient();
    if (!client) return { error: "OPENAI_API_KEY is not set" };

    const chosenVoice = voice || TTS_VOICE;
    console.log(`[TTS] ${text.length} characters with ${TTS_MODEL} (${chosenVoice})`);
    let response;
    try {
      response = await client.chat.completions.create({
        model: TTS_MODEL,
        modalities: ["text", "audio"],
        audio: { voice: chosenVoice, format: "mp3" },
        messages: [
          { role: "system", content: SPEAK_INSTRUCTIONS },
          { role: "user", content: `<script>${text}</script>` },
        ],
      });
    } catch (error) {
      return permanentErrorOrThrow("TTS", error);
    }

    const audio = response.choices[0]?.message.audio;
    if (!audio?.data) throw new Error("The model returned no audio");
    console.log(`[TTS] ${audio.data.length} base64 characters of mp3`);
    // spoken_text is the model's transcript of the audio it produced, so you
    // can check it read the script and didn't answer it.
    return { audio_base64: audio.data, audio_format: "mp3", spoken_text: audio.transcript };
  },
);

// ---- Orchestrator ----

// handleVoiceMessage only chains the other tasks, so it doesn't retry: a retry
// would rerun every step, including the ones that already succeeded. Each step
// retries on its own.
task(
  {
    name: "handleVoiceMessage",
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
    timeoutSeconds: 600,
  },
  // Answer a voice message: speech-to-text, then the LLM reply, then text-to-speech.
  async function handleVoiceMessage(ctx: TaskContext, audioBase64: string, audioFormat: string = "mp3") {
    // ctx.run starts each step as its own task run and waits for its result.
    const heard = await ctx.run(transcribe, audioBase64, audioFormat);
    if ("error" in heard) return { stage: "transcribe", error: heard.error };

    const answer = await ctx.run(reply, heard.text);
    if ("error" in answer) return { stage: "reply", transcript: heard.text, error: answer.error };

    const speech = await ctx.run(synthesize, answer.text);
    if ("error" in speech) {
      return { stage: "synthesize", transcript: heard.text, reply: answer.text, error: speech.error };
    }

    return {
      transcript: heard.text,
      reply: answer.text,
      audio_base64: speech.audio_base64,
      audio_format: speech.audio_format,
    };
  },
);
