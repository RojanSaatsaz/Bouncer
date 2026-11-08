// Flow 7 steps 3–5: classify one simulated carrier SMS with the Flow 1 Jev questions, store it in
// carrier_events, and (outside bulk mode) text the enrolled user it was addressed to.
// Simulated data only: body is public dataset text; phone numbers are stored masked.
import pLimit from "p-limit";
import { one } from "../db.js";
import { askJev } from "../detection/jev.js";
import { MESSAGE_QUESTIONS } from "../detection/questions.js";
import { scoreAnswers } from "../detection/scan.js";
import { atLeast, LEVEL_LABEL, type RiskLevel } from "../detection/risk.js";
import { getUserByVoicePhone, textUser, toE164 } from "../users.js";

export interface CarrierEvent {
  event_id: string;
  type?: string;
  to: string;
  from: string;
  body: string;
  zip?: string | null;
  ts?: string;
  true_label?: string | null;
  /** Bulk replay: never texts anyone (Flow 7 step 5). */
  bulk?: boolean;
}

export type AlertStatus = "sent" | "bulk" | "below_level" | "no_user" | "no_thread" | "failed";

export interface CarrierVerdict {
  event_id: string;
  level: RiskLevel;
  label: string;
  confidence: number;
  p_scam: number;
  scam_type: string | null;
  flags: string[];
  latency_ms: number;
  alerted: boolean;
  alert: AlertStatus;
  duplicate?: boolean;
}

/** Plain words for the alert text ("looks like a {x} scam"). */
const SCAM_WORDS: Record<string, string> = {
  toll_or_delivery: "toll or delivery",
  bank_or_card: "bank or card",
  crypto: "crypto",
  government: "government",
  tech_support: "tech support",
  family_emergency: "family emergency",
  job_or_prize: "job or prize",
  marketplace: "marketplace",
  romance_or_investment: "romance or investment",
};

/** "…1234" for phone numbers, "…" + last 4 for short codes. Never the full number. */
export function maskNumber(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits ? "…" + digits.slice(-4) : null;
}

/** Normalises dataset labels to scam | legit | spam. */
export function normLabel(raw: string | null | undefined): string | null {
  const l = String(raw ?? "").trim().toLowerCase();
  if (["smishing", "scam", "fraud"].includes(l)) return "scam";
  if (["ham", "benign", "legit"].includes(l)) return "legit";
  if (l === "spam") return "spam";
  return null;
}

/** Validates a POST body. Returns an error string or the cleaned event. */
export function parseEvent(x: any): CarrierEvent | string {
  if (!x || typeof x !== "object") return "body must be a JSON object";
  const str = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  if (!str(x.event_id, 100)) return "event_id: non-empty string up to 100 chars";
  if (x.type !== undefined && x.type !== "sms") return 'type must be "sms"';
  if (!str(x.to, 40)) return "to: phone number string";
  if (!str(x.from, 40)) return "from: phone number or short code string";
  if (!str(x.body, 2000)) return "body: non-empty string up to 2000 chars";
  return {
    event_id: x.event_id.trim(),
    type: "sms",
    to: x.to.trim(),
    from: x.from.trim(),
    body: x.body,
    zip: typeof x.zip === "string" && /^\d{5}$/.test(x.zip) ? x.zip : null,
    ts: typeof x.ts === "string" ? x.ts : undefined,
    true_label: normLabel(x.true_label),
    bulk: x.bulk === true,
  };
}

// Bulk traffic shares 4 Jev slots; demo events skip the queue so the toll alert never waits behind a replay.
const bulkLimit = pLimit(4);
export const bulkQueueDepth = () => bulkLimit.activeCount + bulkLimit.pendingCount;

export function ingestEvent(ev: CarrierEvent): Promise<CarrierVerdict> {
  return ev.bulk ? bulkLimit(() => classify(ev)) : classify(ev);
}

async function classify(ev: CarrierEvent): Promise<CarrierVerdict> {
  const existing = await one<any>("SELECT * FROM carrier_events WHERE event_id = $1", [ev.event_id]);
  if (existing) return { ...fromRow(existing), duplicate: true };

  const t0 = Date.now();
  // Same state shape as Flow 1 ({ body, sender }); true_label is never sent to Jev.
  const r = await askJev({ body: ev.body, sender: ev.from }, MESSAGE_QUESTIONS, { timeoutMs: 6_000, retries: 1 });
  const scan = scoreAnswers(r);
  const latency = Date.now() - t0;
  const level = scan.risk.level;

  const row = await one<{ id: string }>(
    `INSERT INTO carrier_events
       (event_id, to_number, from_masked, zip, level, p_scam, scam_type, flags, body, true_label, latency_ms, bulk)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (event_id) DO NOTHING RETURNING id`,
    [
      ev.event_id,
      maskNumber(ev.to),
      maskNumber(ev.from),
      ev.zip ?? null,
      level,
      scan.risk.p,
      scan.scamType,
      scan.flags,
      ev.body,
      ev.true_label ?? null,
      latency,
      !!ev.bulk,
    ],
  );

  const verdict: CarrierVerdict = {
    event_id: ev.event_id,
    level,
    label: LEVEL_LABEL[level],
    confidence: scan.risk.confidence,
    p_scam: Math.round(scan.risk.p * 1000) / 1000,
    scam_type: scan.scamType,
    flags: scan.flags,
    latency_ms: latency,
    alerted: false,
    alert: "bulk",
  };
  if (!row) return { ...verdict, duplicate: true }; // a concurrent request with the same event_id won the insert

  if (!ev.bulk) {
    verdict.alert = await alertRecipient(ev, verdict);
    verdict.alerted = verdict.alert === "sent";
    if (verdict.alerted) await one("UPDATE carrier_events SET alerted = true WHERE id = $1", [row.id]);
  }
  return verdict;
}

/** Flow 7 step 4: text the enrolled user this message was sent to, in their existing Bouncer thread. */
async function alertRecipient(ev: CarrierEvent, v: CarrierVerdict): Promise<AlertStatus> {
  if (!atLeast(v.level, "likely_scam")) return "below_level";
  const phone = toE164(ev.to);
  const user = phone ? await getUserByVoicePhone(phone) : null;
  if (!user) return "no_user";
  if (!user.space_id) return "no_thread";
  const kind = v.scam_type ? SCAM_WORDS[v.scam_type] : undefined;
  const what = kind ? `a ${kind} scam` : "a scam";
  const text = `⚠️ A text to your phone from ${maskNumber(ev.from)} looks like ${what} (${v.confidence}% sure). Don't tap its link.`;
  try {
    return (await textUser(user.id, [text], `bouncer:carrier:${ev.event_id}`)) ? "sent" : "no_thread";
  } catch (err: any) {
    console.error(`[carrier] alert failed: ${err?.message}`);
    return "failed";
  }
}

function fromRow(r: any): CarrierVerdict {
  const level = (r.level ?? "safe") as RiskLevel;
  const p = Number(r.p_scam ?? 0);
  return {
    event_id: r.event_id,
    level,
    label: LEVEL_LABEL[level],
    confidence: Math.round((level === "safe" ? 1 - p : p) * 100),
    p_scam: Math.round(p * 1000) / 1000,
    scam_type: r.scam_type,
    flags: r.flags ?? [],
    latency_ms: r.latency_ms,
    alerted: r.alerted,
    alert: r.alerted ? "sent" : r.bulk ? "bulk" : "below_level",
  };
}
