// Flow 3 setup-by-text test (reworked Nov 8: whole family protected, titles like "Mom", one family-alerts
// switch per person) with DRY_RUN on: texts go to the in-memory outbox instead of Photon, no phone rings.
// The emergency at the end matches "Mom" by code; Jev is only called for the family-text classifier.
//   DATABASE_URL=postgres://… npm run test:setup      (an env DATABASE_URL wins over .env)
// Uses fake +1214555014x handles and deletes every row it creates.
export {};
process.env.DRY_RUN = "1";
process.env.PHOTON_SOCKET = "off";

// Test-only words, typed with messy case and punctuation like a real text.
const WORD_TYPED = "Blue-Heron Sunrise!";
const WORD = "blue heron sunrise";
const WORD2_TYPED = "Copper  Kettle.";
const WORD2 = "copper kettle";
const WORD_RE = /heron|sunrise|copper|kettle/i;

const H = { sam: "+12145550141", gma: "+12145550142", mom: "+12145550143", jake: "+12145550144", eve: "+12145550145", nora: "+12145550146" };
const JOE = "+12145550147"; // listed in Eve's circle only, never texts
type Who = keyof typeof H;
const SPACE = (w: Who) => `tsu-${w}-space`;
const AGENT = "tsu-agent";

// Capture everything the code logs, to check that names, numbers and the word never leak.
const logs: string[] = [];
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    orig(...a);
  };
}

const { query, one, pool } = await import("../src/db.js");
const { getOrCreateUser, saveConversation, getUserById } = await import("../src/users.js");
const setup = await import("../src/family/setup.js");
const family = await import("../src/family/index.js");
const { parseYesNo, resolvePending, peekPending } = await import("../src/pending.js");
const { dryRunOutbox } = await import("../src/photon/client.js");
const { parseSystemVars } = await import("../src/voice/sse.js");
const { decryptWord } = await import("../src/family/crypto.js");
const { getSafeWordRow } = await import("../src/family/circle.js");
const { notifyFamily } = await import("../src/family/alerts.js");

family.familyTimings.alertWaitMs = 1_500;
family.familyTimings.retriggerCooldownMs = 0;

