import { task, type TaskContext } from "@renderinc/sdk/workflows";

const calculateSquare = task(
  { name: "calculateSquare" },
  function calculateSquare(_ctx: TaskContext, a: number): number {
    return a * a;
  },
);

const sumSquares = task(
  { name: "sumSquares" },
  async function sumSquares(ctx: TaskContext, a: number, b: number): Promise<number> {
    const [result1, result2] = await Promise.all([
      ctx.run(calculateSquare, a),
      ctx.run(calculateSquare, b),
    ]);
    return result1 + result2;
  },
);

task(
  {
    name: "flipCoin",
    retry: {
      maxRetries: 3,
      waitDurationMs: 1000,
      backoffScaling: 1.5,
    },
  },
  function flipCoin(_ctx: TaskContext): string {
    if (Math.random() < 0.5) {
      throw new Error("Flipped tails! Retrying.");
    }
    return "Flipped heads!";
  },
);
