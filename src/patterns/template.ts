// SPEC Flow 5 steps 3–4: turn a reported message into an anonymised template, plus the helpers used to
// match templates (registered domain, token Jaccard, embedding cosine). Gemini only rewrites text here;
// it never decides whether anything is a scam (rule 3). Nothing here logs message text (rule 1).
import { config } from "../config.js";
import { generateJson } from "../detection/gemini.js";
import { SCAM_TYPES } from "../detection/questions.js";

// Optional env, read here because Flow 5 is the only user. (Move into src/config.ts if it grows.)
export const EMBED_MODEL = config.embedModel;
export const EMBED_DIMS = 768;

export interface Template {
  template: string;
  brand: string | null;
  scamType: string;
  linkDomain: string | null;
}

// ---------- registered domain ----------

/** Second-level public suffixes where the registered domain is three labels (co.uk, com.au, ...). */
const TWO_PART_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.jp", "co.in", "co.za", "co.kr",
  "com.br", "com.mx", "com.cn", "com.sg", "com.tr", "com.ar", "com.co", "com.hk", "com.tw",
]);

/** Link shorteners: a shared shortener domain says nothing about which scam it is. */
export const SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "ow.ly", "rebrand.ly", "cutt.ly", "shorturl.at",
  "rb.gy", "t.ly", "s.id", "buff.ly", "tiny.cc", "lnkd.in",
]);

