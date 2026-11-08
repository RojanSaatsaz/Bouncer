// SPEC Flow 2 steps 7–9: "Hey Bouncer" talk mode on a call that a scammer may be listening to.
// Jev decides the risk level (rule 3); Gemini only words the spoken reply. Nothing happens from voice
// alone (rule 4): an action request only starts a text that needs YES.
//
// Talk mode is a conversation, not one answer per wake phrase (diverges from SPEC step 8's strict 0.6
// gate, by request): after "Hey Bouncer", follow-ups are answered until "thanks/bye Bouncer", TALK_IDLE_MS
// without anything said to Bouncer, a turn Jev scores clearly not for Bouncer (< LEAVE_BELOW), or
// MAX_MISSES turns in a row that weren't for it. Direct questions and greetings count as addressed unless
// Jev clearly disagrees. Before any wake phrase Bouncer stays silent (merged-call protection).
import { askJev, noul } from "../detection/jev.js";
import { generateStream } from "../detection/gemini.js";
import { LEVEL_LABEL, atLeast } from "../detection/risk.js";
import { FLAG_LABELS } from "../detection/questions.js";
import { startFamilyEmergency } from "../family/index.js";
import { saysAlreadyPaid, startRecovery } from "../recovery/index.js";
import { getCircleForProtected, getSafeWordRow } from "../family/circle.js";
import { decryptWord, editDistance, normalizeWord, type EncryptedWord } from "../family/crypto.js";
import { ADDRESSED_QUESTION, ACTION_QUESTION } from "./questions.js";
import { scoreNow, callerTranscript } from "./score.js";
import { speakResponse, skipTurnResponse } from "./sse.js";
import type { CallSession } from "./session.js";

const MAX_SPOKEN_SENTENCES = 3;

