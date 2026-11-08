// In-memory call sessions for the Listen agent (SPEC Flow 2 step 2), keyed by ElevenLabs conversation id.
// Turn text lives here only and is dropped by endSession() on the post-call webhook (rule 1).
// OWNERSHIP: llm.ts / talk.ts / score.ts create and update sessions; webhooks.ts only calls endSession().
import type { RiskLevel } from "../detection/risk.js";

export interface CallSession {
  conv: string;
  /** users.id, or "unknown" when the caller couldn't be matched (no alerts are sent). null until resolved. */
  userId: string | null;
  mode: "listening" | "talking";
  /** Transcript turns (in memory only), indexed by user-turn number. Revised turns replace, never append. */
  turns: string[];
  /** Highest level reached so far. */
  level: RiskLevel;
  p: number;
  scamType: string | null;
  /** Flag names that have crossed 0.7 and been alerted on. */
  alerted: Set<string>;
  alertCount: number;
  startedAt: number;

  // ---- Flow 2 internals (llm.ts / talk.ts / score.ts only) ----
  /** In-flight user lookup, started on the first turn. */
  identifying: Promise<void> | null;
  /** Bumped whenever a turn is added or revised. */
  version: number;
  /** Version that the last finished Jev scoring saw. */
  scoredVersion: number;
  /** Debounce timer: scoring waits until the turns stop changing. */
  debounce: NodeJS.Timeout | null;
  scoring: boolean;
  /** Every flag that crossed 0.7 this call (including ones without their own alert line). */
  flags: Set<string>;
  /** Latest probabilities from Jev (numbers only, no content). */
  probs: Record<string, number>;
  /** Highest level we texted an alert for. */
  alertedLevel: RiskLevel;
  familyStarted: boolean;
  /** Talk mode: user-turn index → state of the spoken reply for that turn. */
  spoken: Map<number, "streaming" | "done">;
  /** Talk mode: user-turn index → in-flight/finished "is this addressed to Bouncer?" decision. */
  addressed: Map<number, Promise<boolean>>;
  /** Index of the last turn Bouncer answered out loud. */
  lastTalkTurn: number;
  /** Turn indexes spoken to Bouncer (wake, thanks, follow-ups): left out of what Jev scores. */
  botTurns: Set<number>;
  ended: boolean;
}

const sessions = new Map<string, CallSession>();

export function getOrCreateSession(conv: string): CallSession {
  let s = sessions.get(conv);
  if (!s) {
    s = {
      conv,
      userId: null,
      mode: "listening",
      turns: [],
      level: "safe",
      p: 0,
      scamType: null,
      alerted: new Set(),
      alertCount: 0,
      startedAt: Date.now(),
      identifying: null,
      version: 0,
      scoredVersion: 0,
      debounce: null,
      scoring: false,
      flags: new Set(),
      probs: {},
      alertedLevel: "safe",
      familyStarted: false,
      spoken: new Map(),
      addressed: new Map(),
      lastTalkTurn: -1,
      botTurns: new Set(),
      ended: false,
    };
    sessions.set(conv, s);
  }
  return s;
}

export const peekSession = (conv: string) => sessions.get(conv) ?? null;

/** Removes the session (and its transcript) and returns it for the post-call summary. */
export function endSession(conv: string): CallSession | null {
  const s = sessions.get(conv) ?? null;
  sessions.delete(conv);
  if (s) {
    s.ended = true;
    if (s.debounce) clearTimeout(s.debounce);
    s.debounce = null;
    s.addressed.clear(); // background work checks `ended` and stops; the object is garbage once the webhook is done
  }
  return s;
}

// Safety net: drop sessions whose post-call webhook never arrived (max call length is 30 min).
setInterval(() => {
  const cutoff = Date.now() - 45 * 60_000;
  for (const [k, s] of sessions) if (s.startedAt < cutoff) endSession(k);
}, 5 * 60_000).unref();
