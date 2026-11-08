// SPEC Flow 1 step 9: Gemini words the reply; the verdict and confidence come from code (rule 3).
// Three lines: verdict + confidence, up to three red flags, one safe next step.
import { generateJson, generate } from "./gemini.js";
import { FLAG_LABELS, SCAM_TYPES } from "./questions.js";
import { LEVEL_LABEL, type RiskLevel } from "./risk.js";
import type { ScanResult } from "./scan.js";

const EMOJI: Record<RiskLevel, string> = { safe: "✅", unsure: "🤔", likely_scam: "⚠️", high_risk: "⚠️" };

const SYSTEM =
  "You are Bouncer, T-Mobile's scam helper. Plain words, sixth-grade reading level. " +
  "Line 1: the verdict and confidence. Line 2: up to three red flags. Line 3: one safe next step. " +
  "Never call anything 100% safe. For Unsure, say how to check through the company's official app or number. " +
  "You do not decide the verdict: use exactly the verdict and confidence you are given.";

const SCHEMA = {
  type: "object",
  properties: {
    line1: { type: "string", description: "Starts with the given verdict prefix, then one short instruction (max 8 words)" },
    line2: { type: "string", description: "Up to 3 red flags specific to this message, under 20 words total. Empty string if none." },
    line3: { type: "string", description: "One safe next step, one sentence" },
  },
  required: ["line1", "line2", "line3"],
};

/** Highest-probability flags first, at most three. */
export function topFlags(scan: ScanResult, n = 3): string[] {
  return [...scan.flags].sort((a, b) => (scan.probs[b] ?? 0) - (scan.probs[a] ?? 0)).slice(0, n);
}

export const verdictPrefix = (scan: ScanResult) =>
  scan.risk.level === "unsure"
    ? `${EMOJI.unsure} ${LEVEL_LABEL.unsure} (${scan.risk.confidence}% chance it's a scam).`
    : `${EMOJI[scan.risk.level]} ${LEVEL_LABEL[scan.risk.level]} (${scan.risk.confidence}% sure).`;

/** Reply used when Gemini is slow or down, and as the shape Gemini is asked to match. */
export function templateReply(scan: ScanResult, claimedBrand?: string | null): string[] {
  const prefix = verdictPrefix(scan);
  const flags = topFlags(scan).map((f) => FLAG_LABELS[f] ?? f);
  const where = claimedBrand ? `${claimedBrand}'s official app or the number on your card or bill` : "the company's official app or website";
  switch (scan.risk.level) {
    case "high_risk":
      return [`${prefix} Don't tap links or reply.`, flags.length ? `Red flags: ${flags.join("; ")}.` : "", `If you're worried, check through ${where}. Then delete the message.`];
    case "likely_scam":
      return [`${prefix} Don't tap links or reply.`, flags.length ? `Red flags: ${flags.join("; ")}.` : "", `Check through ${where} instead of the message.`];
    case "unsure":
      return [`${prefix} Be careful with this one.`, flags.length ? `Watch out: ${flags.join("; ")}.` : "", `Don't use the links or numbers in it. Check through ${where}.`];
    default:
      return [`${prefix} I didn't spot scam signs.`, "", claimedBrand ? `If it ever asks you to pay or log in, use ${where} instead.` : "If it ever asks for money or a code, check with the sender another way first."];
  }
}

/**
 * Gemini wording (fast tier, ~0.6 s) with the code-made verdict prefix enforced; falls back to the
 * template on any error. `body` is the message, in memory only, so the wording can be specific.
 */
export async function writeVerdictReply(scan: ScanResult, body: string, claimedBrand?: string | null): Promise<string[]> {
  const prefix = verdictPrefix(scan);
  const fallback = templateReply(scan, claimedBrand);
  const flags = topFlags(scan).map((f) => FLAG_LABELS[f] ?? f);
  if (scan.risk.level === "safe") return fallback; // nothing for Gemini to add, and it tends to over-reassure
  try {
    const out = await generateJson<{ line1: string; line2: string; line3: string }>({
      tier: "fast",
      system: SYSTEM,
      parts: [
        {
          text: JSON.stringify({
            verdict_prefix: prefix,
            level: LEVEL_LABEL[scan.risk.level],
            confidence_percent: scan.risk.confidence,
            scam_type: scan.scamType ? SCAM_TYPES[scan.scamType] ?? scan.scamType : null,
            red_flags: flags,
            claimed_brand: claimedBrand ?? null,
            message: body.slice(0, 2000),
          }),
        },
      ],
      jsonSchema: SCHEMA,
      temperature: 0.3,
      timeoutMs: 3_000,
    });
    let line1 = (out.line1 ?? "").trim();
    // The verdict is ours: if Gemini changed or dropped it, put the exact prefix back.
    if (!line1.startsWith(prefix)) line1 = `${prefix} ${line1.replace(/^.*?\(\d+%[^)]*\)\.?\s*/, "")}`.trim();
    const lines = [line1, (out.line2 ?? "").trim(), (out.line3 ?? "").trim()];
    if (lines.some((l) => /100\s?% (safe|sure)/i.test(l)) || !lines[2]) return fallback;
    return lines;
  } catch (err: any) {
    console.warn(`[reply] Gemini wording failed, using template: ${err?.message}`);
    return fallback;
  }
}

const QUESTION_SYSTEM =
  "You are Bouncer, T-Mobile's scam helper on iMessage. Plain words, sixth-grade reading level, at most 3 short sentences. " +
  "You help people check texts, DMs, screenshots and calls for scams. Users can send you a screenshot or paste a message " +
  "to check, or call your number and say 'Hey Bouncer'. Never call anything 100% safe. If you aren't sure, say to check " +
  "through the company's official app or number. Don't make up features.";

/** Flow 1 step 4 `question`: a general question gets a short Gemini answer. */
export async function answerQuestion(text: string): Promise<string> {
  try {
    return (await generate({ tier: "fast", system: QUESTION_SYSTEM, parts: [{ text }], temperature: 0.4, maxOutputTokens: 200, timeoutMs: 4_000 })).trim();
  } catch (err: any) {
    console.warn(`[reply] question answer failed: ${err?.message}`);
    return "Send me any text, DM or screenshot you're unsure about and I'll check it.";
  }
}
