// SPEC Flow 2 steps 3 and 6: identify the caller, score the call with Jev in the background,
// and text alerts. Never blocks a turn's response. Logs names and numbers only, never turn text (rule 1).
import { askJev, noul, choice } from "../detection/jev.js";
import { generateJson } from "../detection/gemini.js";
import { riskLevel, atLeast, LEVEL_ORDER, type RiskLevel } from "../detection/risk.js";
import { startFamilyEmergency } from "../family/index.js";
import { toE164, getUserByVoicePhone, getListenPendingUser, clearListenPending, textUser } from "../users.js";
import { CALL_QUESTIONS, CALL_FLAGS } from "./questions.js";
import type { CallSession } from "./session.js";
import { WAKE_ANY } from "./wake.js";
import { loadSafeWord, writeAlertLines } from "./summary.js";
import { redactSafeWord } from "./talk.js";

/** How long the turns must stay unchanged before Jev scores them (speculative / revised turns). */
export const SCORE_DEBOUNCE_MS = Number(process.env.CALL_SCORE_DEBOUNCE_MS) || 1200;
const FLAG_ALERT = 0.7;

const short = (s: string) => s.slice(0, 10);

/** Step 3: caller number → users.voice_phone; else the user who texted "listen" in the last 2 min; else "unknown". */
export function identify(s: CallSession, caller: string | undefined): Promise<void> {
  if (s.userId !== null) return Promise.resolve();
  s.identifying ??= (async () => {
    try {
      const e164 = toE164(caller);
      let user = e164 ? await getUserByVoicePhone(e164) : null;
      let how = "voice_phone";
      if (!user) {
        user = await getListenPendingUser();
        how = "listen_pending";
        // One "listen" text covers one call: clear it so the next unknown caller isn't attributed to this user.
        if (user) await clearListenPending(user.id).catch((err) => console.error(`[listen] clearing listen_pending failed: ${err?.message}`));
      }
      s.userId = user?.id ?? "unknown";
      console.log(
        `[listen] conv=${short(s.conv)} caller=${e164 ? "present" : caller ? "unparsable" : "EMPTY"} user=${user ? `${user.id.slice(0, 8)} (${how})` : "unknown"}`,
      );
    } catch (err: any) {
      console.error(`[listen] user lookup failed (will retry next turn): ${err?.message}`);
      s.identifying = null; // userId stays null → next turn retries
    }
  })();
  return s.identifying;
}

/** Called on every turn that changed the transcript. Scoring runs once the turns are stable. */
export function scheduleScore(s: CallSession) {
  if (s.ended) return;
  if (s.debounce) clearTimeout(s.debounce);
  s.debounce = setTimeout(() => {
    s.debounce = null;
    void runScore(s);
  }, SCORE_DEBOUNCE_MS);
}

const inFlight = new WeakMap<CallSession, Promise<void>>();
const alertChain = new WeakMap<CallSession, Promise<void>>();
/** Tests: resolves once this session's queued alert texts are sent. */
export const alertsSettled = (s: CallSession): Promise<void> => alertChain.get(s) ?? Promise.resolve();

/**
 * Talk mode: make sure the level is fresh before Bouncer speaks (Jev decides, Gemini only words it).
 * Skips the debounce, or waits for the run already in flight, for at most `maxWaitMs`.
 */
export async function scoreNow(s: CallSession, maxWaitMs: number): Promise<void> {
  if (s.debounce) {
    clearTimeout(s.debounce);
    s.debounce = null;
  }
  const p = inFlight.get(s) ?? runScore(s);
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, maxWaitMs)))]);
  clearTimeout(timer);
}

function runScore(s: CallSession): Promise<void> {
  if (s.ended || s.scoring || s.version === s.scoredVersion) return inFlight.get(s) ?? Promise.resolve();
  const p = scoreOnce(s).finally(() => inFlight.delete(s));
  inFlight.set(s, p);
  return p;
}

async function scoreOnce(s: CallSession) {
  s.scoring = true;
  const version = s.version;
  const transcript = callerTranscript(s);
  try {
    if (!transcript) return;
    const [r] = await Promise.all([askJev({ transcript }, CALL_QUESTIONS, { retries: 2 }), s.identifying]);
    if (s.ended) return;
    s.scoredVersion = version;

    const probs: Record<string, number> = {};
    for (const f of [...CALL_FLAGS, "is_scam"]) probs[f] = noul(r, f);
    s.probs = probs;
    const risk = riskLevel({
      is_scam: probs.is_scam,
      asks_code: probs.asks_code,
      money_or_code: probs.money_or_code,
      urgency_secrecy: probs.urgency_secrecy,
      impersonation: probs.impersonation,
    });
    const st = choice(r, "scam_type");
    const raised = LEVEL_ORDER.indexOf(risk.level) > LEVEL_ORDER.indexOf(s.level);
    if (raised) {
      s.level = risk.level;
      s.p = risk.p;
      if (st.label && atLeast(risk.level, "unsure")) s.scamType = st.label;
    } else if (risk.level === s.level) {
      s.p = Math.max(s.p, risk.p);
    }
    const crossed = CALL_FLAGS.filter((f) => probs[f] >= FLAG_ALERT);
    for (const f of crossed) s.flags.add(f);
    s.likelyStreak = nextStreak(s.likelyStreak, risk.level);
    const streak = s.likelyStreak;
    console.log(
      `[listen] conv=${short(s.conv)} scored turns=${s.turns.length} level=${risk.level} p=${risk.p.toFixed(2)} flags=[${crossed.join(",")}] jev=${r.ms}ms`,
    );

    // Alerts (brand lookup + texts) run after the level is set, so a waiting spoken reply isn't held
    // up by them. Chained per session so two runs never interleave their sends.
    const prev = alertChain.get(s) ?? Promise.resolve();
    alertChain.set(s, prev.then(() => alert(s, transcript, streak)).catch((err) => console.error(`[listen] alerts failed: ${err?.message}`)));
  } catch (err: any) {
    console.error(`[listen] conv=${short(s.conv)} scoring failed: ${err?.message}`);
  } finally {
    s.scoring = false;
    // Turns changed while Jev was running (or it failed): score again once they settle.
    if (!s.ended && s.version !== s.scoredVersion) scheduleScore(s);
  }
}

