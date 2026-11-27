/**
 * Browser screenshots on Render Workflows
 *
 * Checks many web pages with headless Chromium (Playwright). For each URL, one
 * task run loads the page and records its HTTP status, title, load time,
 * console errors and broken images, then takes a screenshot. An orchestrator
 * fans out one run per URL, with a cap on how many run at once.
 *
 * Chromium runs on Render's native Node runtime: the build command downloads
 * Playwright's headless Chromium into the project, so there's no Docker image.
 *
 * To stay self-contained, each run returns a small JPEG thumbnail (base64) and
 * discards the full screenshot. A real app would upload the full screenshot to
 * object storage such as S3 in storeScreenshot().
 */
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import type { Browser, BrowserContext } from "playwright";

// How many checkPage runs checkPages keeps going at once. Render has no
// per-task concurrency setting, so the cap lives in code. It also keeps you
// from flooding the sites you check.
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? "5");
// The most URLs one checkPages run accepts. Every page's thumbnail comes back
// in the batch result (about 10-20 KB each), so this keeps results small.
const MAX_URLS = Number(process.env.MAX_URLS ?? "100");
// How long a page may take to fire its load event, per attempt.
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS ?? "30000");

const VIEWPORT = { width: 1280, height: 800 };
const THUMBNAIL_WIDTH = 320;
// Keep at most this many console errors and broken image URLs per page.
const MAX_LISTED = 10;

// Navigation errors a retry won't fix. Anything else (timeouts, connection
// resets, a crashed browser) is thrown so Render retries the run.
const PERMANENT_NET_ERRORS = [
  "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_CERT_",
  "net::ERR_SSL_",
  "net::ERR_BAD_SSL_CLIENT_AUTH_CERT",
  "net::ERR_INVALID_URL",
  "net::ERR_UNSAFE_PORT",
  "net::ERR_TOO_MANY_REDIRECTS",
  "net::ERR_ABORTED",
];

type PageCheck = {
  url: string;
  final_url: string;
  ok: boolean;
  problems: string[];
  status: number | null;
  title: string;
  load_ms: number;
  console_error_count: number;
  console_errors: string[];
  broken_image_count: number;
  broken_images: string[];
  screenshot_bytes: number;
  thumbnail_jpeg_base64: string;
};
type PageFailure = { url: unknown; ok: false; error: string };
type CheckResult = PageCheck | PageFailure;

/** A failure a retry can't fix. checkPage returns it instead of throwing. */
class PermanentError extends Error {}

// ---- Helpers ----

/** Return url if it's an absolute http(s) URL, or throw PermanentError. */
function checkUrl(url: unknown): string {
  if (typeof url !== "string" || !url.trim()) {
    throw new PermanentError("Each URL must be a non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new PermanentError("URL must start with http:// or https://");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) {
    throw new PermanentError("URL must start with http:// or https://");
  }
  return url.trim();
}

const plural = (n: number, word: string) => (n === 1 ? `${n} ${word}` : `${n} ${word}s`);

/**
 * Load Playwright's Chromium.
 *
 * Playwright looks for the browser inside its own package when
 * PLAYWRIGHT_BROWSERS_PATH is "0", which is where the build command put it
 * ("PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install"). The default location,
 * ~/.cache, isn't kept from the build to task runs on Render. Playwright reads
 * the variable when it's first imported, so set it before a dynamic import.
 */
async function loadChromium() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
  const { chromium } = await import("playwright");
  return chromium;
}

/**
 * Decide what to keep of the full screenshot before the run ends.
 *
 * This example keeps only a small JPEG thumbnail, returned as base64, and
 * discards the full PNG.
 *
 * In a real app, upload png here instead, for example with @aws-sdk/client-s3:
 *   const key = `screenshots/${createHash("sha256").update(url).digest("hex")}.png`;
 *   await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: png, ContentType: "image/png" }));
 * and return the key. A key derived from the URL means a retry overwrites its
 * earlier upload instead of leaving a duplicate.
 */
async function storeScreenshot(context: BrowserContext, url: string, png: Buffer) {
  // A fresh blank page, so the checked site's Content-Security-Policy can't
  // block the data: URL. Chromium is already running, so it makes the
  // thumbnail too: no image library needed.
  const page = await context.newPage();
  try {
    const thumbnail = await page.evaluate(
      async ([data, width]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = Math.round((img.height * width) / img.width);
        const draw = canvas.getContext("2d")!;
        draw.imageSmoothingQuality = "high";
        draw.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
      },
      [png.toString("base64"), THUMBNAIL_WIDTH] as const,
    );
    return { screenshot_bytes: png.length, thumbnail_jpeg_base64: thumbnail };
  } finally {
    await page.close();
  }
}

