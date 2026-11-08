// Wording for call texts (SPEC Flow 2 steps 6 and 10): the post-call summary and the in-call alert lines.
// Rule 3: Jev decided the level, confidence, scam type and flags; the model only words them. Code writes the
// verdict line, checks the model's words never contradict it, and falls back to templates on any doubt.
// Rule 1: the transcript is in memory only, goes to the model provider (as talk replies already do), and is
// never logged or stored. Rule 2: the family safe word is redacted before the model sees anything; if it
// can't be loaded we don't call the model at all (fail closed).
import { generate, generateJson } from "../detection/gemini.js";
import { LEVEL_LABEL, atLeast, type RiskLevel } from "../detection/risk.js";
import { FLAG_LABELS, SCAM_TYPES } from "../detection/questions.js";
import { getCircleForProtected, getSafeWordRow } from "../family/circle.js";
import { decryptWord } from "../family/crypto.js";
import { redactSafeWord } from "./talk.js";
import { scrubModelText } from "../photon/links.js";

/** Total length cap for the post-call text (header + body + question). */
export const SUMMARY_MAX_CHARS = 900;
export const FEEDBACK_QUESTION = "Was it a scam? Reply YES or NO.";
export const NO_SIGNS_TEXT = "Call ended. I didn't hear any scam signs.";
/** Wording only: reasoning on, since the call is over and nobody is waiting on the line. */
const SUMMARY_TIMEOUT_MS = 20_000;
/** In-call alert wording: reasoning off, short budget, then the fixed lines. */
export const ALERT_TIMEOUT_MS = Number(process.env.CALL_ALERT_WORDING_MS) || 2500;

/** Fewer characters of call speech than this: template, not the model (nothing specific to say). */
const MIN_CALL_CHARS = 80;

/** Flags that mean the caller asked for something the user might already have handed over. */
const CONCRETE_ASKS = ["asks_code", "money_or_code", "remote_access"];

// ---- Safe word ----------------------------------------------------------------------------------

/** The plain safe word of the user's circle (never logged), or null if they have none. Throws on DB errors. */
export async function loadSafeWord(userId: string): Promise<string | null> {
  const circle = await getCircleForProtected(userId);
  const enc = circle ? await getSafeWordRow(circle.id) : null;
  return enc && circle ? decryptWord(enc, circle.id) : null;
}

const leaksWord = (text: string, secret: string | null) => !!secret && redactSafeWord(text, secret) !== text;

// ---- Consistency checks (rule 3) ----------------------------------------------------------------

/** Calls it a scam. Not allowed below likely_scam. */
const SCAM_CLAIM =
  /\b(?:was|is|be|looks? like|looked like|sounds? like|sounded like|seems? like|seemed like|definitely|clearly|probably)\s+(?:a\s+|an\s+)?(?:likely\s+|real\s+|classic\s+|known\s+)?(?:scam|fraud|fake|con)\b|\bscam\s+call\b|\bthe\s+scammers?\b|\blikely\s+scam\b|\bhigh[- ]risk\b|\bknown\s+scam\s+pattern\b|\bthis\s+scam\b/i;
/** Calls it safe or real. Not allowed at likely_scam or above, nor at unsure. */
const SAFE_CLAIM =
  /(?<!\b(?:if|whether|unless)\s)\b(?:the call|this call|that call|it|this|that|the caller|they)\s+(?:was|is|were|are|seems?|seemed|looks?|looked|sounds?|sounded)\s+(?:\w+\s+)?(?:safe|legit|legitimate|genuine|real|fine|harmless|normal|okay)\b|\bnot\s+a\s+scam\b|\bwasn'?t\s+a\s+scam\b|\bno\s+scam\b|\bnothing\s+to\s+worry\b/i;
/** Never, at any level (CLAUDE.md). */
const NEVER = /\b100\s?%|\bguarantee/i;

