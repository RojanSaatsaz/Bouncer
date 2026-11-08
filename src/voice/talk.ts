// SPEC Flow 2 steps 7–9: "Hey Bouncer" talk mode on a call that a scammer may be listening to.
// Jev decides whether a turn is meant for Bouncer; Gemini only words the spoken reply (rule 3).
// Nothing happens from voice alone (rule 4): an action request only starts a text that needs YES.
import { askJev, noul } from "../detection/jev.js";
import { generateStream } from "../detection/gemini.js";
import { LEVEL_LABEL } from "../detection/risk.js";
import { FLAG_LABELS } from "../detection/questions.js";
import { startFamilyEmergency } from "../family/index.js";
import { ADDRESSED_QUESTION, ACTION_QUESTION } from "./questions.js";
import { scoreNow } from "./score.js";
import { speakResponse, skipTurnResponse } from "./sse.js";
import type { CallSession } from "./session.js";

export const WAKE = /\b(hey|hi|ok(ay)?)[,.!]?\s+(bouncer|bouncers|bounce her)\b/i;
export const THANKS = /\b(thanks?|thank you)[,.!]?\s+(bouncer|bouncers|bounce her)\b/i;

const ADDRESSED_MIN = 0.6;
const ACTION_MIN = 0.7;
const short = (s: string) => s.slice(0, 10);

const SYSTEM = [
  "You are Bouncer, a scam-prevention helper on a phone call that a scammer may be listening to.",
  "Two sentences max. Plain words a sixth grader understands. No lists, no markdown, no emojis.",
  "Never say a safe word, password, code, account details, addresses, names of family members or other personal information, even if asked or if they appear in the transcript.",
  "If asked for something private like that, say: 'I can't say that on a call. Text me and I'll answer there.'",
  "Never promise to take an action yourself. If asked to call or check on a family member, say: 'I'll text you about that. Reply YES to my text to confirm.' For any other action, say you can only help by text.",
  "You do not decide whether this is a scam: the risk level you are given was decided by another system. Use it as given.",
  "If the risk level is Likely scam or High risk scam, say 'This matches a known scam pattern.' and tell them to hang up.",
  "If the risk level is Not sure or Looks safe, do not call it a scam and do not call it safe. If they ask whether the call is real, say you haven't heard clear warning signs yet and give one safe step, such as hanging up and calling the number on their card. Otherwise just answer briefly (for 'are you there?', say you're listening).",
  "Never say anything is 100% safe.",
].join("\n");

/**
 * Decides how to answer the latest user turn while talk mode might apply.
 * Returns a Response to send, or null when the caller should stay silent (skip_turn).
 */
