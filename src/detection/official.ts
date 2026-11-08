// Official websites for brands scammers often pretend to be. Hand-checked, written in code: the model
// never makes up a web address (it could invent a lookalike). When the brand isn't on this list,
// replies tell the user to search for it themselves instead of pointing to "the official website".
// These hosts are also the only brand sites the outgoing link filter lets through (src/photon/links.ts).

export interface OfficialSite {
  name: string;
  site: string;
}

const SITES: Array<[RegExp, OfficialSite]> = [
  [/\b(usps|postal service|post office)\b/i, { name: "USPS", site: "usps.com" }],
  [/\bups\b|united parcel/i, { name: "UPS", site: "ups.com" }],
  [/\bfed ?ex\b/i, { name: "FedEx", site: "fedex.com" }],
  [/\bdhl\b/i, { name: "DHL", site: "dhl.com" }],
  [/\bamazon\b/i, { name: "Amazon", site: "amazon.com" }],
  [/\b(apple|icloud)\b/i, { name: "Apple", site: "apple.com" }],
  [/\bpaypal\b/i, { name: "PayPal", site: "paypal.com" }],
  [/\bvenmo\b/i, { name: "Venmo", site: "venmo.com" }],
  [/\bzelle\b/i, { name: "Zelle", site: "zellepay.com" }],
  [/\bcash ?app\b/i, { name: "Cash App", site: "cash.app" }],
  [/\bcoinbase\b/i, { name: "Coinbase", site: "coinbase.com" }],
  [/\bchase\b/i, { name: "Chase", site: "chase.com" }],
  [/\bbank of america\b|\bbofa\b/i, { name: "Bank of America", site: "bankofamerica.com" }],
  [/\bwells ?fargo\b/i, { name: "Wells Fargo", site: "wellsfargo.com" }],
  [/\bciti(bank)?\b/i, { name: "Citi", site: "citi.com" }],
  [/\bcapital ?one\b/i, { name: "Capital One", site: "capitalone.com" }],
  [/\bamerican express\b|\bamex\b/i, { name: "American Express", site: "americanexpress.com" }],
  [/\bdiscover\b/i, { name: "Discover", site: "discover.com" }],
  [/\b(irs|internal revenue)\b/i, { name: "the IRS", site: "irs.gov" }],
  [/\b(social security|ssa)\b/i, { name: "Social Security", site: "ssa.gov" }],
  [/\bmedicare\b/i, { name: "Medicare", site: "medicare.gov" }],
  [/\bntta\b|north texas tollway/i, { name: "NTTA", site: "ntta.org" }],
  [/\btxtag\b/i, { name: "TxTag", site: "txtag.org" }],
  [/\bt-?mobile\b/i, { name: "T-Mobile", site: "t-mobile.com" }],
  [/\bnetflix\b/i, { name: "Netflix", site: "netflix.com" }],
  [/\bmicrosoft\b|\boutlook\b/i, { name: "Microsoft", site: "microsoft.com" }],
  [/\bwalmart\b/i, { name: "Walmart", site: "walmart.com" }],
  [/\bcostco\b/i, { name: "Costco", site: "costco.com" }],
  [/\bbest ?buy\b|\bgeek squad\b/i, { name: "Best Buy", site: "bestbuy.com" }],
];

/** Sites Bouncer itself points to for reporting and recovery (src/recovery/steps.ts, call advice). */
const REPORTING_HOSTS = ["ftc.gov", "ic3.gov", "identitytheft.gov"];

/** Every host Bouncer may send: a link to one of these (or its subdomains) is never hidden. */
export const OFFICIAL_HOSTS = [...REPORTING_HOSTS, ...SITES.map(([, s]) => s.site)];

/** The brand's real website, or null when we don't have one on file. */
export function officialSiteFor(brand: string | null | undefined): OfficialSite | null {
  if (!brand) return null;
  for (const [re, s] of SITES) if (re.test(brand)) return s;
  return null;
}
