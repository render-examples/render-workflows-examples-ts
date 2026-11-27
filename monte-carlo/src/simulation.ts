/**
 * The Monte Carlo math, with no Render code in it.
 *
 * Prices an arithmetic-average Asian call: an option that pays
 * max(average price - strike, 0) at maturity, where the average is taken over
 * every monitoring date (daily, by default). There's no closed-form price for
 * it, which is why people simulate it.
 *
 * The paths are split into fixed-size blocks. Block i always draws from the
 * same random stream, derived from (seed, i), no matter which task run or
 * worker thread simulates it. So the same seed gives the same price whether
 * the blocks run in one task run or spread across many.
 */
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { uniformFloat64 } from "pure-rand/distribution/uniformFloat64";
import { xoroshiro128plus } from "pure-rand/generator/xoroshiro128plus";

// Paths per block. Each block is one unit of work for a worker thread, and one
// entry in a chunk's result. Changing it changes which random numbers each
// path gets, so it's a constant rather than an input.
export const BLOCK_SIZE = 100_000;

export const DEFAULTS = {
  spot: 100, // price of the underlying today
  strike: 100,
  rate: 0.05, // risk-free rate, continuously compounded
  volatility: 0.2, // annualized
  maturity_years: 1,
  steps: 252, // monitoring dates: one per trading day
  paths: 2_000_000,
  seed: 42,
  chunks: 4, // task runs to split the paths across (priceOption only)
};
export type Spec = typeof DEFAULTS;
export type Request = Partial<Spec>;

const MAX_PATHS = 1_000_000_000;
const MAX_STEPS = 10_000;
const MAX_CHUNKS = 64;

/** Bad input. A retry won't fix it, so tasks return it instead of throwing. */
export class InputError extends Error {}

/** Fill in defaults and check ranges. */
export function parseRequest(request: Request | null | undefined): Spec {
  const given = request ?? {};
  if (typeof given !== "object" || Array.isArray(given)) throw new InputError("The request must be an object");
  const unknown = Object.keys(given).filter((key) => !(key in DEFAULTS));
  if (unknown.length) throw new InputError(`Unknown fields: ${JSON.stringify(unknown.sort())}`);
  const spec = { ...DEFAULTS, ...given };
  for (const key of ["spot", "strike", "volatility", "maturity_years"] as const) {
    if (typeof spec[key] !== "number" || !(spec[key] > 0)) throw new InputError(`${key} must be a positive number`);
  }
  if (typeof spec.rate !== "number" || !Number.isFinite(spec.rate)) throw new InputError("rate must be a number");
  const ranges = [
    ["steps", 1, MAX_STEPS],
    ["paths", 1, MAX_PATHS],
    ["chunks", 1, MAX_CHUNKS],
    ["seed", 0, 2 ** 32 - 1],
  ] as const;
  for (const [key, low, high] of ranges) {
    const value = spec[key];
    if (!Number.isInteger(value) || value < low || value > high) {
      throw new InputError(`${key} must be an integer from ${low} to ${high}`);
    }
  }
  return spec;
}

export function blockCount(paths: number): number {
  return Math.ceil(paths / BLOCK_SIZE);
}

/**
 * CPUs this run may use.
 *
 * On Render, the OS can report the host's CPUs rather than the compute plan's.
 * The plan's limit is in the cgroup's cpu.max ("800000 100000" is 8 CPUs).
 */
export function availableCpus(): number {
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf-8").trim().split(/\s+/);
    if (quota !== "max") return Math.max(1, Math.floor(Number(quota) / Number(period)));
  } catch {
    // Not on Linux with cgroup v2, for example on your laptop.
  }
  return availableParallelism();
}

/** [paths, Asian payoff sum, sum of squares, European payoff sum, sum of squares], undiscounted. */
export type Partial5 = [number, number, number, number, number];

/**
 * Simulate the given blocks (in ascending order) and return one entry per block.
 *
 * Each block's random stream is xoroshiro128+ seeded with `seed`, then jumped
 * ahead `block` times. A jump skips 2^64 numbers, so blocks never overlap.
 */
