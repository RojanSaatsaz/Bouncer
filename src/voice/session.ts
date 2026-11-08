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
  /** Consecutive Jev scorings whose own level was likely_scam or higher (reset to 0 otherwise). */
  likelyStreak: number;
  /**
   * Talk mode: user-turn index → the spoken reply for that turn: its state, the turn text it answered,
   * and a generation number (a revised turn text supersedes the old reply; stale onEnd calls are ignored).
   */
  spoken: Map<number, { state: "streaming" | "done"; text: string; gen: number }>;
  /** Bumped for every spoken reply started this call. */
  speakGen: number;
  /** Talk mode: user-turn index → in-flight/finished Jev addressed_to_bouncer probability for that text (null = failed). */
  addressed: Map<number, { text: string; p: Promise<number | null>; missCounted?: boolean }>;
  /** Index of the last turn Bouncer answered out loud. */
  lastTalkTurn: number;
  /**
   * Talk mode memory (in memory only, dropped with the session): user-turn index → what Bouncer said
   * in reply. Prompts Gemini with the real dialogue so Bouncer can hold a conversation without repeating.
   */
  replies: Map<number, string>;
  /** Last time someone talked with Bouncer (answered turn or end of a spoken reply). Talk mode idles out from here. */
  talkAt: number;
  /** Talk mode: consecutive turns that didn't look meant for Bouncer (2 → back to listening). */
  misses: number;
  /** Last filler / sign-off line spoken, so the same one is never said twice in a row. */
  lastFiller: string | null;
  lastSignOff: string | null;
  /** Turn indexes spoken to Bouncer (wake, thanks, follow-ups): left out of what Jev scores. */
  botTurns: Set<number>;
  /** Index of the first wake turn this call (-1 until someone says "Hey Bouncer"). */
  firstWakeTurn: number;
  /**
   * Who Bouncer is talking to, derived in code (talk.ts callContext): "direct" = the user called Bouncer
   * 1-on-1 (no other speech before the first wake), "merged" = Bouncer is on a live call with someone else.
   * null until the first wake. Once "merged", it stays merged.
   */
  callContext: "direct" | "merged" | null;
  /** Last few canned lines spoken (fillers, sign-offs, fallbacks), so none comes back too soon. */
  recentLines: string[];
  ended: boolean;
}

const sessions = new Map<string, CallSession>();

/**
 * Conversation ids whose call already ended → when. A turn that arrives after the post-call webhook
 * must not recreate a session (it would hold transcript until the 45-min sweep). Ids only, no content.
 */
const ENDED_KEEP_MS = 10 * 60_000;
const endedConvs = new Map<string, number>();

export const isEnded = (conv: string) => endedConvs.has(conv);

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
      likelyStreak: 0,
      spoken: new Map(),
      addressed: new Map(),
      speakGen: 0,
      lastTalkTurn: -1,
      replies: new Map(),
      talkAt: 0,
      misses: 0,
      lastFiller: null,
      lastSignOff: null,
      botTurns: new Set(),
      firstWakeTurn: -1,
      callContext: null,
      recentLines: [],
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
  endedConvs.set(conv, Date.now());
  if (s) {
    s.ended = true;
    if (s.debounce) clearTimeout(s.debounce);
    s.debounce = null;
    s.replies.clear();
    s.addressed.clear(); // background work checks `ended` and stops; the object is garbage once the webhook is done
  }
  return s;
}

// Safety net: drop sessions whose post-call webhook never arrived (max call length is 30 min).
setInterval(() => {
  const cutoff = Date.now() - 45 * 60_000;
  for (const [k, s] of sessions) if (s.startedAt < cutoff) endSession(k);
  const endedCutoff = Date.now() - ENDED_KEEP_MS;
  for (const [k, at] of endedConvs) if (at < endedCutoff) endedConvs.delete(k);
}, 5 * 60_000).unref();