/** "https://www.pay.ntta-toll.top/x?y" → "ntta-toll.top". Null if it doesn't look like a host. */
export function registeredDomain(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  let host = urlOrHost.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^@/]*@/, "");
  host = host.split(/[/?#:\s]/)[0].replace(/\.+$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  return TWO_PART_TLDS.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join(".") : lastTwo;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
// Bare host like "ntta-pay.top/abc". Needs a letter-only TLD of 2+ chars, so "U.S." and "$4.35" don't match.
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\b(?:\/[^\s<>"']*)?/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Registered domain of the first link in the text, found in code (more reliable than asking Gemini). */
export function firstLinkDomain(text: string): string | null {
  const noEmails = text.replace(EMAIL_RE, " ");
  for (const re of [URL_RE, HOST_RE]) {
    for (const m of noEmails.matchAll(re)) {
      const d = registeredDomain(m[0]);
      if (d) return d;
    }
  }
  return null;
}

// ---------- anonymising ----------

/**
 * Belt and braces after Gemini: anything that still looks like a link, email, phone number, amount or
 * code becomes a placeholder, so a template can't carry a reporter's details even if Gemini missed one.
 */
const PLACEHOLDERS = new Set(["NAME", "PHONE", "AMOUNT", "DATE", "LINK", "CODE"]);
const PLACEHOLDER_ALIASES: Record<string, string> = {
  URL: "LINK", WEBSITE: "LINK", EMAIL: "LINK", DOMAIN: "LINK",
  NUMBER: "CODE", ACCOUNT: "CODE", ACCOUNT_NUMBER: "CODE", ID: "CODE", REF: "CODE", OTP: "CODE", PIN: "CODE",
  PRICE: "AMOUNT", MONEY: "AMOUNT", TIME: "DATE", PHONE_NUMBER: "PHONE",
};

/** Only the six SPEC placeholders survive; others ({MERCHANT}, {URL}, ...) map onto them. "${AMOUNT}" → "{AMOUNT}". */
export function normalizePlaceholders(template: string, brand: string | null): string {
  return template
    .replace(/\{\s*([A-Za-z_ ]+?)\s*\}/g, (_, raw: string) => {
      const k = raw.toUpperCase().replace(/\s+/g, "_");
      if (PLACEHOLDERS.has(k)) return `{${k}}`;
      if ((k === "BRAND" || k === "COMPANY") && brand) return brand;
      return `{${PLACEHOLDER_ALIASES[k] ?? "NAME"}}`;
    })
    .replace(/[$€£]\s?\{AMOUNT\}/g, "{AMOUNT}");
}

export function scrub(template: string): string {
  return template
    .replace(EMAIL_RE, "{LINK}")
    .replace(URL_RE, "{LINK}")
    .replace(HOST_RE, "{LINK}")
    .replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "{PHONE}")
    .replace(/[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d{2})\s?(?:usd|dollars)?\b/gi, "{AMOUNT}")
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, "{DATE}")
    .replace(/\b[A-Z0-9]*\d[A-Z0-9-]{2,}\b/gi, (m) => (m.replace(/\D/g, "").length >= 3 ? "{CODE}" : m))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

const TEMPLATE_PROMPT =
  "Rewrite this message as a template. Replace names, phone numbers, amounts, dates, links and codes with " +
  "{NAME}, {PHONE}, {AMOUNT}, {DATE}, {LINK}, {CODE}, and use no other placeholders. Keep the brand name " +
  "exactly as written, even in capitals (it is not a {NAME}). Also replace addresses, account, order, case or plate numbers, email addresses, and store or merchant names (other than the brand the message " +
  "claims to be from) with the closest placeholder, so no personal or one-off detail is left. " +
  "Keep the rest of the wording. Return template, brand (the company or agency it claims to be from, or null), " +
  "scam_type, and link_domain (the domain of the first link, or null). Do not judge whether it is a scam.";

const TEMPLATE_SCHEMA = {
  type: "object",
  properties: {
    template: { type: "string" },
    brand: { type: "string", nullable: true },
    scam_type: { type: "string", enum: Object.keys(SCAM_TYPES) },
    link_domain: { type: "string", nullable: true },
  },
  required: ["template", "scam_type"],
};

/**
 * Flow 5 step 3. `jevScamType` (from Flow 1's Jev scan) wins over Gemini's guess when present.
 * Throws if Gemini fails: there is no safe template without it (names would stay in).
 */
export async function makeTemplate(body: string, jevScamType: string | null): Promise<Template> {
  type Out = { template: string; brand?: string | null; scam_type?: string; link_domain?: string | null };
  const ask = () =>
    generateJson<Out>({
      tier: "fast",
      system: TEMPLATE_PROMPT,
      parts: [{ text: body.slice(0, 4000) }],
      jsonSchema: TEMPLATE_SCHEMA,
      temperature: 0,
      timeoutMs: 6_000,
    });
  let out: Out;
  try {
    out = await ask();
  } catch (err: any) {
    // Both tiers busy (429/503): one more try after a short pause. A report isn't time-critical.
    if (!/HTTP (429|5\d\d)|timed out/.test(String(err?.message))) throw err;
    await new Promise((r) => setTimeout(r, 2_000));
    out = await ask();
  }
  const rawBrand = out.brand?.trim().slice(0, 60) || null;
  const brand = rawBrand && !/[{}]/.test(rawBrand) ? rawBrand : null;
  const template = scrub(normalizePlaceholders(out.template ?? "", brand));
  if (template.length < 10) throw new Error("template came back empty");
  const pick = (t: string | null | undefined) => (t && t in SCAM_TYPES ? t : null);
  return {
    template,
    brand,
    scamType: pick(jevScamType) ?? pick(out.scam_type) ?? "other",
    linkDomain: firstLinkDomain(body) ?? registeredDomain(out.link_domain),
  };
}

// ---------- similarity ----------

/** Gemini embedding of a template (768 numbers), or null on any failure (matching falls back to Jaccard). */
export async function embed(text: string): Promise<number[] | null> {
  try {
    // Shape verified live 2026-11-08: POST models/{model}:embedContent → { embedding: { values: number[] } }.
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`, {
      method: "POST",
      headers: { "x-goog-api-key": config.gemini.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text }] }, output_dimensionality: EMBED_DIMS }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      console.warn(`[patterns] embed ${EMBED_MODEL} HTTP ${res.status}; using word overlap only`);
      return null;
    }
    const data: any = await res.json();
    const v = data?.embedding?.values;
    return Array.isArray(v) && v.length ? v : null;
  } catch (err: any) {
    console.warn(`[patterns] embed failed (${err?.name === "TimeoutError" ? "timeout" : err?.message}); using word overlap only`);
    return null;
  }
}

export function cosine(a: number[], b: number[]): number | null {
  if (!a?.length || a.length !== b?.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : null;
}

const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "your", "you", "is", "at", "on", "in", "for", "by", "be", "this", "it", "we", "our"]);
const tokens = (t: string) =>
  new Set((t.toLowerCase().match(/\{[a-z]+\}|[a-z0-9']+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w)));

/** Word-set overlap of two templates, 0..1. */
export function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