/** Why the text contradicts Jev's level, or null when it doesn't. Exported for tests. */
export function contradiction(text: string, level: RiskLevel): string | null {
  if (NEVER.test(text)) return "absolute claim";
  if (!atLeast(level, "likely_scam") && SCAM_CLAIM.test(text)) return `calls it a scam at level ${level}`;
  if (level !== "safe" && SAFE_CLAIM.test(text)) return `calls it safe at level ${level}`;
  return null;
}

/**
 * Broken output: words run together ("stopsyoufromchecking"), notes to itself, or leftover placeholders.
 * Links and e-mail-like strings are skipped (the model shouldn't write them, but they aren't garbled).
 */
export function garbled(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => !/[/@]|\.(com|org|gov|net|us)\b/i.test(w));
  if (words.some((w) => w.replace(/[^\p{L}]/gu, "").length > 22)) return true;
  if (/[a-z][.!?,;:][A-Za-z]{2,}/.test(words.join(" ").replace(/\b(?:e\.g|i\.e|a\.m|p\.m|dr|mr|mrs|ms|st)\./gi, ""))) return true;
  return /\b(fix wording|rewrite|draft|paragraph \d|placeholder|as an ai)\b|\{\{|\[(?:name|brand|company)\]/i.test(text);
}

/** Strips markdown the model sometimes adds; iMessage shows it literally. */
function plain(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[*•]\s+/gm, "- ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- Post-call summary --------------------------------------------------------------------------

export interface SummaryFacts {
  level: RiskLevel;
  p: number;
  scamType: string | null;
  /** Flags texted about during the call (also the events row's flags). */
  alerted: string[];
  /** Every flag that crossed 0.7 at some point. */
  crossed: string[];
  /** Latest Jev probabilities (numbers only). */
  probs: Record<string, number>;
  /** The alert texts Bouncer sent during this call, in order. */
  alertsSent: string[];
  durationS: number;
  /** The user talked with Bouncer ("Hey Bouncer") on this call. */
  talkUsed: boolean;
  /** Ask the feedback question (only when the pending slot was free and there were red flags). */
  askFeedback: boolean;
}

export interface CallDialogue {
  turns: string[];
  /** Turn indexes spoken to Bouncer. */
  botTurns: Set<number>;
  /** Turn index → what Bouncer said back out loud. */
  replies: Map<number, string>;
}

export interface SummaryResult {
  text: string;
  source: "model" | "template";
  /** Why the model's text wasn't used (no content: reason codes only). */
  reason?: string;
  ms: number;
}

/** Jev's confidence as a percent, never 0 or 100 ("100% safe" is never said). */
const confidence = (f: SummaryFacts) => Math.min(99, Math.max(1, Math.round((f.level === "safe" ? 1 - f.p : f.p) * 100)));

/** Verdict line, written by code from Jev's numbers (rule 3). */
export function verdictLine(f: SummaryFacts): string {
  const c = confidence(f);
  const label = LEVEL_LABEL[f.level];
  if (f.level === "unsure") return `📞 Call summary: ${label} (${c}% chance it was a scam).`;
  if (f.level === "safe") return `📞 Call summary: ${label} (${c}% sure).`;
  return `📞 Call summary: ⚠️ ${label} (${c}% sure).`;
}

/** "45-second" / "3-minute", to read before "call". */
function duration(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))}-second`;
  return `${Math.round(s / 60)}-minute`;
}

/** Red flags to talk about: everything that crossed, highest probability first. */
function summaryFlags(f: SummaryFacts): string[] {
  const all = [...new Set([...f.alerted, ...f.crossed])].filter((x) => FLAG_LABELS[x]);
  return all.sort((a, b) => (f.probs[b] ?? 0.7) - (f.probs[a] ?? 0.7));
}

/** The call as labelled lines, safe word redacted, newest last, capped in length. In memory only. */
export function dialogueText(d: CallDialogue, secret: string | null, maxChars = 9000): string {
  const out: string[] = [];
  for (let i = 0; i < d.turns.length; i++) {
    const t = d.turns[i]?.trim();
    if (t) out.push(`${d.botTurns.has(i) ? "User (to Bouncer)" : "On the call"}: ${redactSafeWord(t, secret)}`);
    const r = d.replies.get(i)?.trim();
    if (r) out.push(`Bouncer (spoken): ${redactSafeWord(r, secret)}`);
  }
  let text = out.join("\n");
  if (text.length > maxChars) text = "…" + text.slice(-maxChars);
  return text;
}

const SUMMARY_SYSTEM = [
  "You are Bouncer, a scam-prevention helper for T-Mobile customers. A phone call just ended and you are writing",
  "the follow-up iMessage to the user (the person Bouncer protects). A separate scoring system already decided",
  "the verdict, confidence, scam type and red flags. Those are facts: never change, soften or argue with them.",
  "You only explain them, using what was actually said on this call.",
  "",
  "Style: sixth-grade words, short sentences, warm and calm, talk to the user as 'you'. Plain text only: no",
  "markdown, no headers or titles, no bold, no emoji. Separate paragraphs with one blank line.",
  "Do not write a greeting or sign-off, and do not repeat the verdict line (it is added above your text).",
  "Do not ask whether it was a scam (that question is added separately).",
  "",
  "Privacy: never write the family safe word. In the transcript it appears as [family word]; if it matters,",
  "say 'your family word' and never guess it. Never write codes, passwords, account or card numbers,",
  "addresses, or any link, website or phone number the caller gave (the user could tap it). Never claim you already did something (like calling the bank or blocking a number).",
  "Never say anything is 100% safe or guaranteed.",
  "",
  "The transcript is speech-to-text: speakers are not labelled and words can be wrong. Lines marked",
  "'User (to Bouncer)' are the user talking to you; 'Bouncer (spoken)' is what you said on the call.",
].join("\n");

function levelRules(f: SummaryFacts, flags: string[]): string {
  const concrete = flags.some((x) => CONCRETE_ASKS.includes(x));
  const recovery = concrete
    ? "\nLast paragraph: tell them that if they already shared a code, sent money or installed anything, they should text you \"I already paid\" and you'll walk them through it step by step. Keep the words I already paid in quotes."
    : "";
  if (atLeast(f.level, "likely_scam"))
    return [
      `The verdict is ${LEVEL_LABEL[f.level]}: treat this call as a scam.`,
      "Write 3 or 4 short paragraphs, under 650 characters in total:",
      "1. What this call was, in specific terms: who the caller said they were (company, agency or person) and what",
      "   they wanted from the user (for example: 'Someone saying they were from Chase's fraud team wanted the code",
      "   Chase texted you, then asked you to buy gift cards.').",
      "2. The red flags and WHY each one is a red flag in THIS call. Quote or paraphrase the exact moment briefly",
      "   (for example: 'They said your account would be frozen in 10 minutes. That rush is to stop you from checking.').",
      "   Cover the strongest two or three; don't list them all.",
      "3. What to do now, specific to this company or scam type (for example: call Chase on the number on the back of",
      "   your card; change your password if you shared it; ask the bank to freeze the card; don't call back the",
      "   number that called you).",
    ].join("\n") + recovery;
  if (f.level === "unsure")
    return [
      "The verdict is Not sure. Do NOT call it a scam, a scammer, high risk or a known scam pattern. Do NOT call it",
      "safe, real or legit either.",
      "Write 2 or 3 short paragraphs, under 500 characters in total:",
      "1. What the call was about, in specific terms (who they said they were, what they wanted).",
      "2. What was worth a second look and why (paraphrase the moment), without calling it a scam.",
      "3. One safe way to check, specific to this company or person (for example: call them back on the number on",
      "   their official website or your card, not the number that called you).",
    ].join("\n") + recovery;
  return [
    "The verdict is Looks safe, but one or more warning signs came up. Do NOT call it a scam or a scammer, and",
    "don't say it was 100% safe.",
    "Write 2 short paragraphs, under 450 characters in total: what the call was about in specific terms, then the",
    "one thing worth double-checking and a safe way to check it.",
  ].join("\n") + recovery;
}

function factsBlock(f: SummaryFacts, flags: string[]): string {
  const lines = [
    `Verdict: ${LEVEL_LABEL[f.level]} (${confidence(f)}% ${f.level === "unsure" ? "chance it was a scam" : "sure"})`,
    `Kind of scam: ${f.scamType && f.level !== "safe" ? SCAM_TYPES[f.scamType] ?? f.scamType : "none decided"}`,
    `Red flags found (strongest first): ${
      flags.length ? flags.map((x) => `${FLAG_LABELS[x]} (${Math.round((f.probs[x] ?? 0.7) * 100)}%)`).join("; ") : "none"
    }`,
    `Warnings you texted during the call: ${f.alertsSent.length ? f.alertsSent.map((a) => `"${a}"`).join(" | ") : "none"}`,
    `Call length: ${duration(f.durationS).replace("-", " ")}s`,
    `The user talked to you during the call: ${f.talkUsed ? "yes" : "no"}`,
  ];
  return lines.join("\n");
}

/**
 * The whole post-call text: code-written verdict line, model-written explanation (or the template), and the
 * feedback question when asked. Never throws.
 */
export async function writeCallSummary(f: SummaryFacts, d: CallDialogue, userId: string): Promise<SummaryResult> {
  const t0 = Date.now();
  const flags = summaryFlags(f);
  const warm = f.level === "safe" && flags.length === 0;
  const done = (text: string, source: SummaryResult["source"], reason?: string): SummaryResult => ({
    text,
    source,
    reason,
    ms: Date.now() - t0,
  });
  const template = (reason: string) => done(warm ? NO_SIGNS_TEXT : templateSummary(f), "template", reason);

  let secret: string | null;
  try {
    secret = await loadSafeWord(userId);
  } catch {
    return template("safe word unavailable"); // fail closed: the model never sees an unredacted call
  }
  const transcript = dialogueText(d, secret);
  if (!transcript.trim()) return template("empty transcript");
  // Too little said to be specific about: the model would invent a story (seen on a "hello"-only call).
  const said = d.turns.filter((t, i) => t?.trim() && !d.botTurns.has(i)).join(" ");
  if (said.length < MIN_CALL_CHARS && d.botTurns.size === 0) return template("call too short to describe");

  try {
    if (warm) {
      const raw = await generate({
        tier: "quality",
        system: SUMMARY_SYSTEM,
        parts: [
          {
            text:
              `${factsBlock(f, flags)}\n\n` +
              "The verdict is Looks safe and no warning signs came up. Write ONE or TWO short sentences, under 220\n" +
              "characters, starting with 'Call ended.' Be warm and specific: name what the call was about if it's\n" +
              "harmless (for example 'your call with the pharmacy about the refill'). If the user talked to you, refer\n" +
              "to that exact advice (for example 'Hope my tip about that Amazon text helped.'). You may say you didn't\n" +
              "hear scam signs; never call it 100% safe. Don't call anything a scam. No question.\n\n" +
              `Call transcript:\n${transcript}`,
          },
        ],
        temperature: 0.8,
        presencePenalty: 0.2,
        frequencyPenalty: 0.1,
        reasoning: "low",
        maxOutputTokens: 200,
        timeoutMs: SUMMARY_TIMEOUT_MS,
      });
      const body = scrubModelText(plain(raw).replace(/\n+/g, " "));
      const bad =
        body.length < 15
          ? "too short"
          : body.length > 300
            ? "too long"
            : garbled(body)
              ? "garbled"
              : contradiction(body, "safe") ?? (leaksWord(body, secret) ? "safe word" : null);
      return bad ? template(bad) : done(body, "model");
    }

    const raw = await generate({
      tier: "quality",
      system: SUMMARY_SYSTEM,
      parts: [{ text: `Facts (decided, do not change):\n${factsBlock(f, flags)}\n\n${levelRules(f, flags)}\n\nCall transcript:\n${transcript}` }],
      temperature: 0.8,
      // Measured: 0.5 / 0.3 glued words together ("stopsyoufromchecking"); spaces are tokens too.
      presencePenalty: 0.2,
      frequencyPenalty: 0.1,
      reasoning: "medium",
      // openrouter.ts adds 2000 for the hidden reasoning; 500 still ran out ("length") on a long call.
      maxOutputTokens: 1200,
      timeoutMs: SUMMARY_TIMEOUT_MS,
    });
    const head = verdictLine(f);
    const tail = f.askFeedback ? FEEDBACK_QUESTION : "";
    let body = scrubModelText(plain(raw))
      .split("\n")
      .filter((l) => !/was it a scam\?|reply yes or no/i.test(l) && !/^\W*call summary\b/i.test(l))
      .join("\n")
      .trim();
    if (body.length < 80) return template("too short");
    const bad = garbled(body) ? "garbled" : contradiction(body, f.level) ?? (leaksWord(body, secret) ? "safe word" : null);
    if (bad) return template(bad);

    // Recovery pointer is required when the caller asked for a code, money or access: add it if missing.
    if (flags.some((x) => CONCRETE_ASKS.includes(x)) && !/already paid/i.test(body)) body += `\n\n${RECOVERY_LINE}`;

    const budget = SUMMARY_MAX_CHARS - head.length - (tail ? tail.length + 2 : 0) - 2;
    body = fitParagraphs(body, budget);
    if (!body) return template("too long");
    return done([head, body, tail].filter(Boolean).join("\n\n"), "model");
  } catch (err: any) {
    // Error text never contains the transcript (openrouter.ts / gemini.ts log status codes only).
    return template(`model failed: ${String(err?.message ?? err).slice(0, 80)}`);
  }
}

const RECOVERY_LINE = `If you already shared a code, sent money or installed anything, text me "I already paid" and I'll walk you through it.`;

