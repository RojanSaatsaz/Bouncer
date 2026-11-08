// The user's active "case": the key facts of the last scam call or flagged message, so the next texts
// ("I already paid", "klarna", "what should I do?") are understood in context instead of cold.
//
// Fixed size on purpose (no transcript, no message text): level, scam type, flag names, brand, payment
// method, up to 3 amounts, and a one-line summary written in code. In memory only, one per user,
// dropped 30 minutes after the last update; never written to the DB or logged (rule 1). Facts are
// pulled from the transcript with code (regexes) before the transcript is deleted, so no extra model
// call sees the call. A newer case replaces the old one.
import type { RiskLevel } from "../detection/risk.js";
import { LEVEL_LABEL } from "../detection/risk.js";
import type { LossType } from "../recovery/steps.js";

const TTL_MS = 30 * 60_000;

export type PayMethod = "bnpl" | "gift_card" | "crypto" | "bank_or_p2p" | "card" | "cash";

export interface Payment {
  method: PayMethod;
  /** Display name: "Klarna", "Zelle", "gift cards", "a card"… */
  label: string;
}

export interface CaseFile {
  source: "call" | "text" | "screenshot";
  level: RiskLevel;
  scamType: string | null;
  flags: string[];
  brand: string | null;
  payment: Payment | null;
  /** Normalised amounts mentioned, in order ("$5,000"), max 3. */
  amounts: string[];
  durationS: number | null;
  /** Real contact for the organization it claimed to be (src/contacts, verified), once looked up. */
  official?: { name: string; website: string; phone: string | null } | null;
  /** One line written in code from the fields above (≤ 200 chars). */
  summary: string;
  at: number;
}

interface Slot {
  c: CaseFile;
  timer: NodeJS.Timeout;
}
const cases = new Map<string, Slot>();

export function openCase(userId: string, c: Omit<CaseFile, "summary" | "at">): CaseFile {
  const full: CaseFile = { ...c, summary: summarize(c), at: Date.now() };
  const old = cases.get(userId);
  if (old) clearTimeout(old.timer);
  const timer = setTimeout(() => cases.delete(userId), TTL_MS);
  timer.unref();
  cases.set(userId, { c: full, timer });
  return full;
}

export const getCase = (userId: string): CaseFile | null => cases.get(userId)?.c ?? null;

/** Attaches the verified real contact to the user's active case (no-op without one). */
export function setCaseContact(userId: string, official: { name: string; website: string; phone: string | null }) {
  const s = cases.get(userId);
  if (s) s.c.official = { name: official.name, website: official.website, phone: official.phone };
}

export function closeCase(userId: string) {
  const s = cases.get(userId);
  if (s) clearTimeout(s.timer);
  cases.delete(userId);
}

/** Compact view for a model prompt or Jev state (~300 chars). Labels only, no transcript or message text. */
export function caseForModel(c: CaseFile) {
  return {
    what: c.source === "call" ? "a phone call Bouncer listened to" : c.source === "screenshot" ? "a screenshot the user sent" : "a message the user sent",
    minutes_ago: Math.max(0, Math.round((Date.now() - c.at) / 60_000)),
    verdict: LEVEL_LABEL[c.level],
    scam_type: c.scamType,
    red_flags: c.flags,
    claimed_to_be: c.brand,
    payment_method_mentioned: c.payment?.label ?? null,
    amounts_mentioned: c.amounts,
    real_contact_verified: c.official ?? null,
    summary: c.summary,
  };
}

/** The recovery checklist that matches a payment method. */
export const LOSS_FOR_METHOD: Record<PayMethod, LossType> = {
  bnpl: "paid_bnpl",
  gift_card: "paid_gift_card",
  crypto: "paid_crypto",
  bank_or_p2p: "paid_bank_or_p2p",
  card: "paid_card",
  cash: "paid_bank_or_p2p",
};

// ---- Facts from text, in code ------------------------------------------------------------------

