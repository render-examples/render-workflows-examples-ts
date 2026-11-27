/**
 * PDF Extraction on Render Workflows
 *
 * Extract structured invoice fields from text-layer PDFs with an LLM, inside a
 * workflow task. The task reads each page's text, asks the model for a strict
 * JSON schema, re-prompts a bounded number of times when the answer doesn't
 * check out, and runs business checks. Anything a human should look at comes
 * back as an exception, never as a silently empty field.
 *
 * Scanned PDFs have no text layer. Run those through OCR first (see the
 * batch-ocr example).
 */
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { extractText } from "unpdf";
import { z } from "zod";

// Read the model from the environment so a retired model is a config change,
// not a code change.
const MODEL = process.env.OPENAI_MODEL ?? "gpt-6.2-sol";

// How many times to ask the model per task attempt: the first ask plus
// re-prompts when the answer fails validation.
const MAX_MODEL_ATTEMPTS = Number(process.env.EXTRACTION_MAX_ATTEMPTS ?? "3");

// Refuse to download more than this. Large files belong in object storage,
// passed to the task as a URL.
const MAX_PDF_BYTES = 20 * 1024 * 1024;

// OpenAI errors that mean the request itself is wrong: unknown model, bad key,
// invalid input. A retry can't fix them, so the task returns them as a result.
const PERMANENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 422]);

// Fields every invoice must have. If the model can't find one on any page,
// the result carries a missing_field exception for it.
const REQUIRED_FIELDS = ["invoice_number", "vendor_name", "invoice_date", "total"] as const;

// Sources that aren't URLs are read from this folder, which holds the sample
// invoices and ships with the service.
const BASE_DIR = fileURLToPath(new URL("..", import.meta.url));

// ---- The schema the model fills in. Every field carries the page it came from. ----

const page = z.number().int();

const TextField = z.object({
  value: z.string().nullable().describe("The value as printed, or null if absent."),
  page: page.nullable().describe("1-based page the value is on, or null if absent."),
});

const DateField = z.object({
  value: z.string().nullable().describe("The date as YYYY-MM-DD, or null if absent."),
  page: page.nullable().describe("1-based page the value is on, or null if absent."),
});

const AmountField = z.object({
  value: z.number().nullable().describe("The amount as a number, or null if absent."),
  page: page.nullable().describe("1-based page the value is on, or null if absent."),
});

const LineItem = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  amount: z.number().describe("The line total."),
  page: page.describe("1-based page the line is on."),
});

const Invoice = z.object({
  invoice_number: TextField,
  vendor_name: TextField.describe("Who issued the invoice."),
  customer_name: TextField.describe("Who the invoice is billed to."),
  invoice_date: DateField,
  due_date: DateField,
  currency: TextField.describe("ISO 4217 code, such as USD or EUR."),
  subtotal: AmountField.describe("Total of the line items before tax and shipping."),
  tax: AmountField,
  shipping: AmountField.describe("Shipping, freight or delivery charges."),
  total: AmountField.describe("The amount due."),
  line_items: z.array(LineItem).describe("Every line item, across all pages."),
});
type Invoice = z.infer<typeof Invoice>;

const DATE_FIELDS = new Set(["invoice_date", "due_date"]);

const INSTRUCTIONS = `You extract invoice data from the text layer of a PDF. The text of each page
follows a "=== Page N ===" marker.

- Copy values from the document. Never guess or compute a value that isn't printed.
- If a field isn't in the document, set its value and page to null.
- Set page to the page number where you found the value.
- Write dates as YYYY-MM-DD and currencies as ISO 4217 codes.
- Write amounts as plain numbers, without currency symbols or thousands separators.
- Include every line item from every page, in order.
`;

// What extractDocument takes and returns.
type DocRef = { document_id: string; source: string };
type ExtractionException = { code: string; field: string | null; message: string };
type ExtractionResult = {
  document_id: string | null;
  record: Invoice | null;
  exceptions: ExtractionException[];
};

// ---- Reading the PDF ----

// A problem with the input that a retry can't fix.
class PermanentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    // 408 and 429 can pass on their own, and so can 5xx: throw so the task retries.
    const { status } = response;
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      throw new PermanentError("fetch_failed", `GET ${url} returned ${status}`);
    }
    throw new Error(`GET ${url} returned ${status}`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > MAX_PDF_BYTES) {
    throw new PermanentError("too_large", `${url} is larger than ${MAX_PDF_BYTES} bytes`);
  }
  return data;
}

