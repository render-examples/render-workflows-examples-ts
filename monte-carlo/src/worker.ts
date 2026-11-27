/**
 * A worker thread: simulates the blocks it's given and posts their sums back.
 * simulateBlocks() in simulation.ts starts one per CPU.
 */
import { parentPort, workerData } from "node:worker_threads";
import { simulateBlockList, type Spec } from "./simulation.js";

const { spec, blocks } = workerData as { spec: Spec; blocks: number[] };
parentPort!.postMessage(simulateBlockList(spec, blocks));
