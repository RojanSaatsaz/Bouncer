// SPEC Flow 2 steps 7–9: "Hey Bouncer" talk mode on a call that a scammer may be listening to.
// Jev decides whether a turn is meant for Bouncer; Gemini only words the spoken reply (rule 3).
// Nothing happens from voice alone (rule 4): an action request only starts a text that needs YES.
import { askJev, noul } from "../detection/jev.js";
import { generateStream } from "../detection/gemini.js";
import { LEVEL_LABEL } from "../detection/risk.js";
import { FLAG_LABELS } from "../detection/questions.js";
import { startFamilyEmergency } from "../family/index.js";
import { saysAlreadyPaid, startRecovery } from "../recovery/index.js";
import { getCircleForProtected, getSafeWordRow } from "../family/circle.js";
import { decryptWord, editDistance, normalizeWord, type EncryptedWord } from "../family/crypto.js";
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
  "If the risk level is Not sure or Looks safe, do not call it a scam, do not call it safe, and do not tell them to hang up. If they ask whether the call is real, say: 'I haven't heard any warning signs so far. I'll text you if I hear any.' Otherwise just answer briefly (for 'are you there?', say you're listening).",
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
    const gen = claimTurn(s, idx, text);
    if (gen === null) return skipTurnResponse();
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} thanks → listening`);
    return speak(s, idx, gen, "Okay, I'll keep listening quietly.");
  }

  if (WAKE.test(text)) {
    s.mode = "talking";
    const gen = claimTurn(s, idx, text);
    if (gen === null) return skipTurnResponse();
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} wake phrase → talking`);
    void checkAction(s, idx);
    return (await recoveryReply(s, idx, gen, text)) ?? speak(s, idx, gen, reply(s, idx));
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
    s.botTurns.add(idx);
    const gen = claimTurn(s, idx, text);
    if (gen === null) return skipTurnResponse();
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} follow-up for Bouncer → answering`);
    void checkAction(s, idx);
    return (await recoveryReply(s, idx, gen, text)) ?? speak(s, idx, gen, reply(s, idx));
  }
  return null;
}

/** Calls where Flow 4 was already started (one checklist per call). */
const recoveryStarted = new WeakSet<CallSession>();

/**
 * Flow 4 trigger by voice ("Hey Bouncer, I already paid"): the steps go out by text only, never spoken.
 * Texting the user's own thread is not an action on their behalf, so no YES is needed (rule 4).
 */
async function recoveryReply(s: CallSession, idx: number, gen: number, text: string): Promise<Response | null> {
  if (!saysAlreadyPaid(text)) return null;
  await s.identifying;
  if (!s.userId || s.userId === "unknown") return speak(s, idx, gen, "Text me what happened and I'll send you the steps.");
  if (!recoveryStarted.has(s)) {
    recoveryStarted.add(s);
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} says already paid → Flow 4 by text`);
    void startRecovery({ userId: s.userId, text, source: "call" });
  }
  return speak(s, idx, gen, "I've sent the steps to your phone.");
}

/**
 * One spoken reply per user-turn index and text. A duplicate (speculative) request with the SAME text as
 * the reply we're streaming or finished gets skip_turn. A request with DIFFERENT text is ElevenLabs revising
 * the turn: it will play the newer response and cancel the older one, so the newer request supersedes the
 * claim (new generation). If ElevenLabs cancelled our reply mid-stream, the claim is released and the next
 * request for that turn may answer again. Returns the claim's generation, or null to stay silent.
 */
function claimTurn(s: CallSession, idx: number, text: string): number | null {
  const cur = s.spoken.get(idx);
  if (cur && cur.text === text) return null;
  const gen = ++s.speakGen;
  if (cur) console.log(`[listen] conv=${short(s.conv)} turn=${idx} revised text → answering the newer request`);
  s.spoken.set(idx, { state: "streaming", text, gen });
  s.lastTalkTurn = Math.max(s.lastTalkTurn, idx);
  return gen;
}

function speak(s: CallSession, idx: number, gen: number, source: AsyncIterable<string> | string): Response {
  return speakResponse(source, {
    model: "bouncer-listen",
    firstChunkFallback: typeof source === "string" ? undefined : "One moment... ",
    fallbackAfterMs: 700,
    onEnd: ({ cancelled }) => {
      const cur = s.spoken.get(idx);
      if (cur?.gen !== gen) return; // superseded by a revised request: that one owns the turn now
      if (cancelled) {
        s.spoken.delete(idx);
        console.log(`[listen] conv=${short(s.conv)} turn=${idx} reply cancelled by client; turn may be answered again`);
      } else {
        cur.state = "done";
      }
    },
  });
}

