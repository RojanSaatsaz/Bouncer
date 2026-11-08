import pg from "pg";
import { config } from "./config.js";

// Same rule as scripts/migrate.ts: plain TCP for the local tunnel, SSL everywhere else
// (Railway's postgres-ssl image accepts SSL on the internal network too).
const isLocal = /localhost|127\.0\.0\.1/.test(config.databaseUrl);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
});

pool.on("error", (err) => console.error("[db] idle client error:", err.message));

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const { rows } = await pool.query<T>(text, params);
  return rows[0] ?? null;
}
