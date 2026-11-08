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
import { getCircleForUser, getSafeWordRow } from "../family/circle.js";
import { decryptWord, editDistance, normalizeWord, type EncryptedWord } from "../family/crypto.js";
import { ADDRESSED_QUESTION, ACTION_QUESTION, WAKE_QUESTION } from "./questions.js";
import { scoreNow, callerTranscript } from "./score.js";
import { speakResponse, skipTurnResponse } from "./sse.js";
import type { CallSession } from "./session.js";
import { WAKE, THANKS, NAME_FIRST, wakeCue } from "./wake.js";

/** Spoken replies stop after this many sentences (CLAUDE.md: short on a call). Direct advice may use one more. */
const MAX_SPOKEN_SENTENCES = 3;
const MAX_DIRECT_SENTENCES = 4;

export { WAKE, THANKS, WAKE_ANY, wakeCue } from "./wake.js";
/** "Should I hang up, Bouncer?" — the name last. A talk-mode cue only; it does not wake Bouncer from silence. */
const NAME_LAST = /(?:,\s*(?:bouncer|bouncers)\s*[?.!]*|\s(?:bouncer|bouncers)\s*\?)\s*$/i;
const BYE = /\b(bye|goodbye|good night|that'?s all|that is all|that'?s it|see you|talk (to you )?later)[,.!]?\s+(bouncer|bouncers|bounce her)\b/i;
/** In talk mode only: a bare "okay, thanks" right after Bouncer answered. */
const PLAIN_THANKS =
  /^\W*(?:(?:ok(?:ay)?|alright|all right|great|cool|got it|perfect|good|awesome)[,.!]?\s+)*(?:thanks|thank you)(?:\s+(?:so much|a lot|again))?[\s.!]*$/i;

/**
 * Wakes Bouncer from silence for sure: the turn addresses Bouncer by name (a greeting + the name, the
 * name first or last, or the name in a question/request; see wake.ts). A turn that only might
 * ("maybe") is settled by Jev in maybeTalk. An incidental mention ("the bouncer at the club") never wakes.
 */
export const isWake = (t: string) => wakeCue(t) === "wake";

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
      String.raw`what (?:do|does|did|should|would|can|could|are|is|was|else|makes|made|kind|sort|type|happens|if|about)\b`,
      String.raw`why\b`,
      String.raw`how (?:do|does|can|would|should|did) (?:i|we|you|it|they|that|this|scammers?)\b`,
      String.raw`is (?:this|that|it|he|she|they|the call|this call|this guy|this person)\b`,
      String.raw`(?:should|do|can|am|could|would) (?:i|we)\b`,
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
const ADDRESSED_MIN_DIRECT = 0.4; // 1-on-1 call: nobody else is on the line, so a lower bar
const LEAVE_BELOW = 0.3; // Jev this sure it's for the other person: not answered
const MAX_MISSES = 2; // consecutive not-for-Bouncer turns before going back to listening
const DIRECT_WAIT_MS = 700; // how long a cued turn waits for Jev's tie-break before answering anyway
const WAKE_WAIT_MS = 700; // an ambiguous mention of the name waits this long for Jev, else stays silent
const WAKE_MIN = 0.6;
export const TALK_IDLE_MS = Number(process.env.CALL_TALK_IDLE_MS) || 28_000;
const ACTION_MIN = 0.7;
const SCORE_WAIT_MS = 600; // a reply waits at most this long for a Jev scoring already under way
const FILLER_AFTER_MS = 900;
/** Words of other speech before the first wake that make this a merged call (a few "hello?"s don't). */
const MERGED_PRE_WAKE_WORDS = 12;
/** Words of non-Bouncer speech after the first wake that turn a direct call into a merged one. */
const MERGED_LATER_WORDS = 30;
const RECENT_LINES = 6; // canned lines remembered so none repeats too soon
const short = (s: string) => s.slice(0, 10);