let failures = 0;
const check = (name: string, cond: unknown, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n=== ${s} ===`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}
const outboxTo = (w: Who, since: number) => dryRunOutbox.slice(since).filter((m) => m.spaceId === SPACE(w));
const textsTo = (w: Who, since: number) => outboxTo(w, since).map((m) => m.text);

/**
 * One inbound iMessage through the same order the router uses (proposed inbound.ts wiring):
 * YES/NO for a parked action → Flow 3 emergency texts → setup → (else the normal router).
 */
async function send(who: Who, body: string, spaceKind = "direct") {
  const since = dryRunOutbox.length;
  const msg = {
    id: "tmsg-" + Math.random().toString(36).slice(2, 10),
    spaceId: spaceKind === "direct" ? SPACE(who) : `tsu-${who}-group`,
    spaceKind,
    senderHandle: H[who],
    agentUserId: AGENT,
    text: body,
    attachmentIds: [] as string[],
    receivedAt: new Date().toISOString(),
  };
  const { user: u } = await getOrCreateUser(msg.senderHandle);
  if (spaceKind === "direct") await saveConversation(u.id, msg.spaceId, msg.agentUserId);
  const user = (await getUserById(u.id))!;
  let route = "router";
  const yn = parseYesNo(body);
  if (yn && (await resolvePending(user.id, yn))) route = "pending";
  else if (await family.handleFamilyText(user, msg)) route = "family";
  else if (await setup.handleSetupText(user, msg)) route = "setup";
  return { route, replies: textsTo(who, since), all: dryRunOutbox.slice(since), userId: user.id };
}
const has = (rs: string[], s: string | RegExp) => rs.some((r) => (typeof s === "string" ? r.includes(s) : s.test(r)));

async function cleanup() {
  const { rows } = await query<{ id: string }>("SELECT id FROM users WHERE imessage_handle = ANY($1) OR voice_phone = ANY($1)", [Object.values(H)]);
  const uids = rows.map((r) => r.id);
  if (!uids.length) return;
  await query("DELETE FROM events WHERE user_id = ANY($1)", [uids]);
  await query("DELETE FROM circles WHERE protected_user_id = ANY($1) OR organizer_user_id = ANY($1)", [uids]);
  await query("DELETE FROM users WHERE id = ANY($1)", [uids]);
}

type Msg = { role: string; content: string };
async function verifyTurn(v: { id: string; conv: string }, history: Msg[]) {
  const messages: Msg[] = [
    { role: "system", content: `verify=${v.id} conv=${v.conv}` },
    { role: "assistant", content: "Hi Maria, this is Bouncer calling for Sam. Are you safe right now?" },
    ...history,
  ];
  const res = await family.handleVerifyTurn({} as any, { model: "bouncer-verify", stream: true, messages }, parseSystemVars(messages));
  let content = "";
  let endCall = false;
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ") || line.trim() === "data: [DONE]") continue;
    const d = JSON.parse(line.slice(6)).choices[0].delta;
    if (d.content) content += d.content;
    if ((d.tool_calls ?? []).some((t: any) => t.function.name === "end_call")) endCall = true;
  }
  return { content, endCall };
}

let ids = { sam: "", gma: "", mom: "", jake: "", eve: "", circle: "", code: "" };
const ASK_ALERTS = "Want an instant text if anyone in your family is targeted by a scam? Reply YES or NO.";
const member = (title: string) =>
  one("SELECT * FROM circle_members WHERE circle_id = $1 AND title IS NOT DISTINCT FROM $2", [ids.circle, title]);

try {
  await cleanup();

  section("before setup");
  {
    const g = await send("gma", "hi");
    ids.gma = g.userId;
    check("Grandma's hello is not a setup text", g.route === "router");
    check(
      "isSetupCommand (setup, join, alerts)",
      setup.isSetupCommand("Set up family!") &&
        setup.isSetupCommand("join ab12cd") &&
        setup.isSetupCommand("Family alerts ON") &&
        setup.isSetupCommand("turn off family alerts") &&
        !setup.isSetupCommand("hello"),
    );
    const grp = await send("sam", "set up family", "group");
    check("group chat → asked to use a 1:1 chat", grp.route === "setup" && grp.replies.length === 0 && grp.all.some((m) => m.text.includes("1:1 chat")));
  }

  section("1: organizer builds the family, one question per message");
  {
    let r = await send("sam", "Set up family");
    ids.sam = r.userId;
    check("start → intro (everyone protected) + first-name question", r.route === "setup" && has(r.replies, "I'll protect everyone in it") && has(r.replies, "what's your first name?"), r.replies.join(" | "));
    check("no 'who should I protect' step", !has(r.replies, "Who should I protect"));
    r = await send("sam", "sam");
    check("name → first title question (Mom or Grandma)", has(r.replies, "Thanks, Sam.") && has(r.replies, "Who's first? Text what you call them, like Mom or Grandma."), r.replies.join(" | "));
    r = await send("sam", "done");
    check("DONE with nobody → asks for one person", has(r.replies, "Add at least one person first"));
    r = await send("sam", "Grandma");
    check("title → first name question", has(r.replies, "What's Grandma's first name?"), r.replies.join(" | "));
    r = await send("sam", "123");
    check("bad name → re-ask", has(r.replies, "Just Grandma's first name, please."), r.replies.join(" | "));
    r = await send("sam", "rosa");
    check("name → cell number question", has(r.replies, "What's Grandma's cell number?"), r.replies.join(" | "));
    r = await send("sam", "call me maybe");
    check("bad number → re-ask", has(r.replies, "doesn't look like a phone number"));
    r = await send("sam", "(214) 555-0142");
    check("added with title + name, next question", has(r.replies, "Added Grandma (Rosa).") && has(r.replies, "Who's next? Text what you call them, or DONE"), r.replies.join(" | "));
    r = await send("sam", "grandma");
    check("duplicate title → re-ask", has(r.replies, "You already added Grandma (Rosa).") , r.replies.join(" | "));
    r = await send("sam", "my mom");
    check("'my mom' → title Mom", has(r.replies, "What's Mom's first name?"), r.replies.join(" | "));
    await send("sam", "Maria");
    r = await send("sam", "+1 214 555 0141");
    check("organizer's own number → rejected", has(r.replies, "That's your number. What's Mom's own number?"), r.replies.join(" | "));
    r = await send("sam", "214.555.0142");
    check("duplicate member number → rejected", has(r.replies, "Grandma already has that number."), r.replies.join(" | "));
    r = await send("sam", "214 555 0143");
    check("Mom added", has(r.replies, "Added Mom (Maria)."), r.replies.join(" | "));
    await send("sam", "Jake");
    await send("sam", "jake");
    r = await send("sam", "214-555-0144");
    check("title = name → just the name", has(r.replies, "Added Jake."), r.replies.join(" | "));
    r = await send("sam", "That's all");
    const join = r.replies.join(" ").match(/Text JOIN ([A-Z0-9]{6}) to Bouncer at /);
    check("DONE → circle ready + JOIN text", !!join && has(r.replies, "I'll protect each of them once they reply YES."), r.replies.join(" | "));
    check("DONE → whole-family alerts question", has(r.replies, ASK_ALERTS), r.replies.join(" | "));
    ids.code = join?.[1] ?? "";
    r = await send("sam", "maybe later");
    check("unclear answer → alerts re-ask", has(r.replies, "Reply YES for instant family scam alerts, or NO"), r.replies.join(" | "));
    r = await send("sam", "Yes");
    check("YES → alerts on + safe word question (SPEC wording)", r.route === "setup" && has(r.replies, "Family alerts are on.") && has(r.replies, "Text FAMILY ALERTS ON or OFF any time") && has(r.replies, "Pick a word or short phrase you'd never say by accident and tell your family in person. Then text it to me here."), r.replies.join(" | "));
  }

  section("2: circle rows");
  {
    const c = await one("SELECT id, organizer_user_id, protected_user_id, join_code FROM circles WHERE join_code = $1", [ids.code]);
    ids.circle = c?.id ?? "";
    check("circle: organizer Sam, protected_user_id = organizer, 6-char code", c && c.organizer_user_id === ids.sam && c.protected_user_id === ids.sam && /^[A-Z2-9]{6}$/.test(c.join_code));
    const { rows } = await query("SELECT * FROM circle_members WHERE circle_id = $1 ORDER BY created_at", [ids.circle]);
    check("4 rows, one per person, all role 'relative'", rows.length === 4 && rows.every((m: any) => m.role === "relative"), JSON.stringify(rows.map((m: any) => [m.name, m.title, m.role])));
    const self = rows.find((m: any) => m.user_id === ids.sam);
    check("Sam's own row: title NULL, joined, phone, space, alerts on", self && self.title === null && self.name === "Sam" && self.joined && self.phone === H.sam && self.space_id === SPACE("sam") && self.alerts === true, JSON.stringify(self));
    const g = rows.find((m: any) => m.title === "Grandma");
    check("Grandma: name Rosa, E.164 phone, not joined, alerts off", g?.name === "Rosa" && g.phone === H.gma && g.imessage_handle === H.gma && !g.joined && !g.alerts && g.user_id === null);
    const m = rows.find((x: any) => x.title === "Mom");
    check("Mom: name Maria, not joined", m?.name === "Maria" && m.phone === H.mom && !m.joined);
    check("Jake: title Jake", rows.some((x: any) => x.title === "Jake" && x.name === "Jake" && x.phone === H.jake));
    check("no safe word yet", !(await getSafeWordRow(ids.circle)));
  }

  section("3: safe word");
  {
    const r = await send("sam", WORD_TYPED);
    check("word → SPEC confirmation, nothing else", r.route === "setup" && r.replies.length === 1 && r.replies[0] === "Saved and encrypted. I'll never say it on a call. You can delete your message now.", r.replies.join(" | "));
    const row = await getSafeWordRow(ids.circle);
    check("stored encrypted; decrypts to the normalised word", !!row && decryptWord(row, ids.circle) === WORD && !Buffer.from(row.ciphertext).toString("utf8").toLowerCase().includes("heron") && row.iv.length === 12);
    const after = await send("sam", "hello");
    check("setup is over: next text goes to the router", after.route === "router");
  }

  section("4: JOIN + YES + family alerts YES/NO");
  {
    let r = await send("eve", `JOIN ${ids.code}`);
    ids.eve = r.userId;
    check("unlisted number → not on the list", r.route === "setup" && has(r.replies, "isn't on that family list"), r.replies.join(" | "));
    r = await send("jake", "JOIN ZZZZZZ");
    check("unknown code → not found", has(r.replies, "couldn't find that code"));
    r = await send("jake", `join ${ids.code.toLowerCase()}`);
    ids.jake = r.userId;
    check(
      "consent text",
      r.replies.length === 1 &&
        r.replies[0] ===
          "Sam added you to their Bouncer family circle. If someone pretends to be family to scam you, I'll help you check. I may also call this number once to check you're safe. I never share your messages. Reply YES to join.",
      r.replies.join(" | "),
    );
    check("circle_join pending", peekPending(ids.jake)?.kind === "circle_join");
    check("not joined before YES", !(await member("Jake"))?.joined);
    let ts = dryRunOutbox.length;
    r = await send("jake", "Yes");
    check("YES → joined + protected + alerts question", r.route === "pending" && has(r.replies, "You're in Sam's family circle. I'm protecting you now.") && has(r.replies, ASK_ALERTS), r.replies.join(" | "));
    const jm = await member("Jake");
    check("Jake row: joined, user linked, space stored", jm?.joined && jm.user_id === ids.jake && jm.space_id === SPACE("jake"));
    check("organizer told (by title) Jake joined", has(textsTo("sam", ts), "Jake joined your family circle."), textsTo("sam", ts).join(" | "));
    check("family_alerts pending", peekPending(ids.jake)?.kind === "family_alerts");
    r = await send("jake", "no");
    check("NO → alerts off reply", r.route === "pending" && has(r.replies, "Okay, family alerts are off.") && has(r.replies, "FAMILY ALERTS ON or OFF"), r.replies.join(" | "));
    check("Jake alerts off", (await member("Jake"))?.alerts === false);

    r = await send("mom", `JOIN ${ids.code}`);
    ids.mom = r.userId;
    r = await send("mom", "no");
    check("NO to joining → not joined", r.route === "pending" && has(r.replies, "you're not in the circle"));
    check("Mom still not joined", !(await member("Mom"))?.joined);
    r = await send("mom", "change safe word");
    check("not-yet-joined member can't change the word", has(r.replies, "You don't have a family circle yet."), r.replies.join(" | "));
    await send("mom", `JOIN ${ids.code}`);
    await send("mom", "yes");
    r = await send("mom", "no");
    check("Mom joins with alerts off", has(r.replies, "family alerts are off") && (await member("Mom"))?.joined && (await member("Mom"))?.alerts === false, r.replies.join(" | "));

    await send("gma", `JOIN ${ids.code}`);
    ts = dryRunOutbox.length;
    await send("gma", "yes");
    check("organizer told Grandma joined (his title)", has(textsTo("sam", ts), "Grandma joined your family circle."), textsTo("sam", ts).join(" | "));
    r = await send("gma", "yes");
    check("Grandma alerts YES → on", has(r.replies, "Family alerts are on.") && (await member("Grandma"))?.alerts === true, r.replies.join(" | "));
    r = await send("jake", `JOIN ${ids.code}`);
    check("JOIN again → already in", has(r.replies, "You're already in Sam's family circle."), r.replies.join(" | "));
  }

  section("5: FAMILY ALERTS ON / OFF");
  {
    let r = await send("mom", "Family alerts on");
    check("Mom turns alerts on", r.route === "setup" && has(r.replies, "Family alerts are on.") && (await member("Mom"))?.alerts === true, r.replies.join(" | "));
    r = await send("jake", "turn on family alerts");
    check("'turn on family alerts' works", has(r.replies, "Family alerts are on.") && (await member("Jake"))?.alerts === true, r.replies.join(" | "));
    r = await send("jake", "alerts off");
    check("'alerts off' → off, still protected", has(r.replies, "Family alerts are off. I'll still protect everyone") && (await member("Jake"))?.alerts === false, r.replies.join(" | "));
    r = await send("nora", "family alerts on");
    check("no circle → told to set one up", has(r.replies, "You're not in a family circle yet."), r.replies.join(" | "));
  }

  section("6: change safe word");
  {
    let r = await send("sam", "Change my safe word");
    check("organizer → asks for the new word", has(r.replies, "a new safe word for your family") && has(r.replies, "Pick a word"), r.replies.join(" | "));
    r = await send("sam", "cancel");
    check("cancel → old word kept", has(r.replies, "didn't save a new safe word") && decryptWord((await getSafeWordRow(ids.circle))!, ids.circle) === WORD);
    r = await send("jake", "new safe word");
    check("joined member can change it too", has(r.replies, "a new safe word for your family"), r.replies.join(" | "));
    r = await send("jake", "one two three four five six seven");
    check("too long → re-ask", has(r.replies, "That's long for a safe word"));
    r = await send("jake", WORD2_TYPED);
    check("saved", r.replies[0] === "Saved and encrypted. I'll never say it on a call. You can delete your message now.");
    check("new word decrypts", decryptWord((await getSafeWordRow(ids.circle))!, ids.circle) === WORD2);
  }

  section("7: guards (second organizer)");
  {
    let r = await send("eve", "family setup");
    check("Eve starts setup", has(r.replies, "what's your first name?"));
    await send("eve", "Eve");
    await send("eve", "Nana");
    await send("eve", "Nora");
    r = await send("eve", "214-555-0146");
    check("Nana added", has(r.replies, "Added Nana (Nora)."), r.replies.join(" | "));
    await send("eve", "Uncle Joe");
    await send("eve", "Joe");
    r = await send("eve", "214-555-0146");
    check("same number as Nana → rejected", has(r.replies, "Nana already has that number."), r.replies.join(" | "));
    await send("eve", JOE);
    r = await send("eve", "done");
    check("Eve's circle ready → alerts question", has(r.replies, ASK_ALERTS));
    r = await send("eve", "cancel");
    check("CANCEL during alerts → alerts stay off", has(r.replies, "Okay, family alerts stay off.") && has(r.replies, "FAMILY ALERTS ON or OFF"), r.replies.join(" | "));
    check("draft ended", (await send("eve", "hello")).route === "router");
    const ec = await one("SELECT id FROM circles WHERE organizer_user_id = $1", [ids.eve]);
    const eself = ec ? await one("SELECT alerts, joined FROM circle_members WHERE circle_id = $1 AND user_id = $2", [ec.id, ids.eve]) : null;
    check("Eve's circle kept, her alerts off, no safe word", !!ec && eself?.joined && eself.alerts === false && !(await getSafeWordRow(ec.id)));
    check("Sam's circle untouched", (await one("SELECT organizer_user_id FROM circles WHERE id = $1", [ids.circle]))?.organizer_user_id === ids.sam);

    r = await send("eve", "add family");
    check("existing circle → replace warning", has(r.replies, "You already have a family circle. Finishing this replaces it."), r.replies.join(" | "));
    r = await send("eve", "cancel");
    check("cancel → stopped", has(r.replies, "I stopped family setup"));
    check("no user row for Joe", !(await one("SELECT 1 FROM users WHERE imessage_handle = $1", [JOE])));

    await send("eve", "set up family");
    r = await send("eve", "Your package is held, pay the fee at https://usps-redeliver.top/x");
    check("pasted link mid-setup → setup stops, router checks it", r.route === "router" && has(r.all.map((m) => m.text), "I stopped family setup"));
  }

  section("8: the organizer's emergency finds 'Mom' by title");
  {
    const mom = await member("Mom");
    const t = dryRunOutbox.length;
    const tl = logs.length;
    await family.startFamilyEmergency({ userId: ids.sam, content: "Mom is in jail and needs bail", source: "text" });
    const coach = textsTo("sam", t);
    check("coach text uses his title and her pronouns", has(coach, "Ask her for the family safe word") && has(coach, "I'm checking on Mom."), coach.join(" | "));
    check("matched by title, no Jev", logs.slice(tl).some((l) => l.includes("(title/name match)")));
    check("would call Mom", logs.slice(tl).some((l) => l.includes(`would call relative ${mom?.id}`)));
    const v = await one<{ id: string; conversation_id: string; target_user_id: string }>(
      "SELECT id, conversation_id, target_user_id FROM verifications WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 1",
      [ids.circle],
    );
    check("verification row targets Sam", v?.target_user_id === ids.sam);

    const r = await send("sam", "what's the safe word?");
    const sent = r.all.filter((m) => m.spaceId === SPACE("sam"));
    check("Sam asks for the word → sensitive text with the new word", r.route === "family" && sent.length === 1 && sent[0].sensitive && sent[0].text.includes(WORD2));

    const vv = { id: v!.id, conv: v!.conversation_id };
    const h: Msg[] = [{ role: "user", content: "Yeah I'm fine, I'm at work." }];
    const t1 = await verifyTurn(vv, h);
    h.push({ role: "assistant", content: t1.content }, { role: "user", content: "It's copper kettle." });
    const t2 = await verifyTurn(vv, h);
    check("Mom says the word set by Jake → accepted", t2.endCall && t2.content.startsWith("Thank you, that's right."), t2.content);
    check("verified_safe", await waitFor(async () => (await one("SELECT status FROM verifications WHERE id = $1", [v!.id]))?.status === "verified_safe"));
    check("result text to Sam names Mom", await waitFor(() => has(textsTo("sam", t), "Mom just answered her own phone")), textsTo("sam", t).join(" | "));
    await waitFor(() => peekPending(ids.sam)?.kind === "loss_question");
    const ta = dryRunOutbox.length;
    await send("sam", "no");
    const expected = "Sam received a likely family-emergency scam. Maria is safe. No money was sent.";
    check("Grandma (alerts on) alerted by first name", textsTo("gma", ta).includes(expected), textsTo("gma", ta).join(" | "));
    check("Mom (alerts on) alerted", textsTo("mom", ta).includes(expected), textsTo("mom", ta).join(" | "));
    check("Jake (alerts off) not alerted", textsTo("jake", ta).length === 0);
    check("Sam (the target) gets no circle alert", !textsTo("sam", ta).some((x) => x.includes("received a likely")));
    await family.onVerifyCallEnded(vv.conv, { failed: false });
  }

  section("9: instant family alert for any scam");
  {
    const ta = dryRunOutbox.length;
    const n = await notifyFamily({ userId: ids.gma, level: "high_risk", scamType: "bank_or_card", source: "call" });
    check("2 family members texted (Sam, Mom)", n === 2, String(n));
    check("organizer sees his title + pronoun", has(textsTo("sam", ta), "⚠️ Family alert: Grandma just got a fake bank or card scam call. I warned her"), textsTo("sam", ta).join(" | "));
    check("Mom sees the first name", has(textsTo("mom", ta), "⚠️ Family alert: Rosa just got a fake bank or card scam call. I warned them"), textsTo("mom", ta).join(" | "));
    check("Jake (alerts off) and Grandma (target) not texted", textsTo("jake", ta).length === 0 && textsTo("gma", ta).length === 0);
    check("same type again within 30 min → no repeat", (await notifyFamily({ userId: ids.gma, level: "high_risk", scamType: "bank_or_card", source: "text" })) === 0);
    check("unsure → no alert", (await notifyFamily({ userId: ids.jake, level: "unsure", scamType: "crypto", source: "text" })) === 0);
  }

  section("privacy");
  {
    const leaks = logs.filter((l) => WORD_RE.test(l) && !/^(PASS|FAIL)/.test(l));
    check("safe words never in logs (DRY_RUN prints included)", leaks.length === 0, leaks.join(" | "));
    const echoed = dryRunOutbox.filter((m) => WORD_RE.test(m.text) && !m.sensitive);
    check("safe words never echoed in a normal text", echoed.length === 0, echoed.map((m) => m.text).join(" | "));
    const setupLogs = logs.filter((l) => l.startsWith("[setup]"));
    check("setup logs carry no names, titles or numbers", setupLogs.length > 5 && !setupLogs.some((l) => /grandma|jake|mom|maria|rosa|nora|nana|joe|sam|eve|214555|555-0/i.test(l)), setupLogs.join(" | "));
  }
} catch (err: any) {
  failures++;
  console.error("TEST CRASHED:", err?.stack ?? err);
} finally {
  await sleep(300);
  await cleanup().catch((e) => console.error("cleanup failed:", e?.message));
  const left = await one("SELECT count(*)::int AS n FROM users WHERE imessage_handle = ANY($1)", [Object.values(H)]);
  console.log(`\ncleanup: ${left?.n ?? "?"} test users left`);
  await pool.end();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}