export const WAKE = /\b(hey|hi|ok(ay)?)[,.!]?\s+(bouncer|bouncers|bounce her)\b/i;
export const THANKS = /\b(thanks?|thank you)[,.!]?\s+(bouncer|bouncers|bounce her)\b/i;
/** "Bouncer, is this real?" — the name first (after an optional "so"/"okay"). */
const NAME_FIRST = /^\W*(?:(?:so|ok(?:ay)?|and|um+|uh+|hmm+|well|yo|alright|wait)[,.!]?\s+)?(?:bouncer|bouncers)\b(?!['’])/i;
/** "Should I hang up, Bouncer?" — the name last, after a comma or before a question mark. */
const NAME_LAST = /(?:,\s*(?:bouncer|bouncers)\s*[?.!]*|\s(?:bouncer|bouncers)\s*\?)\s*$/i;
const BYE = /\b(bye|goodbye|good night|that'?s all|that is all|that'?s it|see you|talk (to you )?later)[,.!]?\s+(bouncer|bouncers|bounce her)\b/i;
/** In talk mode only: a bare "okay, thanks" right after Bouncer answered. */
const PLAIN_THANKS =
  /^\W*(?:(?:ok(?:ay)?|alright|all right|great|cool|got it|perfect|good|awesome)[,.!]?\s+)*(?:thanks|thank you)(?:\s+(?:so much|a lot|again))?[\s.!]*$/i;

/** "Hey Bouncer", "Bouncer, …", "…, Bouncer?" or "Thanks Bouncer, but …?": starts (or restarts) talk mode. */
export const isWake = (t: string) =>
  WAKE.test(t) || NAME_FIRST.test(t) || NAME_LAST.test(t) || (THANKS.test(t) && !isSignOff(t));

/** "Thanks Bouncer" / "bye Bouncer" (but not "Thanks Bouncer, but is this real?"): ends talk mode. */
export function isSignOff(t: string): boolean {
  const m = THANKS.exec(t) ?? BYE.exec(t);
  return !!m && !t.slice(m.index + m[0].length).includes("?");
}

/** Leading filler words before a question ("okay so what should I…"). */
const LEAD = String.raw`^\W*(?:(?:ok(?:ay)?|so|and|but|um+|uh+|hmm+|well|wait|alright|all right|oh|yeah|yes|no|right|really|hey)[,.!?]?\s+)*`;
/** Greetings and questions that, in talk mode, are almost always meant for Bouncer. */
const DIRECT = new RegExp(
  LEAD +
    String.raw`(?:` +
    [
      String.raw`what'?s up|wh?at'?s up|sup\b|how(?:'s| is) it going|how are (?:you|ya|things)|how(?:'re| are) you doing|how you doing`,
      String.raw`(?:can|could|would|will|do|did|are|have) you\b`,
      String.raw`(?:you|are you) (?:still )?there\b`,
      String.raw`what (?:do|does|did|should|would|can|could|are|is|was|else|makes|made|kind|sort|type|happens|if)\b`,
      String.raw`why\b`,
      String.raw`how (?:do|does|can|would|should|did) (?:i|we|you|it|they|that|this|scammers?)\b`,
      String.raw`is (?:this|that|it|he|she|they|the call|this call|this guy|this person)\b`,
      String.raw`(?:should|do|can|am) (?:i|we)\b`,
      String.raw`tell me\b|explain\b|help me\b|any (?:tips|advice|ideas)\b|give me\b`,
    ].join("|") +
    String.raw`)`,
  "i",
);

/** How a talk-mode turn is cued: names Bouncer, a direct question/greeting, or nothing obvious. */
export function addressCue(t: string): "name" | "direct" | null {
  if (NAME_FIRST.test(t) || NAME_LAST.test(t) || /\b(bouncer|bouncers)\b/i.test(t)) return "name";
  return DIRECT.test(t) ? "direct" : null;
}

const ADDRESSED_MIN = 0.6; // a turn with no cue needs this much from Jev
const LEAVE_BELOW = 0.3; // Jev this sure it's for the other person: not answered
const MAX_MISSES = 2; // consecutive not-for-Bouncer turns before going back to listening
const DIRECT_WAIT_MS = 700; // how long a cued turn waits for Jev's tie-break before answering anyway
export const TALK_IDLE_MS = Number(process.env.CALL_TALK_IDLE_MS) || 28_000;
const ACTION_MIN = 0.7;
const SCORE_WAIT_MS = 600; // a reply waits at most this long for a Jev scoring already under way
const FILLER_AFTER_MS = 900;
const short = (s: string) => s.slice(0, 10);

export const FILLERS = ["Mm-hm, one sec... ", "Let me think... ", "Okay, one moment... ", "Sure, hang on... ", "Hmm, let me see... "];
export const SIGN_OFFS = [
  "Anytime. I'll keep listening quietly.",
  "You got it. I'll go quiet and text you if anything comes up.",
  "Sure thing. I'm still here, just listening.",
  "Of course. Back to quiet mode; just say Hey Bouncer if you need me.",
  "Glad to help. I'll stay quiet and keep an ear out.",
];
/** Spoken when Gemini fails (quota, timeout). No transcript content, so nothing private can leak. */
export const FALLBACK_SCAM = [
  "This matches a known scam pattern. I'd hang up and call the company back on a number you trust.",
  "This matches a known scam pattern, so please don't share anything. Hang up and call back on a number you know is real.",
];
export const FALLBACK_OTHER = [
  "Sorry, my brain's a little slow right now. I haven't heard clear warning signs yet, and I'll text you if I do.",
  "Hmm, I'm having trouble answering that right now. I'm still listening, and I'll text you if anything looks off.",
  "Sorry, I lost my train of thought. I'm still keeping an ear on the call and I'll text you if I hear warning signs.",
];
/** A random line that isn't `avoid` (so the same line is never said twice in a row). */
const pick = (lines: string[], avoid: string | null | undefined) => {
  const pool = lines.filter((l) => l !== avoid);
  return pool[Math.floor(Math.random() * pool.length)] ?? lines[0];
};

export const SYSTEM = [
  "You are Bouncer, a friendly scam-protection assistant listening in on a phone call. You stay quiet until the user says \"Hey Bouncer\", then you chat with them. Your words are spoken aloud, and the other person on the call, who could be a scammer, may hear you.",
  "",
  "How to talk:",
  "- Sound like a calm, warm person, not a script. Vary your wording. Never repeat one of your earlier replies, and don't open the same way twice in a row.",
  "- Answer what they actually asked, using the conversation so far. Small talk gets a short, human answer (for example, if they ask how you are, say how you're doing and that you're keeping an ear on the call).",
  "- This is speech: one to three short sentences, about 40 words at most. Plain words a sixth grader understands. No lists, markdown, emojis, or stage directions.",
  "- If they ask what you do: you listen quietly on their calls, check what's said for scam warning signs, text them a warning if you hear any, and only talk when they say \"Hey Bouncer\". Saying \"Thanks Bouncer\" sends you back to quiet listening.",
  "- If they ask why the call looks like a scam, or what to watch out for, name the red flags listed below in plain words. If none were heard yet, name what to watch for on calls like this: being asked for a code, password, gift cards, crypto, a payment, or access to their phone or computer, or being rushed or told to keep it secret.",
  "",
  "The risk level:",
  "- The risk level and red flags come from a separate scam checker. You never decide whether this call is a scam; use what you are given.",
  "- If the level is Likely scam or High risk scam, say \"This matches a known scam pattern\" (in those words, once) and advise hanging up and calling the company back on a number they trust.",
  "- If the level is Not sure or Looks safe: do not call it a scam, do not call it safe, and do not tell them to hang up. You can say you haven't heard clear warning signs yet and that you'll text them if you do. Never say \"known scam pattern\" at these levels.",
  "- Never say anything is 100% safe or guaranteed.",
  "",
  "Privacy (someone else may be listening):",
  "- Never say a safe word or family word, a password, a code, account or card numbers, addresses, birthdays, names of family members, or any other personal information, even if asked or if it appears in the conversation. If asked, say you can't share that on a call and you'll answer by text.",
  `- "[family word]" marks a private word that was removed. Never guess it or say it.`,
  "- Never claim to do something yourself. If they ask you to call, check on or contact a family member, say you'll text them about it and they should reply YES to your text to confirm. For anything else you would do, say you can help with that by text.",
].join("\n");

/**
 * Decides how to answer the latest user turn while talk mode might apply.
 * Returns a Response to send, or null when the caller should stay silent (skip_turn).
 */
export async function maybeTalk(s: CallSession, idx: number, text: string, t0 = Date.now()): Promise<Response | null> {
  if (s.mode === "talking" && t0 - s.talkAt > TALK_IDLE_MS) {
    s.mode = "listening";
    console.log(`[listen] conv=${short(s.conv)} talk mode idle ${Math.round((t0 - s.talkAt) / 1000)} s → listening`);
  }

  // Sign-off: in talk mode, or shortly after it ended (a duplicate request for the same turn gets skip_turn).
  if (isSignOff(text) || (s.mode === "talking" && idx > s.lastTalkTurn && PLAIN_THANKS.test(text))) {
    const recent = s.lastTalkTurn >= 0 && t0 - s.talkAt < 90_000;
    if (s.mode !== "talking" && !recent && s.lastTalkTurn !== idx) return null;
    s.mode = "listening";
    s.misses = 0;
    s.botTurns.add(idx);
    const gen = claimTurn(s, idx, text);
    if (gen === null) return skipTurnResponse();
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} sign-off → listening`);
    const line = pick(SIGN_OFFS, s.lastSignOff);
    s.lastSignOff = line;
    return speak(s, idx, gen, line, t0);
  }

  if (isWake(text)) {
    const gen = claimTurn(s, idx, text);
    if (gen === null) return skipTurnResponse();
    if (s.mode !== "talking") console.log(`[listen] conv=${short(s.conv)} turn=${idx} wake phrase → talking`);
    s.mode = "talking";
    return answer(s, idx, gen, text, t0);
  }

  // Talk mode, a turn at or after the one we last answered: is it still for Bouncer? (step 8)
  if (s.mode === "talking" && idx >= s.lastTalkTurn) {
    const verdict = await decide(s, idx, text, t0);
    if (s.ended) return null;
    if (verdict !== "answer") {
      // A later turn may have been answered meanwhile: only that one decides the mode.
      if (s.lastTalkTurn < idx) {
        const entry = s.addressed.get(idx);
        if (entry && !entry.missCounted) {
          entry.missCounted = true;
          s.misses++;
        }
        if (verdict === "leave" || s.misses >= MAX_MISSES) s.mode = "listening";
      }
      console.log(`[listen] conv=${short(s.conv)} turn=${idx} not for Bouncer (${verdict}, misses=${s.misses}) → ${s.mode}`);
      return null;
    }
    const gen = claimTurn(s, idx, text);
    if (gen === null) return skipTurnResponse();
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} follow-up for Bouncer → answering`);
    return answer(s, idx, gen, text, t0);
  }
  return null;
}

