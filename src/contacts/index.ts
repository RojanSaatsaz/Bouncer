// Real contact info for the organization a scam pretends to be ("call the real Idaho court" → the number
// and website, so the user doesn't have to search). Order: the verified directory (config/contacts.json,
// built by `npm run verify:contacts`, instant and free) → cache (memory, then the official_contacts table)
// → live search (src/contacts/search.ts: .gov only for government; exactly <brand>.<tld> for companies;
// a phone only if it is written on that official site).
//
// Nothing about the user is stored: the cache is keyed by organization name and holds public info only.
import fs from "node:fs";
import path from "node:path";
import { query, one } from "../db.js";
import { generateJson } from "../detection/gemini.js";
import { searchOfficialContact, type ContactKind } from "./search.js";
import { allowContact, allowDomain } from "./allow.js";

export interface OfficialContact {
  name: string;
  website: string;
  phone: string | null;
  kind: ContactKind;
  source: "directory" | "search";
  note?: string;
}

interface DirEntry {
  key: string;
  name: string;
  aliases: string[];
  kind: ContactKind;
  domain: string;
  website: string;
  phone: string | null;
  note?: string;
}

export interface Resource {
  key: string;
  name: string;
  website: string | null;
  phone: string | null;
  use: string;
}

const FILE = path.resolve(process.cwd(), "config/contacts.json");
const data: { entries: DirEntry[]; resources: Resource[] } = (() => {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    console.warn("[contacts] config/contacts.json missing: directory empty (run npm run verify:contacts)");
    return { entries: [], resources: [] };
  }
})();

export const RESOURCES: Resource[] = data.resources;

// The outgoing link/phone filters (src/photon/links.ts) let every verified site and number through.
for (const e of data.entries) {
  allowDomain(e.domain);
  allowContact(e.website, e.phone);
}
for (const r of data.resources) allowContact(r.website, r.phone);
export const resource = (key: string) => RESOURCES.find((r) => r.key === key) ?? null;

const norm = (s: string) => ` ${s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()} `;

/** Directory hit when one of an entry's aliases appears as whole words in the name. */
export function fromDirectory(org: string): OfficialContact | null {
  const n = norm(org);
  let best: { e: DirEntry; len: number } | null = null;
  for (const e of data.entries)
    for (const a of e.aliases) {
      const na = norm(a);
      if (n.includes(na) && (!best || na.length > best.len)) best = { e, len: na.length };
    }
  if (!best) return null;
  const e = best.e;
  return { name: e.name, website: e.website, phone: e.phone, kind: e.kind, source: "directory", ...(e.note ? { note: e.note } : {}) };
}

const GOV_RE =
  /\b(court|courts|county|state of|city of|department|dept|police|sheriff|dmv|motor vehicles?|tax|treasury|revenue|attorney general|federal|jury|clerk|marshal|immigration|toll ?way|toll authority|turnpike|municipal|government|agency|bureau|commission|social security|medicare|medicaid|unemployment|workforce)\b/i;

export const looksGovernment = (org: string, scamType?: string | null) => scamType === "government" || GOV_RE.test(org);

const mem = new Map<string, { c: OfficialContact | null; at: number }>();
const MEM_MS = 6 * 60 * 60_000;
const DB_DAYS = 30;

/**
 * Real contact for `org` (as the scam names it), or null. Never throws. `hint` = a US state or city
 * from the message, to pick the right office. Directory hits are instant; a live search takes ~1–2 s.
 */