/** Drops whole paragraphs from the end (keeping the recovery line if present) until it fits; "" if it can't. */
function fitParagraphs(body: string, budget: number): string {
  if (body.length <= budget) return body;
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const recovery = paras.findIndex((p) => /already paid/i.test(p));
  const keep = recovery >= 0 ? paras.splice(recovery, 1)[0] : null;
  while (paras.length > 2) {
    paras.pop();
    const text = [...paras, ...(keep ? [keep] : [])].join("\n\n");
    if (text.length <= budget) return text;
  }
  return "";
}

// ---- Template fallback (rule 3: built from Jev's flags only, no call content) --------------------

const FLAG_WHY: Record<string, string> = {
  asks_code: "They asked for a code, password or PIN. Real companies never ask you to read one out, and that code is the key to your account.",
  money_or_code: "They wanted money, gift cards, crypto or a code. Real companies and agencies don't take payment that way, and it can't be undone.",
  remote_access: "They wanted you to install an app or let them into your device. That would let them see your bank and passwords.",
  impersonation: "They said they were from a company, an agency or your family. Names and caller ID are easy to fake.",
  urgency_secrecy: "They rushed you or told you to keep it quiet. Pressure is how scammers stop you from checking.",
  family_danger: "They said someone in your family was in trouble. Fear is used to make you act before you check.",
};