/** Said only if the reply hasn't started after FILLER_AFTER_MS. */
export const FILLERS = [
  "Mm-hm, one sec... ",
  "Let me think... ",
  "Okay, one moment... ",
  "Sure, hang on... ",
  "Hmm, let me see... ",
  "Good question... ",
  "Right, give me a second... ",
  "Okay, let me think about that... ",
  "Hmm... ",
  "Just a sec... ",
  "Alright, bear with me... ",
  "Let's see... ",
];
export const SIGN_OFFS = [
  "Anytime. I'll keep listening quietly.",
  "You got it. I'll go quiet and text you if anything comes up.",
  "Sure thing. I'm still here, just listening.",
  "Of course. Back to quiet mode; just say Hey Bouncer if you need me.",
  "Glad to help. I'll stay quiet and keep an ear out.",
  "No problem. I'll be right here if you need me again.",
  "Happy to help. Say Hey Bouncer whenever you want me back.",
  "You're welcome. Going quiet now.",
  "Take care. I'm a Hey Bouncer away if anything else comes up.",
  "My pleasure. I'll hang back and stay quiet.",
  "Okay, I'll let you be. Just call my name if you need me.",
  "Good luck. I'll stay in the background.",
];
/** Spoken when the model fails (quota, timeout). No transcript content, so nothing private can leak. */
export const FALLBACK_SCAM = [
  "This matches a known scam pattern. I'd hang up and call the company back on a number you trust.",
  "This matches a known scam pattern, so please don't share anything. Hang up and call back on a number you know is real.",
];
export const FALLBACK_OTHER = [
  "Sorry, my brain's a little slow right now. Nothing alarming has come up so far, and I'll text you if it does.",
  "Hmm, I'm having trouble answering that right now. I'm still listening, and I'll text you if anything looks off.",
  "Sorry, I lost my train of thought. I'm still on the line and I'll text you if something worrying comes up.",
];
/** Direct (1-on-1) calls: there is no other call to report on, so no "I'm still listening" status. */
export const FALLBACK_DIRECT = [
  "Sorry, I lost my train of thought. Could you say that one more time?",
  "Hmm, I'm a bit slow right now. Can you ask me that again?",
  "Sorry, that one slipped past me. Mind saying it again?",
];
/** A random line not spoken recently (so the same canned line never comes back too soon). */
function pick(lines: string[], avoid: string | null | undefined, s?: CallSession): string {
  const recent = new Set([avoid, ...(s?.recentLines ?? [])]);
  let pool = lines.filter((l) => !recent.has(l));
  if (!pool.length) pool = lines.filter((l) => l !== avoid);
  const line = pool[Math.floor(Math.random() * pool.length)] ?? lines[0];
  if (s) s.recentLines = [...s.recentLines, line].slice(-RECENT_LINES);
  return line;
}

/** Spoken-reply system prompt (shared part). The call-type block below is added per reply. */
export const SYSTEM = [
  "You are Bouncer, a warm, quick scam-protection assistant on a phone line. People either call you one-on-one for advice, or merge you into a live phone call so you can listen for scams. You stay silent until someone greets you by name, then you talk with them. Your words are spoken aloud.",
  "",
  "How to talk:",
  "- Sound like a calm, friendly person who knows scams well, not a script. Plain words a sixth grader understands. No lists, markdown, emojis, or stage directions.",
  "- Keep it short: one to three short sentences, about 45 words at most. Only when giving advice about something that happened to them on a one-on-one call may you use a fourth sentence, and stay under 60 words.",
  "- Answer exactly what they asked, using the whole conversation. Small talk gets a short, human answer.",
  "- Vary your words like a real person. Never open the same way as one of your earlier replies, never reuse a sentence or catchphrase you already said, and rephrase instead of repeating. Lead with the answer itself, not a preamble.",
  "- Don't use these stock phrases: \"I haven't heard any clear warning signs\", \"I haven't heard clear signs\", \"I'll text you if I hear anything\", \"keeping an ear on the call\", \"Great question\", \"Absolutely\", \"I understand your concern\", \"It's important to\", \"Rest assured\". Don't start with \"So\", \"Okay\" or \"Well\".",
  "- If they ask what you do: people can call you for advice about anything scam-related, or merge you into a call; on a call you listen quietly, check what's said for scam warning signs, text them a warning if you hear any, and only talk when greeted with \"Hey Bouncer\". \"Thanks Bouncer\" sends you back to quiet.",
  "- Never say anything is 100% safe or guaranteed.",
  "",
  "Privacy (someone else may be listening):",
  "- Never say a safe word or family word, a password, a code, account or card numbers, addresses, birthdays, names of family members, or any other personal information, even if asked or if it appears in the conversation. If asked, say you can't share that out loud and you'll answer by text.",
  `- "[family word]" marks a private word that was removed. Never guess it or say it.`,
  "- Never claim to do something yourself. If they ask you to call, check on or contact a family member, say you'll text them about it and they should reply YES to your text to confirm. For anything else you would do, say you can help with that by text.",
].join("\n");

