/**
 * Price the option from another service or script, fanned out and in one run,
 * and compare.
 *
 * Requires RENDER_API_KEY. Set WORKFLOW_SLUG to your workflow service's slug
 * (it defaults to monte-carlo).
 *
 *   node dist/client.js              # 2 million paths
 *   node dist/client.js 100000000    # 100 million paths
 */
import { Render } from "@renderinc/sdk";

// The shape the pricing tasks return. Task results come back untyped, so declare it here.
type Estimate = { price: number; std_error: number; ci95: [number, number] };
type PriceResult = {
  asian_call: Estimate;
  european_check: Estimate & { black_scholes: number; within_ci95: boolean };
  paths: number;
  run: {
    mode: string;
    wall_seconds: number;
    chunk_runs?: { blocks: [number, number]; cpus: number; start_delay_seconds: number; compute_seconds: number }[];
  };
  error?: string;
};

const SLUG = process.env.WORKFLOW_SLUG ?? "monte-carlo";
const paths = process.argv[2] ? Number(process.argv[2]) : 2_000_000;
const request = { paths, seed: 42, chunks: 4 };

// Render() reads RENDER_API_KEY from the environment.
const render = new Render();

const results: Record<string, PriceResult> = {};
for (const name of ["priceOption", "priceOptionSingleRun"]) {
  console.log(`Running ${name} with ${paths.toLocaleString("en-US")} paths...`);
  // Task input is an array of the task's arguments. runTask waits for the run
  // to finish and returns its details.
  const run = await render.workflows.runTask(`${SLUG}/${name}`, [request]);
  if (run.status !== "completed") throw new Error(`Run ${run.id} ended as ${run.status}: ${run.error}`);
  // results is an array holding the task's return value.
  const result = run.results[0] as PriceResult;
  if (result.error) throw new Error(`${name}: ${result.error}`);
  results[name] = result;
}

for (const [name, result] of Object.entries(results)) {
  const { asian_call: asian, european_check: check, run } = result;
  console.log(`\n${name}: ${run.wall_seconds} s`);
  console.log(`  Asian call: ${asian.price.toFixed(4)}  (95% CI ${asian.ci95[0].toFixed(4)} to ${asian.ci95[1].toFixed(4)})`);
  console.log(`  European check: ${check.price.toFixed(4)} vs Black-Scholes ${check.black_scholes.toFixed(4)}`);
  for (const chunk of run.chunk_runs ?? []) {
    console.log(
      `  chunk [${chunk.blocks}]: ${chunk.cpus} CPUs, started after ${chunk.start_delay_seconds} s, computed ${chunk.compute_seconds} s`,
    );
  }
}

const fanOut = results.priceOption;
const single = results.priceOptionSingleRun;
console.log(`\nSame price from both: ${JSON.stringify(fanOut.asian_call) === JSON.stringify(single.asian_call)}`);
console.log(`Speedup: ${(single.run.wall_seconds / fanOut.run.wall_seconds).toFixed(1)}x`);
