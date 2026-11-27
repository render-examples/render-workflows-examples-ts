/**
 * Web service API: the workflow service
 *
 * One task, buildReport, turns the bundled sales data into a quarterly report
 * for one region. It needs no API keys, so you can run the whole example as is.
 * The API service (src/api.ts) starts it and reads its result.
 */
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { checkRequest, combine, monthsIn, monthTotals, type MonthTotals } from "./report.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// buildReport only reads, so a retry is safe. In a real app this task would
// query a database or a warehouse, which can fail for a moment; Render retries
// the attempt up to twice.
task(
  {
    name: "buildReport",
    retry: { maxRetries: 2, waitDurationMs: 1000, backoffScaling: 2 },
    timeoutSeconds: 60,
  },
  async function buildReport(_ctx: TaskContext, region: string, quarter: string) {
    // The API checks input before it starts a run, but runs can also start from
    // the Dashboard or the CLI. A retry can't fix bad input, so return the
    // problem as a result instead of throwing.
    const problem = checkRequest(region, quarter);
    if (problem) return { error: problem };

    const months: MonthTotals[] = [];
    for (const month of monthsIn(quarter)) {
      console.log(`[REPORT] ${region} ${month}`);
      // Stand-in for a slow query, so a run takes a few seconds and you can
      // watch it go from running to completed.
      await sleep(1000);
      months.push(monthTotals(region, month));
    }

    return combine(region, quarter, months);
  },
);