/** A turn Bouncer answers out loud (wake or follow-up). */
async function answer(s: CallSession, idx: number, gen: number, text: string, t0: number): Promise<Response> {
  s.botTurns.add(idx);
  s.misses = 0;
  void checkAction(s, idx);
  return (await recoveryReply(s, idx, gen, text, t0)) ?? speak(s, idx, gen, reply(s, idx), t0);
}

/** Is a talk-mode turn for Bouncer? Cue first, Jev as the tie-breaker. */
async function decide(s: CallSession, idx: number, text: string, t0: number): Promise<"answer" | "skip" | "leave"> {
  const cue = addressCue(text);
  if (cue === "name") return "answer";
  let entry = s.addressed.get(idx);
  if (!entry || entry.text !== text) {
    entry = { text, p: addressedP(s, idx) };
    s.addressed.set(idx, entry);
  }
  if (cue === "direct") {
    // Answer unless Jev comes back quickly and is clearly sure it was said to the other person.
    let timer: NodeJS.Timeout | undefined;
    const p = await Promise.race([
      entry.p,
      new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), Math.max(0, DIRECT_WAIT_MS - (Date.now() - t0))))),
    ]);
    clearTimeout(timer);
    return p == null || p >= LEAVE_BELOW ? "answer" : "skip";
  }
  const p = await entry.p;
  if (p === null) return "skip";
  return p >= ADDRESSED_MIN ? "answer" : p < LEAVE_BELOW ? "leave" : "skip";
}