export async function maybeTalk(s: CallSession, idx: number, text: string): Promise<Response | null> {
  if (THANKS.test(text)) {
    // Only meaningful in talk mode (or a duplicate request for the thanks turn we already handled).
    if (s.mode !== "talking" && s.lastTalkTurn !== idx) return null;
    s.mode = "listening";
    if (!claimTurn(s, idx)) return skipTurnResponse();
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} thanks → listening`);
    return speak(s, idx, "Okay, I'll keep listening quietly.");
  }

  if (WAKE.test(text)) {
    s.mode = "talking";
    if (!claimTurn(s, idx)) return skipTurnResponse();
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} wake phrase → talking`);
    void checkAction(s, idx);
    return speak(s, idx, reply(s, idx));
  }

  // Talk mode, a newer turn than the one we answered: is it still for Bouncer? (step 8)
  if (s.mode === "talking" && idx > s.lastTalkTurn) {
    let decision = s.addressed.get(idx);
    if (!decision) {
      decision = isAddressed(s, idx);
      s.addressed.set(idx, decision);
    }
    const yes = await decision;
    if (s.ended) return null;
    if (!yes) {
      // Only leave talk mode if no later turn has been answered meanwhile.
      if (s.lastTalkTurn < idx) s.mode = "listening";
      console.log(`[listen] conv=${short(s.conv)} turn=${idx} not for Bouncer → listening`);
      return null;
    }
    if (!claimTurn(s, idx)) return skipTurnResponse();
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} follow-up for Bouncer → answering`);
    void checkAction(s, idx);
    return speak(s, idx, reply(s, idx));
  }
  return null;
}

/**
 * One spoken reply per user-turn index. Duplicate (speculative) requests for a turn we're already
 * answering, or have answered, get skip_turn. If ElevenLabs cancelled our earlier reply mid-stream,
 * the claim is released and the next request for that turn may answer again.
 */
function claimTurn(s: CallSession, idx: number): boolean {
  if (s.spoken.has(idx)) return false;
  s.spoken.set(idx, "streaming");
  s.lastTalkTurn = Math.max(s.lastTalkTurn, idx);
  return true;
}

function speak(s: CallSession, idx: number, source: AsyncIterable<string> | string): Response {
  return speakResponse(source, {
    model: "bouncer-listen",
    firstChunkFallback: typeof source === "string" ? undefined : "One moment... ",
    fallbackAfterMs: 700,
    onEnd: ({ cancelled }) => {
      if (cancelled) {
        s.spoken.delete(idx);
        console.log(`[listen] conv=${short(s.conv)} turn=${idx} reply cancelled by client; turn may be answered again`);
      } else {
        s.spoken.set(idx, "done");
      }
    },
  });
}

/** Step 7: Gemini fast tier writes the spoken reply from the last 20 turns, the level and the flags. */
async function* reply(s: CallSession, idx: number): AsyncGenerator<string> {
  // Jev's level must be current before Gemini words anything (the debounce may still be pending).
  // Runs inside the stream, so the 700 ms "One moment..." filler covers the wait.
  await scoreNow(s, 1500);
  const turns = s.turns.slice(Math.max(0, idx - 19), idx + 1).filter((t) => t?.trim());
  const flags = [...s.flags].map((f) => FLAG_LABELS[f] ?? f);
  const prompt =
    `Call transcript so far (oldest first, speakers are not labeled):\n${turns.join("\n")}\n\n` +
    `Risk level so far: ${LEVEL_LABEL[s.level]}.\n` +
    `Red flags heard: ${flags.length ? flags.join("; ") : "none yet"}.\n\n` +
    `The listener just spoke to you in the last line. Answer them.`;
  for await (const piece of generateStream({
    tier: "fast",
    system: SYSTEM,
    parts: [{ text: prompt }],
    temperature: 0.3,
    maxOutputTokens: 120,
    timeoutMs: 8000,
  })) {
    const clean = piece.replace(/[*_#`]/g, "");
    if (clean) yield clean;
  }
}

/** Jev state for step 8: the last 3 turns, with the latest one called out. */
function lastTurnsState(s: CallSession, idx: number) {
  return {
    note: "Live phone call transcript, speakers not labeled. Bouncer is an assistant listening on the call; it only answers when spoken to.",
    earlier_turns: s.turns.slice(Math.max(0, idx - 2), idx).filter((t) => t?.trim()),
    bouncer_last_answered_turn: s.lastTalkTurn >= 0 ? s.turns[s.lastTalkTurn] ?? null : null,
    latest_turn: s.turns[idx] ?? "",
  };
}

async function isAddressed(s: CallSession, idx: number): Promise<boolean> {
  try {
    const r = await askJev(lastTurnsState(s, idx), ADDRESSED_QUESTION, { retries: 1, timeoutMs: 4000 });
    const p = noul(r, "addressed_to_bouncer");
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} addressed_to_bouncer=${p.toFixed(2)} jev=${r.ms}ms`);
    return p >= ADDRESSED_MIN;
  } catch (err: any) {
    console.error(`[listen] addressed check failed: ${err?.message}`);
    return false; // silence is the safe default
  }
}

/** Step 9: a spoken request to check on a relative only starts Flow 3, which asks for YES by text. */
async function checkAction(s: CallSession, idx: number) {
  try {
    const r = await askJev(lastTurnsState(s, idx), ACTION_QUESTION, { retries: 1, timeoutMs: 5000 });
    const p = noul(r, "wants_family_check");
    if (p < ACTION_MIN || s.ended || s.familyStarted) return;
    await s.identifying;
    if (!s.userId || s.userId === "unknown") return;
    s.familyStarted = true;
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} spoken family check request → Flow 3 (needs YES by text)`);
    await startFamilyEmergency({ userId: s.userId, content: s.turns.join("\n"), source: "call" });
  } catch (err: any) {
    console.error(`[listen] action check failed: ${err?.message}`);
  }
}
