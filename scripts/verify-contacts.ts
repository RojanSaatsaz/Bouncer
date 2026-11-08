// Builds config/contacts.json: the directory of organizations scammers pretend to be, with each phone number
// VERIFIED on that organization's own website (web search restricted to its domain; the number must be
// written on a result page there). Numbers that can't be verified are left out (website only).
//   npm run verify:contacts            (~45 searches, ~$0.05 of OpenRouter credit)
// Review the printed table before committing: verification proves the number is on the official site, not
// that it's the best line, so eyeball anything odd (fax, a single office).
export {};
process.env.PHOTON_SOCKET = "off";
const fs = await import("node:fs");
const pLimit = (await import("p-limit")).default;
const { searchOfficialContact } = await import("../src/contacts/search.js");

type Kind = "gov" | "business";
interface Seed {
  key: string;
  name: string;
  aliases: string[];
  kind: Kind;
  domain: string;
  website: string;
  query?: string;
  note?: string;
  noPhone?: boolean; // the organization says it has no phone line for this (don't look one up)
}

const S = (key: string, name: string, kind: Kind, domain: string, website: string, aliases: string[], extra: Partial<Seed> = {}): Seed => ({
  key, name, kind, domain, website, aliases, ...extra,
});

const SEEDS: Seed[] = [
  // Government (and agencies that use non-.gov domains, pinned to their real domain).
  S("irs", "IRS", "gov", "irs.gov", "https://www.irs.gov", ["irs", "internal revenue service", "us treasury", "department of the treasury", "treasury department"],
    { query: "IRS individual taxpayer phone line" }),
  S("ssa", "Social Security Administration", "gov", "ssa.gov", "https://www.ssa.gov", ["social security", "ssa", "social security administration"]),
  S("medicare", "Medicare", "gov", "medicare.gov", "https://www.medicare.gov", ["medicare"]),
  S("usps", "USPS", "gov", "usps.com", "https://www.usps.com", ["usps", "us postal service", "postal service", "united states postal service", "post office"],
    { query: "USPS customer service phone number" }),
  S("ftc", "Federal Trade Commission", "gov", "ftc.gov", "https://reportfraud.ftc.gov", ["ftc", "federal trade commission"]),
  S("fbi", "FBI", "gov", "fbi.gov", "https://www.fbi.gov", ["fbi", "federal bureau of investigation"], { query: "FBI tips phone number 1-800-CALL-FBI" }),
  S("uscis", "USCIS", "gov", "uscis.gov", "https://www.uscis.gov", ["uscis", "immigration services", "citizenship and immigration"], { query: "USCIS contact center phone number" }),
  S("marshals", "U.S. Marshals Service", "gov", "usmarshals.gov", "https://www.usmarshals.gov", ["us marshals", "u s marshals", "marshals service", "marshal service"],
    { note: "The Marshals never call to demand money for missed jury duty." }),
  S("ntta", "NTTA (North Texas Tollway Authority)", "gov", "ntta.org", "https://www.ntta.org", ["ntta", "north texas tollway", "tolltag", "toll tag"], { query: "NTTA customer service phone number" }),
  S("txtag", "TxTag", "gov", "txtag.org", "https://www.txtag.org", ["txtag", "tx tag"], { query: "TxTag customer service phone number" }),
  S("sunpass", "SunPass", "gov", "sunpass.com", "https://www.sunpass.com", ["sunpass", "sun pass"], { query: "SunPass customer service phone number" }),
  S("fastrak", "FasTrak", "gov", "bayareafastrak.org", "https://www.bayareafastrak.org", ["fastrak", "fas trak"], { query: "Bay Area FasTrak customer service phone number" }),
  // Companies.
  S("amazon", "Amazon", "business", "amazon.com", "https://www.amazon.com/gp/help/customer/contact-us", ["amazon", "amazon prime", "prime video"]),
  S("apple", "Apple", "business", "apple.com", "https://support.apple.com", ["apple", "icloud", "apple support", "apple id"]),
  S("microsoft", "Microsoft", "business", "microsoft.com", "https://support.microsoft.com", ["microsoft", "windows support", "microsoft support"],
    { note: "Microsoft never calls you about a virus." }),
  S("paypal", "PayPal", "business", "paypal.com", "https://www.paypal.com/us/smarthelp/contact-us", ["paypal", "pay pal"]),
  S("venmo", "Venmo", "business", "venmo.com", "https://help.venmo.com", ["venmo"]),
  S("cashapp", "Cash App", "business", "cash.app", "https://cash.app/help", ["cash app", "cashapp", "square cash"]),
  S("zelle", "Zelle", "business", "zellepay.com", "https://www.zellepay.com", ["zelle"], { noPhone: true, note: "For a Zelle payment, call the bank you sent it from." }),
  S("coinbase", "Coinbase", "business", "coinbase.com", "https://help.coinbase.com", ["coinbase"], { note: "Coinbase support starts in the app or at help.coinbase.com." }),
  S("chase", "Chase", "business", "chase.com", "https://www.chase.com", ["chase", "jpmorgan chase", "chase bank"]),
  S("bofa", "Bank of America", "business", "bankofamerica.com", "https://www.bankofamerica.com", ["bank of america", "bofa", "boa"]),
  S("wellsfargo", "Wells Fargo", "business", "wellsfargo.com", "https://www.wellsfargo.com", ["wells fargo"],
    { query: "Wells Fargo phone number to report fraud on your account" }),
  S("citi", "Citi", "business", "citi.com", "https://www.citi.com", ["citi", "citibank"]),
  S("capitalone", "Capital One", "business", "capitalone.com", "https://www.capitalone.com", ["capital one"]),
  S("tmobile", "T-Mobile", "business", "t-mobile.com", "https://www.t-mobile.com/contact-us", ["t mobile", "tmobile", "t-mobile"],
    { note: "From a T-Mobile phone you can also dial 611." }),
  S("verizon", "Verizon", "business", "verizon.com", "https://www.verizon.com/support", ["verizon"]),
  S("att", "AT&T", "business", "att.com", "https://www.att.com/support", ["at and t", "att"]),
  S("ups", "UPS", "business", "ups.com", "https://www.ups.com", ["ups"]),
  S("fedex", "FedEx", "business", "fedex.com", "https://www.fedex.com", ["fedex", "fed ex"]),
  S("dhl", "DHL", "business", "dhl.com", "https://www.dhl.com/us-en", ["dhl"], { query: "DHL Express customer service phone number United States for package tracking" }),
  S("netflix", "Netflix", "business", "netflix.com", "https://help.netflix.com", ["netflix"]),
  S("klarna", "Klarna", "business", "klarna.com", "https://www.klarna.com/us/customer-service", ["klarna"]),
  S("afterpay", "Afterpay", "business", "afterpay.com", "https://help.afterpay.com", ["afterpay", "after pay"]),
  S("affirm", "Affirm", "business", "affirm.com", "https://helpcenter.affirm.com", ["affirm"]),
  S("walmart", "Walmart", "business", "walmart.com", "https://www.walmart.com/help", ["walmart"]),
  S("bestbuy", "Best Buy / Geek Squad", "business", "bestbuy.com", "https://www.bestbuy.com/contact-us", ["geek squad", "best buy"]),
  S("norton", "Norton", "business", "norton.com", "https://support.norton.com", ["norton", "norton antivirus", "norton 360"],
    { noPhone: true, note: "Check any renewal by signing in at norton.com yourself." }),
  S("mcafee", "McAfee", "business", "mcafee.com", "https://www.mcafee.com/support", ["mcafee", "mc afee"]),
];

