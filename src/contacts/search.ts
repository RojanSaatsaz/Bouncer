// Live lookup of an organization's real website and phone number (OpenRouter web search plugin, Parallel
// engine: ~1 s, ~$0.001 per search; verified live 2026-11-08, see docs/API_NOTES.md).
//
// A wrong number here would send the user to a scammer, so the model only PROPOSES; code accepts:
//   - the website only if it came back in the search results AND its domain is official for the kind:
//     a .gov / .mil (or state .us) domain for government, or exactly <brand>.<tld> for a business
//     ("klarna.com" for Klarna; never "klarna-secure-login.com" or "klarna.com.verify.io");
//   - the phone only if its digits appear in the text of a result page on that official domain.
// Only the organization's name is sent to the search (never the user's message, rule 1).
import { config } from "../config.js";

export type ContactKind = "gov" | "business";

export interface FoundContact {
  name: string;
  website: string; // https URL on the official domain
  phone: string | null; // "(208) 334-2210" / "1-888-518-2771"
  kind: ContactKind;
  sourceUrl: string;
}

const URL = "https://openrouter.ai/api/v1/chat/completions";

/** example.com for www.help.example.com (US-focused: last two labels). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  return labels.slice(-2).join(".");
}

export const isGovHost = (host: string) =>
  /\.(gov|mil)$/i.test(host) || /\.(state|courts?|co|ci|k12)\.[a-z]{2}\.us$/i.test(host) || /\.[a-z]{2}\.us$/i.test(host);

/** "Bank of America" → "bankofamerica" (what its own domain label would be). */
export const brandLabel = (name: string) =>
  name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(inc|llc|corp|corporation|co|company|the|us|usa|customer service|support)\b/g, "")
    .replace(/[^a-z0-9]/g, "");

/** `domain` (e.g. "cash.app") pins the one official domain; otherwise .gov rules or <brand>.<tld>. */
function officialHost(host: string, kind: ContactKind, brand: string, domain?: string): boolean {
  if (domain) return registrableDomain(host) === domain.toLowerCase();
  if (kind === "gov") return isGovHost(host);
  const label = registrableDomain(host).split(".")[0].replace(/-/g, "");
  return brandLabels(brand).includes(label);
}

/** A trailing word that describes the business rather than naming it ("Southwest Airlines" → southwest.com). */
const DESCRIPTOR = /\s+(airlines?|air lines|bank|banking|financial|insurance|credit union|card|cards|services?|stores?|online|wireless|mobile|pharmacy)$/i;

/** Domain labels that count as the brand's own: the full name, or the name without one trailing descriptor. */
export function brandLabels(name: string): string[] {
  const full = brandLabel(name);
  const short = brandLabel(name.trim().replace(DESCRIPTOR, ""));
  return [...new Set([full, short].filter((l) => l.length >= 3))];
}

const digits = (s: string) => s.replace(/\D/g, "");
/** 10-digit US number (drops a leading 1), or null. */
function usNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = digits(raw);
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? d : null;
}
/** Every US phone number written in a page's text, as 10 digits. */
export function phonesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<!\d)(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g)) out.push(m[1] + m[2] + m[3]);
  return out;
}
export const formatPhone = (d: string) => (/^8(00|33|44|55|66|77|88)/.test(d) ? `1-${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`);

interface Citation {
  url: string;
  host: string;
  content: string;
}

/**
 * Searches for the organization's official contact and verifies it. null when nothing passes the checks
 * (or the search fails / times out). `hint` is extra context such as a state name ("Idaho").
 */
export async function searchOfficialContact(
  name: string,
  kind: ContactKind,
  opts: { hint?: string | null; timeoutMs?: number; domain?: string } = {},
): Promise<FoundContact | null> {
  const or = config.openrouter;
  if (!or) return null; // no OpenRouter key: no live lookup (the curated directory still works)
  const who = `${name}${opts.hint && !name.toLowerCase().includes(opts.hint.toLowerCase()) ? ` (${opts.hint})` : ""}`;
  const question =
    kind === "gov"
      ? `Official website and main public phone number of this US government office: ${who}.`
      : `Official US customer service website and phone number of the company ${who} (the number customers call for account or fraud help).`;
  let data: any;
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${or.apiKey}`, "Content-Type": "application/json", "X-Title": "Bouncer" },
      body: JSON.stringify({
        model: or.fastModel,
        reasoning: { enabled: false },
        temperature: 0,
        max_tokens: 150,
        plugins: [
          {
            id: "web",
            engine: "parallel",
            mode: "fast",
            max_results: 5,
            // ".gov" is the form that works with this engine ("*.gov" and "gov" return HTTP 500).
            ...(opts.domain ? { include_domains: [opts.domain] } : kind === "gov" ? { include_domains: [".gov"] } : {}),
          },
        ],
        messages: [
          {
            role: "user",
            content:
              `${question}\nReply with ONLY JSON: {"name": string, "website": string|null, "phone": string|null}. ` +
              "Use only the search results. Use null for anything the results don't show. Never guess a number.",
          },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6_000),
    });
    if (!res.ok) {
      console.warn(`[contacts] search HTTP ${res.status}`);
      return null;
    }
    data = await res.json();
  } catch (err: any) {
    console.warn(`[contacts] search failed: ${err?.name === "TimeoutError" ? "timed out" : err?.message}`);
    return null;
  }

  const msg = data?.choices?.[0]?.message;
  const citations: Citation[] = (msg?.annotations ?? [])
    .map((a: any) => a?.url_citation)
    .filter((c: any) => typeof c?.url === "string")
    .map((c: any) => {
      try {
        return { url: c.url, host: new globalThis.URL(c.url).hostname.toLowerCase(), content: String(c.content ?? "") };
      } catch {
        return null;
      }
    })
    .filter((c: Citation | null): c is Citation => !!c);
  const official = citations.filter((c) => officialHost(c.host, kind, name, opts.domain));
  if (!official.length) {
    console.log(`[contacts] no official result (kind=${kind}, ${citations.length} results)`);
    return null;
  }

  let proposed: { name?: string; website?: string | null; phone?: string | null } = {};
  try {
    const raw = String(msg?.content ?? "").replace(/^```(?:json)?|```$/gm, "").trim();
    proposed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    /* fall back to the citations alone */
  }

  // Website: the proposed one if it is on an official host that came back in the results, else that host.
  let site: string | null = null;
  try {
    const u = proposed.website ? new globalThis.URL(proposed.website.startsWith("http") ? proposed.website : `https://${proposed.website}`) : null;
    if (u && official.some((c) => registrableDomain(c.host) === registrableDomain(u.hostname)) && officialHost(u.hostname.toLowerCase(), kind, name, opts.domain)) {
      site = `https://${u.hostname.toLowerCase()}${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`;
    }
  } catch {
    /* bad URL: use a citation */
  }

  // Phone: only if that exact number is written on an official result page.
  const want = usNumber(proposed.phone);
  const proof = want ? official.find((c) => phonesIn(c.content).includes(want)) : undefined;
  if (!site) site = `https://${(proof ?? official[0]).host}`;
  const sourceUrl = (proof ?? official.find((c) => site!.includes(c.host)) ?? official[0]).url;
  return {
    name: (proposed.name?.trim() || name).slice(0, 80),
    website: site,
    phone: proof && want ? formatPhone(want) : null,
    kind,
    sourceUrl,
  };
}