// Fetch the PDF a document reference points to.
async function loadPdf(source: string): Promise<Uint8Array> {
  if (source.startsWith("https://") || source.startsWith("http://")) {
    return download(source);
  }
  const path = resolve(BASE_DIR, source);
  const isFile = await stat(path).then((s) => s.isFile(), () => false);
  if (!path.startsWith(BASE_DIR.endsWith(sep) ? BASE_DIR : BASE_DIR + sep) || !isFile) {
    throw new PermanentError("source_not_found", `No file at ${source}`);
  }
  return new Uint8Array(await readFile(path));
}

// Return the text layer of each page.
async function readPages(pdf: Uint8Array): Promise<string[]> {
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return text;
  } catch (error) {
    throw new PermanentError("unreadable_pdf", `Can't read the PDF: ${(error as Error).message}`);
  }
}

// ---- Validation and business checks ----

function exception(code: string, field: string | null, message: string): ExtractionException {
  return { code, field, message };
}

// Lowercase and drop whitespace, for loose text matching.
const squash = (text: string) => text.replace(/\s+/g, "").toLowerCase();

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

// Problems with the model's answer that a re-prompt can fix.
function findProblems(invoice: Invoice, pages: string[]): string[] {
  const problems: string[] = [];
  const pageCount = pages.length;
  const inRange = (p: number | null) => p !== null && p >= 1 && p <= pageCount;

  for (const [name, field] of Object.entries(invoice)) {
    if (name === "line_items" || Array.isArray(field) || field.value === null) continue;
    if (!inRange(field.page)) {
      problems.push(`${name}.page must be between 1 and ${pageCount}`);
    }
    if (DATE_FIELDS.has(name) && !isIsoDate(String(field.value))) {
      problems.push(`${name} must be a YYYY-MM-DD date, got ${JSON.stringify(field.value)}`);
    }
  }

  const currency = invoice.currency.value;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    problems.push(`currency must be an ISO 4217 code, got ${JSON.stringify(currency)}`);
  }

  // The invoice number must be printed on the page the model cites.
  const number = invoice.invoice_number;
  if (number.value !== null && inRange(number.page)) {
    if (!squash(pages[number.page! - 1]).includes(squash(number.value))) {
      problems.push(
        `invoice_number ${JSON.stringify(number.value)} does not appear on page ${number.page}. ` +
          "Copy it exactly, or set it to null if the document has none.",
      );
    }
  }

  invoice.line_items.forEach((item, i) => {
    if (!inRange(item.page)) problems.push(`line_items[${i}].page must be between 1 and ${pageCount}`);
  });

  return problems;
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.01;
const round2 = (x: number) => Math.round(x * 100) / 100;

// Checks a re-prompt can't fix. Each failure is an exception for review.
function businessChecks(invoice: Invoice): ExtractionException[] {
  const found: ExtractionException[] = [];

  for (const name of REQUIRED_FIELDS) {
    if (invoice[name].value === null) {
      found.push(exception("missing_field", name, `No ${name} on any page`));
    }
  }
  if (invoice.line_items.length === 0) {
    found.push(exception("missing_field", "line_items", "No line items on any page"));
  }

  invoice.line_items.forEach((item, i) => {
    if (item.quantity !== null && item.unit_price !== null) {
      if (!close(item.quantity * item.unit_price, item.amount)) {
        found.push(
          exception(
            "line_amount_mismatch",
            `line_items[${i}]`,
            `${item.quantity} x ${item.unit_price} is not ${item.amount}`,
          ),
        );
      }
    }
  });

  const subtotal = invoice.subtotal.value;
  if (subtotal !== null && invoice.line_items.length > 0) {
    const lineSum = round2(invoice.line_items.reduce((sum, item) => sum + item.amount, 0));
    if (!close(lineSum, subtotal)) {
      found.push(
        exception(
          "subtotal_mismatch",
          "subtotal",
          `Line items add up to ${lineSum}, the invoice says ${subtotal}`,
        ),
      );
    }
  }

  const total = invoice.total.value;
  if (subtotal !== null && total !== null) {
    const expected = round2(subtotal + (invoice.tax.value ?? 0) + (invoice.shipping.value ?? 0));
    if (!close(expected, total)) {
      found.push(
        exception(
          "total_mismatch",
          "total",
          `Subtotal + tax + shipping is ${expected}, the invoice says ${total}`,
        ),
      );
    }
  }

  const issued = invoice.invoice_date.value;
  const due = invoice.due_date.value;
  if (issued && due && due < issued) {
    found.push(exception("due_before_issue", "due_date", `Due ${due}, issued ${issued}`));
  }

  return found;
}

