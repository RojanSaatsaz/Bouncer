// Flow 5 runner: REPORT → template → ZIP3 counts → spike → local alerts, with DRY_RUN on (alerts are
// printed, never sent). Uses live Gemini and the DB in DATABASE_URL; deletes every row it creates.
//   DATABASE_URL=postgres://postgres@127.0.0.1:54330/bouncer npm run test:patterns
// Refuses to run against a non-local DB unless you pass --force (it sets last_local_alert_at on 752xx users).
export {};
process.env.DRY_RUN = "1";
process.env.PHOTON_SOCKET = "off";
process.env.PATTERN_SPIKE_THRESHOLD ||= "3";

const url = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(url) && !process.argv.includes("--force")) {
  console.error("test-patterns writes to users in ZIP3 752. Point DATABASE_URL at a local DB, or pass --force.");
  process.exit(1);
}

const { query, one, pool } = await import("../src/db.js");
const { getUserById } = await import("../src/users.js");
const { dryRunOutbox } = await import("../src/photon/client.js");
const P = await import("../src/patterns/index.js");
const { registeredDomain, scrub, jaccard, normalizePlaceholders } = await import("../src/patterns/template.js");

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures++;
};

// ---- fixtures ----
const PEOPLE = [
  { key: "A", zip: "75201", opted: true, space: true },
  { key: "B", zip: "75204", opted: true, space: true },
  { key: "C", zip: "75219", opted: true, space: true },
  { key: "D", zip: "75225", opted: true, space: true },
  { key: "E", zip: "75230", opted: false, space: true }, // not opted in: no alert
  { key: "F", zip: "76102", opted: true, space: true }, // other ZIP3: no alert
  { key: "G", zip: "75240", opted: true, space: false }, // no thread: no alert
  { key: "H", zip: null, opted: true, space: true }, // no ZIP: counts as "unk"
];
const handle = (i: number) => `+1555555017${i}`;
const space = (k: string) => `tsp-pat-${k}`;

async function cleanup(templateIds: string[]) {
  if (templateIds.length) await query("DELETE FROM report_templates WHERE id = ANY($1::uuid[])", [templateIds]);
  await query("DELETE FROM users WHERE imessage_handle LIKE '+1555555017%'");
}

const before = new Set((await query<{ id: string }>("SELECT id FROM report_templates")).rows.map((r) => r.id));
await cleanup([]);