/** The call-type block: who is on the line decides what "this call" means and which verdict words are allowed. */
export const CONTEXT_RULES: Record<"direct" | "merged", string> = {
  direct: [
    "Call type: ONE-ON-ONE. The user called you directly to talk with you. Nobody else is on this line, and there is no other call for you to judge.",
    "- When they describe something that happened (a text, an email, a call, a website, someone they met), give real advice about THAT situation: what it looks like, the red flags and why they matter, and the safest next step. Don't talk about \"this call\" or report what you've heard on it.",
    "- No scam checker has scored their story, so speak as a teacher, not a judge: say it \"has the signs of a common gift card scam\", \"is a trick scammers use\" or \"sounds a lot like\" one, and explain why (for example: real companies never ask for gift cards; nobody legit asks you to read back a code; real support never rushes you or tells you to keep it secret). Don't state a verdict like \"that's a scam\", \"that's a classic scam\" or \"it's definitely fake\", never give a percentage, never say it's safe, and never say \"known scam pattern\".",
    "- Safe next steps you can suggest: stop replying; don't pay, buy gift cards or share codes; contact the company only through its official app, website or the number on their card or statement; if money, a card number or a code was shared, call the bank or card company on the number on the back of the card right away and ask them to block it; gift card companies sometimes freeze cards if called fast with the card number and receipt; report it at ReportFraud.ftc.gov.",
    "- If they ask whether this call or this line is safe, explain it's just the two of you right now, and that they can merge you into a call they're unsure about.",
  ].join("\n"),
  merged: [
    "Call type: LIVE CALL. You were merged into a phone call with someone else, who could be a scammer and can hear you.",
    "- Talk about \"this call\" only when they ask about it (\"is this real?\", \"should I hang up?\", \"what do you think of this guy?\"). If they ask about something else, like a text they got earlier, answer about that instead.",
    "- The risk level and red flags for this call come from a separate scam checker. You never decide on your own whether the call is a scam; use what you are given.",
    "- If the level is Likely scam or High risk scam: say \"This matches a known scam pattern\" once, in those words, name the red flags in plain words, and suggest hanging up and calling the company back on a number they trust. In later replies, refer back to it in fresh words (\"those are the same warning signs\", \"everything he's asking for fits that pattern\") without repeating the phrase. Never go beyond the checker with your own verdict, such as \"it's a scam, plain and simple\" or \"it's definitely fake\".",
    "- If the level is Not sure or Looks safe: don't call it a scam or safe, and don't tell them to hang up. In your own fresh words, say nothing alarming has come up so far and name one specific thing to watch for (a request for a code, password, gift cards, crypto, a payment, remote access, or pressure to rush or keep it secret). Never say \"known scam pattern\" at these levels.",
  ].join("\n"),
};

/** A turn asking for real advice (a story, or "what should I do / what if …"): may get a 4th sentence on a direct call. */
const wantsAdvice = (t: string) =>
  words(t) >= 15 || /\b(what (should|do|can) (i|we)|what if|should (i|we)|how (do|can|should) (i|we)|advice|tips|help me|what now|what next)\b/i.test(t);