/**
 * What Jev scores: the call without speech aimed at Bouncer. A wake turn keeps only the words before
 * "Hey Bouncer" (on a merged call one turn can hold both speakers); thanks/follow-up turns are dropped.
 * Otherwise "Hey Bouncer, is this real?" itself pushes Jev toward "scam".
 */
export function callerTranscript(s: CallSession): string {
  return s.turns
    .map((t, i) => {
      if (!t?.trim() || !s.botTurns.has(i)) return t;
      const m = t.match(WAKE_ANY);
      return m && m.index! > 0 ? t.slice(0, m.index) : "";
    })
    .filter((t) => t?.trim())
    .join("\n");
}

/** Flags that mean someone on the call actually asked for something (impersonation + urgency alone isn't). */
const CONCRETE_ASKS = ["asks_code", "remote_access", "money_or_code"];
/** Consecutive Likely+ scorings that open the text gate without a concrete ask (docs/EVAL_CALLS.md). */
export const LIKELY_STREAK_MIN = 2;

/** Streak after one scoring: +1 when that scoring's own level is likely_scam or higher, else back to 0. */
export const nextStreak = (prev: number, level: RiskLevel) => (atLeast(level, "likely_scam") ? prev + 1 : 0);

/**
 * Flag / level texts need the call's level at likely_scam or higher AND either a concrete ask flag or
 * LIKELY_STREAK_MIN consecutive Likely+ scorings. One spiky scoring with no ask stays quiet (the live
 * teammates false alarm, 2026-11-08); government threats and similar calls without a clear ask still alert.
 */
export function textGateOpen(s: { level: RiskLevel; flags: Set<string> }, streak: number): boolean {
  if (!atLeast(s.level, "likely_scam")) return false;
  return CONCRETE_ASKS.some((f) => s.flags.has(f)) || streak >= LIKELY_STREAK_MIN;
}

/**
 * Fixed alert lines (SPEC step 6), in priority order. Each flag is texted at most once per call. The model
 * normally words a call-specific line instead (summary.ts writeAlertLines); these are the fallback.
 */
const FLAG_LINES: Record<string, (brand: string | null) => string> = {
  asks_code: () => "⚠️ High risk: hang up. Never read a code to someone who called you.",
  remote_access: () => "⚠️ High risk: don't install anything. Hang up.",
  money_or_code: () => "⚠️ Likely scam: hang up. Real companies never ask for gift cards or crypto.",
  // Not "Real {brand} never calls you": charities, insurers and doctors do call.
  impersonation: (brand) =>
    brand
      ? `⚠️ Likely scam: hang up. If you think it's really ${brand}, call them back on a number you trust.`
      : "⚠️ Likely scam: hang up. If you think it's really them, call back on the number on their website or your card.",
};

const LEVEL_LINES: Partial<Record<RiskLevel, string>> = {
  likely_scam: "⚠️ Likely scam: this call matches a known scam pattern. Hang up and call the company on a number you trust.",
  high_risk: "⚠️ High risk: hang up now. This call matches a known scam pattern.",
};

/**
 * Alert texts actually sent on this call, in order (memory only: the object dies with the session).
 * The next alert's wording avoids repeating them, and the post-call summary lists them.
 */
const sentAlerts = new WeakMap<CallSession, string[]>();
export const alertTexts = (s: CallSession): string[] => [...(sentAlerts.get(s) ?? [])];

/** Per call: the circle's safe word (decrypted on use only), so alert wording never sees it (rule 2). */
const safeWords = new WeakMap<CallSession, Promise<string | null>>();
function safeWordFor(s: CallSession, userId: string): Promise<string | null> {
  let p = safeWords.get(s);
  if (!p) {
    p = loadSafeWord(userId);
    p.catch(() => safeWords.delete(s)); // retry on the next alert
    safeWords.set(s, p);
  }
  return p;
}