export function simulateBlockList(spec: Spec, blocks: number[]): Partial5[] {
  const steps = spec.steps;
  const dt = spec.maturity_years / steps;
  const drift = (spec.rate - 0.5 * spec.volatility ** 2) * dt;
  const shock = spec.volatility * Math.sqrt(dt);

  const cursor = xoroshiro128plus(spec.seed);
  let at = 0;
  const out: Partial5[] = [];
  for (const block of blocks) {
    while (at < block) {
      cursor.jump();
      at++;
    }
    const rng = cursor.clone();
    const n = Math.min(BLOCK_SIZE, spec.paths - block * BLOCK_SIZE);

    // Marsaglia's polar method turns two uniforms into two standard normals.
    // Keep the spare for the next call.
    let spare = 0;
    let hasSpare = false;
    const normal = () => {
      if (hasSpare) {
        hasSpare = false;
        return spare;
      }
      let u: number, v: number, q: number;
      do {
        u = 2 * uniformFloat64(rng) - 1;
        v = 2 * uniformFloat64(rng) - 1;
        q = u * u + v * v;
      } while (q >= 1 || q === 0);
      const scale = Math.sqrt((-2 * Math.log(q)) / q);
      spare = v * scale;
      hasSpare = true;
      return u * scale;
    };

    let asianSum = 0;
    let asianSq = 0;
    let euroSum = 0;
    let euroSq = 0;
    for (let path = 0; path < n; path++) {
      // logPrice is log(S / spot). Walk it forward one monitoring date at a time.
      let logPrice = 0;
      let priceSum = 0;
      let price = 1;
      for (let step = 0; step < steps; step++) {
        logPrice += drift + shock * normal();
        price = Math.exp(logPrice);
        priceSum += price;
      }
      const asian = Math.max((spec.spot * priceSum) / steps - spec.strike, 0);
      // The European payoff max(S_T - strike, 0) comes from the same paths.
      // It has a closed-form price (Black-Scholes), so it checks the simulation.
      const euro = Math.max(spec.spot * price - spec.strike, 0);
      asianSum += asian;
      asianSq += asian * asian;
      euroSum += euro;
      euroSq += euro * euro;
    }
    out.push([n, asianSum, asianSq, euroSum, euroSq]);
  }
  return out;
}

/**
 * Simulate blocks [firstBlock, firstBlock + blockTotal), using up to `cpus`
 * worker threads. Returns one entry per block, in block order.
 *
 * JavaScript runs this on one CPU, so a bigger compute plan only helps if we
 * start more threads. Thread i gets blocks i, i + workers, i + 2 * workers, ...
 */
export async function simulateBlocks(
  spec: Spec,
  firstBlock: number,
  blockTotal: number,
  cpus: number,
): Promise<Partial5[]> {
  const blocks = Array.from({ length: blockTotal }, (_, i) => firstBlock + i);
  const workers = Math.min(cpus, blocks.length);
  if (workers <= 1) return simulateBlockList(spec, blocks);

  const shares = Array.from({ length: workers }, (_, w) => blocks.filter((_, i) => i % workers === w));
  const results = await Promise.all(
    shares.map(
      (share) =>
        new Promise<Partial5[]>((resolve, reject) => {
          const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: { spec, blocks: share } });
          worker.once("message", resolve);
          worker.once("error", reject);
          worker.once("exit", (code) => code !== 0 && reject(new Error(`Worker exited with code ${code}`)));
        }),
    ),
  );

  // Put the blocks back in order.
  const byBlock = new Map<number, Partial5>();
  shares.forEach((share, w) => share.forEach((block, i) => byBlock.set(block, results[w][i])));
  return blocks.map((block) => byBlock.get(block)!);
}

type Estimate = { price: number; std_error: number; ci95: [number, number] };

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function estimate(total: number, totalSq: number, n: number, discount: number): Estimate {
  const mean = total / n;
  const variance = (Math.max(totalSq / n - mean * mean, 0) * n) / Math.max(n - 1, 1);
  const stdError = discount * Math.sqrt(variance / n);
  const price = discount * mean;
  return {
    price: round6(price),
    std_error: round6(stdError),
    // 95% confidence interval: price ± 1.96 standard errors.
    ci95: [round6(price - 1.96 * stdError), round6(price + 1.96 * stdError)],
  };
}

/** Standard normal CDF, accurate to double precision (Hart, 1968; as given by West, 2005). */
function normalCdf(x: number): number {
  const z = Math.abs(x);
  let c: number;
  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp((-z * z) / 2);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * n) / d;
    } else {
      let d = z + 0.65;
      d = z + 4 / d;
      d = z + 3 / d;
      d = z + 2 / d;
      d = z + 1 / d;
      c = e / d / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

export function blackScholesCall(spec: Spec): number {
  const { spot: s, strike: k, rate: r, volatility: sigma, maturity_years: t } = spec;
  const d1 = (Math.log(s / k) + (r + 0.5 * sigma ** 2) * t) / (sigma * Math.sqrt(t));
  const d2 = d1 - sigma * Math.sqrt(t);
  return s * normalCdf(d1) - k * Math.exp(-r * t) * normalCdf(d2);
}

/** Reduce per-block sums (in block order) to prices with 95% intervals. */
export function combine(spec: Spec, partials: Partial5[]) {
  const sums = [0, 0, 0, 0, 0];
  for (const partial of partials) partial.forEach((value, i) => (sums[i] += value));
  const n = sums[0];
  const discount = Math.exp(-spec.rate * spec.maturity_years);
  const european = estimate(sums[3], sums[4], n, discount);
  const exact = blackScholesCall(spec);
  return {
    asian_call: estimate(sums[1], sums[2], n, discount),
    // A sanity check from the same paths: the European call's simulated price
    // should land near Black-Scholes (inside the interval about 95% of the time).
    european_check: {
      ...european,
      black_scholes: round6(exact),
      within_ci95: european.ci95[0] <= exact && exact <= european.ci95[1],
    },
    paths: n,
  };
}
