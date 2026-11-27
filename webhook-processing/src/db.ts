// Database helpers shared by the receiver and the workflow service.
import { readFileSync } from "node:fs";
import pg from "pg";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf-8");

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString });
  }
  return pool;
}

export async function applySchema(): Promise<void> {
  await db().query(SCHEMA);
}