// ---- Talking to the model ----

function formatPages(pages: string[]): string {
  return pages.map((text, i) => `=== Page ${i + 1} ===\n${text}`).join("\n\n");
}

// Ask the model for the invoice, re-prompting on answers that fail validation.
// Returns the last invoice the model produced (or null) and the problems it
// still had after the last attempt.
async function extractInvoice(
  client: OpenAI,
  documentId: string,
  pages: string[],
): Promise<{ invoice: Invoice | null; problems: string[] }> {
  const conversation: { role: "user"; content: string }[] = [
    { role: "user", content: formatPages(pages) },
  ];
  let invoice: Invoice | null = null;
  let problems: string[] = [];

  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt++) {
    try {
      const response = await client.responses.parse({
        model: MODEL,
        instructions: INSTRUCTIONS,
        input: conversation,
        text: { format: zodTextFormat(Invoice, "invoice") },
      });
      invoice = response.output_parsed;
      problems = invoice
        ? findProblems(invoice, pages)
        : ["The response held no invoice. Return the invoice as JSON."];
    } catch (error) {
      // The output didn't match the schema (for example, it was cut off).
      if (!(error instanceof z.core.$ZodError)) throw error;
      problems = error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    }

    if (problems.length === 0) {
      console.log(`[EXTRACT] ${documentId}: valid answer on attempt ${attempt}`);
      return { invoice, problems: [] };
    }

    console.warn(`[EXTRACT] ${documentId}: attempt ${attempt} had ${problems.length} problems`);
    conversation.push({
      role: "user",
      content:
        "Your answer had these problems:\n- " +
        problems.join("\n- ") +
        "\nExtract the invoice again and fix them.",
    });
  }

  return { invoice, problems };
}

// ---- Task ----

// extractDocument calls OpenAI and may download the PDF, so it retries.
// A retry reruns every model call, which is safe because nothing here writes.
// The caller saves the result.
task(
  {
    name: "extractDocument",
    retry: { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 2 },
    timeoutSeconds: 300,
  },
  // docRef is { document_id, source }, where source is an http(s) URL or a
  // path inside this folder. Pass references, not file contents: a task run's
  // arguments are capped at 4 MB.
  async function extractDocument(_ctx: TaskContext, docRef: DocRef): Promise<ExtractionResult> {
    const documentId = docRef?.document_id ?? null;
    const source = docRef?.source;

    // A problem a retry can't fix: return it as a result instead of throwing.
    const failed = (code: string, message: string): ExtractionResult => {
      console.error(`[EXTRACT] ${documentId}: ${code}: ${message}`);
      return { document_id: documentId, record: null, exceptions: [exception(code, null, message)] };
    };

    if (!documentId || !source) {
      return failed("bad_input", "The input needs a document_id and a source");
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return failed("config_error", "OPENAI_API_KEY is not set");

    console.log(`[EXTRACT] ${documentId}: reading ${source}`);
    let pages: string[];
    try {
      pages = await readPages(await loadPdf(source));
    } catch (error) {
      if (error instanceof PermanentError) return failed(error.code, error.message);
      throw error;
    }

    if (!pages.some((text) => text.trim())) {
      return failed("no_text_layer", "The PDF has no text layer. Run it through OCR first.");
    }

    // Render retries this task, so turn off the OpenAI client's own retries to
    // keep one retry policy in charge.
    const client = new OpenAI({ apiKey, maxRetries: 0 });
    let invoice: Invoice | null;
    let problems: string[];
    try {
      ({ invoice, problems } = await extractInvoice(client, documentId, pages));
    } catch (error) {
      if (error instanceof OpenAI.APIError && PERMANENT_ERROR_STATUSES.has(error.status ?? 0)) {
        return failed("llm_error", `OpenAI error ${error.status}: ${error.message}`);
      }
      throw error;
    }

    // Problems left after the last re-prompt go to review with the rest.
    const exceptions = problems.map((p) => exception("invalid_output", null, p));
    if (invoice === null) return { document_id: documentId, record: null, exceptions };

    exceptions.push(...businessChecks(invoice));
    console.log(
      `[EXTRACT] ${documentId}: ${invoice.line_items.length} line items, ` +
        `${exceptions.length} exceptions`,
    );
    return { document_id: documentId, record: invoice, exceptions };
  },
);
