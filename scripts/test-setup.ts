// Flow 3 setup-by-text test (SPEC Flow 3 Setup steps 1–3) with DRY_RUN on: texts go to the in-memory
// outbox instead of Photon, no phone rings. The emergency at the end calls the real Jev API.
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
    { role: "assistant", content: "Hi Jake, this is Bouncer calling for Grandma. Are you safe right now?" },
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

let ids = { sam: "", gma: "", mom: "", jake: "", circle: "", code: "" };

try {
  await cleanup();

  section("before setup");
  {
    const g = await send("gma", "hi");
    ids.gma = g.userId;
    check("Grandma's hello is not a setup text", g.route === "router");
    check("isSetupCommand", setup.isSetupCommand("Set up family!") && setup.isSetupCommand("join ab12cd") && !setup.isSetupCommand("hello"));
    const grp = await send("sam", "set up family", "group");
    check("group chat → asked to use a 1:1 chat", grp.route === "setup" && grp.replies.length === 0 && grp.all.some((m) => m.text.includes("1:1 chat")));
  }

  section("1: organizer builds the circle, one question per message");
  {
    let r = await send("sam", "Set up family");
    ids.sam = r.userId;
    check("start → intro + first-name question", r.route === "setup" && has(r.replies, "one thing at a time") && has(r.replies, "what's your first name?"), r.replies.join(" | "));
    r = await send("sam", "sam");
    check("name → who to protect", has(r.replies, "Thanks, Sam.") && has(r.replies, "Who should I protect?"), r.replies.join(" | "));
    r = await send("sam", "Grandma");
    check("protected name → cell number question", has(r.replies, "What's Grandma's cell number?"), r.replies.join(" | "));
    r = await send("sam", "call me maybe");
    check("bad number → re-ask", has(r.replies, "doesn't look like a phone number"));
    r = await send("sam", "(214) 555-0142");
    check("Grandma has texted before → no heads-up, first member question", !has(r.replies, "hasn't texted") && has(r.replies, "What's the first person's name?"), r.replies.join(" | "));
    r = await send("sam", "done");
    check("DONE with nobody → asks for one person", has(r.replies, "Add at least one person first"));
    r = await send("sam", "Jake");
    check("member name → relationship", has(r.replies, "How is Jake related to Grandma?"));
    r = await send("sam", "grandson");
    check("relationship → number", has(r.replies, "What's Jake's cell number?"));
    r = await send("sam", "214-555-0144");
    check("number → role", has(r.replies, "Reply ALERTS") && has(r.replies, "CALL") && has(r.replies, "BOTH"));
    r = await send("sam", "maybe");
    check("bad role → re-ask", has(r.replies, "Reply ALERTS, CALL or BOTH for Jake."));
    r = await send("sam", "Call");
    check("role → added + next", has(r.replies, "Added Jake.") && has(r.replies, "Who's next?"));
    await send("sam", "Mom");
    await send("sam", "daughter");
    r = await send("sam", "2145550142");
    check("Grandma's own number for a member → rejected", has(r.replies, "That's Grandma's number."), r.replies.join(" | "));
    r = await send("sam", "214.555.0144");
    check("duplicate member number → rejected", has(r.replies, "Jake already has that number."), r.replies.join(" | "));
    await send("sam", "214 555 0143");
    r = await send("sam", "alerts");
    check("Mom added", has(r.replies, "Added Mom."));
    await send("sam", "Sam");
    await send("sam", "son");
    await send("sam", "+1 214 555 0141"); // the organizer lists himself
    r = await send("sam", "both");
    check("Sam added", has(r.replies, "Added Sam."));
    r = await send("sam", "That's all");
    const join = r.replies.join(" ").match(/Text JOIN ([A-Z0-9]{6}) to Bouncer at /);
    check("DONE → circle ready + JOIN text", !!join && has(r.replies, "Nobody gets alerts or calls until they reply YES."), r.replies.join(" | "));
    check("organizer told he's already in", has(r.replies, "You're already in."));
    check("asks for the safe word (SPEC wording)", has(r.replies, "Pick a word or short phrase you'd never say by accident and tell your family in person. Then text it to me here."));
    ids.code = join?.[1] ?? "";
  }

  section("2: circle rows");
  {
    const c = await one("SELECT id, organizer_user_id, protected_user_id, join_code FROM circles WHERE join_code = $1", [ids.code]);
    ids.circle = c?.id ?? "";
    check("circle: organizer Sam, protecting Grandma (existing user), 6-char code", c && c.organizer_user_id === ids.sam && c.protected_user_id === ids.gma && /^[A-Z2-9]{6}$/.test(c.join_code));
    const { rows } = await query("SELECT name, relationship, phone, imessage_handle, role, joined, user_id, space_id FROM circle_members WHERE circle_id = $1 ORDER BY created_at, role", [ids.circle]);
    const by = (n: string, role: string) => rows.find((m: any) => m.name === n && m.role === role);
    check("4 member rows (Sam = guardian + relative)", rows.length === 4, JSON.stringify(rows.map((m: any) => [m.name, m.role])));
    check("Jake: relative, E.164 phone, not joined", by("Jake", "relative")?.phone === H.jake && by("Jake", "relative")?.relationship === "grandson" && !by("Jake", "relative")?.joined);
    check("Mom: guardian, not joined", by("Mom", "guardian")?.imessage_handle === H.mom && !by("Mom", "guardian")?.joined);
    check("Sam (organizer) joined at once with user + space", ["guardian", "relative"].every((r) => by("Sam", r)?.joined && by("Sam", r)?.user_id === ids.sam && by("Sam", r)?.space_id === SPACE("sam")));
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

  section("4: JOIN + YES");
  {
    let r = await send("eve", `JOIN ${ids.code}`);
    check("unlisted number → not on the list", r.route === "setup" && has(r.replies, "isn't on that family list"), r.replies.join(" | "));
    r = await send("jake", "JOIN ZZZZZZ");
    check("unknown code → not found", has(r.replies, "couldn't find that code"));
    r = await send("jake", `join ${ids.code.toLowerCase()}`);
    ids.jake = r.userId;
    check(
      "consent text (SPEC wording)",
      r.replies.length === 1 &&
        r.replies[0] ===
          "Sam added you to Grandma's Bouncer circle. You'll get the scam type and outcome if someone targets them, never their messages. Relatives may get one verification call from Bouncer. Reply YES to join.",
      r.replies.join(" | "),
    );
    check("circle_join pending", peekPending(ids.jake)?.kind === "circle_join");
    let joined = await one("SELECT joined FROM circle_members WHERE circle_id = $1 AND name = 'Jake'", [ids.circle]);
    check("not joined before YES", joined && !joined.joined);
    const ts = dryRunOutbox.length;
    r = await send("jake", "Yes");
    check("YES → joined reply (relative wording)", r.route === "pending" && has(r.replies, "You're in Grandma's circle.") && has(r.replies, "I may call this number"), r.replies.join(" | "));
    const jm = await one("SELECT joined, user_id, space_id FROM circle_members WHERE circle_id = $1 AND name = 'Jake'", [ids.circle]);
    check("Jake row: joined, user linked, space stored", jm?.joined && jm.user_id === ids.jake && jm.space_id === SPACE("jake"));
    check("organizer told Jake joined", has(textsTo("sam", ts), "Jake joined Grandma's circle."), textsTo("sam", ts).join(" | "));

    r = await send("mom", `JOIN ${ids.code}`);
    ids.mom = r.userId;
    r = await send("mom", "no");
    check("NO → not joined", r.route === "pending" && has(r.replies, "you're not in the circle"));
    joined = await one("SELECT joined FROM circle_members WHERE circle_id = $1 AND name = 'Mom'", [ids.circle]);
    check("Mom still not joined", joined && !joined.joined);
    await send("mom", `JOIN ${ids.code}`);
    r = await send("mom", "yes");
    check("YES → joined reply (guardian wording)", has(r.replies, "I'll text you here with the scam type and outcome"), r.replies.join(" | "));
    const mm = await one("SELECT joined, user_id, space_id FROM circle_members WHERE circle_id = $1 AND name = 'Mom'", [ids.circle]);
    check("Mom row: joined, user linked, space stored", mm?.joined && mm.user_id === ids.mom && mm.space_id === SPACE("mom"));
    r = await send("jake", `JOIN ${ids.code}`);
    check("JOIN again → already in", has(r.replies, "You're already in Grandma's circle."));
  }

  section("5: change safe word");
  {
    let r = await send("mom", "change safe word");
    check("member (not organizer / protected) → no circle of theirs", has(r.replies, "You don't have a family circle yet."));
    r = await send("sam", "Change my safe word");
    check("organizer → asks for the new word", has(r.replies, "a new safe word for Grandma's circle") && has(r.replies, "Pick a word"), r.replies.join(" | "));
    r = await send("sam", "cancel");
    check("cancel → old word kept", has(r.replies, "didn't save a new safe word") && decryptWord((await getSafeWordRow(ids.circle))!, ids.circle) === WORD);
    r = await send("gma", "new safe word");
    check("protected person can change it too", has(r.replies, "a new safe word for your circle"), r.replies.join(" | "));
    r = await send("gma", "one two three four five six seven");
    check("too long → re-ask", has(r.replies, "That's long for a safe word"));
    r = await send("gma", WORD2_TYPED);
    check("saved", r.replies[0] === "Saved and encrypted. I'll never say it on a call. You can delete your message now.");
    check("new word decrypts", decryptWord((await getSafeWordRow(ids.circle))!, ids.circle) === WORD2);
  }

  section("6: guards");
  {
    let r = await send("eve", "family setup");
    check("stranger starts setup", has(r.replies, "what's your first name?"));
    await send("eve", "Eve");
    await send("eve", "Grandma");
    r = await send("eve", "214-555-0142");
    check("can't take over Grandma's circle", has(r.replies, "Grandma already has a family circle. Only the person who set it up can change it."), r.replies.join(" | "));
    check("draft ended", (await send("eve", "hello")).route === "router");
    const c = await one("SELECT organizer_user_id FROM circles WHERE protected_user_id = $1", [ids.gma]);
    check("Grandma's circle untouched", c?.organizer_user_id === ids.sam);

    await send("eve", "add family");
    await send("eve", "Nora");
    r = await send("eve", "214-555-0146");
    check("protected person never texted → says so", has(r.replies, "Nora hasn't texted me yet") && has(r.replies, "What's the first person's name?"), r.replies.join(" | "));
    r = await send("eve", "cancel");
    check("cancel → stopped", has(r.replies, "I stopped family setup"));
    check("no user row or circle for Nora", !(await one("SELECT 1 FROM users WHERE imessage_handle = $1", [H.nora])));

    await send("eve", "set up family");
    r = await send("eve", "Your package is held, pay the fee at https://usps-redeliver.top/x");
    check("pasted link mid-setup → setup stops, router checks it", r.route === "router" && has(r.all.map((m) => m.text), "I stopped family setup"));
  }

  section("7: the new circle works in an emergency");
  {
    const jakeMember = await one("SELECT id FROM circle_members WHERE circle_id = $1 AND name = 'Jake'", [ids.circle]);
    const t = dryRunOutbox.length;
    const tl = logs.length;
    await family.startFamilyEmergency({ userId: ids.gma, content: "Jake is calling me crying, he says he's in jail and needs bail money", source: "text" });
    const coach = textsTo("gma", t);
    check("coach text names Jake", has(coach, "Ask him for the family safe word") && has(coach, "I'm checking on Jake."), coach.join(" | "));
    check("would call the joined relative Jake", logs.slice(tl).some((l) => l.includes(`would call relative ${jakeMember?.id}`)));
    const v = await one<{ id: string; conversation_id: string }>("SELECT id, conversation_id FROM verifications WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 1", [ids.circle]);
    check("verification row", !!v);

    const r = await send("gma", "what's the safe word?");
    const sent = r.all.filter((m) => m.spaceId === SPACE("gma"));
    check("Grandma asks for the word → sensitive text with the new word", r.route === "family" && sent.length === 1 && sent[0].sensitive && sent[0].text.includes(WORD2));

    const vv = { id: v!.id, conv: v!.conversation_id };
    const h: Msg[] = [{ role: "user", content: "Yeah I'm fine, I'm at work." }];
    const t1 = await verifyTurn(vv, h);
    h.push({ role: "assistant", content: t1.content }, { role: "user", content: "It's copper kettle." });
    const t2 = await verifyTurn(vv, h);
    check("relative says the word set by text → accepted", t2.endCall && t2.content.startsWith("Thank you, that's right."), t2.content);
    check("verified_safe", await waitFor(async () => (await one("SELECT status FROM verifications WHERE id = $1", [v!.id]))?.status === "verified_safe"));
    await waitFor(() => peekPending(ids.gma)?.kind === "loss_question");
    const ta = dryRunOutbox.length;
    await send("gma", "no");
    const expected = "Grandma received a likely family-emergency scam. Jake is safe. No money was sent.";
    check("guardian Mom alerted", textsTo("mom", ta).includes(expected), textsTo("mom", ta).join(" | "));
    check("organizer Sam (guardian) alerted", textsTo("sam", ta).includes(expected), textsTo("sam", ta).join(" | "));
    check("relative-only Jake not alerted", textsTo("jake", ta).length === 0);
    await family.onVerifyCallEnded(vv.conv, { failed: false });
  }

  section("privacy");
  {
    const leaks = logs.filter((l) => WORD_RE.test(l) && !/^(PASS|FAIL)/.test(l));
    check("safe words never in logs (DRY_RUN prints included)", leaks.length === 0, leaks.join(" | "));
    const echoed = dryRunOutbox.filter((m) => WORD_RE.test(m.text) && !m.sensitive);
    check("safe words never echoed in a normal text", echoed.length === 0, echoed.map((m) => m.text).join(" | "));
    const setupLogs = logs.filter((l) => l.startsWith("[setup]"));
    check("setup logs carry no names or numbers", setupLogs.length > 5 && !setupLogs.some((l) => /grandma|jake|mom|nora|sam|eve|214555|555-0/i.test(l)), setupLogs.join(" | "));
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