/** Scam type as a short phrase for the template ("It looks like …"). */
const SCAM_KIND: Record<string, string> = {
  bank_or_card: "a fake bank or card fraud call",
  government: "a fake government agency call",
  tech_support: "a fake tech support call",
  family_emergency: "a fake family emergency",
  toll_or_delivery: "a fake toll or delivery problem",
  crypto: "a crypto scam",
  job_or_prize: "a fake prize, refund or job offer",
  marketplace: "a marketplace scam",
  romance_or_investment: "a romance or investment scam",
};

const NEXT_STEP: Record<string, string> = {
  bank_or_card: "Call your bank on the number on the back of your card and ask them to check for new charges. Don't call back the number that called you.",
  government: "Real agencies send letters first and never take gift cards or crypto. If you're worried, look up the agency's number yourself.",
  tech_support: "Don't let anyone into your computer or phone. If you installed something, delete it and change your passwords from another device.",
  family_emergency: "Call your family member on the number you already have for them, or ask for your family word.",
  toll_or_delivery: "Check your account in the official app or website, not with a number or link the caller gave you.",
  crypto: "Don't send crypto to anyone who called you. Check your account in the official app only.",
  job_or_prize: "Real prizes and jobs never ask you to pay first. Don't send anything.",
  marketplace: "Only pay or get paid inside the marketplace app. Don't ship or refund anything they pushed for.",
  romance_or_investment: "Don't send money to someone you only know from calls or texts, even if they seem kind.",
  other: "If you're unsure, call the company back on a number you look up yourself.",
};