const words = (t: string | undefined) => (t ?? "").match(/[\p{L}\p{N}']+/gu)?.length ?? 0;

/**
 * Direct (1-on-1) vs merged call, derived in code at each reply. Merged when there was real speech
 * before the first wake (more than a few hellos), when later speech not aimed at Bouncer piles up, or
 * when Jev's call scoring raised flags. Sticky once merged.
 */
export function callContext(s: CallSession): "direct" | "merged" {
  if (s.callContext === "merged" || s.firstWakeTurn < 0) return (s.callContext = "merged");
  let before = 0;
  let after = 0;
  for (let i = 0; i < s.turns.length; i++) {
    const t = s.turns[i];
    if (i < s.firstWakeTurn && !s.botTurns.has(i)) before += words(t);
    else if (i === s.firstWakeTurn) before += words(wakePrefix(t));
    else if (i > s.firstWakeTurn && !s.botTurns.has(i)) after += words(t);
  }
  const merged = before >= MERGED_PRE_WAKE_WORDS || after >= MERGED_LATER_WORDS || s.flags.size > 0 || atLeast(s.level, "likely_scam");
  const next = merged ? "merged" : "direct";
  if (next !== s.callContext) console.log(`[listen] conv=${short(s.conv)} call context → ${next} (pre-wake words=${before}, later=${after}, flags=${s.flags.size})`);
  return (s.callContext = next);
}

/** The part of a wake turn said before "Hey Bouncer" (on a merged call one turn can hold both speakers). */
function wakePrefix(t: string | undefined): string {
  if (!t) return "";
  if (NAME_FIRST.test(t)) return "";
  const m = WAKE.exec(t);
  return m ? t.slice(0, m.index) : "";
}

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
    const line = pick(SIGN_OFFS, s.lastSignOff, s);
    s.lastSignOff = line;
    return speak(s, idx, gen, line, t0);
  }

  const cue = wakeCue(text);
  // Ambiguous mention while silent ("did you see the bouncer?"): Jev breaks the tie within WAKE_WAIT_MS.
  const woke = cue === "wake" || (cue === "maybe" && s.mode !== "talking" && (await wakeTieBreak(s, idx, text, t0)));
  if (s.ended) return null;
  if (woke) {
    const gen = claimTurn(s, idx, text);
    if (gen === null) return skipTurnResponse();
    if (s.mode !== "talking") console.log(`[listen] conv=${short(s.conv)} turn=${idx} ${cue === "wake" ? "addressed by name" : "Jev: speaks to Bouncer"} → talking`);
    s.mode = "talking";
    if (s.firstWakeTurn < 0 || idx < s.firstWakeTurn) s.firstWakeTurn = idx;
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

/** Listening mode, the name mentioned ambiguously: is the speaker talking to Bouncer? Silent if Jev is slow or unsure. */
const wakeChecks = new WeakMap<CallSession, Map<number, { text: string; p: Promise<number | null> }>>();
async function wakeTieBreak(s: CallSession, idx: number, text: string, t0: number): Promise<boolean> {
  let m = wakeChecks.get(s);
  if (!m) wakeChecks.set(s, (m = new Map()));
  let entry = m.get(idx);
  if (!entry || entry.text !== text) {
    const p = askJev(lastTurnsState(s, idx), WAKE_QUESTION, { retries: 0, timeoutMs: 2500 })
      .then((r) => {
        const v = noul(r, "speaks_to_bouncer");
        console.log(`[listen] conv=${short(s.conv)} turn=${idx} speaks_to_bouncer=${v.toFixed(2)} jev=${r.ms}ms`);
        return v;
      })
      .catch((err: any) => {
        console.error(`[listen] wake check failed: ${err?.message}`);
        return null;
      });
    m.set(idx, (entry = { text, p }));
  }
  let timer: NodeJS.Timeout | undefined;
  const p = await Promise.race([
    entry.p,
    new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), Math.max(0, WAKE_WAIT_MS - (Date.now() - t0))))),
  ]);
  clearTimeout(timer);
  if (p === undefined) console.log(`[listen] conv=${short(s.conv)} turn=${idx} wake check slower than ${WAKE_WAIT_MS} ms → silent`);
  return typeof p === "number" && p >= WAKE_MIN;
}

/** A turn Bouncer answers out loud (wake or follow-up). */
async function answer(s: CallSession, idx: number, gen: number, text: string, t0: number): Promise<Response> {
  s.botTurns.add(idx);
  s.misses = 0;
  void checkAction(s, idx);
  const note = await recoveryNote(s, idx, text);
  return speak(s, idx, gen, reply(s, idx, note), t0);
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
  // 1-on-1 call: nobody else is on the line, so an unclear turn is most likely still for Bouncer.
  const direct = s.callContext === "direct";
  if (p === null) return direct ? "answer" : "skip";
  return p >= (direct ? ADDRESSED_MIN_DIRECT : ADDRESSED_MIN) ? "answer" : p < LEAVE_BELOW ? "leave" : "skip";
}

/** Calls where Flow 4 was already started (one checklist per call). */
const recoveryStarted = new WeakSet<CallSession>();