/** Load url in a new browser context and collect what the checks need. */
async function loadAndInspect(browser: Browser, url: string): Promise<PageCheck> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    const brokenImages = new Set<string>();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
    });
    page.on("pageerror", (error) => consoleErrors.push(`Uncaught: ${error.message}`.slice(0, 300)));
    // An image is broken if its request failed or got an HTTP error.
    page.on("requestfailed", (request) => {
      if (request.resourceType() === "image") brokenImages.add(request.url().slice(0, 300));
    });
    page.on("response", (response) => {
      if (response.request().resourceType() === "image" && response.status() >= 400) {
        brokenImages.add(response.url().slice(0, 300));
      }
    });

    const started = performance.now();
    let response;
    try {
      response = await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    } catch (error) {
      // Timeouts may pass: let Render retry. So may most network errors.
      const message = String((error as Error).message ?? error).split("\n")[0];
      if (PERMANENT_NET_ERRORS.some((code) => message.includes(code))) {
        throw new PermanentError(message);
      }
      throw error;
    }
    const loadMs = Math.round(performance.now() - started);

    const status = response?.status() ?? null;
    // 5xx and 429 often pass. Throw so Render retries the run.
    if (status !== null && (status >= 500 || status === 429)) {
      throw new Error(`HTTP ${status} from ${url}`);
    }

    const finalUrl = page.url();
    const title = await page.title();
    const png = await page.screenshot({ type: "png" });
    const stored = await storeScreenshot(context, url, png);

    const problems: string[] = [];
    if (status === null || status >= 400) problems.push(`HTTP ${status}`);
    if (consoleErrors.length) problems.push(plural(consoleErrors.length, "console error"));
    if (brokenImages.size) problems.push(plural(brokenImages.size, "broken image"));
    return {
      url,
      final_url: finalUrl,
      ok: problems.length === 0,
      problems,
      status,
      title,
      load_ms: loadMs,
      console_error_count: consoleErrors.length,
      console_errors: consoleErrors.slice(0, MAX_LISTED),
      broken_image_count: brokenImages.size,
      broken_images: [...brokenImages].sort().slice(0, MAX_LISTED),
      ...stored,
    };
  } finally {
    await context.close();
  }
}

// ---- Tasks ----

// checkPage loads one URL in its own headless Chromium. Chromium fits in flex
// (up to 1 CPU and 4 GB, billed for what the run uses); move it to 2c-4g if
// your pages are heavy. It retries twice for errors that may pass: timeouts,
// dropped connections, 5xx responses. Loading a page has no side effects on
// our side, so a retry is safe. Each attempt may take up to 2 minutes.
const checkPage = task(
  {
    name: "checkPage",
    plan: "flex",
    timeoutSeconds: 120,
    retry: { maxRetries: 2, waitDurationMs: 5000, backoffScaling: 2 },
  },
  async function checkPage(_ctx: TaskContext, input: string): Promise<CheckResult> {
    let url: string;
    try {
      url = checkUrl(input);
    } catch (error) {
      return { url: input, ok: false, error: (error as Error).message };
    }

    console.log(`[CHECK] ${url}`);
    const chromium = await loadChromium();
    const browser = await chromium.launch();
    let result: PageCheck;
    try {
      result = await loadAndInspect(browser, url);
    } catch (error) {
      if (!(error instanceof PermanentError)) throw error;
      console.error(`[CHECK] ${url}: ${error.message} (not retrying)`);
      return { url, ok: false, error: error.message };
    } finally {
      await browser.close();
    }

    const problems = result.problems.length ? result.problems.join(", ") : "no problems";
    console.log(`[CHECK] ${url}: HTTP ${result.status} in ${result.load_ms} ms, ${problems}`);
    return result;
  },
);

// checkPages only fans out and waits, so it runs on flex and never retries: a
// retry would recheck every URL, including the ones that finished. Each
// checkPage run retries on its own. The timeout covers the whole batch.
task(
  {
    name: "checkPages",
    plan: "flex",
    timeoutSeconds: 60 * 60,
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1.5 },
  },
  async function checkPages(ctx: TaskContext, input: string[]) {
    if (!Array.isArray(input)) return { error: "Input must be a list of URLs" };
    const urls = [...new Set(input)]; // drop duplicates, keep order
    if (urls.length > MAX_URLS) {
      return { error: `Got ${urls.length} URLs; split them into batches of at most ${MAX_URLS}` };
    }

    console.log(`[BATCH] ${urls.length} URLs, at most ${MAX_CONCURRENCY} at once`);

    // A small concurrency limiter: each worker takes the next URL when its
    // previous run finishes, so at most MAX_CONCURRENCY runs are going at once.
    const results: PromiseSettledResult<CheckResult>[] = new Array(urls.length);
    let next = 0;
    async function worker() {
      while (next < urls.length) {
        const i = next++;
        // allSettled-style results keep one failed URL from failing the batch.
        results[i] = await ctx.run(checkPage, urls[i]).then(
          (value) => ({ status: "fulfilled", value }) as const,
          (reason) => ({ status: "rejected", reason }) as const,
        );
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, urls.length) }, worker));

    const pages: PageCheck[] = [];
    const failed: PageFailure[] = [];
    results.forEach((outcome, i) => {
      if (outcome.status === "rejected") {
        // The run threw on every attempt (retries used up).
        failed.push({ url: urls[i], ok: false, error: String(outcome.reason) });
      } else if ("error" in outcome.value) {
        failed.push(outcome.value);
      } else {
        pages.push(outcome.value);
      }
    });

    const withProblems = pages.filter((p) => !p.ok).map((p) => p.url);
    console.log(`[BATCH] ${pages.length} checked (${withProblems.length} with problems), ${failed.length} failed`);
    return {
      total: urls.length,
      checked: pages.length,
      with_problems: withProblems,
      failed,
      pages,
    };
  },
);
