// Builds the response for GET /reports/revenue from today's revenue rows.
export function revenueReport(rows) {
  const currency = rows[0].currency;
  const totalCents = rows.reduce((sum, row) => sum + row.amount_cents, 0);
  return { currency, total_cents: totalCents, orders: rows.length };
}
