// Flow 4 test: real Jev (and Gemini for the bank script), DRY_RUN texts, any Postgres with the schema.
//   npm run test:recovery
//   DATABASE_URL=postgres://postgres@127.0.0.1:54330/bouncer npm run test:recovery   (local throwaway DB)
// Uses a fake +15555550141 handle and deletes every row it creates.
export {};
process.env.DRY_RUN = "1";
process.env.PHOTON_SOCKET = "off";

const HANDLE = "+15555550141";
const SPACE = "tsp-rec-0141";
const AGENT = "tsp-agent";

const { query, pool } = await import("../src/db.js");
const { getOrCreateUser, saveConversation, getUserById } = await import("../src/users.js");
const { dryRunOutbox } = await import("../src/photon/client.js");
const { startRecovery, handleRecoveryText, hasActiveRecovery, saysAlreadyPaid } = await import("../src/recovery/index.js");

let failures = 0;
const check = (name: string, cond: unknown, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n=== ${s} ===`);

// Leftovers from an aborted run.
await query("DELETE FROM events WHERE user_id IN (SELECT id FROM users WHERE imessage_handle = $1)", [HANDLE]);
await query("DELETE FROM users WHERE imessage_handle = $1", [HANDLE]);

const { user: created } = await getOrCreateUser(HANDLE);
await saveConversation(created.id, SPACE, AGENT);
const user = (await getUserById(created.id))!;
const userId = user.id;

let n = 0;
const msg = (text: string) => ({
  id: `test-rec-${++n}`,
  spaceId: SPACE,
  spaceKind: "direct",
  senderHandle: HANDLE,
  agentUserId: AGENT,
  text,
  attachmentIds: [] as string[],
  receivedAt: new Date().toISOString(),
});
const mark = () => dryRunOutbox.length;
const sentSince = (i: number) => dryRunOutbox.slice(i).filter((m) => m.spaceId === SPACE).map((m) => m.text);

/** Sends a reply; returns [consumed, texts sent]. */
async function reply(text: string): Promise<[boolean, string[]]> {
  const i = mark();
  const consumed = await handleRecoveryText(user, msg(text));
  return [consumed, sentSince(i)];
}
async function start(text: string | undefined, source: "text" | "call" | "family" = "text") {
  const i = mark();
  await startRecovery({ userId, text, source });
  return sentSince(i);
}
const lastEvent = () =>
  query<{ source: string; outcome: string; flags: string[]; risk_level: string | null; p_scam: number | null }>(
    "SELECT source, outcome, flags, risk_level, p_scam FROM events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [userId],
  ).then((r) => r.rows[0]);
const eventCount = () =>
  query("SELECT count(*)::int AS c FROM events WHERE user_id = $1", [userId]).then((r) => r.rows[0].c as number);

/** Walks DONE/NEXT through the whole checklist from step 2; checks one text per step and the end message. */
async function walk(total: number, loss: string, words = ["DONE", "next", "Skip", "done"]) {
  for (let step = 2; step <= total; step++) {
    const [ok, texts] = await reply(words[(step - 2) % words.length]);
    check(`step ${step}/${total} sent once`, ok && texts.length >= 1 && texts[0].startsWith(`Step ${step} of ${total}:`), texts.join(" | "));
    check(`step ${step} ends with DONE/NEXT prompt`, texts.at(-1)?.endsWith("Reply DONE when you've done it, or NEXT to skip."));
  }
  const before = await eventCount();
  const [ok, texts] = await reply("Done.");
  check("end message after last step", ok && texts.length === 1 && texts[0] === "That's everything. You did the right things fast.", texts.join(" | "));
  check("recovery closed", !hasActiveRecovery(userId));
  const ev = await lastEvent();
  check("one events row", (await eventCount()) === before + 1);
  check(`event: recovery/completed/loss:${loss}`, ev?.source === "recovery" && ev.outcome === "completed" && ev.flags.join() === `loss:${loss}`, JSON.stringify(ev));
  check("event has no level or score", ev?.risk_level === null && ev?.p_scam === null);
}

try {
  section("A. gift cards (classified) → full checklist");
  let texts = await start("I bought $500 of Target gift cards for the IRS guy");
  check("one text", texts.length === 1, texts.join(" | "));
  check("step 1 = call the gift card company", /^Step 1 of 3: Call the gift card company/.test(texts[0] ?? ""), texts[0]);
  check("no amount echoed", !texts.some((t) => t.includes("500")));
  const [, t2] = await reply("DONE");
  check("step 2 = keep cards and receipt", /^Step 2 of 3: Keep the gift cards/.test(t2[0] ?? ""), t2[0]);
  const [, t3] = await reply("NEXT");
  check("step 3 = 7726 + ReportFraud.ftc.gov", /7726/.test(t3[0] ?? "") && /ReportFraud\.ftc\.gov/.test(t3[0] ?? ""), t3[0]);
  const [okEnd, tEnd] = await reply("done");
  check("end message", okEnd && tEnd[0] === "That's everything. You did the right things fast.", tEnd.join(" | "));
  let ev = await lastEvent();
  check("event completed loss:paid_gift_card", ev?.outcome === "completed" && ev.flags.join() === "loss:paid_gift_card", JSON.stringify(ev));
  const [after] = await reply("done");
  check("DONE with nothing active → false", after === false);

  section("B. shared a code → STOP");
  texts = await start("I gave him the code from my text");
  check("one text", texts.length === 1, texts.join(" | "));
  check("step 1 = change password (shared_code)", /^Step 1 of 4: Someone may be getting into your account/.test(texts[0] ?? ""), texts[0]);
  const [unrelated] = await reply("is this message from my bank real? they say my account is locked");
  check("unrelated text → false", unrelated === false);
  check("recovery still open", hasActiveRecovery(userId));
  const [stopped, tStop] = await reply("STOP");
  check("STOP consumed", stopped && /stopped the steps/.test(tStop[0] ?? ""), tStop.join(" | "));
  ev = await lastEvent();
  check("event stopped loss:shared_code", ev?.outcome === "stopped" && ev.flags.join() === "loss:shared_code", JSON.stringify(ev));

  section("C. Zelle → bank script with blanks");
  texts = await start("I sent $900 on Zelle");
  check("step 1 + script = two texts", texts.length === 2, texts.join(" | "));
  check("step 1 = call your bank", /^Step 1 of 3: Call your bank now/.test(texts[0] ?? ""), texts[0]);
  const script = texts[1] ?? "";
  console.log(`      script:\n${script.replace(/^/gm, "        ")}`);
  check("script has blanks", /\[amount\]/.test(script) && /\[date\]/.test(script), script);
  check("script has no amount or long numbers", !/900/.test(script) && !/\d{4,}/.test(script));
  check("script ends with DONE/NEXT prompt", script.endsWith("Reply DONE when you've done it, or NEXT to skip."));
  await walk(3, "paid_bank_or_p2p", ["next", "skip"]);

  section("D. ambiguous → menu → 6 (crypto)");
  texts = await start("ugh I think I messed up, can you help");
  check("menu sent", texts.length === 1 && /What happened\? Reply 1 clicked a link/.test(texts[0] ?? ""), texts.join(" | "));
  const [notNum] = await reply("next");
  check("NEXT while menu open → false", notNum === false);
  const [ok6, t6] = await reply("6");
  check("\"6\" → crypto step 1", ok6 && /^Step 1 of 3: Open your crypto app/.test(t6[0] ?? ""), t6.join(" | "));
  await walk(3, "paid_crypto");

  section("E. family YES (no text) → menu; restart abandons the old one");
  texts = await start(undefined, "family");
  check("menu sent", /What happened\?/.test(texts[0] ?? ""), texts.join(" | "));
  const [ok4, t4] = await reply("4");
  check("\"4\" → card step 1 (lock card)", ok4 && /^Step 1 of 3: Lock your card/.test(t4[0] ?? ""), t4.join(" | "));
  const [, t4b] = await reply("done");
  check("card step 2 + script", t4b.length === 2 && /back of your card/.test(t4b[0]) && /\[amount\]/.test(t4b[1]), t4b.join(" | "));
  texts = await start("I typed my password into that site");
  ev = (await query("SELECT outcome, flags FROM events WHERE user_id = $1 AND outcome = 'abandoned'", [userId])).rows[0];
  check("old recovery logged abandoned loss:paid_card", ev?.flags?.join() === "loss:paid_card", JSON.stringify(ev));
  check("new one: entered_password step 1", /^Step 1 of 4: Change that password now/.test(texts[0] ?? ""), texts.join(" | "));
  const [okC] = await reply("cancel");
  check("cancel consumed", okC && !hasActiveRecovery(userId));

  section("F. spoken trigger regex");
  for (const t of [
    "Hey Bouncer, I already paid him",
    "hey bouncer I sent him 500 dollars on Zelle",
    "I gave him the code from my text",
    "okay bouncer I've already bought the gift cards",
    "Hey Bouncer I just read him my PIN",
    "I clicked the link",
  ]) check(`speaks paid: "${t}"`, saysAlreadyPaid(t));
  for (const t of [
    "Hey Bouncer, is this call real?",
    "Hey Bouncer, should I pay him?",
    "I haven't paid anything yet",
    "I never sent money",
    "hi bouncer, he wants a gift card",
  ]) check(`not paid: "${t}"`, !saysAlreadyPaid(t));

  section("Privacy");
  const rows = (await query("SELECT source, outcome, flags FROM events WHERE user_id = $1", [userId])).rows;
  const dump = JSON.stringify(rows);
  check("events rows only hold loss type and outcome", rows.every((r) => r.source === "recovery") && !/500|900|zelle|target|irs/i.test(dump), dump);
  console.log(`      ${rows.length} events rows: ${rows.map((r) => `${r.outcome}/${r.flags}`).join(", ")}`);
} finally {
  await query("DELETE FROM events WHERE user_id = $1", [userId]);
  await query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
}

console.log(`\n${failures ? `${failures} FAILED` : "All checks passed"}`);
process.exit(failures ? 1 : 0);