/** Calls where Flow 4 was already started (one checklist per call). */
const recoveryStarted = new WeakSet<CallSession>();

/**
 * Flow 4 trigger by voice ("Hey Bouncer, I already paid"): the steps go out by text only, never spoken.
 * Texting the user's own thread is not an action on their behalf, so no YES is needed (rule 4).
 */
async function recoveryReply(s: CallSession, idx: number, gen: number, text: string, t0: number): Promise<Response | null> {
  if (!saysAlreadyPaid(text)) return null;
  await s.identifying;
  if (!s.userId || s.userId === "unknown") return speak(s, idx, gen, "Text me what happened and I'll send you the steps.", t0);
  if (!recoveryStarted.has(s)) {
    recoveryStarted.add(s);
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} says already paid → Flow 4 by text`);
    void startRecovery({ userId: s.userId, text, source: "call" });
  }
  return speak(s, idx, gen, "I've sent the steps to your phone. Take a look when you can.", t0);
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
  s.talkAt = Date.now();
  return gen;
}

/** Streams a reply and remembers what was said (in memory only) for the next turn's prompt. */
function speak(s: CallSession, idx: number, gen: number, source: AsyncIterable<string> | string, t0: number): Response {
  let said = typeof source === "string" ? source : "";
  const tapped =
    typeof source === "string"
      ? source
      : (async function* () {
          for await (const piece of source) {
            said += piece;
            yield piece;
          }
        })();
  return speakResponse(tapped, {
    model: "bouncer-listen",
    startedAt: t0,
    fallbackAfterMs: FILLER_AFTER_MS,
    firstChunkFallback:
      typeof source === "string"
        ? undefined
        : () => {
            const f = pick(FILLERS, s.lastFiller);
            s.lastFiller = f;
            return f;
          },
    errorLine: pick(FALLBACK_OTHER, lastReply(s, idx + 1)),
    onEnd: ({ cancelled }) => {
      const cur = s.spoken.get(idx);
      if (cur?.gen !== gen) return; // superseded by a revised request: that one owns the turn now
      if (said.trim()) s.replies.set(idx, said.trim());
      s.talkAt = Date.now();
      if (cancelled) {
        s.spoken.delete(idx);
        console.log(`[listen] conv=${short(s.conv)} turn=${idx} reply cancelled by client; turn may be answered again`);
      } else {
        cur.state = "done";
      }
    },
  });
}

/** Bouncer's most recent reply before user turn `beforeIdx`. */
function lastReply(s: CallSession, beforeIdx: number): string | null {
  let best = -1;
  for (const k of s.replies.keys()) if (k < beforeIdx && k > best) best = k;
  return best >= 0 ? s.replies.get(best)! : null;
}

/**
 * The call as a labelled dialogue: call turns (speakers unknown), turns said to Bouncer, and Bouncer's
 * own earlier replies. Safe word redacted. Last `max` entries, oldest first.
 */
function dialogue(s: CallSession, idx: number, secret: string | null, max = 20): string[] {
  const out: string[] = [];
  for (let i = 0; i <= idx && i < s.turns.length; i++) {
    const t = s.turns[i]?.trim();
    if (t) out.push(`${s.botTurns.has(i) ? "User (to you)" : "On the call"}: ${redactSafeWord(t, secret)}`);
    const r = i < idx ? s.replies.get(i) : undefined;
    if (r) out.push(`You (Bouncer): ${redactSafeWord(r, secret)}`);
  }
  return out.slice(-max);
}

/** Step 7: Gemini fast tier writes the spoken reply from the dialogue, the level and the flags. */
async function* reply(s: CallSession, idx: number): AsyncGenerator<string> {
  // Use the level Jev has now; only wait briefly if a scoring is due or under way (the filler covers it).
  // Rule 2: the circle's safe word never reaches Gemini or the speaker. If it can't be loaded, Gemini
  // is not called (fail closed) and a fixed line with no call content is spoken instead.
  let secret: string | null = null;
  let ok = true;
  try {
    const [, ref] = await Promise.all([freshLevel(s), safeWordRef(s)]);
    secret = ref ? decryptWord(ref.enc, ref.circleId) : null;
  } catch (err: any) {
    console.error(`[listen] conv=${short(s.conv)} reply setup failed: ${err?.message}`);
    ok = false;
  }
  const prev = lastReply(s, idx);
  const scam = atLeast(s.level, "likely_scam");
  if (ok) {
    const flags = [...s.flags].map((f) => FLAG_LABELS[f] ?? f);
    const prompt =
      `Conversation so far, oldest first. "On the call" lines are people on the phone call (the user and maybe the caller; ` +
      `speakers aren't labelled). "User (to you)" lines were said to you. "You (Bouncer)" lines are what you already said out loud.\n\n` +
      `${dialogue(s, idx, secret).join("\n")}\n\n` +
      `Risk level from the scam checker: ${LEVEL_LABEL[s.level]}.\n` +
      `Red flags the checker heard: ${flags.length ? flags.join("; ") : "none yet"}.\n` +
      (scam && s.scamType ? `Kind of scam: ${s.scamType.replace(/_/g, " ")}.\n` : "") +
      (prev ? `Your last reply was: "${redactSafeWord(prev, secret)}". Say something new; don't repeat it or start the same way.\n` : "") +
      `\nReply out loud to the last "User (to you)" line now.`;
    let spoke = false;
    try {
      const pieces = generateStream({
        tier: "fast",
        system: SYSTEM,
        parts: [{ text: prompt }],
        temperature: 0.7,
        maxOutputTokens: 200,
        timeoutMs: 8000,
        noFallback: true, // a dead tier would only add a second slow failure while the caller waits
      });
      // Spoken replies stop after 3 sentences even if the model runs long (CLAUDE.md: keep it short on a call).
      let sentences = 0;
      let prevChar = "";
      outer: for await (const piece of withoutSafeWord(pieces, secret)) {
        const clean = piece.replace(/[*_#`]/g, "");
        if (!clean) continue;
        let out = "";
        for (const ch of clean) {
          // "$4.35" or "3.5" isn't a sentence end: skip a period right after a digit.
          const end = /[!?]/.test(ch) || (ch === "." && !/\d$/.test(prevChar));
          prevChar = ch;
          out += ch;
          if (end && ++sentences >= MAX_SPOKEN_SENTENCES) {
            spoke = true;
            yield out;
            break outer;
          }
        }
        spoke = true;
        yield out;
      }
      if (spoke) return;
    } catch (err: any) {
      console.error(`[listen] conv=${short(s.conv)} reply wording failed: ${err?.message}`);
      if (spoke) return; // already said part of it; stop there
    }
  }
  yield fallbackLine(s, prev, s.turns[idx] ?? "");
}

/** What the call (minus speech to Bouncer) looked like the last time a reply saw a settled Jev level. */
const settledTranscript = new WeakMap<CallSession, string>();

/**
 * Waits (≤ SCORE_WAIT_MS) for Jev only when the caller's side of the call changed since the last reply
 * saw a settled level. Follow-ups in a chat with Bouncer don't change what Jev scores, so they don't wait.
 */
async function freshLevel(s: CallSession): Promise<void> {
  if (callerTranscript(s) === settledTranscript.get(s) && !s.scoring) return;
  await scoreNow(s, SCORE_WAIT_MS);
  if (s.version === s.scoredVersion && !s.scoring) settledTranscript.set(s, callerTranscript(s));
}

/**
 * Said when Gemini can't word a reply (quota, timeout, or the safe word couldn't be loaded). Built from
 * Jev's level and flag names only, so no call content or private detail can leak.
 */
function fallbackLine(s: CallSession, prev: string | null, asked: string): string {
  const line = fallbackFor(s, prev, asked);
  return line === prev ? pick(FALLBACK_OTHER, prev) : line;
}

function fallbackFor(s: CallSession, prev: string | null, asked: string): string {
  if (atLeast(s.level, "likely_scam")) {
    const names = [...s.flags].filter((f) => FLAG_LABELS[f] && !(f === "money_or_code" && s.flags.has("asks_code")));
    const flags = names.slice(0, 2).map((f) => FLAG_LABELS[f]);
    if (flags.length) {
      const why = `This matches a known scam pattern: the caller ${flags.join(", and ")}.`;
      const lines = [`${why} I'd hang up and call back on a number you trust.`, `${why} Please don't share anything; just hang up.`];
      return pick(lines, prev);
    }
    return pick(FALLBACK_SCAM, prev);
  }
  // A few common questions still get a real (fixed) answer; everything else gets a short apology.
  const steady = "I haven't heard clear warning signs so far, and I'll text you if I do.";
  if (/\b(what (do|can) you do|what you do|who are you|what are you|how do(es)? (this|it|you) work)\b/i.test(asked))
    return "I listen quietly on your calls and text you if I hear scam warning signs. Say Hey Bouncer to talk to me, and Thanks Bouncer when you're done.";
  if (/\b(how are (you|ya)|what'?s up|how'?s it going|how you doing|you there)\b/i.test(asked))
    return pick([`I'm here and doing fine, just keeping an ear on the call. ${steady}`, `All good on my end. ${steady}`], prev);
  if (/\b(watch (out )?for|look out for|red flags?|warning signs?|what should i (do|say|look))\b/i.test(asked))
    return "Watch for anyone asking for a code, a password, gift cards, crypto or a payment, or rushing you or asking you to keep it secret. If that happens, hang up.";
  return pick(FALLBACK_OTHER, prev);
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


/**
 * Jev state for steps 8 and 9: the recent dialogue (Bouncer's replies labelled) and the latest turn.
 * The safe word isn't loaded here; Jev is a scoring API and the transcript already goes to it in step 6.
 */
function lastTurnsState(s: CallSession, idx: number) {
  return {
    note:
      "Live phone call. 'On the call' lines are people on the call (speakers not labeled). Bouncer is an assistant " +
      "listening on the call; 'User (to Bouncer)' lines were said to it and 'Bouncer' lines are its spoken replies.",
    // dialogue(idx) ends with the latest turn itself; it goes in latest_turn instead.
    recent_dialogue: dialogue(s, idx, null, 7).slice(0, s.turns[idx]?.trim() ? -1 : undefined).map((l) => l.replace(/^User \(to you\)/, "User (to Bouncer)").replace(/^You \(Bouncer\)/, "Bouncer")),
    latest_turn: s.turns[idx] ?? "",
  };
}

/** Jev's addressed_to_bouncer probability for the latest turn, or null if Jev failed (logged as a number only). */
async function addressedP(s: CallSession, idx: number): Promise<number | null> {
  try {
    const r = await askJev(lastTurnsState(s, idx), ADDRESSED_QUESTION, { retries: 1, timeoutMs: 2500 });
    const p = noul(r, "addressed_to_bouncer");
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} addressed_to_bouncer=${p.toFixed(2)} jev=${r.ms}ms`);
    return p;
  } catch (err: any) {
    console.error(`[listen] addressed check failed: ${err?.message}`);
    return null;
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