/**
 * Flow 4 trigger by voice ("Hey Bouncer, I already paid"): the checklist goes out by text only. The spoken
 * reply (still worded by the model) says so and may give the single most urgent step (SPEC Flow 4: "by voice
 * it gives one sentence and texts the rest"). Texting the user's own thread is not an action on their
 * behalf, so no YES is needed (rule 4). Returns a note for the reply prompt, or null.
 */
async function recoveryNote(s: CallSession, idx: number, text: string): Promise<string | null> {
  if (!saysAlreadyPaid(text)) return null;
  await s.identifying;
  if (!s.userId || s.userId === "unknown") {
    return "You can't text this caller. Tell them to text you what happened and you'll send step-by-step help, and give the one most urgent step now.";
  }
  if (!recoveryStarted.has(s)) {
    recoveryStarted.add(s);
    console.log(`[listen] conv=${short(s.conv)} turn=${idx} says already paid → Flow 4 by text`);
    void startRecovery({ userId: s.userId, text, source: "call" });
    return "You just texted them a step-by-step recovery checklist. Say so briefly, and give the one most urgent step out loud (no account details).";
  }
  return "You already texted them a recovery checklist earlier in this call. Point them to it in a few words and answer what they asked.";
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
            const f = pick(FILLERS, s.lastFiller, s);
            s.lastFiller = f;
            return f;
          },
    errorLine: pick(s.callContext === "direct" ? FALLBACK_DIRECT : FALLBACK_OTHER, lastReply(s, idx + 1), s),
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
  return recentReplies(s, beforeIdx, 1)[0] ?? null;
}

/** Bouncer's last `n` replies before user turn `beforeIdx`, oldest first. */
function recentReplies(s: CallSession, beforeIdx: number, n: number): string[] {
  return [...s.replies.keys()]
    .filter((k) => k < beforeIdx)
    .sort((a, b) => a - b)
    .slice(-n)
    .map((k) => s.replies.get(k)!);
}

