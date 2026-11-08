// Web hosts and phone numbers Bouncer itself vouches for: the verified official contacts (config/contacts.json
// and live lookups that passed src/contacts/search.ts's checks). The outgoing filters in src/photon/links.ts
// hide every other link, and every other number in model-written text, so a scam's own contact info is never
// sent back, while "📞 To check with the real Idaho Courts: (208) 334-2210 or isc.idaho.gov" gets through.
// No imports on purpose: links.ts runs on every send.

const hosts = new Set<string>();
const phones = new Set<string>();

const hostOf = (u: string) => {
  try {
    return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** Vouches for a verified website (its host and subdomains) and phone number. */
export function allowContact(website?: string | null, phone?: string | null) {
  const h = website ? hostOf(website) : null;
  if (h) hosts.add(h);
  const d = phone?.replace(/\D/g, "").slice(-10);
  if (d && d.length === 10) phones.add(d);
}

/** Also vouches for a whole registrable domain (e.g. "klarna.com" covers help.klarna.com). */
export function allowDomain(domain: string) {
  const h = hostOf(domain);
  if (h) hosts.add(h);
}

export function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  for (const d of hosts) if (h === d || h.endsWith(`.${d}`)) return true;
  return false;
}

/** `digits` = the number's last 10 digits. */
export const isAllowedPhone = (digits: string) => phones.has(digits.slice(-10));
