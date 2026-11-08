// Official contacts: directory, live verified lookup, safety checks, and the follow-up text after a verdict.
// Real OpenRouter web search (~$0.001 each) + Jev, DRY_RUN texts, any Postgres with the schema.
//   npm run test:contacts
//   DATABASE_URL=postgres://postgres@127.0.0.1:54330/bouncer npm run test:contacts   (local throwaway DB)
export {};
process.env.DRY_RUN = "1";
process.env.PHOTON_SOCKET = "off";

const HANDLE = "+15555550161";
const SPACE = "tsp-contacts-0161";
const AGENT = "tsp-agent";

const { query, pool } = await import("../src/db.js");
const { getOrCreateUser, saveConversation } = await import("../src/users.js");
const { dryRunOutbox } = await import("../src/photon/client.js");
const { handleInbound } = await import("../src/messages/inbound.js");
const { getCase, closeCase } = await import("../src/messages/case.js");
const { clearHistory } = await import("../src/messages/history.js");
const { fromDirectory, findOfficialContact, contactLine, RESOURCES } = await import("../src/contacts/index.js");
const { isGovHost, registrableDomain, brandLabel, brandLabels, phonesIn } = await import("../src/contacts/search.js");
const { FINAL_STEP, checklist } = await import("../src/recovery/steps.js");