/** Step 7: Gemini fast tier writes the spoken reply from the last 20 turns, the level and the flags. */
async function* reply(s: CallSession, idx: number): AsyncGenerator<string> {
  // Jev's level must be current before Gemini words anything (the debounce may still be pending).
  // Runs inside the stream, so the 700 ms "One moment..." filler covers the wait.
  // Rule 2: the circle's safe word never reaches Gemini or the speaker. If it can't be loaded, this
  // throws and the caller hears "Sorry, I'll text you instead." (fail closed).
  const [, ref] = await Promise.all([scoreNow(s, 1500), safeWordRef(s)]);
  const secret = ref ? decryptWord(ref.enc, ref.circleId) : null;
  const turns = s.turns
    .slice(Math.max(0, idx - 19), idx + 1)
    .filter((t) => t?.trim())
    .map((t) => redactSafeWord(t, secret));
  const flags = [...s.flags].map((f) => FLAG_LABELS[f] ?? f);
  const prompt =
    `Call transcript so far (oldest first, speakers are not labeled):\n${turns.join("\n")}\n\n` +
    `Risk level so far: ${LEVEL_LABEL[s.level]}.\n` +
    `Red flags heard: ${flags.length ? flags.join("; ") : "none yet"}.\n` +
    `"${FAMILY_WORD}" marks a private word that was removed; never guess or repeat it.\n\n` +
    `The listener just spoke to you in the last line. Answer them.`;
  const pieces = generateStream({
    tier: "fast",
    system: SYSTEM,
    parts: [{ text: prompt }],
    temperature: 0.3,
    maxOutputTokens: 120,
    timeoutMs: 8000,
  });
  for await (const piece of withoutSafeWord(pieces, secret)) {
    const clean = piece.replace(/[*_#`]/g, "");
    if (clean) yield clean;
  }
}

// ---- Safe word redaction (rule 2) ---------------------------------------------------------------

type WordRef = { enc: EncryptedWord; circleId: string } | null;
/** Per call: the encrypted safe word of the caller's circle (never the plain word; decrypt into a local). */
const wordRefs = new WeakMap<CallSession, Promise<WordRef>>();

function safeWordRef(s: CallSession): Promise<WordRef> {
  let p = wordRefs.get(s);
  if (!p) {
    p = (async () => {
      await s.identifying;
      if (s.userId === null) throw new Error("caller not identified yet");
      if (s.userId === "unknown") return null;
      const circle = await getCircleForProtected(s.userId);
      const enc = circle ? await getSafeWordRow(circle.id) : null;
      return enc && circle ? { enc, circleId: circle.id } : null;
    })();
    p.catch(() => wordRefs.delete(s)); // retry on the next spoken reply
    wordRefs.set(s, p);
  }
  return p;
}

export const FAMILY_WORD = "[family word]";
const TOKEN = /[\p{L}\p{N}\p{M}'’`]+/gu;
// Same tolerance as Flow 3's wordsMatch: one letter per word (3+ letters), exact for shorter words.
const slack = (w: string) => (w.length >= 3 ? 1 : 0);

function tokenize(text: string) {
  const out: { start: number; end: number; norm: string }[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const norm = normalizeWord(m[0]).replace(/ /g, "");
    if (norm) out.push({ start: m.index!, end: m.index! + m[0].length, norm });
  }
  return out;
}

/**
 * Replaces every occurrence of the safe word in `text` with "[family word]". Matching follows Flow 3
 * (normalised, each word within one letter, or the word run together / split). Over-redacting is fine.
 */
export function redactSafeWord(text: string, secret: string | null | undefined): string {
  return replaceSafeWord(text, secret, FAMILY_WORD);
}

function replaceSafeWord(text: string, secret: string | null | undefined, replacement: string): string {
  const want = secret ? normalizeWord(secret).split(" ").filter(Boolean) : [];
  const n = want.length;
  if (!n || !text) return text;
  const joined = want.join("");
  const budget = slack(joined);
  const toks = tokenize(text);
  const spans: [number, number][] = [];
  for (let i = 0; i < toks.length; ) {
    let hit = 0;
    for (const size of [n + 1, n, n - 1]) {
      if (size < 1 || i + size > toks.length) continue;
      const win = toks.slice(i, i + size);
      const ok =
        size === n
          ? want.every((w, k) => editDistance(win[k].norm, w, slack(w)) <= slack(w))
          : editDistance(win.map((t) => t.norm).join(""), joined, budget) <= budget;
      if (ok) {
        hit = size;
        break;
      }
    }
    if (hit) {
      spans.push([toks[i].start, toks[i + hit - 1].end]);
      i += hit;
    } else i++;
  }
  if (!spans.length) return text;
  let out = "";
  let at = 0;
  for (const [a, b] of spans) {
    out += text.slice(at, a) + replacement;
    at = b;
  }
  return out + text.slice(at);
}

/**
 * Filters a stream of spoken text so the safe word is never said, even split across chunks. The last
 * (words in the safe word + 1) words are held back until they can no longer start a match; any match in
 * the held text is dropped. Words released earlier can't be part of a later match (a match spans at most
 * that many words), so nothing already spoken needs taking back.
 */
export async function* withoutSafeWord(source: AsyncIterable<string>, secret: string | null | undefined): AsyncGenerator<string> {
  const words = secret ? normalizeWord(secret).split(" ").filter(Boolean).length : 0;
  if (!words) {
    yield* source;
    return;
  }
  const hold = words + 1;
  let buf = "";
  for await (const piece of source) {
    buf += piece;
    // Only match whole words: a word still being streamed ("elephan…") is checked once it's complete.
    const m = /\s(?=\S*$)/.exec(buf);
    if (!m) continue;
    buf = replaceSafeWord(buf.slice(0, m.index + 1), secret, "") + buf.slice(m.index + 1);
    const toks = tokenize(buf);
    if (toks.length <= hold) continue;
    const cut = toks[toks.length - hold].start;
    const ready = buf.slice(0, cut);
    buf = buf.slice(cut);
    if (ready) yield ready;
  }
  const last = replaceSafeWord(buf, secret, "");
  if (last) yield last;
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
