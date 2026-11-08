// Flow 7 step 6: what the dashboard shows, read from the DB. One shared poller (every 1.5 s, only while
// someone is watching) pushes new rows and stats to every open /dashboard/stream connection.
// Rows from real users come from `events`, which holds type, level and outcome only (rule 1): no
// content, sender, ZIP or user id ever leaves this file for those rows.
import { query, one } from "../db.js";
import { replayStatus } from "../carrier/replayer.js";

const FLAGGED = "('likely_scam','high_risk')";

export interface FeedRow {
  key: string;
  kind: string; // carrier | imessage | call | family | recovery | …
  ts: string;
  level: string | null;
  confidence: number | null;
  scam_type: string | null;
  // carrier rows only (simulated dataset traffic)
  zip?: string | null;
  sender?: string | null;
  body?: string | null;
  true_label?: string | null;
  bulk?: boolean;
  latency_ms?: number | null;
  // both
  alerted?: boolean;
  outcome?: string | null;
}

const confidence = (level: string | null, p: number | null) =>
  p == null || level == null ? null : Math.round((level === "safe" ? 1 - p : p) * 100);

const carrierRow = (r: any): FeedRow => ({
  key: "c" + r.id,
  kind: "carrier",
  ts: new Date(r.created_at).toISOString(),
  level: r.level,
  confidence: confidence(r.level, r.p_scam),
  scam_type: r.scam_type,
  zip: r.zip,
  sender: r.from_masked,
  body: r.body,
  true_label: r.true_label,
  bulk: r.bulk,
  latency_ms: r.latency_ms,
  alerted: r.alerted,
});

const eventRow = (r: any): FeedRow => ({
  key: "e" + r.id,
  kind: r.source,
  ts: new Date(r.created_at).toISOString(),
  level: r.risk_level,
  confidence: confidence(r.risk_level, r.p_scam),
  scam_type: r.scam_type,
  outcome: r.outcome,
  alerted: (r.alert_count ?? 0) > 0,
});

const CARRIER_COLS = "id, created_at, zip, level, p_scam, scam_type, from_masked, body, true_label, bulk, latency_ms, alerted";
const EVENT_COLS = "id, created_at, source, risk_level, p_scam, scam_type, outcome, alert_count";

/** Time of the last "Reset demo": the dashboard hides anything older. */
export async function resetAt(): Promise<Date> {
  try {
    const r = await one<{ value: string }>("SELECT value FROM dashboard_state WHERE key = 'reset_at'");
    const ms = Number(r?.value);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(0);
  } catch {
    return new Date(0);
  }
}

export async function snapshot(limit = 60) {
  const since = await resetAt();
  const [c, e] = await Promise.all([
    query(`SELECT ${CARRIER_COLS} FROM carrier_events WHERE created_at > $1 ORDER BY id DESC LIMIT $2`, [since, limit]),
    query(`SELECT ${EVENT_COLS} FROM events WHERE created_at > $1 ORDER BY created_at DESC LIMIT $2`, [since, limit]),
  ]);
  const rows = [...c.rows.map(carrierRow), ...e.rows.map(eventRow)].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit);
  return { rows, stats: await stats() };
}

// ---- stats: KPI tiles, trends, reports ----

async function stats() {
  const since = await resetAt();
  const [k, ev, perMin, perHour, reports] = await Promise.all([
    one(
      `SELECT count(*)::int AS scanned,
              count(*) FILTER (WHERE level IN ${FLAGGED})::int AS flagged,
              count(*) FILTER (WHERE alerted)::int AS alerted,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS median_ms,
              count(*) FILTER (WHERE true_label = 'scam')::int AS scams,
              count(*) FILTER (WHERE true_label = 'scam' AND level IN ${FLAGGED})::int AS scams_caught,
              count(*) FILTER (WHERE true_label = 'legit')::int AS legit,
              count(*) FILTER (WHERE true_label = 'legit' AND level IN ${FLAGGED})::int AS legit_flagged,
              count(*) FILTER (WHERE true_label = 'spam')::int AS spam,
              count(*) FILTER (WHERE true_label = 'spam' AND level IN ${FLAGGED})::int AS spam_flagged
         FROM carrier_events WHERE created_at > $1`,
      [since],
    ),
    query(
      `SELECT source, count(*)::int AS n, count(*) FILTER (WHERE risk_level IN ${FLAGGED})::int AS flagged
         FROM events WHERE created_at > $1 GROUP BY source`,
      [since],
    ),
    buckets(60, "30 minutes", since),
    buckets(3600, "24 hours", since),
    reportStats(),
  ]);
  return {
    resetAt: since.toISOString(),
    kpi: { ...k, median_ms: k?.median_ms == null ? null : Math.round(Number(k.median_ms)) },
    users: ev.rows,
    trends: { perMinute: perMin, perHour },
    reports,
    replay: replayStatus(),
  };
}

/** Flagged carrier messages per bucket and ZIP3. */
async function buckets(seconds: number, window: string, since: Date) {
  const { rows } = await query(
    `SELECT (floor(extract(epoch FROM created_at) / $1) * $1)::bigint * 1000 AS t, left(zip, 3) AS zip3, count(*)::int AS n
       FROM carrier_events
      WHERE level IN ${FLAGGED} AND zip IS NOT NULL AND created_at > greatest($2::timestamptz, now() - $3::interval)
      GROUP BY 1, 2 ORDER BY 1`,
    [seconds, since, window],
  );
  return { bucketMs: seconds * 1000, windowMs: seconds === 60 ? 30 * 60_000 : 24 * 3_600_000, rows: rows.map((r) => ({ ...r, t: Number(r.t) })) };
}

