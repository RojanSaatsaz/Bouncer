// SPEC Flow 2 steps 3 and 6: identify the caller, score the call with Jev in the background,
// and text alerts. Never blocks a turn's response. Logs names and numbers only, never turn text (rule 1).
import { askJev, noul, choice } from "../detection/jev.js";
import { generateJson } from "../detection/gemini.js";
import { riskLevel, atLeast, LEVEL_ORDER, type RiskLevel } from "../detection/risk.js";
import { startFamilyEmergency } from "../family/index.js";
import { toE164, getUserByVoicePhone, getListenPendingUser, textUser } from "../users.js";
import { CALL_QUESTIONS, CALL_FLAGS } from "./questions.js";
import type { CallSession } from "./session.js";

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
  const transcript = s.turns.filter((t) => t?.trim()).join("\n");
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
    console.log(
      `[listen] conv=${short(s.conv)} scored turns=${s.turns.length} level=${risk.level} p=${risk.p.toFixed(2)} flags=[${crossed.join(",")}] jev=${r.ms}ms`,
    );

    // Alerts (brand lookup + texts) run after the level is set, so a waiting spoken reply isn't held
    // up by them. Chained per session so two runs never interleave their sends.
    const prev = alertChain.get(s) ?? Promise.resolve();
    alertChain.set(s, prev.then(() => alert(s, transcript)).catch((err) => console.error(`[listen] alerts failed: ${err?.message}`)));
  } catch (err: any) {
    console.error(`[listen] conv=${short(s.conv)} scoring failed: ${err?.message}`);
  } finally {
    s.scoring = false;
    // Turns changed while Jev was running (or it failed): score again once they settle.
    if (!s.ended && s.version !== s.scoredVersion) scheduleScore(s);
  }
}

/** Alert lines (SPEC step 6), in priority order. Each flag is texted at most once per call. */
const FLAG_LINES: Record<string, (brand: string | null) => string> = {
  asks_code: () => "⚠️ High risk: hang up. Never read a code to someone who called you.",
  remote_access: () => "⚠️ High risk: don't install anything. Hang up.",
  money_or_code: () => "⚠️ Likely scam: hang up. Real companies never ask for gift cards or crypto.",
  impersonation: (brand) =>
    brand
      ? `⚠️ Likely scam: hang up. Real ${brand} never calls you.`
      : "⚠️ Likely scam: hang up. The real company never calls you like this. Call the number on their website or your card.",
};

const LEVEL_LINES: Partial<Record<RiskLevel, string>> = {
  likely_scam: "⚠️ Likely scam: this call matches a known scam pattern. Hang up and call the company on a number you trust.",
  high_risk: "⚠️ High risk: hang up now. This call matches a known scam pattern.",
};

async function alert(s: CallSession, transcript: string) {
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
  if (!atLeast(s.level, "likely_scam")) return;

  const send = async (key: string, line: string) => {
    try {
      const ok = await textUser(userId, [line], `call:${s.conv}:${key}`);
      if (ok) s.alertCount++;
      return ok;
    } catch (err: any) {
      console.error(`[listen] alert ${key} failed: ${err?.message}`);
      return false;
    }
  };

  let sentFlagLine = false;
  for (const f of Object.keys(FLAG_LINES)) {
    if (!s.flags.has(f) || s.alerted.has(f) || s.ended) continue;
    s.alerted.add(f); // mark before sending so a rerun never doubles it
    const brand = f === "impersonation" ? await brandFrom(transcript) : null;
    // Pretending to be a relative, not a company: Flow 3's coaching text covers it.
    if (f === "impersonation" && !brand && s.flags.has("family_danger")) continue;
    if (await send(f, FLAG_LINES[f](brand))) sentFlagLine = true;
  }
  // urgency_secrecy has no line of its own; it still counts as a red flag in the call summary.
  if (s.flags.has("urgency_secrecy")) s.alerted.add("urgency_secrecy");

  // Level went up since the last text: say so, unless a flag line just said it.
  if (LEVEL_ORDER.indexOf(s.level) > LEVEL_ORDER.indexOf(s.alertedLevel)) {
    const level = s.level;
    s.alertedLevel = level;
    if (!sentFlagLine && LEVEL_LINES[level]) await send(`level:${level}`, LEVEL_LINES[level]!);
  }
}

/** Gemini (fast tier) names the company or agency the caller claims to be. Wording only; Jev already decided. */
async function brandFrom(transcript: string): Promise<string | null> {
  try {
    const out = await generateJson<{ brand: string | null }>({
      tier: "fast",
      system:
        "You read a phone call transcript. Return the short name of the company or government agency the caller " +
        "claims to represent, without 'the' (for example 'Chase', 'IRS', 'Amazon', 'T-Mobile'). Return null if it is a relative, " +
        "a friend, a person without an organization, or unclear.",
      parts: [{ text: transcript.slice(-6000) }],
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
