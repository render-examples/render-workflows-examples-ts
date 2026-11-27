# Product image import on Render Workflows

Bulk-import product images from a list of URLs: resized JPEG, WebP and AVIF variants, a blurhash placeholder, and alt text from an OpenAI vision model, one set of task runs per image.

## What it shows

- Fanning out one task run per image from an orchestrator, with a cap on how many images run at once
- Image processing with [sharp](https://sharp.pixelplumbing.com/) in a task on Render's native Node runtime (sharp's prebuilt binaries include libvips with AVIF and WebP, so nothing else to install)
- Calling a vision model with structured output (`responses.parse` with a Zod schema) for alt text and tags
- Retries only on the tasks that call the network or the model, and none on the fan-out
- Returning bad URLs and files that aren't images as failed rows in the manifest, not as a failed batch
- Returning only small outputs, because task arguments are capped at 4 MB

## Task tree

```
importImages                 (flex, no retries, 1 h timeout; up to MAX_CONCURRENT_IMAGES at once)
  ├── processImage           (2 retries, 5 min timeout per attempt; one run per image)
  │     ├── download the URL into memory
  │     ├── sharp            → 1200 / 600 / 300 px wide, each as JPEG, WebP and AVIF
  │     ├── blurhash         → ~30 character placeholder
  │     └── storeVariants()  → keeps each variant's size and key; the files are discarded
  └── generateAltText        (3 retries, 2 min timeout per attempt; one run per image)
        └── OpenAI vision model → {"alt_text", "tags"}
```

Widths larger than the source are skipped. `generateAltText` gets a 512 px JPEG preview from `processImage` (about 25 KB), not the original file.

## What comes back, and where real outputs would go

To keep the example self-contained, it needs no bucket. `importImages` returns a manifest of about 3.5 KB per image:

```json
{
  "total": 7, "imported": 5, "failed": 2, "missing_alt_text": 0,
  "images": [
    {
      "id": "wireless-mouse", "name": "Wireless mouse", "url": "https://upload.wikimedia.org/...", "status": "imported",
      "source": {"format": "jpeg", "width": 2600, "height": 1600, "has_alpha": false, "bytes": 476739},
      "blurhash": "LnNdL1D%?b_3%May%Lxu~qt7ayfk",
      "variants": [
        {"format": "jpeg", "width": 1200, "height": 738, "bytes": 57363, "key": "products/wireless-mouse/1200.jpeg"},
        {"format": "webp", "width": 1200, "height": 738, "bytes": 50572, "key": "products/wireless-mouse/1200.webp"},
        {"format": "avif", "width": 1200, "height": 738, "bytes": 25399, "key": "products/wireless-mouse/1200.avif"},
        ...
      ],
      "thumbnail_webp_base64": "UklGRgoGAABXRUJQ...",
      "alt_text": "Black Microsoft wireless mouse with a plastic body, a silver-trimmed scroll wheel, and a USB receiver.",
      "tags": ["wireless mouse", "microsoft", "black", "usb receiver", "scroll wheel"],
      "seconds": {"download": 0.38, "variants": 0.61}
    },
    {"id": "missing-file", "status": "failed", "error": "Download failed: HTTP 404", ...}
  ]
}
```

The variant files are deleted with the run's disk. **A real app would upload them to object storage such as S3**, in `storeVariants()`. That function is the one place that decides what leaves the run, and its doc comment shows the upload call:

```ts
function storeVariants(variants) {
  // In a real app, upload them here instead, for example with @aws-sdk/client-s3:
  //   for (const v of variants) {
  //     await s3.send(new PutObjectCommand({
  //       Bucket: BUCKET, Key: v.key, Body: await readFile(v.path), ContentType: `image/${v.format}`,
  //     }));
  //   }
  // and return each key or URL.
}
```

Each `key` comes from the image id, so a retry overwrites its earlier upload instead of leaving a copy.

## Prerequisites

- Node.js 22+
- The [Render CLI](https://render.com/docs/cli)
- An [OpenAI API key](https://platform.openai.com/api-keys)

## Run locally

```bash
npm install
cp .env.example .env   # then set OPENAI_API_KEY
npm run build
render workflows dev -- node dist/main.js
```

The local task server loads `.env` when it starts. In another terminal, import every image in `images.json`. Task input is a JSON array of the task's arguments, and `importImages` takes one: the list.

```bash
render workflows tasks runs start importImages --local --input="[$(cat images.json)]"
```

`images.json` holds five product photos and two broken rows: a URL that returns 404, and a Wikimedia file page (HTML) instead of the image. Both come back with `"status": "failed"`.

To process a single image without alt text, run `processImage` on its own:

```bash
render workflows tasks runs start processImage --local \
  --input='[{"id": "wireless-mouse", "url": "https://upload.wikimedia.org/wikipedia/commons/6/69/Microsoft-wireless-mouse.jpg"}]'
```

Each image is `{"id", "url"}` plus an optional `"name"`, which the model gets as context. The id becomes part of storage keys, so it may only contain letters, digits, `.`, `_` and `-`.

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | none | Required for alt text. Without it, images still import, with `alt_text_error`. |
| `OPENAI_MODEL` | `gpt-6.2-sol` | Any OpenAI model that accepts image input |
| `MAX_CONCURRENT_IMAGES` | `8` | Images `importImages` works on at once |
| `MAX_INPUT_MB` | `25` | Larger downloads fail as `Image is ... over MAX_INPUT_MB` |
| `MAX_MEGAPIXELS` | `50` | Larger images fail before any pixels are decoded |

### Sample images

The five product photos are by Evan-Amos on Wikimedia Commons and are in the **public domain**. Each row in `images.json` links its Commons file page under `source`.

## Deploy to Render

1. Push this folder to a Git repository Render can access.
2. In the Render Dashboard, click **New > Workflow** and connect the repository.
3. Set these fields:

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `product-image-import` (the folder that holds `package.json`). Leave it empty if this folder is the repository root. |
   | Build Command | `npm install && npm run build` |
   | Start Command | `node dist/main.js` |
   | Region | Any |
   | Environment variables | `OPENAI_API_KEY`. Optionally the others in the table above. |

4. Create the workflow. Once the first version is ready, run `importImages` from the Dashboard with the contents of `images.json` wrapped in `[ ]` as its input.

`package-lock.json` lists sharp's prebuilt binaries for every platform, so `npm install` on Render picks the Linux one even if you locked on a Mac.

## Trigger from another service

`src/client.ts` imports `images.json`, prints the manifest and writes each image's thumbnail to the current directory:

```bash
export RENDER_API_KEY=your-render-api-key
export WORKFLOW_SLUG=your-workflow-slug   # defaults to product-image-import
npm run build && npm run client
```

The core of it:

```ts
import { Render } from "@renderinc/sdk";

const render = new Render(); // reads RENDER_API_KEY

const run = await render.workflows.runTask(`${SLUG}/importImages`, [images], {
  idempotencyKey: "import-sample-images-v1",
});
const manifest = run.results[0]; // results is an array holding the return value
for (const row of manifest.images) {
  console.log(row.id, row.status, row.alt_text ?? row.error);
}
```

`runTask` waits for the run to finish. To start a run and check on it later, use `startTask` instead. The idempotency key makes a repeated call within 24 hours return the first run instead of importing the same list again.

## Limits and gotchas

- **Images can't travel as task arguments.** The combined arguments of a task run are capped at 4 MB, so images come in as URLs, and the preview for the model is a 512 px JPEG. Keep results small too: Render keeps each run's inputs and results for 30 days and bills that state per GB ([state retention](https://render.com/docs/workflows-limits#state-retention)). Files belong in object storage, with only their keys in the result. See [limits](https://render.com/docs/workflows-limits#additional-limits).
- **Errors a retry can't fix are returned, not thrown.** A 4xx on the image URL, a URL that isn't http(s), an HTML page, a file sharp can't read, or an image over `MAX_INPUT_MB` or `MAX_MEGAPIXELS` comes back as a failed row. A missing `OPENAI_API_KEY`, an unknown model or another 400/401/403/404/422 from OpenAI comes back as `alt_text_error`, and the image stays imported.
- **Retries go on the tasks that call out, not on the fan-out.** `processImage` retries network errors, HTTP 5xx and 429; `generateAltText` retries OpenAI 429s, 5xx and connection errors. The OpenAI client's own retries are off (`maxRetries: 0`) so Render's policy is the only one. `importImages` never retries, because a retry would redo every image. See [retries](https://render.com/docs/workflows-defining-tasks#retry-settings).
- **A retry redoes the whole image.** That's safe here because `processImage` writes nothing outside its own disk. If you add uploads, keep the id-derived keys so a retry overwrites.
- **Timeouts apply per attempt.** Each attempt gets a fresh timeout. `importImages` has an hour to wait for every image, including retries. The seven sample images take about 10 seconds; raise the timeout for long lists. See [timeouts](https://render.com/docs/workflows-defining-tasks#timeout).
- **Big lists start many runs.** Each image starts two task runs. Render limits how fast a workspace can start chained runs, and fails runs past that limit instead of queuing them. `MAX_CONCURRENT_IMAGES` keeps the pace down; for thousands of images, also split the list into several `importImages` runs. See [workflows limits](https://render.com/docs/workflows-limits).
- **Tell libvips how many CPUs it has.** Inside a task run, `os.cpus()` reports the host machine's CPUs, not your plan's. `availableCpus()` reads the plan's quota from the cgroup and passes it to `sharp.concurrency()`.
- **Send a descriptive User-Agent.** Image hosts such as Wikimedia ask for one and reject some generic clients with HTTP 403. `download()` sends `USER_AGENT`; change it to name your app.
- **Colors and orientation.** Every pipeline applies the EXIF rotation (`autoOrient`). sharp converts variants to sRGB and drops metadata by default.

## Links

- [Render Workflows](https://render.com/docs/workflows)
- [Defining tasks](https://render.com/docs/workflows-defining-tasks)
- [Workflows limits](https://render.com/docs/workflows-limits)
- [Triggering runs](https://render.com/docs/workflows-running)
- [OpenAI images and vision](https://platform.openai.com/docs/guides/images-vision)
- [OpenAI structured outputs](https://platform.openai.com/docs/guides/structured-outputs)
- [sharp output options](https://sharp.pixelplumbing.com/api-output)
- [Blurhash](https://blurha.sh/)
