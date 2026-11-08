// Every table Bouncer needs. Safe to run repeatedly: every statement uses IF NOT EXISTS.
// Used by `npm run migrate` and by the server on startup (so a deploy adds new tables itself).
// Change the schema only here, with IF NOT EXISTS / ADD COLUMN IF NOT EXISTS (CLAUDE.md).
export const SCHEMA_SQL = `
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

-- Our agent's Photon user id on the line (incoming receivedBy.id): the senderId for alerts into space_id.
ALTER TABLE users ADD COLUMN IF NOT EXISTS photon_sender_id text;

-- ===== Flow 5 (reports / patterns) tables go here =====
-- Anonymised scam templates ({NAME}, {PHONE}, {AMOUNT}, {DATE}, {LINK}, {CODE}). No user id, no raw text.
-- embedding: Gemini embedding of the template as real[] (no pgvector); NULL when embedding failed.
CREATE TABLE IF NOT EXISTS report_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template           text NOT NULL,
  brand              text,
  scam_type          text NOT NULL,
  link_domain        text,                   -- registered domain, e.g. ezpass-pay.top
  embedding          real[],
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'spiking')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_templates_type_seen ON report_templates (scam_type, last_seen);

-- Report counter by ZIP3 and day ('unk' when the reporter has no ZIP). Counts only, never who.
CREATE TABLE IF NOT EXISTS report_counts (
  template_id        uuid NOT NULL REFERENCES report_templates(id) ON DELETE CASCADE,
  zip3               text NOT NULL,
  day                date NOT NULL DEFAULT current_date,
  count              integer NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, zip3, day)
);

-- One row per template per ZIP3 that spiked: makes the local alert go out once (re-armed after 7 days).
CREATE TABLE IF NOT EXISTS pattern_spikes (
  template_id        uuid NOT NULL REFERENCES report_templates(id) ON DELETE CASCADE,
  zip3               text NOT NULL,
  spiked_at          timestamptz NOT NULL DEFAULT now(),
  alerts_sent        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, zip3)
);

-- At most one local alert per user per day (Flow 5 step 7). Says nothing about what the user reported.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_local_alert_at timestamptz;
-- ===== end Flow 5 =====

-- ===== Flow 7 (carrier feed / dashboard) tables go here =====
-- Simulated carrier traffic only (replay script + demo button). body is public dataset text, never a
-- real user's message. Phone numbers are stored masked (last 4 digits only).
CREATE TABLE IF NOT EXISTS carrier_events (
  id                 bigserial PRIMARY KEY,
  event_id           text NOT NULL UNIQUE,
  to_number          text,                   -- masked, e.g. "…0147"
  from_masked        text,                   -- masked, e.g. "…8812"
  zip                text,
  level              text,                   -- safe | unsure | likely_scam | high_risk
  p_scam             real,
  scam_type          text,
  flags              text[],
  body               text,                   -- dataset text only
  true_label         text,                   -- scam | legit | spam (scoring only, never sent to Jev)
  latency_ms         integer,
  alerted            boolean NOT NULL DEFAULT false,
  bulk               boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS carrier_events_created_at_idx ON carrier_events (created_at);

-- Small key/value store for the dashboard (e.g. reset_at: the feed hides events older than the last "Reset demo").
CREATE TABLE IF NOT EXISTS dashboard_state (
  key                text PRIMARY KEY,
  value              text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- ===== end Flow 7 =====
`;

/** Creates any missing tables. Logs and carries on if it fails (the existing tables still work). */
export async function ensureSchema(pool: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  try {
    await pool.query(SCHEMA_SQL);
    console.log("[db] schema ready");
  } catch (err: any) {
    console.error(`[db] schema check failed: ${err?.message}`);
  }
}