/** Richer than the old one-liner: verdict, call length, why each red flag matters, a next step, recovery. */
export function templateSummary(f: SummaryFacts): string {
  const flags = summaryFlags(f);
  const parts = [verdictLine(f)];
  const kind = f.scamType && atLeast(f.level, "likely_scam") ? SCAM_KIND[f.scamType] : null;
  const intro = atLeast(f.level, "likely_scam")
    ? `On this ${duration(f.durationS)} call, I heard ${flags.length === 1 ? "a red flag" : `${flags.length} red flags`}${kind ? `. It looks like ${kind}` : ""}.`
    : `On this ${duration(f.durationS)} call, ${flags.length === 1 ? "one thing was" : "a few things were"} worth a second look.`;
  const why = flags.slice(0, 3).map((x) => `- ${FLAG_WHY[x] ?? FLAG_LABELS[x]}`);
  parts.push(flags.length ? `${intro}\n${why.join("\n")}` : intro);
  const step = atLeast(f.level, "likely_scam") ? NEXT_STEP[f.scamType ?? "other"] ?? NEXT_STEP.other : NEXT_STEP.other;
  parts.push(`What to do now: ${step}`);
  if (flags.some((x) => CONCRETE_ASKS.includes(x))) parts.push(RECOVERY_LINE);
  if (f.askFeedback) parts.push(FEEDBACK_QUESTION);
  let text = parts.join("\n\n");
  // Stay under the cap: drop the third reason, then the second.
  while (text.length > SUMMARY_MAX_CHARS && why.length > 1) {
    why.pop();
    parts[1] = `${intro}\n${why.join("\n")}`;
    text = parts.join("\n\n");
  }
  return text;
}

