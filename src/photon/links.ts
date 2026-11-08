// Bouncer never sends a scam's link or call-back number back to the user: iMessage turns any web
// address or phone number into something they can tap. stripLinks runs on EVERY outgoing iMessage
// (sendText); stripPhones runs on model-written text (verdicts, chat, call summaries and alerts), where
// the model could copy a number out of the scam. Code-written texts may still show numbers on purpose
// (the user's own relatives in family setup, Bouncer's voice number).
import { findPhoneNumbersInText } from "libphonenumber-js";
import { config } from "../config.js";
import { OFFICIAL_HOSTS } from "../detection/official.js";

/** Common TLDs that are still a link when written in capitals ("USPS.COM"). */
const COMMON_TLD = new Set(["com", "net", "org", "gov", "edu", "us", "co", "io", "info", "biz", "top", "xyz", "app", "me", "ly"]);

const LINK_RE =
  /\b(?:[a-z0-9._%+-]+@)?(?:(https?:\/\/)|(www\.))?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,24}))\b(?::\d{2,5})?(?:[/?#][^\s]*)?/gi;

const REPLACEMENT = "(link hidden)";

function allowed(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return OFFICIAL_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Without http:// or www., "fine.If you" (a missing space) is not a link: a capitalised last part only counts when it is a common TLD. */
const notALink = (scheme: string | undefined, www: string | undefined, tld: string) =>
  !scheme && !www && /[A-Z]/.test(tld) && !COMMON_TLD.has(tld.toLowerCase());

/** True when the text has a web address or email in it (so a reply may say "the link"). */
export function hasLink(text: string): boolean {
  for (const m of text.matchAll(LINK_RE)) if (!notALink(m[1], m[2], m[4])) return true;
  return false;
}

/** Replaces every web address or email that isn't one of Bouncer's own official sites. */
export function stripLinks(text: string): string {
  return text.replace(LINK_RE, (match, scheme: string | undefined, www: string | undefined, host: string, tld: string) => {
    if (notALink(scheme, www, tld)) return match;
    // Keep sentence punctuation that the path pattern swallowed ("...ntta-pay.top/x)." ).
    const trail = match.match(/[.,!?;:)\]'"]+$/)?.[0] ?? "";
    if (allowed(host) && !match.includes("@")) return match;
    return REPLACEMENT + trail;
  });
}

/** Replaces phone numbers in model-written text, except Bouncer's own voice number. */
export function stripPhones(text: string): string {
  const own = config.photon.voiceNumber.replace(/\D/g, "").slice(-10);
  const found = findPhoneNumbersInText(text, "US");
  let out = "";
  let at = 0;
  for (const f of found) {
    if (f.number.nationalNumber.slice(-10) === own) continue;
    out += text.slice(at, f.startsAt) + "(number hidden)";
    at = f.endsAt;
  }
  return out + text.slice(at);
}

/** Both, for text a model wrote. */
export const scrubModelText = (text: string) => stripPhones(stripLinks(text));
