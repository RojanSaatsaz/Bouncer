// Creates every table Bouncer needs (Flows 1, 2, 3 and 6).
// Safe to run more than once: every statement uses IF NOT EXISTS.
import pg from "pg";
import { SCHEMA_SQL as sql } from "../src/schema.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add it to .env (use Railway's DATABASE_PUBLIC_URL locally).");
  process.exit(1);
}

const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
const client = new pg.Client({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});


try {
  await client.connect();
  await client.query(sql);
  const { rows } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  console.log("Tables ready:", rows.map((r) => r.table_name).join(", "));
} catch (err) {
  console.error("Migration failed:", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