/** General help: shown in recovery and available to chat. */
const RESOURCE_SEEDS = [
  { key: "ftc_report", name: "FTC (report a scam)", domain: "ftc.gov", website: "https://reportfraud.ftc.gov", query: "FTC consumer response center phone number to report fraud", use: "report any scam" },
  { key: "elder_fraud", name: "National Elder Fraud Hotline", domain: "ojp.gov", website: "https://ovc.ojp.gov/program/stop-elder-fraud/providing-help-restoring-hope", query: "National Elder Fraud Hotline phone number", use: "anyone 60 or older who was scammed: free help from a case manager" },
  { key: "aarp_fraud", name: "AARP Fraud Watch Network Helpline", domain: "aarp.org", website: "https://www.aarp.org/money/scams-fraud/helpline/", query: "AARP Fraud Watch Network Helpline phone number", use: "free help talking through a scam, for anyone" },
];
const FIXED_RESOURCES = [
  { key: "ic3", name: "FBI Internet Crime Complaint Center", website: "https://www.ic3.gov", phone: null, use: "report online fraud, crypto and large losses to the FBI" },
  { key: "identity_theft", name: "IdentityTheft.gov", website: "https://www.identitytheft.gov", phone: null, use: "a free step-by-step plan if someone has your SSN or personal info" },
  { key: "spam_7726", name: "Forward scam texts to 7726", website: null, phone: "7726", use: "forward a scam text to 7726 (SPAM) so your carrier can block it" },
];