/** First three words of a reply (filler aside), for the "don't open like this again" list. */
function opening(t: string): string {
  let x = t.trim();
  for (const f of FILLERS) if (x.startsWith(f.trim())) x = x.slice(f.trim().length).trim();
  return (x.match(/[\p{L}\p{N}']+/gu) ?? []).slice(0, 3).join(" ");
}

/**
 * The call as a labelled dialogue: call turns (speakers unknown), turns said to Bouncer, and Bouncer's
 * own earlier replies. Safe word redacted. Last `max` entries, oldest first.
 */
function dialogue(s: CallSession, idx: number, secret: string | null, max = 20): string[] {
  const out: string[] = [];
  const other = s.callContext === "direct" ? "On the line" : "On the call";
  for (let i = 0; i <= idx && i < s.turns.length; i++) {
    const t = s.turns[i]?.trim();
    if (t) out.push(`${s.botTurns.has(i) ? "User (to you)" : other}: ${redactSafeWord(t, secret)}`);
    const r = i < idx ? s.replies.get(i) : undefined;
    if (r) out.push(`You (Bouncer): ${redactSafeWord(r, secret)}`);
  }
  return out.slice(-max);
}

/**
 * Step 7: the fast model writes the spoken reply from the dialogue and the call context. On a merged
 * call it also gets Jev's level and flags (rule 3: Jev decides, the model only words it). On a direct
 * (1-on-1) call there is no call to judge: the model gives advice about what the user describes, as
 * education ("a trick scammers use"), never a verdict or a percentage. Reasoning stays off (latency).
 */
async function* reply(s: CallSession, idx: number, note: string | null = null): AsyncGenerator<string> {
  // Rule 2: the circle's safe word never reaches the model or the speaker. If it can't be loaded, the
  // model is not called (fail closed) and a fixed line with no call content is spoken instead.
  let secret: string | null = null;
  let ok = true;
  let ctx = callContext(s);
  try {
    // Only a merged call needs a fresh Jev level (the filler covers a short wait); a direct call has none to use.
    const [, ref] = await Promise.all([ctx === "merged" ? freshLevel(s) : Promise.resolve(), safeWordRef(s)]);
    secret = ref ? decryptWord(ref.enc, ref.circleId) : null;
  } catch (err: any) {
    console.error(`[listen] conv=${short(s.conv)} reply setup failed: ${err?.message}`);
    ok = false;
  }
  ctx = callContext(s);
  const prev = lastReply(s, idx);
  const scam = atLeast(s.level, "likely_scam");
  if (ok) {
    const recent = recentReplies(s, idx, 4).map((r) => redactSafeWord(r, secret));
    const openings = [...new Set(recent.map(opening).filter(Boolean))];
    const flags = [...s.flags].map((f) => FLAG_LABELS[f] ?? f);
    const prompt =
      (ctx === "direct"
        ? `Conversation so far, oldest first, on a one-on-one call with you. "User (to you)" lines were said to you. ` +
          `"On the line" lines are other things the user said (not to you). "You (Bouncer)" lines are what you already said out loud.\n\n`
        : `Conversation so far, oldest first. "On the call" lines are people on the phone call (the user and maybe the caller; ` +
          `speakers aren't labelled). "User (to you)" lines were said to you. "You (Bouncer)" lines are what you already said out loud.\n\n`) +
      `${dialogue(s, idx, secret).join("\n")}\n\n` +
      (ctx === "merged"
        ? `Risk level for this call from the scam checker: ${LEVEL_LABEL[s.level]}.\n` +
          `Red flags the checker heard on this call: ${flags.length ? flags.join("; ") : "none yet"}.\n` +
          (scam && s.scamType ? `Kind of scam: ${s.scamType.replace(/_/g, " ")}.\n` : "")
        : `No scam checker verdict applies here: explain and advise, don't judge.\n`) +
      (recent.length
        ? `\nYour recent replies, oldest first (word this one differently: new opening, no reused sentences or catchphrases):\n` +
          recent.map((r) => `- "${r}"`).join("\n") +
          `\n` +
          (openings.length ? `Don't start with any of: ${openings.map((o) => `"${o}"`).join(", ")}.\n` : "")
        : "") +
      (note ? `\nNote: ${note}\n` : "") +
      `\nReply out loud to the last "User (to you)" line now. If it's vague ("what do you think?", "can you pitch in?", "help"), ` +
      (ctx === "merged"
        ? `give your read on this call so far, based on the checker's level and red flags.`
        : `give your take on what they described and the safest next step; if they haven't described anything yet, ask what happened.`);
    let spoke = false;
    try {
      const pieces = generateStream({
        tier: "fast",
        system: `${SYSTEM}\n\n${CONTEXT_RULES[ctx]}`,
        parts: [{ text: prompt }],
        temperature: 0.8,
        // Variety comes mainly from the prompt (recent replies + banned openings). Higher penalties made
        // DeepSeek V4.1 Flash glue words together ("stopsyoufromchecking…", measured 2026-11-08): keep them low.
        presencePenalty: 0.2,
        frequencyPenalty: 0.1,
        reasoning: "off", // a caller is waiting: first token ~0.3–0.5 s with reasoning off
        maxOutputTokens: 200,
        timeoutMs: 8000,
        noFallback: true, // a dead tier would only add a second slow failure while the caller waits
      });
      // Spoken replies stop after 3 sentences (4 for advice on a direct call) even if the model runs long.
      const advice = ctx === "direct" && wantsAdvice(s.turns[idx] ?? "");
      const maxSentences = advice ? MAX_DIRECT_SENTENCES : MAX_SPOKEN_SENTENCES;
      // Also stop at the first sentence end past this many words (keeps a long-winded reply under ~60 words).
      const wordBudget = advice ? 50 : 40;
      let sentences = 0;
      let wordCount = 0;
      let prevChar = "";
      let pendingEnd = false;
      outer: for await (const piece of withoutGarble(withoutSafeWord(pieces, secret))) {
        const clean = piece.replace(/[*_#`]/g, "").replace(/\s*\n+\s*/g, " "); // speech: no paragraphs
        if (!clean) continue;
        let out = "";
        for (const ch of clean) {
          // A sentence ends at . ! ? followed by a space ("irs.gov" and "$4.35" don't end one; closing
          // quotes in between are fine). The space itself is not spoken when the reply stops there.
          if (pendingEnd && /\s/.test(ch)) {
            pendingEnd = false;
            if (++sentences >= maxSentences || wordCount + 1 >= wordBudget) {
              spoke = true;
              if (out) yield out;
              break outer;
            }
          } else if (pendingEnd && !/[.!?"'”’)]/.test(ch)) pendingEnd = false;
          if (/[.!?]/.test(ch) && !(ch === "." && /\d$/.test(prevChar))) pendingEnd = true;
          if (/\s/.test(ch) && prevChar && !/\s/.test(prevChar)) wordCount++;
          prevChar = ch;
          out += ch;
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
  yield note ? "I've sent the steps to your phone. Take a look when you can." : fallbackLine(s, prev, s.turns[idx] ?? "");
}

/** Glued-together words ("stopsyoufromchecking") or prompt artifacts: the model output is broken. */
const GARBLED = /[\p{L}]{25,}|fix wording/iu;
class GarbledOutput extends Error {}

/**
 * Passes text through whole words at a time and throws GarbledOutput on a broken word, so the caller
 * stops (or, if nothing was said yet, speaks a fixed fallback line). Holds back at most one partial word.
 */
export async function* withoutGarble(source: AsyncIterable<string>): AsyncGenerator<string> {
  let buf = "";
  for await (const piece of source) {
    buf += piece;
    const cut = buf.search(/\s\S*$/);
    if (cut < 0) {
      if (GARBLED.test(buf)) throw new GarbledOutput("garbled model output");
      continue;
    }
    const ready = buf.slice(0, cut + 1);
    buf = buf.slice(cut + 1);
    if (GARBLED.test(ready)) throw new GarbledOutput("garbled model output");
    if (ready) yield ready;
  }
  if (GARBLED.test(buf)) throw new GarbledOutput("garbled model output");
  if (buf) yield buf;
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
  return line === prev ? pick(s.callContext === "direct" ? FALLBACK_DIRECT : FALLBACK_OTHER, prev, s) : line;
}

function fallbackFor(s: CallSession, prev: string | null, asked: string): string {
  const direct = s.callContext === "direct";
  if (!direct && atLeast(s.level, "likely_scam")) {
    const names = [...s.flags].filter((f) => FLAG_LABELS[f] && !(f === "money_or_code" && s.flags.has("asks_code")));
    const flags = names.slice(0, 2).map((f) => FLAG_LABELS[f]);
    if (flags.length) {
      const why = `This matches a known scam pattern: the caller ${flags.join(", and ")}.`;
      const lines = [`${why} I'd hang up and call back on a number you trust.`, `${why} Please don't share anything; just hang up.`];
      return pick(lines, prev, s);
    }
    return pick(FALLBACK_SCAM, prev, s);
  }
  // A few common questions still get a real (fixed) answer; everything else gets a short apology.
  if (/\b(what (do|can) you do|what you do|who are you|what are you|how do(es)? (this|it|you) work)\b/i.test(asked))
    return "You can call me for scam advice, or merge me into a call and I'll listen quietly and text you if I hear warning signs. Say Hey Bouncer to talk to me, and Thanks Bouncer when you're done.";
  if (/\b(how are (you|ya)|what'?s up|how'?s it going|how you doing|you there)\b/i.test(asked))
    return pick(
      direct
        ? ["I'm here and doing well. What's on your mind?", "Doing fine, thanks for asking. How can I help?"]
        : ["I'm here and doing fine. Nothing alarming has come up on this call so far.", "All good on my end, and nothing worrying so far."],
      prev,
      s,
    );
  if (/\b(watch (out )?for|look out for|red flags?|warning signs?|what should i (do|say|look))\b/i.test(asked))
    return "Watch for anyone asking for a code, a password, gift cards, crypto or a payment, or rushing you or asking you to keep it secret. If that happens, hang up.";
  return pick(direct ? FALLBACK_DIRECT : FALLBACK_OTHER, prev, s);
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
      const circle = await getCircleForUser(s.userId);
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
  const direct = s.callContext === "direct";
  return {
    note:
      (direct
        ? "Phone call where the user called the assistant Bouncer one-on-one (no other caller on the line). "
        : "Live phone call, possibly with another caller on the line. ") +
      "'On the call'/'On the line' lines are other speech (speakers not labeled). Bouncer is an AI assistant " +
      "on the call; 'User (to Bouncer)' lines were said to it and 'Bouncer' lines are its spoken replies.",
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