// ---- In-call alerts (score.ts) ------------------------------------------------------------------

/** What each flag's alert should focus on (the model writes the words). */
const ALERT_FOCUS: Record<string, string> = {
  asks_code: "the caller wants a one-time code, password or PIN. Action: don't read it out, hang up.",
  remote_access: "the caller wants them to install an app or give access to their phone or computer. Action: don't install anything, hang up.",
  money_or_code: "the caller wants money, gift cards, crypto, a transfer or a code. Action: don't pay or buy anything, hang up.",
  impersonation:
    "the caller claims to be a company, agency or person they may not be. Action: hang up and call back on a number you trust (the card, the official website).",
  level: "the call as a whole matches a known scam pattern. Action: hang up and call the company on a number you trust.",
};

const ACTION = /\b(hang up|hanging up|don'?t|do not|never|call (?:them |it |\w+ )?back|stop)\b/i;
const ALERT_PREFIX = /^[\s⚠️❗🚨!]*(?:(?:likely scam|high risk(?: scam)?|warning|alert|scam alert)\s*[:\-–—!]\s*)?/iu;
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const tooSimilar = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.split(" ").slice(0, 6).join(" ") === y.split(" ").slice(0, 6).join(" ");
};

export const alertPrefix = (level: RiskLevel) => (level === "high_risk" ? "⚠️ High risk:" : "⚠️ Likely scam:");