async function alert(s: CallSession, transcript: string, streak: number) {
  const userId = s.userId;
  if (!userId || userId === "unknown") return; // still transcribed and scored, but no one to text

  // Flow 3 step 4: family_danger starts the family flow once per call (it asks YES before calling anyone).
  if (s.flags.has("family_danger") && !s.familyStarted) {
    s.familyStarted = true;
    s.alerted.add("family_danger");
    await startFamilyEmergency({ userId, content: transcript, source: "call" });
  }

  // Flag alerts say "Likely scam" / "High risk", so they wait until the call's level is at least
  // likely_scam (impersonation alone fires on many legit calls, see docs/HANDOFF.md). A flag that
  // crossed earlier is texted as soon as the level gets there.
  // Live false alarm (2026-11-08): two teammates chatting reached likely_scam with no ask at all.
  if (!textGateOpen(s, streak)) return;

  const send = async (key: string, line: string) => {
    try {
      const ok = await textUser(userId, [line], `call:${s.conv}:${key}`);
      if (ok) {
        s.alertCount++;
        const list = sentAlerts.get(s) ?? [];
        list.push(line);
        sentAlerts.set(s, list);
      }
      return ok;
    } catch (err: any) {
      console.error(`[listen] alert ${key} failed: ${err?.message}`);
      return false;
    }
  };

  if (s.ended) return;
  const pending = Object.keys(FLAG_LINES).filter((f) => s.flags.has(f) && !s.alerted.has(f));
  for (const f of pending) s.alerted.add(f); // mark before sending so a rerun never doubles it
  const level = s.level;
  const levelUp = LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(s.alertedLevel) && !!LEVEL_LINES[level];

  // Wording (call-specific, ~1 s) and the brand for the fixed impersonation line run side by side.
  const keys = [...pending, ...(levelUp && !pending.length ? ["level"] : [])];
  const [brand, words] = await Promise.all([
    pending.includes("impersonation") ? brandFrom(transcript, s, userId) : Promise.resolve(null),
    wordAlerts(s, userId, keys, level, transcript),
  ]);
  if (brand) s.brand = brand; // kept for the post-call case file (messages/case.ts)

  let sentFlagLine = false;
  for (const f of pending) {
    if (s.ended) {
      s.alerted.delete(f); // never texted
      continue;
    }
    // Pretending to be a relative, not a company: Flow 3's coaching text covers it.
    if (f === "impersonation" && !brand && s.flags.has("family_danger")) continue;
    if (await send(f, words[f] ?? FLAG_LINES[f](brand))) sentFlagLine = true;
  }
  // urgency_secrecy has no line of its own; it still counts as a red flag in the call summary.
  if (s.flags.has("urgency_secrecy")) s.alerted.add("urgency_secrecy");

  // Level went up since the last text: say so, unless a flag line just said it.
  if (LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(s.alertedLevel)) {
    s.alertedLevel = level;
    if (!sentFlagLine && LEVEL_LINES[level] && !s.ended) await send(`level:${level}`, words.level ?? LEVEL_LINES[level]!);
  }
}

/** Call-specific alert lines from the model; {} (→ fixed lines) on any failure. Logs key names and timing only. */
async function wordAlerts(
  s: CallSession,
  userId: string,
  keys: string[],
  level: RiskLevel,
  transcript: string,
): Promise<Record<string, string>> {
  if (!keys.length) return {};
  let secret: string | null;
  try {
    secret = await safeWordFor(s, userId);
  } catch {
    return {}; // fail closed: no model call without redaction (rule 2)
  }
  const r = await writeAlertLines({ keys, level, transcript, previous: alertTexts(s), secret });
  console.log(
    `[listen] conv=${short(s.conv)} alert wording keys=[${keys.join(",")}] model=[${Object.keys(r.lines).join(",")}] ${r.ms}ms${r.reason ? ` (${r.reason})` : ""}`,
  );
  return r.lines;
}

/** Gemini (fast tier) names the company or agency the caller claims to be. Wording only; Jev already decided. */
async function brandFrom(transcript: string, s: CallSession, userId: string): Promise<string | null> {
  try {
    const secret = await safeWordFor(s, userId); // throws → caught below → no brand (rule 2)
    const out = await generateJson<{ brand: string | null }>({
      tier: "fast",
      system:
        "You read a phone call transcript. Return the short name of the company or government agency the caller " +
        "claims to represent, without 'the' (for example 'Chase', 'IRS', 'Amazon', 'T-Mobile'). Return null if it is a relative, " +
        "a friend, a person without an organization, or unclear.",
      parts: [{ text: redactSafeWord(transcript, secret).slice(-6000) }],
      jsonSchema: { type: "object", properties: { brand: { type: "string", nullable: true } }, required: ["brand"] },
      temperature: 0,
      timeoutMs: 4000,
    });
    const b = out.brand?.replace(/[^\p{L}\p{N} .&'-]/gu, "").replace(/^the\s+/i, "").trim();
    return b && b.length <= 40 && b.toLowerCase() !== "null" ? b : null;
  } catch (err: any) {
    console.warn(`[listen] brand lookup failed: ${err?.message}`);
    return null;
  }
}