/**
 * Flow 5's tables (report_templates, report_counts) are built by another track. Read them defensively:
 * if they don't exist yet (or their shape differs), the panel says "no reports yet".
 */
async function reportStats() {
  const out: {
    available: boolean;
    total: number;
    today: number;
    byZip3: { zip3: string; n: number }[];
    spiking: { id: string; template: string; brand: string | null; scam_type: string | null; link_domain: string | null; last_seen: string | null; n: number | null }[];
  } = { available: false, total: 0, today: 0, byZip3: [], spiking: [] };
  try {
    const t = await one<{ rc: string | null; rt: string | null }>(
      "SELECT to_regclass('public.report_counts')::text AS rc, to_regclass('public.report_templates')::text AS rt",
    );
    if (t?.rc) {
      const k = await one(
        `SELECT coalesce(sum(count), 0)::int AS total,
                coalesce(sum(count) FILTER (WHERE day::date = current_date), 0)::int AS today
           FROM report_counts`,
      );
      out.total = k?.total ?? 0;
      out.today = k?.today ?? 0;
      const z = await query(
        `SELECT zip3::text AS zip3, sum(count)::int AS n FROM report_counts
          WHERE day::date >= current_date - 1 AND zip3 IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 6`,
      );
      out.byZip3 = z.rows;
      out.available = true;
    }
    if (t?.rt) {
      const s = await query(
        `SELECT id::text AS id, template, brand, scam_type, link_domain, last_seen FROM report_templates
          WHERE status = 'spiking' ORDER BY last_seen DESC NULLS LAST LIMIT 5`,
      );
      let counts = new Map<string, number>();
      if (t.rc && s.rows.length) {
        const c = await query(
          `SELECT template_id::text AS id, sum(count)::int AS n FROM report_counts
            WHERE day::date >= current_date - 1 AND template_id::text = ANY($1) GROUP BY 1`,
          [s.rows.map((r) => r.id)],
        );
        counts = new Map(c.rows.map((r) => [r.id, r.n]));
      }
      out.spiking = s.rows.map((r) => ({
        ...r,
        template: String(r.template ?? "").slice(0, 160),
        last_seen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
        n: counts.get(r.id) ?? null,
      }));
      out.available = true;
    }
  } catch (err: any) {
    console.warn(`[dashboard] report tables not readable yet: ${err?.message}`);
  }
  return out;
}

// ---- shared poller ----

type Send = (event: string, data: unknown) => void;
const subscribers = new Set<Send>();
let loop: NodeJS.Timeout | null = null;
let lastCarrierId = 0;
let lastEventTs = new Date();
const seenEvents = new Map<string, number>(); // events id → created_at ms (events ids are uuids, so we dedupe by id)
let ticks = 0;
let busy = false;

export function subscribe(send: Send): () => void {
  subscribers.add(send);
  if (!loop) void startLoop();
  return () => {
    subscribers.delete(send);
    if (!subscribers.size && loop) {
      clearInterval(loop);
      loop = null;
    }
  };
}

const broadcast: Send = (event, data) => {
  for (const s of subscribers) s(event, data);
};

async function startLoop() {
  loop = setInterval(() => void tick(), 1500); // set first, so a second subscriber can't start another loop
  try {
    const r = await one<{ id: string | null }>("SELECT max(id)::text AS id FROM carrier_events");
    lastCarrierId = Number(r?.id ?? 0);
  } catch {
    lastCarrierId = 0;
  }
  lastEventTs = new Date();
  seenEvents.clear();
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const since = await resetAt();
    const c = await query(`SELECT ${CARRIER_COLS} FROM carrier_events WHERE id > $1 ORDER BY id LIMIT 200`, [lastCarrierId]);
    if (c.rows.length) lastCarrierId = Number(c.rows[c.rows.length - 1].id);
    // Look back a few seconds (rows commit slightly out of order) and drop the ones already sent.
    const e = await query(
      `SELECT ${EVENT_COLS} FROM events WHERE created_at > greatest($1::timestamptz, $2::timestamptz - interval '10 seconds')
        ORDER BY created_at LIMIT 200`,
      [since, lastEventTs],
    );
    const fresh = e.rows.filter((r) => !seenEvents.has(r.id));
    for (const r of fresh) {
      const t = new Date(r.created_at).getTime();
      seenEvents.set(r.id, t);
      if (t > lastEventTs.getTime()) lastEventTs = new Date(t);
    }
    for (const [id, t] of seenEvents) if (t < lastEventTs.getTime() - 60_000) seenEvents.delete(id);

    const rows = [
      ...c.rows.filter((r) => new Date(r.created_at) > since).map(carrierRow),
      ...fresh.map(eventRow),
    ].sort((a, b) => a.ts.localeCompare(b.ts));
    if (rows.length) broadcast("rows", rows);
    if (ticks++ % 2 === 0 || rows.length) broadcast("stats", await stats());
  } catch (err: any) {
    console.error(`[dashboard] poll failed: ${err?.message}`);
  } finally {
    busy = false;
  }
}

/** "Reset demo": stops the replay, deletes the last 12 h of simulated carrier rows, and hides older
 *  `events` rows from the feed (they are not deleted: they belong to real users' history). */
export async function resetDemo() {
  const del = await query("DELETE FROM carrier_events WHERE created_at > now() - interval '12 hours'");
  await query(
    `INSERT INTO dashboard_state (key, value, updated_at) VALUES ('reset_at', (extract(epoch FROM now()) * 1000)::bigint::text, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  );
  return { carrierDeleted: del.rowCount ?? 0, resetAt: (await resetAt()).toISOString() };
}
