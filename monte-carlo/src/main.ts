/**
 * Monte Carlo option pricing on Render Workflows
 *
 * Prices an Asian call option by simulating millions of price paths.
 * priceOption (on the default flex plan) splits the paths into chunks and runs
 * each chunk as its own task run on an 8 CPU / 32 GB compute plan, where it
 * uses all 8 CPUs through worker threads. It then combines the chunks into a
 * price with a 95% confidence interval.
 *
 * priceOptionSingleRun does the same simulation in one flex run, so you can
 * compare wall-clock times. With the same seed, both return the same price.
 *
 * The math is in simulation.ts.
 */
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import {
  availableCpus,
  blockCount,
  combine,
  InputError,
  parseRequest,
  simulateBlocks,
  type Partial5,
  type Request,
  type Spec,
} from "./simulation.js";

const CHUNK_PLAN = "8c-32g";

const elapsed = (start: number) => Math.round((Date.now() - start) / 10) / 100;

type ChunkResult =
  | { first_block: number; partials: Partial5[]; cpus: number; started_at: number; compute_seconds: number }
  | { error: string };

/** Return input errors as results: a retry won't fix them. */
function parseOrError(request: Request | null | undefined): Spec | { error: string } {
  try {
    return parseRequest(request);
  } catch (e) {
    if (e instanceof InputError) return { error: e.message };
    throw e;
  }
}

// simulateChunk is the heavy task: 8 CPUs and 32 GB for this run alone, billed
// per second while it runs. It's pure and deterministic (same input, same
// output, no writes anywhere), so retrying it is always safe: a retry
// recomputes exactly the same numbers. Two retries cover a lost instance.
const simulateChunk = task(
  {
    name: "simulateChunk",
    plan: CHUNK_PLAN,
    timeoutSeconds: 60 * 60,
    retry: { maxRetries: 2, waitDurationMs: 5_000, backoffScaling: 2 },
  },
  async function simulateChunk(
    _ctx: TaskContext,
    request: Request,
    firstBlock: number,
    blockTotal: number,
  ): Promise<ChunkResult> {
    const startedAt = Date.now();
    const spec = parseOrError(request);
    if ("error" in spec) return spec;
    const blocks = blockCount(spec.paths);
    const last = firstBlock + blockTotal - 1;
    if (!Number.isInteger(firstBlock) || !Number.isInteger(blockTotal) || firstBlock < 0 || blockTotal < 1 || last >= blocks) {
      return { error: `Blocks ${firstBlock}..${last} are outside 0..${blocks - 1}` };
    }

    const cpus = availableCpus();
    console.log(`[CHUNK] blocks ${firstBlock}..${last} on ${cpus} CPUs`);
    const partials = await simulateBlocks(spec, firstBlock, blockTotal, cpus);
    const seconds = elapsed(startedAt);
    console.log(`[CHUNK] blocks ${firstBlock}..${last} done in ${seconds} s`);
    return { first_block: firstBlock, partials, cpus, started_at: startedAt / 1000, compute_seconds: seconds };
  },
);

// priceOption only splits, waits and adds up, so it runs on flex and never
// retries: a retry would rerun every chunk. Its timeout covers chunks that
// queue for compute and the chunks' own retries.
task(
  {
    name: "priceOption",
    timeoutSeconds: 2 * 60 * 60,
    retry: { maxRetries: 0, waitDurationMs: 1_000, backoffScaling: 1.5 },
  },
  async function priceOption(ctx: TaskContext, request?: Request) {
    const startedAt = Date.now();
    const spec = parseOrError(request);
    if ("error" in spec) return spec;

    // Split the blocks into `chunks` contiguous ranges of near-equal size.
    const blocks = blockCount(spec.paths);
    const chunks = Math.min(spec.chunks, blocks);
    const ranges = Array.from({ length: chunks }, (_, i) => [
      Math.floor((i * blocks) / chunks),
      Math.floor(((i + 1) * blocks) / chunks),
    ]);
    console.log(`[PRICE] ${spec.paths.toLocaleString("en-US")} paths, ${blocks} blocks, ${chunks} chunks on ${CHUNK_PLAN}`);

    // Each ctx.run is its own task run on its own 8c-32g instance. If a chunk
    // fails all its attempts, Promise.all rejects and this run fails: a price
    // missing some paths would be wrong.
    const dispatchedAt = Date.now() / 1000;
    const results = await Promise.all(ranges.map(([start, end]) => ctx.run(simulateChunk, spec, start, end - start)));
    const failed = results.find((result) => "error" in result);
    if (failed && "error" in failed) return { error: failed.error };
    const done = results as Extract<ChunkResult, { partials: Partial5[] }>[];

    const wall = elapsed(startedAt);
    console.log(`[PRICE] done in ${wall} s`);
    return {
      ...combine(spec, done.flatMap((result) => result.partials)),
      spec,
      run: {
        mode: "fan-out",
        chunks,
        chunk_plan: CHUNK_PLAN,
        wall_seconds: wall,
        chunk_runs: done.map((result, i) => ({
          blocks: [ranges[i][0], ranges[i][1] - 1],
          cpus: result.cpus,
          // Time from ctx.run to the chunk's code starting: queueing for
          // compute plus starting the instance.
          start_delay_seconds: Math.round((result.started_at - dispatchedAt) * 100) / 100,
          compute_seconds: result.compute_seconds,
        })),
      },
    };
  },
);

// The baseline: every path in one run on the default flex plan (up to 1 CPU).
// Pure and deterministic like simulateChunk, so retries are safe here too.
task(
  {
    name: "priceOptionSingleRun",
    timeoutSeconds: 2 * 60 * 60,
    retry: { maxRetries: 2, waitDurationMs: 5_000, backoffScaling: 2 },
  },
  async function priceOptionSingleRun(_ctx: TaskContext, request?: Request) {
    const startedAt = Date.now();
    const spec = parseOrError(request);
    if ("error" in spec) return spec;

    const cpus = availableCpus();
    const blocks = blockCount(spec.paths);
    console.log(`[SINGLE] ${spec.paths.toLocaleString("en-US")} paths, ${blocks} blocks on ${cpus} CPUs`);
    const partials = await simulateBlocks(spec, 0, blocks, cpus);
    const wall = elapsed(startedAt);
    console.log(`[SINGLE] done in ${wall} s`);
    return { ...combine(spec, partials), spec, run: { mode: "single run", cpus, wall_seconds: wall } };
  },
);