const users: Record<string, any> = {};
for (const [i, p] of PEOPLE.entries()) {
  const row = await one(
    `INSERT INTO users (imessage_handle, zip, opted_in, space_id, photon_sender_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [handle(i), p.zip, p.opted, p.space ? space(p.key) : null, p.space ? "tsp-agent" : null],
  );
  users[p.key] = row;
}
const fresh = async (k: string) => (users[k] = await getUserById(users[k].id));

const replies: Record<string, string[][]> = {};
const replyFor = (k: string) => async (lines: string[]) => {
  await new Promise((r) => setTimeout(r, 800)); // spread Gemini calls out a little (shared quota)
  (replies[k] ??= []).push(lines);
  for (const l of lines) console.log(`    [reply → ${k}] ${l}`);
};
const alertsTo = () => {
  const m: Record<string, number> = {};
  for (const o of dryRunOutbox) {
    const k = o.spaceId.replace("tsp-pat-", "");
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
};
const lastReply = (k: string) => replies[k]?.at(-1)?.join(" ") ?? "";

try {
  console.log("\n# pure helpers");
  check(registeredDomain("https://pay.ntta-tollpay.top/x?y=1") === "ntta-tollpay.top", "registeredDomain: subdomain stripped");
  check(registeredDomain("www.hmrc-refund.co.uk/claim") === "hmrc-refund.co.uk", "registeredDomain: co.uk keeps 3 labels");
  check(registeredDomain("not a url") === null, "registeredDomain: junk → null");
  check(!/4\.35|555-0144|88213/.test(scrub("Pay $4.35 at 469-555-0144, ref 88213")), "scrub: amount, phone, code removed");
  check(jaccard("Pay {AMOUNT} at {LINK} now", "Pay {AMOUNT} at {LINK} now") === 1, "jaccard: identical = 1");
  check(normalizePlaceholders("{BRAND}: a ${AMOUNT} buy at {MERCHANT}, see {URL}", "Chase") === "Chase: a {AMOUNT} buy at {NAME}, see {LINK}", "placeholders normalised");
  check(P.applyPatternFloor("unsure", 0.85) === "likely_scam", "floor: unsure + 0.85 → likely_scam");
  check(P.applyPatternFloor("high_risk", 0.95) === "high_risk", "floor: never lowers");
  check(P.applyPatternFloor("safe", 0.5) === "safe", "floor: below 0.8 → unchanged");

  console.log("\n# ZIP keyword");
  check((await P.setZipFromText(users.H, "hello there")) === null, "non-ZIP text → null");
  check(/5-digit/.test((await P.setZipFromText(users.H, "zip 7508")) ?? ""), "bad ZIP → help text");
  check(/ZIP 99999/.test((await P.setZipFromText(users.H, "ZIP 99999")) ?? ""), "ZIP 99999 → saved");
  check((await fresh("H"))?.zip === "99999", "users.zip updated");
  await query("UPDATE users SET zip = NULL WHERE id = $1", [users.H.id]);
  await fresh("H");

  console.log("\n# nothing to report");
  await P.handleReport(users.A, replyFor("A"));
  check(/Forward or screenshot/.test(lastReply("A")), "REPORT with nothing remembered → ask for the message");
  await P.handleReport(users.A, replyFor("A"), "I want to report a scam");
  check(/Forward or screenshot/.test(lastReply("A")), "'I want to report a scam' (no content) → ask for the message");

  console.log("\n# 3 reports of the same toll scam in ZIP3 752 → spike");
  // 1: A, via a Flow 1 verdict then REPORT (remembered body + Jev's scam_type)
  P.rememberBody(users.A.id, "NTTA: Hi Maria, you have an unpaid toll balance of $4.35. Pay by Nov 10 to avoid a $50 late fee: https://ntta-tollpay.top/pay?id=88213", "toll_or_delivery");
  await P.handleReport(users.A, replyFor("A"));
  check(/You're the first near you/.test(lastReply("A")), "1st report → 'first near you'");
  // 2: B pastes the scam with the REPORT text
  await P.handleReport(users.B, replyFor("B"), "report this: NTTA Notice: James, your toll balance of $6.80 is past due. Pay now at ntta-tollpay.top/u/5521 to avoid a $75 penalty.", "toll_or_delivery");
  check(/2 people near you/.test(lastReply("B")), "2nd report → '2 people near you'");
  check(dryRunOutbox.length === 0, "no alerts yet");
  // 3: C pastes, no Jev scam_type (Gemini's category is used)
  await P.handleReport(users.C, replyFor("C"), "NTTA: Dear customer, unpaid toll of $11.20 on 11/07. Settle today at https://www.ntta-tollpay.top/r/x9k or your license may be suspended.");
  check(/3 people near you/.test(lastReply("C")) && /spiking/.test(lastReply("C")), "3rd report → '3 people near you' + spiking note");

  const toll = await query("SELECT * FROM report_templates WHERE link_domain = 'ntta-tollpay.top'");
  check(toll.rows.length === 1, `one template for the 3 variants (got ${toll.rows.length})`);
  const tollT = toll.rows[0];
  console.log(`    template: ${tollT?.template}`);
  console.log(`    brand=${tollT?.brand} scam_type=${tollT?.scam_type} domain=${tollT?.link_domain} status=${tollT?.status} emb=${tollT?.embedding?.length ?? 0}`);
  check(tollT?.status === "spiking", "status = spiking");
  const cnt = await one("SELECT sum(count)::int AS n FROM report_counts WHERE template_id = $1 AND zip3 = '752'", [tollT.id]);
  check(cnt?.n === 3, `report_counts 752 = 3 (got ${cnt?.n})`);
  const a1 = alertsTo();
  console.log(`    alerts by recipient: ${JSON.stringify(a1)}`);
  check(a1.A === 1 && a1.B === 1 && a1.D === 1, "A, B, D each got one local alert");
  check(!a1.C, "reporter C (who triggered the spike) not alerted");
  check(!a1.E && !a1.F && !a1.G && !a1.H, "not opted in / other ZIP3 / no thread / no ZIP: no alert");
  for (const o of dryRunOutbox.slice(0, 1)) console.log(`    alert text: ${o.text}`);

  const active = await P.activePatternsFor(users.A);
  check(active.length === 1 && active[0] === tollT.template, "activePatternsFor(752 user) → the toll template");
  check((await P.activePatternsFor(users.F)).length === 0, "activePatternsFor(761 user) → []");
  check((await P.activePatternsFor(users.H)).length === 0, "activePatternsFor(no ZIP) → []");

  console.log("\n# 4th report of the same scam → no re-alert");
  const n0 = dryRunOutbox.length;
  await P.handleReport(users.D, replyFor("D"), "NTTA toll alert: Robert, $3.15 unpaid. Pay at http://secure.ntta-tollpay.top/p/221 within 24 hours.", "toll_or_delivery");
  check(/4 people near you/.test(lastReply("D")) && !/spiking/.test(lastReply("D")), "4th report → '4 people near you', no spiking note");
  check(dryRunOutbox.length === n0, "no new alerts");

  console.log("\n# a different scam → new template; its spike can't re-alert anyone today");
  const bank = [
    ["A", "Chase Fraud Alert: Did you try a $1,249.00 purchase at Walmart? Reply YES or NO. If not, call us at 469-555-0144 now."],
    ["B", "Chase Fraud Dept: Was the $899.99 Best Buy charge you? If not, call 214-555-0199 right away to block your card."],
    ["C", "CHASE: Suspicious $560.00 purchase at Target flagged on your card. Not you? Call 972-555-0123 immediately."],
  ];
  for (const [k, text] of bank) await P.handleReport(users[k], replyFor(k), text, "bank_or_card");
  const all = await query("SELECT id, template, brand, scam_type, link_domain, status FROM report_templates WHERE NOT (id = ANY($1::uuid[]))", [[...before]]);
  const bankT = all.rows.filter((r) => r.id !== tollT.id);
  for (const r of bankT) console.log(`    template: [${r.scam_type}/${r.status}] ${r.template}`);
  check(bankT.length >= 1 && bankT.every((r) => r.scam_type === "bank_or_card"), "bank scam → its own template(s)");
  check(bankT.length === 1, `bank variants merged into one template (got ${bankT.length}; no shared domain, so this relies on embeddings/word overlap)`);
  check(dryRunOutbox.length === n0, "bank spike sent nothing: A, B, D already had today's local alert, C reported");

  console.log("\n# no ZIP → counted as 'unk'");
  await P.handleReport(users.H, replyFor("H"), "NTTA: Hi Ana, toll balance $2.10 overdue. Pay at ntta-tollpay.top/q/77 today.", "toll_or_delivery");
  check(/Text ZIP/.test(lastReply("H")), "reply asks for a ZIP");
  check(!!(await one("SELECT 1 FROM report_counts WHERE template_id = $1 AND zip3 = 'unk'", [tollT.id])), "counted under zip3 'unk'");

  console.log("\n# privacy");
  const cols = await query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('report_templates','report_counts','pattern_spikes')",
  );
  check(!cols.rows.some((c) => /user|handle|phone|sender|body/.test(c.column_name)), "no user / handle / sender / body columns");
  const dump = JSON.stringify((await query("SELECT template, brand, link_domain FROM report_templates")).rows);
  const leaks = ["Maria", "James", "Robert", "Ana", "4.35", "6.80", "11.20", "1,249", "88213", "5521", "x9k", "469-555", "214-555", "Walmart", "Best Buy"].filter((s) => dump.includes(s));
  check(leaks.length === 0, `no names, amounts, codes, numbers or merchants in templates${leaks.length ? ` (leaked: ${leaks.join(", ")})` : ""}`);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  const created = (await query<{ id: string }>("SELECT id FROM report_templates")).rows.map((r) => r.id).filter((id) => !before.has(id));
  await cleanup(created);
  const left = await one("SELECT (SELECT count(*) FROM users WHERE imessage_handle LIKE '+1555555017%')::int AS u");
  console.log(`\ncleanup: removed ${created.length} template(s) and test users (left: ${left?.u})`);
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  await pool.end();
  process.exit(failures ? 1 : 0);
}