/**
 * One alert body per key (flag names and/or "level"), written in ONE fast call (reasoning off). The prefix
 * comes from Jev's level, in code. Keys whose wording fails a check are missing from the result: the caller
 * uses its fixed line for them. Never throws.
 */
export async function writeAlertLines(args: {
  keys: string[];
  level: RiskLevel;
  transcript: string;
  previous: string[];
  secret: string | null;
  timeoutMs?: number;
}): Promise<{ lines: Record<string, string>; ms: number; reason?: string }> {
  const t0 = Date.now();
  const { keys, level, previous, secret } = args;
  if (!keys.length) return { lines: {}, ms: 0 };
  const label = level === "high_risk" ? "High risk" : "Likely scam";
  try {
    const out = await generateJson<Record<string, string>>({
      tier: "fast",
      noFallback: true,
      reasoning: "off",
      temperature: 0.8,
      presencePenalty: 0.2,
      frequencyPenalty: 0.1,
      maxOutputTokens: 120 * keys.length,
      timeoutMs: args.timeoutMs ?? ALERT_TIMEOUT_MS,
      system:
        "You write short iMessage warnings that Bouncer texts to a person WHILE they are still on a phone call. " +
        `A scoring system already decided this call is "${label}"; you only write the words and never change that. ` +
        "For each key, write one or two short sentences, under 170 characters, sixth-grade words: name what the caller " +
        "actually asked for or claimed, in specific terms from this call (for example 'They want the 6-digit code Chase " +
        "just texted you.' or 'Nobody from the IRS takes Apple gift cards.'), say in a few words why that's dangerous, " +
        "and END with one clear action (hang up / don't read the code / don't install anything / don't buy the cards). " +
        "Each key's text must make a DIFFERENT point from the other keys and from the earlier warnings: if two keys " +
        "would say the same thing (for example the code ask and the money ask when only a code was asked for), make " +
        "the second one about what the caller would do with it next or what to do right after hanging up. Do not start with a label, " +
        "'Warning' or an emoji; the app adds '⚠️ Likely scam:' itself. Never write a family safe word or [family word], " +
        "codes, passwords, account or card numbers, links, web addresses or phone numbers the caller gave. Never call the call safe or real. The transcript is speech-to-text " +
        "with no speaker labels.",
      parts: [
        {
          text:
            `Keys to write, with what each one is about:\n${keys.map((k) => `- ${k}: ${ALERT_FOCUS[k] ?? FLAG_LABELS[k] ?? k}`).join("\n")}\n\n` +
            `Earlier warnings already texted on this call (say something new):\n${previous.length ? previous.map((p) => `- ${p}`).join("\n") : "- none"}\n\n` +
            `Call transcript so far:\n${redactSafeWord(args.transcript, secret).slice(-5000)}`,
        },
      ],
      jsonSchema: {
        type: "object",
        properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
        required: keys,
      },
    });
    const lines: Record<string, string> = {};
    const seen = [...previous];
    for (const k of keys) {
      const body = scrubModelText(plain(String(out?.[k] ?? ""))).replace(/\s*\n+\s*/g, " ").replace(ALERT_PREFIX, "").trim();
      if (body.length < 20 || body.length > 220) continue;
      if (!ACTION.test(body) || garbled(body) || contradiction(body, level) || leaksWord(body, secret)) continue;
      if (/\[family word\]|\bfamily word\b/i.test(body)) continue;
      const line = `${alertPrefix(level)} ${body.charAt(0).toUpperCase()}${body.slice(1)}${/[.!?]$/.test(body) ? "" : "."}`;
      if (seen.some((p) => tooSimilar(p, line))) continue;
      seen.push(line);
      lines[k] = line;
    }
    return { lines, ms: Date.now() - t0, reason: Object.keys(lines).length < keys.length ? "some lines failed checks" : undefined };
  } catch (err: any) {
    return { lines: {}, ms: Date.now() - t0, reason: `model failed: ${String(err?.message ?? err).slice(0, 80)}` };
  }
}