export async function findOfficialContact(
  org: string | null | undefined,
  opts: { scamType?: string | null; hint?: string | null; timeoutMs?: number } = {},
): Promise<OfficialContact | null> {
  const name = org?.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name || name.length < 2) return null;
  const gov = looksGovernment(name, opts.scamType);
  const dir = fromDirectory(name);
  // "Apple Valley Police" or "Chase County Court" must not become Apple Inc. or Chase bank.
  if (dir && !(gov && dir.kind === "business" && GOV_RE.test(name))) return dir;

  const kind: ContactKind = gov ? "gov" : "business";
  const key = `${norm(name).trim()}|${(opts.hint ?? "").toLowerCase()}`.slice(0, 160);
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < MEM_MS) return hit.c;
  try {
    const row = await one<{ name: string | null; website: string | null; phone: string | null; kind: string | null }>(
      `SELECT name, website, phone, kind FROM official_contacts WHERE key = $1 AND checked_at > now() - interval '${DB_DAYS} days'`,
      [key],
    );
    if (row) {
      const c = row.website ? { name: row.name ?? name, website: row.website, phone: row.phone, kind: (row.kind as ContactKind) ?? kind, source: "search" as const } : null;
      if (c) allowContact(c.website, c.phone);
      mem.set(key, { c, at: Date.now() });
      return c;
    }
  } catch (err: any) {
    console.warn(`[contacts] cache read failed: ${err?.message}`);
  }

  const t0 = Date.now();
  const found = await searchOfficialContact(name, kind, { hint: opts.hint, timeoutMs: opts.timeoutMs });
  const c: OfficialContact | null = found ? { name: found.name, website: found.website, phone: found.phone, kind, source: "search" } : null;
  if (c) allowContact(c.website, c.phone);
  console.log(`[contacts] search kind=${kind} → ${c ? `site${c.phone ? "+phone" : ""}` : "nothing verified"} in ${Date.now() - t0} ms`);
  mem.set(key, { c, at: Date.now() });
  query(
    `INSERT INTO official_contacts (key, name, website, phone, kind, source_url, checked_at) VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website, phone = EXCLUDED.phone,
       kind = EXCLUDED.kind, source_url = EXCLUDED.source_url, checked_at = now()`,
    [key, c?.name ?? null, c?.website ?? null, c?.phone ?? null, kind, found?.sourceUrl ?? null],
  ).catch((err) => console.warn(`[contacts] cache write failed: ${err?.message}`));
  return c;
}

/** "isc.idaho.gov/contact-us" for display (no scheme, no trailing slash). */
export const displayUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");

/** The text Bouncer sends: real number and site, and a reminder not to use the scam's own contact info. */
export function contactLine(c: OfficialContact, after: "message" | "call" = "message"): string {
  const where = c.phone ? `${c.phone} or ${displayUrl(c.website)}` : displayUrl(c.website);
  const from = c.source === "search" ? ` (from their official ${c.kind === "gov" ? ".gov " : ""}website)` : "";
  const note = c.note ? ` ${c.note}` : "";
  const not = after === "call" ? "not a number or link the caller gave you" : "not any number or link in the message";
  return `📞 To check with the real ${c.name}: ${where}${from}.${note} Use this, ${not}.`;
}

/** Which organization a pasted message claims to be from (wording/extraction only; Jev already judged it). */
export async function orgFromMessage(body: string, timeoutMs = 2_500): Promise<{ org: string | null; hint: string | null }> {
  try {
    const out = await generateJson<{ organization: string | null; us_state_or_city: string | null }>({
      tier: "fast",
      system:
        "You read a message someone received. Return the company, bank or government office the SENDER claims to be or speak for " +
        "(for example 'Chase', 'IRS', 'Ada County Court', 'USPS', 'NTTA'), and the US state or city it names, if any. " +
        "Use null for a person, a relative, an unknown sender, or if unclear. Short names only.",
      parts: [{ text: body.slice(0, 2000) }],
      jsonSchema: {
        type: "object",
        properties: { organization: { type: "string", nullable: true }, us_state_or_city: { type: "string", nullable: true } },
        required: ["organization", "us_state_or_city"],
      },
      temperature: 0,
      timeoutMs,
    });
    const clean = (s: string | null | undefined) => {
      const t = s?.replace(/[^\p{L}\p{N} .&'-]/gu, "").trim();
      return t && t.length <= 60 && t.toLowerCase() !== "null" ? t : null;
    };
    return { org: clean(out.organization), hint: clean(out.us_state_or_city) };
  } catch (err: any) {
    console.warn(`[contacts] org extraction failed: ${err?.message}`);
    return { org: null, hint: null };
  }
}
