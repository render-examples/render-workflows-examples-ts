/**
 * The sales data and report logic, shared by both services.
 *
 * The API uses checkRequest to reject bad input before it starts a run. The
 * workflow task uses it too, because runs can also start from the Dashboard or
 * the CLI, and then builds the report one month at a time.
 */
import { readFileSync } from "node:fs";

type Sale = { month: string; region: string; product: string; units: number; unit_price: number };
type Totals = { units: number; revenue: number };
export type MonthTotals = Totals & { month: string; by_product: Record<string, Totals> };

const SALES: Sale[] = JSON.parse(readFileSync(new URL("../sales.json", import.meta.url), "utf8"));

export const REGIONS = [...new Set(SALES.map((row) => row.region))].sort();

/** The three months of a quarter such as 2026-Q3, as 2026-07, 2026-08, 2026-09. */
export function monthsIn(quarter: string): string[] {
  const [year, q] = quarter.split("-Q");
  const first = (Number(q) - 1) * 3 + 1;
  return [first, first + 1, first + 2].map((month) => `${year}-${String(month).padStart(2, "0")}`);
}

// A quarter is reportable when the data has all three of its months.
const MONTHS = new Set(SALES.map((row) => row.month));
const CANDIDATES = new Set([...MONTHS].map((m) => `${m.slice(0, 4)}-Q${Math.floor((Number(m.slice(5)) - 1) / 3) + 1}`));
export const QUARTERS = [...CANDIDATES].filter((q) => monthsIn(q).every((m) => MONTHS.has(m))).sort();

/** Return why a report request is invalid, or null if it's fine. */
export function checkRequest(region: unknown, quarter: unknown): string | null {
  if (typeof region !== "string" || !REGIONS.includes(region)) {
    return `region must be one of ${REGIONS.join(", ")}`;
  }
  if (typeof quarter !== "string" || !/^\d{4}-Q[1-4]$/.test(quarter)) {
    return "quarter must look like 2026-Q3";
  }
  if (!QUARTERS.includes(quarter)) {
    return `no data for ${quarter}; quarters with data: ${QUARTERS.join(", ")}`;
  }
  return null;
}

/** Revenue and units for one region and month, by product. */
export function monthTotals(region: string, month: string): MonthTotals {
  const byProduct: Record<string, Totals> = {};
  for (const row of SALES) {
    if (row.region === region && row.month === month) {
      byProduct[row.product] = { units: row.units, revenue: row.units * row.unit_price };
    }
  }
  const products = Object.values(byProduct);
  return {
    month,
    units: products.reduce((sum, p) => sum + p.units, 0),
    revenue: products.reduce((sum, p) => sum + p.revenue, 0),
    by_product: byProduct,
  };
}

/** Roll monthly totals up into the quarter's report. */
export function combine(region: string, quarter: string, months: MonthTotals[]) {
  const byProduct: Record<string, Totals> = {};
  for (const month of months) {
    for (const [product, totals] of Object.entries(month.by_product)) {
      const entry = (byProduct[product] ??= { units: 0, revenue: 0 });
      entry.units += totals.units;
      entry.revenue += totals.revenue;
    }
  }
  const topProduct = Object.keys(byProduct).reduce((a, b) => (byProduct[b].revenue > byProduct[a].revenue ? b : a));
  return {
    region,
    quarter,
    revenue: months.reduce((sum, m) => sum + m.revenue, 0),
    units: months.reduce((sum, m) => sum + m.units, 0),
    top_product: topProduct,
    by_product: byProduct,
    by_month: months.map(({ month, units, revenue }) => ({ month, units, revenue })),
  };
}