const METHODS: Array<[RegExp, PayMethod, string | null]> = [
  // Pay-later services. "Klarna" is often heard as "Clarna" / "Klarner" by speech-to-text.
  [/\b(k|c)larn(a|er|ah)\b/gi, "bnpl", "Klarna"],
  [/\bafter ?pay\b/gi, "bnpl", "Afterpay"],
  [/\b(?:pay|paid|use|using|with|through|via|accept|on)\s+affirm\b|\baffirm (?:app|loan|payment)/gi, "bnpl", "Affirm"],
  [/\bsezzle\b|\bpay in (?:4|four)\b|\bbuy now,? pay later\b/gi, "bnpl", null],
  [/\b(?:google play|itunes|apple|steam|target|amazon|ebay|walmart|visa)?\s*gift ?cards?\b/gi, "gift_card", "gift cards"],
  [/\bbitcoin(?: atm)?\b|\bcrypto(?:currency)?\b|\bbtc\b|\bethereum\b|\busdt\b|\btether\b|\bcrypto wallet\b/gi, "crypto", "crypto"],
  [/\bzelle\b/gi, "bank_or_p2p", "Zelle"],
  [/\bvenmo\b/gi, "bank_or_p2p", "Venmo"],
  [/\bcash ?app\b/gi, "bank_or_p2p", "Cash App"],
  [/\bpay ?pal\b/gi, "bank_or_p2p", "PayPal"],
  [/\bwestern union\b|\bmoney ?gram\b|\bwire (?:transfer|the money)\b|\bbank transfer\b|\brouting number\b/gi, "bank_or_p2p", "a bank transfer"],
  [/\b(?:credit|debit) card\b|\bcard number\b|\bcvv\b|\bcard ending\b/gi, "card", "a card"],
  [/\b(?:mail|send|withdraw|courier|pick ?up) (?:the )?cash\b|\bcash (?:in an? (?:envelope|box))\b/gi, "cash", "cash"],
];

/**
 * The payment method mentioned LAST in the text (the latest ask wins: "send Zelle… fine, we accept Klarna"
 * → Klarna). null if none.
 */
export function detectPayment(text: string): Payment | null {
  let best: { pos: number; p: Payment } | null = null;
  for (const [re, method, label] of METHODS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const pos = m.index ?? 0;
      if (!best || pos >= best.pos) {
        const named = method === "bnpl" && !label ? "a pay-later service" : label ?? method;
        best = { pos, p: { method, label: named } };
      }
    }
  }
  return best?.p ?? null;
}

const SMALL: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
const fmt = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

/** Amounts of money mentioned, normalised and de-duplicated, in order (max 3). "5k", "$1,500", "fifteen hundred". */
export function detectAmounts(text: string): string[] {
  const found: Array<{ pos: number; v: number }> = [];
  const push = (pos: number, v: number) => {
    if (v >= 20 && v <= 10_000_000) found.push({ pos, v });
  };
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|grand|thousand)?\b/gi))
    push(m.index!, parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1));
  for (const m of text.matchAll(/(?<![$\d.,])\b(\d+(?:\.\d+)?)\s?(k|grand|thousand)\b/gi)) push(m.index!, parseFloat(m[1]) * 1000);
  for (const m of text.matchAll(/(?<![$\d.,])\b(\d{2,6})\s?(dollars|bucks)\b/gi)) push(m.index!, parseFloat(m[1]));
  const words = Object.keys(SMALL).join("|");
  for (const m of text.matchAll(new RegExp(`\\b(${words})(?: and a half)?\\s+(thousand|grand)\\b`, "gi")))
    push(m.index!, (SMALL[m[1].toLowerCase()] + (/and a half/i.test(m[0]) ? 0.5 : 0)) * 1000);
  for (const m of text.matchAll(new RegExp(`\\b(${words})\\s+hundred\\b(?!\\s+thousand)`, "gi")))
    push(m.index!, SMALL[m[1].toLowerCase()] * 100);
  const out: string[] = [];
  for (const { v } of found.sort((a, b) => a.pos - b.pos)) {
    const s = fmt(v);
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 3);
}

function summarize(c: Omit<CaseFile, "summary" | "at">): string {
  const what = c.source === "call" ? `Call${c.durationS ? ` (${Math.max(1, Math.round(c.durationS / 60))} min)` : ""}` : c.source === "screenshot" ? "Screenshot" : "Message";
  const parts = [`${what}: ${LEVEL_LABEL[c.level]}`];
  if (c.brand) parts.push(`claimed to be ${c.brand}`);
  if (c.amounts.length) parts.push(`amounts ${c.amounts.join(" → ")}`);
  if (c.payment) parts.push(`payment by ${c.payment.label}`);
  if (c.flags.length) parts.push(`flags ${c.flags.slice(0, 4).join(", ")}`);
  return parts.join("; ").slice(0, 200) + ".";
}