let failures = 0;
const check = (name: string, cond: unknown, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n=== ${s} ===`);

await query("DELETE FROM official_contacts WHERE key LIKE 'idaho%' OR key LIKE 'ada county%' OR key LIKE 'southwest%' OR key LIKE 'zzq%'");
await query("DELETE FROM events WHERE user_id IN (SELECT id FROM users WHERE imessage_handle = $1)", [HANDLE]);
await query("DELETE FROM users WHERE imessage_handle = $1", [HANDLE]);
const { user } = await getOrCreateUser(HANDLE);
await saveConversation(user.id, SPACE, AGENT);

try {
  section("1. Safety checks (no network)");
  check("isc.idaho.gov is government", isGovHost("isc.idaho.gov"));
  check("ci.boise.id.us is government", isGovHost("ci.boise.id.us"));
  check("idaho-court-pay.com is not", !isGovHost("idaho-court-pay.com"));
  check("idahocourts.gov.payments.io is not", !isGovHost("idahocourts.gov.payments.io"));
  check("registrable domain of a lookalike", registrableDomain("klarna.com.secure-verify.io") === "secure-verify.io");
  check("brand label Bank of America", brandLabel("Bank of America") === "bankofamerica");
  check("brand labels drop a trailing descriptor only", brandLabels("Southwest Airlines").includes("southwest") && !brandLabels("Bank of America").includes("ofamerica"));
  check("phones on a page", phonesIn("Call (208) 334-2210 or 1-888-518-2771. Room 208, 334 seats").join() === "2083342210,8885182771");

  section("2. Verified directory");
  const cases: Array<[string, string | null]> = [
    ["Chase Bank", "Chase"],
    ["Internal Revenue Service", "IRS"],
    ["North Texas Tollway Authority", "NTTA (North Texas Tollway Authority)"],
    ["Klarna", "Klarna"],
    ["groups of friends", null], // "ups" must not match inside a word
  ];
  for (const [org, want] of cases) {
    const d = fromDirectory(org);
    check(`directory: "${org}" → ${want ?? "none"}`, (d?.name ?? null) === want, d?.name);
  }
  const chase = fromDirectory("Chase");
  check("Chase has a verified phone + chase.com", !!chase?.phone && /chase\.com/.test(chase.website), JSON.stringify(chase));
  const zelle = fromDirectory("Zelle");
  check("Zelle: no phone, note to call your bank", zelle?.phone === null && /bank/i.test(zelle?.note ?? ""), JSON.stringify(zelle));
  const apv = await findOfficialContact("Apple Valley Police Department", { scamType: "government", timeoutMs: 8_000 });
  check("Apple Valley Police ≠ Apple Inc.", !apv || !/apple\.com/.test(apv.website), JSON.stringify(apv));
  check("resources include FTC and Elder Fraud Hotline", !!RESOURCES.find((r) => r.key === "ftc_report")?.phone && !!RESOURCES.find((r) => r.key === "elder_fraud")?.phone);

  section("3. Live lookup: government (.gov only, phone written on the site)");
  let t0 = Date.now();
  const idaho = await findOfficialContact("Idaho court", { scamType: "government", hint: "Idaho", timeoutMs: 8_000 });
  console.log(`      ${JSON.stringify(idaho)}  (${Date.now() - t0} ms)`);
  check("Idaho court → a .gov site", !!idaho && isGovHost(new URL(idaho.website).hostname), JSON.stringify(idaho));
  check("Idaho court → a verified phone", !!idaho?.phone);
  t0 = Date.now();
  const again = await findOfficialContact("Idaho court", { scamType: "government", hint: "Idaho" });
  check("second lookup is cached (< 50 ms)", Date.now() - t0 < 50 && again?.website === idaho?.website, `${Date.now() - t0} ms`);
  let row: any = null;
  for (let k = 0; k < 20 && !row; k++) {
    row = (await query("SELECT website, phone FROM official_contacts WHERE key LIKE 'idaho court%'")).rows[0];
    if (!row) await new Promise((r) => setTimeout(r, 100)); // the cache write is fire-and-forget
  }
  check("cached in official_contacts", row?.website === idaho?.website, JSON.stringify(row));
  const ada = await findOfficialContact("Ada County Magistrate Court", { scamType: "government", hint: "Idaho", timeoutMs: 8_000 });
  console.log(`      ${JSON.stringify(ada)}`);
  check("county court → .gov or nothing", !ada || isGovHost(new URL(ada.website).hostname), JSON.stringify(ada));

  section("4. Live lookup: company not in the directory (its own domain only)");
  const sw = await findOfficialContact("Southwest Airlines", { timeoutMs: 8_000 });
  console.log(`      ${JSON.stringify(sw)}`);
  check("Southwest → southwest.com or nothing", !sw || registrableDomain(new URL(sw.website).hostname) === "southwest.com", JSON.stringify(sw));
  const fake = await findOfficialContact("Zzqxv Rewards Center", { timeoutMs: 8_000 });
  check("made-up company → nothing", fake === null, JSON.stringify(fake));

  section("5. The text Bouncer sends");
  if (idaho) console.log(`      ${contactLine(idaho)}`);
  check("line has number, site, and the warning", !!idaho && contactLine(idaho).includes(idaho.phone ?? "") && /Use this, not any number or link in the message/.test(contactLine(idaho)));
  check("recovery last step has FTC + elder hotline", /1-877-382-4357/.test(FINAL_STEP.text) && /Elder Fraud Hotline/.test(FINAL_STEP.text), FINAL_STEP.text);
  const klarnaStep = checklist("paid_bnpl", "Klarna")[0].text;
  check("Klarna recovery step has Klarna's verified number", klarnaStep.includes(fromDirectory("Klarna")?.phone ?? "???"), klarnaStep);

  section("6. End to end: an Idaho court scam text → verdict, then the real court's contact");
  const i0 = dryRunOutbox.length;
  t0 = Date.now();
  await handleInbound({
    id: `test-contacts-${Date.now()}`,
    spaceId: SPACE,
    spaceKind: "direct",
    senderHandle: HANDLE,
    agentUserId: AGENT,
    text: "IDAHO COURTS NOTICE: You missed jury duty and a bench warrant was issued. Pay the $450 fine today at idaho-courts-pay.com or call 208-555-0147 to avoid arrest.",
    attachmentIds: [],
    receivedAt: new Date().toISOString(),
  });
  const out = dryRunOutbox.slice(i0).filter((m) => m.spaceId === SPACE).map((m) => m.text);
  for (const t of out) console.log(`      bouncer: ${JSON.stringify(t)}`);
  console.log(`      (${Date.now() - t0} ms total)`);
  const line = out.find((t) => t.startsWith("📞"));
  check("verdict first, then a contact line", out.length >= 2 && /scam/i.test(out[0]) && out.at(-1) === line, out.join(" | "));
  check("contact is a .gov site", !!line && /\.gov/.test(line), line);
  check("never the scam's own number or link", !!line && !/555-0147|idaho-courts-pay/.test(line));
  check("case carries the verified contact", !!getCase(user.id)?.official?.website);
} finally {
  closeCase(user.id);
  clearHistory(user.id);
  await query("DELETE FROM events WHERE user_id = $1", [user.id]);
  await query("DELETE FROM users WHERE id = $1", [user.id]);
  await pool.end();
}

console.log(`\n${failures ? `${failures} FAILED` : "All checks passed"}`);
process.exit(failures ? 1 : 0);
