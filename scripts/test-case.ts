// Case memory end to end: a scam call ends → its facts become the user's case → texts are understood in
// context. Real Jev + wording model, DRY_RUN texts, any Postgres with the schema.
//   npm run test:case
//   DATABASE_URL=postgres://postgres@127.0.0.1:54330/bouncer npm run test:case   (local throwaway DB)
// Uses a fake +15555550151 handle and deletes every row it creates.
export {};
process.env.DRY_RUN = "1";
process.env.PHOTON_SOCKET = "off";

const HANDLE = "+15555550151";
const SPACE = "tsp-case-0151";
const AGENT = "tsp-agent";

const { query, pool } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const { getOrCreateUser, saveConversation } = await import("../src/users.js");
const { dryRunOutbox } = await import("../src/photon/client.js");
const { getOrCreateSession } = await import("../src/voice/session.js");
const { onCallEnded } = await import("../src/voice/callEnd.js");
const { handleInbound } = await import("../src/messages/inbound.js");
const { getCase, closeCase } = await import("../src/messages/case.js");
const { getHistory, addUserTurn, addBouncerTurn, clearHistory } = await import("../src/messages/history.js");
const { hasActiveRecovery } = await import("../src/recovery/index.js");

let failures = 0;
const check = (name: string, cond: unknown, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n=== ${s} ===`);

await query("DELETE FROM feedback WHERE user_id IN (SELECT id FROM users WHERE imessage_handle = $1)", [HANDLE]);
await query("DELETE FROM events WHERE user_id IN (SELECT id FROM users WHERE imessage_handle = $1)", [HANDLE]);
await query("DELETE FROM users WHERE imessage_handle = $1", [HANDLE]);
const { user } = await getOrCreateUser(HANDLE);
await saveConversation(user.id, SPACE, AGENT);
const userId = user.id;

let n = 0;
const msg = (text: string) => ({
  id: `test-case-${Date.now()}-${++n}`,
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
async function send(text: string): Promise<string[]> {
  const i = mark();
  const t0 = Date.now();
  await handleInbound(msg(text));
  const out = sentSince(i);
  console.log(`      you: ${JSON.stringify(text)}  (${Date.now() - t0} ms)\n      bouncer: ${out.map((t) => JSON.stringify(t)).join("\n               ")}`);
  return out;
}
const imessageEvents = () =>
  query("SELECT count(*)::int AS c FROM events WHERE user_id = $1 AND source = 'imessage'", [userId]).then((r) => r.rows[0].c as number);

try {
  section("1. A Klarna scam call ends → case opened from the transcript, transcript dropped");
  const conv = `test-case-conv-${Date.now()}`;
  const s = getOrCreateSession(conv);
  s.userId = userId;
  s.turns = [
    "Hello, this is the account security team. Your account was hacked and you owe a fee.",
    "You need to send us 5k today or you lose everything.",
    "I only have 1k.",
    "Well you can give us 1.5k then.",
    "I can't do that.",
    "That's fine, we accept Klarna. I'll text you the link.",
  ];
  s.level = "likely_scam";
  s.p = 0.82;
  s.scamType = "other";
  s.flags = new Set(["money_or_code", "urgency_secrecy", "impersonation"]);
  s.alerted = new Set(["money_or_code"]);
  s.alertCount = 1;
  let i = mark();
  await onCallEnded({
    type: "post_call_transcription",
    data: { agent_id: config.elevenlabs.listenAgentId, conversation_id: conv, metadata: { call_duration_secs: 95 } },
  });
  const summary = sentSince(i);
  console.log(`      summary: ${JSON.stringify(summary[0] ?? "")}`);
  const c = getCase(userId);
  check("case opened from the call", c?.source === "call" && c.level === "likely_scam", JSON.stringify(c));
  check("payment = Klarna (pay-later)", c?.payment?.method === "bnpl" && c.payment.label === "Klarna", JSON.stringify(c?.payment));
  check("amounts $5,000 → $1,000 → $1,500", c?.amounts.join() === "$5,000,$1,000,$1,500", c?.amounts.join());
  check("summary is one short line", !!c && c.summary.length <= 201 && !c.summary.includes("\n"), c?.summary);
  check("transcript dropped after the webhook", s.turns.length === 0);
  check("summary text sent", summary.length === 1);
  const note = getHistory(userId).turns.find((t) => t.role === "bouncer" && t.text.startsWith("[Bouncer texted a call summary]"));
  check("chat memory has a short note of the summary", !!note && note.text.length <= 360, note?.text);

  section("2. \"I already paid\" → Bouncer confirms Klarna from the call (no 9-option menu)");
  let texts = await send("I already paid");
  check("asks to confirm Klarna after that call", /paid with Klarna after that call\. Is that right\?/.test(texts.join(" ")), texts.join(" | "));
  check("no menu", !/Reply 1 clicked a link/.test(texts.join(" ")));
  check("recovery open", hasActiveRecovery(userId));

  section("3. YES goes to recovery, not to the post-call \"Was it a scam?\" question");
  texts = await send("yes");
  check("YES → Klarna step 1", /^Step 1 of 3: Open the Klarna app yourself/.test(texts[0] ?? ""), texts.join(" | "));
  const fb = (await query("SELECT count(*)::int AS c FROM feedback WHERE user_id = $1", [userId])).rows[0].c;
  check("YES not stored as call feedback", fb === 0, `feedback rows: ${fb}`);
  texts = await send("stop");
  check("STOP ends it", /stopped the steps/.test(texts[0] ?? "") && !hasActiveRecovery(userId), texts.join(" | "));

  section("4. A short reply during the case is answered in context, never scanned as a new message");
  let before = await imessageEvents();
  texts = await send("klarna link");
  check("got a reply", texts.length >= 1);
  check("not scanned (no imessage verdict logged)", (await imessageEvents()) === before);
  check("no scam-verdict wording", !/% sure|chance it's a scam|Not sure \(/i.test(texts.join(" ")), texts.join(" | "));
  texts = await send("what should I do now?");
  check("follow-up answered", texts.length >= 1);
  check("still not scanned", (await imessageEvents()) === before);

  section("5. A pasted message with a link during the case still gets a full scan");
  before = await imessageEvents();
  texts = await send("Klarna: your account is locked. Verify now at klarna-secure-login.com/verify or lose access");
  check("scanned (imessage verdict logged)", (await imessageEvents()) === before + 1, texts.join(" | "));

  section("6. Long chats are compacted: a short summary + the last turns");
  clearHistory(userId);
  for (let k = 1; k <= 5; k++) {
    addUserTurn(userId, k === 1 ? "Is this text real? It says to call 214-555-0199 and go to chase-alerts.co" : `follow-up question ${k} about that text`);
    addBouncerTurn(userId, k === 1 ? "That looks like a likely scam: the link doesn't match Chase." : `answer ${k}: use the official Chase app.`);
  }
  const deadline = Date.now() + 10_000;
  while (!getHistory(userId).summary && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  const h = getHistory(userId);
  console.log(`      summary (${h.summary?.length ?? 0} chars): ${JSON.stringify(h.summary)}`);
  check("summary written", !!h.summary);
  check("summary ≤ 281 chars", (h.summary?.length ?? 999) <= 281);
  check("summary drops numbers and links", !!h.summary && !/214|0199|chase-alerts\.co/i.test(h.summary), h.summary ?? "");
  check("only the newest turns kept word for word", h.turns.length <= 6, `${h.turns.length} turns`);

  section("Privacy");
  const rows = (await query("SELECT source, risk_level, scam_type, flags, outcome FROM events WHERE user_id = $1", [userId])).rows;
  const dump = JSON.stringify(rows);
  check("events hold no amounts, Klarna or text", !/5,000|1,500|5k|1\.5k|klarna|hacked/i.test(dump), dump);
} finally {
  closeCase(userId);
  clearHistory(userId);
  await query("DELETE FROM feedback WHERE user_id = $1", [userId]);
  await query("DELETE FROM events WHERE user_id = $1", [userId]);
  await query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
}

console.log(`\n${failures ? `${failures} FAILED` : "All checks passed"}`);
process.exit(failures ? 1 : 0);