// Search results vary run to run: try up to 3 times, and keep a number verified on an earlier run (it has
// its source_url) when this run simply didn't surface it.
const previous: Record<string, { phone: string | null; source_url?: string }> = (() => {
  try {
    const old = JSON.parse(fs.readFileSync("config/contacts.json", "utf8"));
    return Object.fromEntries([...old.entries, ...old.resources].map((e: any) => [e.key, e]));
  } catch {
    return {};
  }
})();
async function verifyPhone(query: string, kind: Kind, domain: string, key: string) {
  for (let i = 0; i < 3; i++) {
    const f = await searchOfficialContact(query, kind, { domain, timeoutMs: 15_000 });
    if (f?.phone) return { phone: f.phone, source_url: f.sourceUrl };
  }
  const prev = previous[key];
  return prev?.phone && prev.source_url ? { phone: prev.phone, source_url: prev.source_url } : { phone: null, source_url: null };
}

const limit = pLimit(4);
const t0 = Date.now();
const entries = await Promise.all(
  SEEDS.map((s) =>
    limit(async () => {
      if (s.noPhone) return { ...s, phone: null, source_url: null };
      return { ...s, ...(await verifyPhone(s.query ?? s.name, s.kind, s.domain, s.key)) };
    }),
  ),
);
const resources = await Promise.all(
  RESOURCE_SEEDS.map((r) =>
    limit(async () => {
      const v = await verifyPhone(r.query, "gov", r.domain, r.key);
      return { key: r.key, name: r.name, website: r.website, phone: v.phone, use: r.use, source_url: v.source_url };
    }),
  ),
);

for (const e of entries) console.log(`${e.key.padEnd(11)} ${(e.phone ?? "—").padEnd(16)} ${e.source_url ?? e.website}`);
console.log("---");
for (const r of resources) console.log(`${r.key.padEnd(11)} ${(r.phone ?? "—").padEnd(16)} ${r.source_url ?? r.website}`);
const verified = entries.filter((e) => e.phone).length + resources.filter((r) => r.phone).length;
console.log(`\n${verified} numbers verified on official sites in ${Math.round((Date.now() - t0) / 1000)} s`);

const out = {
  generated_at: new Date().toISOString(),
  how: "npm run verify:contacts — each phone was found written on the organization's own domain (web search limited to it).",
  entries: entries.map(({ key, name, aliases, kind, domain, website, phone, note, source_url }) => ({ key, name, aliases, kind, domain, website, phone, ...(note ? { note } : {}), ...(source_url ? { source_url } : {}) })),
  resources: [...resources, ...FIXED_RESOURCES],
};
fs.writeFileSync("config/contacts.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote config/contacts.json");
