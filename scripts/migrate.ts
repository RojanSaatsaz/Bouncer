// Creates every table Bouncer needs (Flows 1, 2, 3 and 6).
// Safe to run more than once: every statement uses IF NOT EXISTS.
import pg from "pg";

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

const sql = `
CREATE TABLE IF NOT EXISTS users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imessage_handle    text UNIQUE,
  voice_phone        text UNIQUE,
  name               text,
  zip                text,
  space_id           text,
  opted_in           boolean NOT NULL DEFAULT false,
  listen_pending_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS circles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  protected_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  join_code          text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS circle_members (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id          uuid NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  name               text NOT NULL,
  relationship       text,
  phone              text,
  imessage_handle    text,
  role               text NOT NULL CHECK (role IN ('guardian', 'relative')),
  joined             boolean NOT NULL DEFAULT false,
  space_id           text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Safe words: encrypted with AES-256-GCM. The key lives only in the server env (SAFE_WORD_KEY).
CREATE TABLE IF NOT EXISTS safe_words (
  circle_id          uuid PRIMARY KEY REFERENCES circles(id) ON DELETE CASCADE,
  ciphertext         bytea NOT NULL,
  iv                 bytea NOT NULL,
  auth_tag           bytea NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_memory (
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone              text NOT NULL,
  safe_count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, phone)
);

-- Events: NO message content, sender or images. Type, level and outcome only.
CREATE TABLE IF NOT EXISTS events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  source             text NOT NULL,          -- imessage | call | family | recovery
  risk_level         text,                   -- safe | unsure | likely_scam | high_risk
  p_scam             real,
  scam_type          text,
  flags              text[],
  outcome            text,
  alert_count        integer,
  duration_s         integer,
  latency_ms         integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  event_id           uuid REFERENCES events(id) ON DELETE CASCADE,
  answer             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id          uuid REFERENCES circles(id) ON DELETE CASCADE,
  relative_id        uuid REFERENCES circle_members(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'calling', -- calling | verified_safe | verified_needs_help | failed | unreachable
  conversation_id    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS processed_messages (
  id                 text PRIMARY KEY,
  processed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS photon_cursor (
  id                 integer PRIMARY KEY DEFAULT 1,
  seq                bigint,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eval_results (
  id                 bigserial PRIMARY KEY,
  run_id             text NOT NULL,          -- e.g. '2026-11-08-holdout-1'
  dataset            text NOT NULL,          -- 'mendeley' | 'test30'
  row_index          integer NOT NULL,       -- the id column in mendeley_clean.csv, or S1/L1 order for test30
  split              text,                   -- 'train' | 'holdout' (null for test30)
  label              text NOT NULL,          -- ham | spam | smishing (or scam | legit | spam for test30)
  p_scam             real,
  level              text,                   -- safe | unsure | likely_scam | high_risk
  flags              text[],
  scam_type          text,
  jev_model          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, dataset, row_index)
);
`;

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
