// SPEC Flow 1 steps 6–8 and 12: contact memory, one Jev request, risk level in code.
// Jev decides (rule 3). Nothing here logs or stores message content.
import { query, one } from "../db.js";
import { askJev, noul, choice, type JevQuestion, type JevResult } from "./jev.js";
import { MESSAGE_QUESTIONS, MESSAGE_FLAGS } from "./questions.js";
import { riskLevel, flagsFrom, atLeast, type Risk } from "./risk.js";
import { toE164 } from "../users.js";

/** What Jev sees. Same shape as the eval (`{ body, sender }`) so the tuned thresholds still apply. */
export interface MessageState {
  body: string;
  sender?: string | null;
  sender_type?: string | null;
  urls?: string[];
  claimed_brand?: string | null;
  known_contact?: boolean;
}

export interface ScanResult {
  risk: Risk;
  /** Red-flag names (never content). Empty for Safe verdicts. */
  flags: string[];
  scamType: string | null;
  probs: Record<string, number>;
  jev: JevResult;
}

/** Phone number this user has marked safe ≥ 3 times (Flow 1 step 6). */
export async function isKnownContact(userId: string, sender: string | null | undefined): Promise<boolean> {
  const phone = toE164(sender);
  if (!phone) return false;
  const row = await one<{ safe_count: number }>(
    "SELECT safe_count FROM contact_memory WHERE user_id = $1 AND phone = $2",
    [userId, phone],
  );
  return (row?.safe_count ?? 0) >= 3;
}

/** Flow 1 step 12: Safe → +1, Likely or above → reset to 0. */
export async function updateContactMemory(userId: string, sender: string | null | undefined, risk: Risk) {
  const phone = toE164(sender);
  if (!phone) return;
  if (risk.level === "safe") {
    await query(
      `INSERT INTO contact_memory (user_id, phone, safe_count) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, phone) DO UPDATE SET safe_count = contact_memory.safe_count + 1`,
      [userId, phone],
    );
  } else if (atLeast(risk.level, "likely_scam")) {
    await query("UPDATE contact_memory SET safe_count = 0 WHERE user_id = $1 AND phone = $2", [userId, phone]);
  }
}

/** Turns Jev's answers to MESSAGE_QUESTIONS into a verdict. */
export function scoreAnswers(r: JevResult, knownContact = false): ScanResult {
  const probs: Record<string, number> = {};
  for (const k of [...MESSAGE_FLAGS, "is_scam"]) probs[k] = noul(r, k);
  const risk = riskLevel({
    is_scam: probs.is_scam,
    asks_code: probs.asks_code,
    money_or_code: probs.money_or_code,
    urgency_secrecy: probs.urgency_secrecy,
    impersonation: probs.impersonation,
    knownContact,
    messageFlags: Object.fromEntries(MESSAGE_FLAGS.map((f) => [f, probs[f]])),
  });
  // impersonation alone fires on almost every business message: only list it when the verdict is Likely+.
  const flags =
    risk.level === "safe"
      ? []
      : flagsFrom(probs, MESSAGE_FLAGS).filter((f) => f !== "impersonation" || atLeast(risk.level, "likely_scam"));
  const st = choice(r, "scam_type");
  return { risk, flags, scamType: st.label, probs, jev: r };
}

/**
 * One Jev request with every message question, plus any `extra` questions (e.g. the text router's
 * `intent`), so a pasted text costs a single round trip.
 */
export async function scanMessage(
  state: MessageState,
  extra: Record<string, JevQuestion> = {},
): Promise<ScanResult> {
  const r = await askJev(state, { ...MESSAGE_QUESTIONS, ...extra });
  return scoreAnswers(r, !!state.known_contact);
}

/** `events` row: type, level, flags, latency only (rule 1). Returns its id for feedback. */
export async function logEvent(e: {
  userId: string | null;
  source: "imessage" | "call";
  level?: string | null;
  p?: number | null;
  scamType?: string | null;
  flags?: string[];
  outcome?: string | null;
  alertCount?: number | null;
  durationS?: number | null;
  latencyMs?: number | null;
}): Promise<string | null> {
  try {
    const row = await one<{ id: string }>(
      `INSERT INTO events (user_id, source, risk_level, p_scam, scam_type, flags, outcome, alert_count, duration_s, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        e.userId,
        e.source,
        e.level ?? null,
        e.p ?? null,
        e.scamType ?? null,
        e.flags ?? [],
        e.outcome ?? null,
        e.alertCount ?? null,
        e.durationS ?? null,
        e.latencyMs ?? null,
      ],
    );
    return row?.id ?? null;
  } catch (err: any) {
    console.error(`[events] insert failed: ${err?.message}`);
    return null;
  }
}
