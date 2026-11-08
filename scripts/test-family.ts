// Flow 3 end-to-end test against the real Jev API and the shared Railway DB, with DRY_RUN on:
// texts are printed instead of sent and no phone ever rings.
//   npx tsx --env-file=.env scripts/test-family.ts
// Uses fake +1555555013x handles and deletes every row it creates.
export {};
process.env.DRY_RUN = "1";
process.env.PHOTON_SOCKET = "off";

const TEST_WORD = "purple elephant"; // test-only word, lives in this file
const H = { gma: "+15555550131", mom: "+15555550132", jake: "+15555550133" };
const SPACE = { gma: "tsp-gma-0131", mom: "tsp-mom-0132" };
const AGENT = "tsp-agent";

// Capture everything the code logs, so we can read the dry-run texts and check the word never leaks.
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
const { seedCircle } = await import("../src/family/seed.js");
const family = await import("../src/family/index.js");
const { resolvePending, peekPending, setPending } = await import("../src/pending.js");
const { dryRunOutbox } = await import("../src/photon/client.js");
const { parseSystemVars } = await import("../src/voice/sse.js");
const cr = await import("../src/family/crypto.js");
const circleLib = await import("../src/family/circle.js");
const { notifyFamily } = await import("../src/family/alerts.js");

family.familyTimings.alertWaitMs = 1_500;
family.familyTimings.retriggerCooldownMs = 0;

let failures = 0;
const check = (name: string, cond: unknown, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n=== ${s} ===`);
const mark = () => logs.length;
const textsTo = (space: string, since: number) =>
  logs
    .slice(since)
    .filter((l) => l.startsWith(`[photon:dry-run] → space ${space}`))
    .map((l) => l.slice(l.indexOf("…  ") + 3));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

const spoken: string[] = [];
const GREETING = "Hi Jake, this is Bouncer calling for Grandma. Are you safe right now?";
type Msg = { role: string; content: string };

/** One ElevenLabs-style custom-LLM request for the Verify agent; returns spoken text and tool calls. */
async function verifyTurn(v: { id: string; conv: string }, history: Msg[]) {
  const messages: Msg[] = [{ role: "system", content: `verify=${v.id} conv=${v.conv}` }, { role: "assistant", content: GREETING }, ...history];
  const body = { model: "bouncer-verify", stream: true, temperature: 0.5, messages };
  const res = await family.handleVerifyTurn({} as any, body, parseSystemVars(messages));
  const raw = await res.text();
  let content = "";
  const tools: Array<{ name: string; args: any }> = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ") || line.trim() === "data: [DONE]") continue;
    const d = JSON.parse(line.slice(6)).choices[0].delta;
    if (d.content) content += d.content;
    for (const t of d.tool_calls ?? []) tools.push({ name: t.function.name, args: JSON.parse(t.function.arguments || "{}") });
  }
  spoken.push(content);
  return { content, tools, endCall: tools.some((t) => t.name === "end_call") };
}

/** Plays a conversation: each user line gets the server's reply appended to the history. */
async function converse(v: { id: string; conv: string }, lines: string[]) {
  const history: Msg[] = [];
  let last: Awaited<ReturnType<typeof verifyTurn>> | null = null;
  for (const line of lines) {
    history.push({ role: "user", content: line });
    last = await verifyTurn(v, history);
    history.push({ role: "assistant", content: last.content });
  }
  return last!;
}

let ids = { gma: "", mom: "", circle: "", jake: "" };
const latestVerification = () =>
  one<{ id: string; status: string; conversation_id: string }>(
    "SELECT id, status, conversation_id FROM verifications WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 1",
    [ids.circle],
  );
const statusOf = async (id: string) => (await one<{ status: string }>("SELECT status FROM verifications WHERE id = $1", [id]))?.status;
const verificationCount = async () => Number((await one("SELECT count(*)::int AS n FROM verifications WHERE circle_id = $1", [ids.circle]))!.n);
const inbound = (text: string, space = SPACE.gma) => ({
  id: "tmsg-" + Math.random().toString(36).slice(2, 10),
  spaceId: space,
  spaceKind: "direct",
  senderHandle: H.gma,
  agentUserId: AGENT,
  text,
  attachmentIds: [],
  receivedAt: new Date().toISOString(),
});

/** Starts a text-triggered emergency and returns the verification it created. */
async function textEmergency(content: string) {
  const before = await verificationCount();
  await family.startFamilyEmergency({ userId: ids.gma, content, source: "text" });
  await waitFor(async () => (await verificationCount()) > before);
  const v = await latestVerification();
  return { id: v!.id, conv: v!.conversation_id };
}

async function cleanup() {
  const { rows } = await query<{ id: string }>("SELECT id FROM users WHERE imessage_handle = ANY($1)", [Object.values(H)]);
  const uids = rows.map((r) => r.id);
  if (!uids.length) return;
  await query("DELETE FROM events WHERE user_id = ANY($1)", [uids]);
  await query("DELETE FROM circles WHERE protected_user_id = ANY($1) OR organizer_user_id = ANY($1)", [uids]);
  await query("DELETE FROM users WHERE id = ANY($1)", [uids]);
}

try {
  await cleanup();

  section("crypto");
  {
    const cid = "00000000-0000-0000-0000-000000000001";
    const enc = cr.encryptWord("  Purple-Elephant! ", cid);
    check("decrypt(encrypt) round-trips the normalised word", cr.decryptWord(enc, cid) === TEST_WORD);
    check("ciphertext doesn't contain the word", !enc.ciphertext.toString("utf8").includes("purple") && enc.iv.length === 12 && enc.auth_tag.length === 16);
    let threw = false;
    try {
      cr.decryptWord(enc, "00000000-0000-0000-0000-000000000002");
    } catch {
      threw = true;
    }
    check("decrypting with another circle id fails (GCM auth)", threw);
    const yes = ["purple elephant", "it's purple elephent", "purpel elephant", "Purple elephants.", "um the word is purple elephant okay", "purpleelephant", "purple ele phant"];
    const no = ["purple", "pink elephant", "elephant purple", "purple elegant", "purple elefant", "banana bread", "purpel elefant", ""];
    for (const s of yes) check(`match: "${s}"`, cr.wordsMatch(s, TEST_WORD));
    for (const s of no) check(`no match: "${s}"`, !cr.wordsMatch(s, TEST_WORD));
  }

  section("seed");
  {
    const g = await getOrCreateUser(H.gma);
    await saveConversation(g.user.id, SPACE.gma, AGENT);
    const m = await getOrCreateUser(H.mom);
    await saveConversation(m.user.id, SPACE.mom, AGENT);
    const input = {
      protected: { name: "Grandma", handle: H.gma },
      members: [
        { name: "Jake", title: "Grandson", phone: H.jake },
        { name: "Mom", relationship: "daughter", phone: H.mom, role: "guardian" as const }, // legacy keys → alerts on
      ],
    };
    await seedCircle(input, TEST_WORD);
    const s = await seedCircle(input, TEST_WORD); // idempotent: second run replaces the first
    ids = {
      gma: s.protectedUserId,
      mom: s.people.find((p) => p.name === "Mom")!.userId!,
      jake: s.people.find((p) => p.name === "Jake")!.memberId!,
      circle: s.circleId,
    };
    const circles = await one("SELECT count(*)::int AS n FROM circles WHERE protected_user_id = $1", [ids.gma]);
    check("seed is idempotent (one circle)", circles!.n === 1);
    check("seed linked existing users by handle", ids.gma === g.user.id && ids.mom === m.user.id);
    const members = await query("SELECT name, title, role, joined, user_id, alerts FROM circle_members WHERE circle_id = $1", [ids.circle]);
    const row = (n: string) => members.rows.find((r: any) => r.name === n);
    check("3 members (Grandma has her own row) joined", members.rows.length === 3 && members.rows.every((r: any) => r.joined && r.role === "relative"));
    check("Grandma organizes her own circle", (await one("SELECT organizer_user_id FROM circles WHERE id = $1", [ids.circle]))!.organizer_user_id === ids.gma);
    check("titles: Grandson; legacy relationship → Daughter", row("Jake")?.title === "Grandson" && row("Mom")?.title === "Daughter");
    check("alerts: legacy guardian on, others off", row("Mom")?.alerts === true && row("Jake")?.alerts === false && row("Grandma")?.alerts === false);
    check("no thread warnings for Grandma/Mom", !s.warnings.some((w) => /Grandma|Mom/.test(w)), s.warnings.join("; "));
    check("seed output has no word", !JSON.stringify(s).toLowerCase().includes("purple"));
  }

  section("1+2+5: text emergency → correct word (1-letter STT error) → verified_safe → NO → alert");
  {
    const t = mark();
    const v = await textEmergency("Jake is calling me crying, he says he's in jail and needs $2000 for bail right now");
    const coach = textsTo(SPACE.gma, t);
    check("coach text sent", coach.some((x) => x.startsWith("Ask him for the family safe word") && x.includes("I'm checking on Jake")), coach.join(" | "));
    check('"would call relative <member id>" logged', logs.slice(t).some((l) => l.includes(`would call relative ${ids.jake}`)));
    check("verification row is calling with a conversation id", (await statusOf(v.id)) === "calling" && v.conv?.startsWith("dry_conv_"));

    const re = await verifyTurn(v, []); // re-engagement before the relative said anything
    check("re-engagement re-asks, no end_call", re.content === "Are you safe right now?" && !re.endCall, re.content);

    const h: Msg[] = [{ role: "user", content: "Yeah I'm fine, I'm at work. Why?" }];
    const t1 = await verifyTurn(v, h);
    check("turn 1 asks for the word", t1.content === "Thanks. Please say your family safe word." && !t1.endCall, t1.content);
    h.push({ role: "assistant", content: t1.content });
    const re2 = await verifyTurn(v, h); // last message is the assistant: no new user words
    check("re-engagement in word phase re-asks", re2.content === "Please say your family safe word." && !re2.endCall, re2.content);
    h.push({ role: "user", content: "Oh, it's purple elephent." });
    const t2 = await verifyTurn(v, h);
    check("correct word → thanks + end_call", t2.content.startsWith("Thank you, that's right. I'll let Grandma know.") && t2.endCall, t2.content);
    check("end_call carries a reason", typeof (t2.tools.find((x) => x.name === "end_call")?.args?.reason) === "string");
    check("status verified_safe", await waitFor(async () => (await statusOf(v.id)) === "verified_safe"));
    await waitFor(() => textsTo(SPACE.gma, t).some((x) => x.startsWith("Did you send money")));
    const res = textsTo(SPACE.gma, t);
    check("Grandma told Jake is safe", res.some((x) => x.startsWith("Jake just answered his own phone and said the family word. He's safe.")), res.join(" | "));
    check("loss question asked + pending", res.some((x) => x === "Did you send money or share any codes? Reply NO or YES.") && peekPending(ids.gma)?.kind === "loss_question");

    const tm = mark();
    await resolvePending(ids.gma, "no");
    const alert = textsTo(SPACE.mom, tm);
    check("guardian alert: type + outcome + No money", alert.some((x) => x === "Grandma received a likely family-emergency scam. Jake is safe. No money was sent."), alert.join(" | "));
    await family.onVerifyCallEnded(v.conv, { failed: false }); // post-call webhook after a finished check
    check("post-call webhook keeps verified_safe", (await statusOf(v.id)) === "verified_safe");
    const after = await verifyTurn(v, [...h, { role: "user", content: "hello?" }]);
    check("turn after the end just says goodbye", after.endCall);
  }

  section("2b: wrong word twice → failed → YES → checklist, alert without 'No money'");
  {
    const t = mark();
    const v = await textEmergency("Grandma it's Jake, I crashed the car and I need money, please don't tell mom");
    const h: Msg[] = [{ role: "user", content: "Hello? Yes, I'm okay." }];
    const t1 = await verifyTurn(v, h);
    h.push({ role: "assistant", content: t1.content }, { role: "user", content: "banana" });
    const t2a = await verifyTurn(v, h);
    h[h.length - 1] = { role: "user", content: "banana bread" }; // ElevenLabs re-sends the same turn, longer
    const t2b = await verifyTurn(v, h);
    check("first miss asks once more (re-sent turn counted once)", t2a.content.includes("one more time") && t2b.content.includes("one more time") && !t2b.endCall, t2b.content);
    h.push({ role: "assistant", content: t2b.content }, { role: "user", content: "Sorry, what?" });
    const tr = await verifyTurn(v, h);
    check('"Sorry, what?" re-asks without counting', tr.content === "Please say your family safe word." && !tr.endCall, tr.content);
    h.push({ role: "assistant", content: tr.content }, { role: "user", content: "uh, sunshine?" });
    const t3 = await verifyTurn(v, h);
    check("second miss → pass-on goodbye + end_call", t3.content === "Thanks, I'll pass that on. Goodbye." && t3.endCall, t3.content);
    check("status failed", await waitFor(async () => (await statusOf(v.id)) === "failed"));
    await waitFor(() => textsTo(SPACE.gma, t).some((x) => x.startsWith("Did you send money")));
    check("Grandma told someone couldn't give the word", textsTo(SPACE.gma, t).some((x) => x.startsWith("Someone answered Jake's number but couldn't give the family word.")));
    const ty = mark();
    await resolvePending(ids.gma, "yes");
    check("YES → recovery menu (Flow 4)", textsTo(SPACE.gma, ty).some((x) => x.startsWith("I'm sorry that happened")));
    const alert = textsTo(SPACE.mom, ty);
    check("alert without 'No money was sent.'", alert.length === 1 && alert[0].includes("couldn't confirm Jake is safe") && !alert[0].includes("No money"), alert.join(" | "));
    await family.onVerifyCallEnded(v.conv, { failed: false });
  }

  section("2c: says he needs help + correct word → verified_needs_help");
  {
    const t = mark();
    const v = await textEmergency("Jake called, says he's hurt and needs money wired to a lawyer");
    const last = await converse(v, ["No, I'm not okay. I was in a car accident and I need help.", "purple elephant"]);
    check("word accepted + end_call", last.endCall && last.content.startsWith("Thank you, that's right."), last.content);
    check("status verified_needs_help", await waitFor(async () => (await statusOf(v.id)) === "verified_needs_help"));
    await waitFor(() => textsTo(SPACE.gma, t).some((x) => x.startsWith("Did you send money")));
    check("Grandma told to call him back", textsTo(SPACE.gma, t).some((x) => x.startsWith("Jake answered and gave the family word, but says he needs help.")));
    await resolvePending(ids.gma, "no");
    await family.onVerifyCallEnded(v.conv, { failed: false });
  }

  section("2d: voicemail picks up → unreachable");
  {
    const v = await textEmergency("Jake is on the phone saying he got arrested");
    const r = await converse(v, ["Hi, you've reached Jake. I can't take your call right now. Please leave a message after the tone."]);
    check("voicemail → short message + end_call", r.endCall && !r.content.toLowerCase().includes("safe word"), r.content);
    check("status unreachable", await waitFor(async () => (await statusOf(v.id)) === "unreachable"));
    await waitFor(() => peekPending(ids.gma)?.kind === "loss_question");
    await resolvePending(ids.gma, "no");
    await family.onVerifyCallEnded(v.conv, { failed: false });
  }

  section("3: call never connects → unreachable → alert after timeout (no 'No money')");
  {
    const t = mark();
    const v = await textEmergency("My grandson Jake is calling, says he's in jail in Mexico");
    await family.onVerifyCallEnded(v.conv, { failed: true });
    check("status unreachable", (await statusOf(v.id)) === "unreachable");
    check("Grandma told I couldn't reach Jake", textsTo(SPACE.gma, t).some((x) => x.startsWith("I couldn't reach Jake. That doesn't mean he's in trouble.")));
    const ok = await waitFor(() => textsTo(SPACE.mom, t).length > 0, 5_000);
    const alert = textsTo(SPACE.mom, t);
    check("alert sent after timeout without the money line", ok && alert[0]?.includes("I couldn't reach Jake") && !alert[0].includes("No money"), alert.join(" | "));
  }

  section("4: call-sourced emergency → YES prompt → YES by text → call");
  {
    const t = mark();
    const before = await verificationCount();
    const transcript = "caller: grandma it's me jake, I'm in trouble, I got arrested, I need you to send bail money, please don't tell mom";
    await family.startFamilyEmergency({ userId: ids.gma, content: transcript, source: "call" });
    const msgs = textsTo(SPACE.gma, t);
    check("coach + YES prompt", msgs.some((x) => x.startsWith("Ask him for the family safe word")) && msgs.some((x) => x === "Reply YES and I'll call Jake's own number to check he's safe."), msgs.join(" | "));
    check("verify_call pending, no call yet", peekPending(ids.gma)?.kind === "verify_call" && (await verificationCount()) === before);
    const t2 = mark();
    await family.startFamilyEmergency({ userId: ids.gma, content: transcript, source: "call" }); // live listen fires again
    check("repeat trigger ignored", textsTo(SPACE.gma, t2).length === 0 && peekPending(ids.gma)?.kind === "verify_call");
    await resolvePending(ids.gma, "yes");
    check("YES → would call + verification row", logs.slice(t2).some((l) => l.includes(`would call relative ${ids.jake}`)) && (await verificationCount()) === before + 1);
    const v = await latestVerification();
    await family.onVerifyCallEnded(v!.conversation_id, { failed: true });
    await resolvePending(ids.gma, "no");
  }

  section("4b: call-sourced emergency → Grandma texts about it herself → that's the go-ahead");
  {
    const transcript = "caller: grandma it's me jake, I'm in trouble, I got arrested, I need you to send bail money, please don't tell mom";
    await family.startFamilyEmergency({ userId: ids.gma, content: transcript, source: "call" });
    check("verify_call pending", peekPending(ids.gma)?.kind === "verify_call");
    const before = await verificationCount();
    let t = mark();
    await family.startFamilyEmergency({ userId: ids.gma, content: "Jake is calling me saying he's in trouble", source: "text" });
    const msgs = textsTo(SPACE.gma, t);
    check("text trigger → 'Calling Jake now' reply", msgs.some((x) => x === "Calling Jake now. I'll text you what I find."), msgs.join(" | "));
    check("text trigger → call placed, YES prompt cleared", (await verificationCount()) === before + 1 && peekPending(ids.gma)?.kind !== "verify_call");

    section("4c: text trigger again while calling / after the result → status reply, no new call");
    t = mark();
    await family.startFamilyEmergency({ userId: ids.gma, content: "Jake is calling me again", source: "text" });
    const busy = textsTo(SPACE.gma, t);
    check("while calling → 'already checking' reply", busy.length === 1 && busy[0] === "I'm already checking on Jake. I'll text you as soon as I know.", busy.join(" | "));
    check("while calling → no second call", (await verificationCount()) === before + 1);
    const v = await latestVerification();
    await family.onVerifyCallEnded(v!.conversation_id, { failed: true });
    t = mark();
    await family.startFamilyEmergency({ userId: ids.gma, content: "Jake is calling me again", source: "text" });
    const done = textsTo(SPACE.gma, t);
    check("after the result → status reply, no new call", done.length === 1 && done[0].startsWith("I already checked on Jake.") && (await verificationCount()) === before + 1, done.join(" | "));
    await resolvePending(ids.gma, "no");
  }

  section("3b: stale YES / NO is not swallowed");
  {
    setPending(ids.gma, "loss_question", { emergencyId: "gone-emergency" });
    check("stale loss_question → resolvePending false (router replies)", (await resolvePending(ids.gma, "yes")) === false);
    check("stale action was dropped", peekPending(ids.gma) === null);
    setPending(ids.gma, "verify_call", { emergencyId: "gone-emergency" });
    const before = await verificationCount();
    check("stale verify_call → resolvePending false, no call", (await resolvePending(ids.gma, "yes")) === false && (await verificationCount()) === before);
  }

  section("6: Grandma texts during an emergency");
  {
    const v = await textEmergency("Jake says he's in the hospital and needs money for the bill");
    const gma = (await getUserById(ids.gma))!;
    let t = mark();
    const ob = dryRunOutbox.length;
    const r1 = await family.handleFamilyText(gma, inbound("What's the safe word again?"));
    const w = textsTo(SPACE.gma, t);
    const sent = dryRunOutbox.slice(ob);
    check(
      "asked for the word → texted in her thread (log shows length only)",
      r1 && w.length === 1 && /^\(sensitive, \d+ chars\)$/.test(w[0]) && sent.length === 1 && sent[0].spaceId === SPACE.gma && sent[0].sensitive && sent[0].text === `Your family word is: ${TEST_WORD}. Delete this after the call.`,
      w.join(" | "),
    );
    t = mark();
    const r2 = await family.handleFamilyText(gma, inbound("He said the word!"));
    check("caller gave the word → likely really him", r2 && textsTo(SPACE.gma, t)[0] === "Then it's very likely really him. Call him back on his saved number to be sure.");
    t = mark();
    const r3 = await family.handleFamilyText(gma, inbound("He knew it, he told me the right one"));
    check("Jev fallback: 'he knew it' → likely really him", r3 && textsTo(SPACE.gma, t)[0]?.startsWith("Then it's very likely"), textsTo(SPACE.gma, t).join(" | "));
    const r4 = await family.handleFamilyText(gma, inbound("ok thank you"));
    check("unrelated text not consumed", r4 === false);
    const mom = (await getUserById(ids.mom))!;
    const r5 = await family.handleFamilyText(mom, inbound("what's the safe word?", SPACE.mom));
    check("no emergency for Mom → not consumed", r5 === false);
    t = mark();
    const r6 = await family.handleFamilyText(gma, { ...inbound("what's the safe word?"), spaceKind: "group" });
    check("group thread → word not sent", r6 && !textsTo(SPACE.gma, t).some((x) => x.includes("purple")));
    await family.onVerifyCallEnded(v.conv, { failed: true });
    await resolvePending(ids.gma, "no");
  }

  section("7: titles, whole-family protection, family alerts");
  {
    const fam = [
      { id: "a", name: "Rosa", title: "Mom" },
      { id: "b", name: "Jake", title: "Grandson" },
      { id: "c", name: "Sofia", title: "Bae" },
    ] as any[];
    const m = (text: string, org = true) => circleLib.matchByName(text, fam, org)?.name ?? null;
    check('"mom is in trouble" → Rosa (organizer\'s title)', m("mom is in trouble") === "Rosa");
    check('"my mother got arrested" → Rosa (synonym)', m("my mother got arrested") === "Rosa");
    check('"Mom\'s car crashed" → Rosa (possessive)', m("Mom's car crashed") === "Rosa");
    check('"bae is in trouble" → Sofia', m("bae is in trouble") === "Sofia");
    check('"Sofia needs bail" → Sofia (first name)', m("Sofia needs bail") === "Sofia");
    check('title ignored for non-organizers ("mom is in trouble")', m("mom is in trouble", false) === null);
    check("two people named → no code match (Jev decides)", m("Jake says mom is hurt") === null);
    check('"momentum" is not "mom"', m("the momentum is gone") === null);
    check("label: organizer sees Mom, others see Rosa", circleLib.labelFor(fam[0], true) === "Mom" && circleLib.labelFor(fam[0], false) === "Rosa");
    check("label: describing titles fall back to the name", circleLib.labelFor(fam[1], true) === "Jake");
    check("pronouns from title", circleLib.memberPronouns({ title: "Grandma", relationship: null }).he === "she" && circleLib.memberPronouns({ title: "Bae", relationship: null }).he === "they");

    // Mom (not the organizer) is targeted: Bouncer calls Jake, and texts go to Mom.
    let t = mark();
    const before = await verificationCount();
    await family.startFamilyEmergency({ userId: ids.mom, content: "Jake called, he says he's in jail and needs bail", source: "text" });
    await waitFor(async () => (await verificationCount()) > before);
    const v = (await one("SELECT id, conversation_id, relative_id, target_user_id FROM verifications WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 1", [ids.circle]))!;
    check("member targeted → calls Jake, target is Mom", v.relative_id === ids.jake && v.target_user_id === ids.mom);
    check("coach text goes to Mom", textsTo(SPACE.mom, t).some((x) => x.includes("I'm checking on Jake")), textsTo(SPACE.mom, t).join(" | "));
    t = mark();
    await family.onVerifyCallEnded(v.conversation_id, { failed: true });
    check("result goes to Mom", textsTo(SPACE.mom, t).some((x) => x.startsWith("I couldn't reach Jake.")), textsTo(SPACE.mom, t).join(" | "));
    await resolvePending(ids.mom, "no");
    check("Grandma (alerts off) got no circle alert", textsTo(SPACE.gma, t).length === 0, textsTo(SPACE.gma, t).join(" | "));

    // The person the scammer used (Mom) says the word: she gets her own text, not "Grandma received… Mom is safe."
    t = mark();
    const vm = await textEmergency("Mom called me crying, she says she's in jail and needs bail");
    const vmRow = (await one("SELECT relative_id FROM verifications WHERE id = $1", [vm.id]))!;
    check("Grandma's emergency about Mom → calls Mom", vmRow.relative_id === (await one("SELECT id FROM circle_members WHERE circle_id = $1 AND name = 'Mom'", [ids.circle]))!.id);
    await converse(vm, ["Yes I'm fine, why?", "purple elephant"]);
    check("status verified_safe", await waitFor(async () => (await statusOf(vm.id)) === "verified_safe"));
    await waitFor(() => peekPending(ids.gma)?.kind === "loss_question");
    const momNote = textsTo(SPACE.mom, t);
    check(
      "Mom gets her own text right away",
      momNote.length === 1 && momNote[0] === "Heads up: a scammer told Grandma you were in trouble. You gave the family word, so I told Grandma you're safe and it's a scam.",
      momNote.join(" | "),
    );
    t = mark();
    await resolvePending(ids.gma, "no");
    await sleep(300);
    const momAfter = textsTo(SPACE.mom, t);
    check("Mom gets no third-person 'Mom is safe' alert", !momAfter.some((x) => x.includes("received a likely family-emergency scam")), momAfter.join(" | "));
    check("Mom told no money was sent", momAfter.includes("Update: Grandma says no money was sent."), momAfter.join(" | "));
    await family.onVerifyCallEnded(vm.conv, { failed: false });

    // Instant family alerts for any likely scam.
    t = mark();
    const n1 = await notifyFamily({ userId: ids.gma, level: "likely_scam", scamType: "bank_or_card", source: "call" });
    const a = textsTo(SPACE.mom, t);
    check("Grandma's scam call → Mom (alerts on) texted", n1 === 1 && a[0]?.startsWith("⚠️ Family alert: Grandma just got a fake bank or card scam call."), a.join(" | "));
    check("alert carries no content", !/\+1|\$|555/.test(a.join(" ")));
    check("same scam again → no repeat", (await notifyFamily({ userId: ids.gma, level: "high_risk", scamType: "bank_or_card", source: "text" })) === 0);
    check("unsure → no alert", (await notifyFamily({ userId: ids.gma, level: "unsure", scamType: "crypto", source: "text" })) === 0);
    check("Mom's scam → nobody (Grandma has alerts off)", (await notifyFamily({ userId: ids.mom, level: "high_risk", scamType: "crypto", source: "text" })) === 0);
    await query("UPDATE circle_members SET alerts = true WHERE circle_id = $1 AND user_id = $2", [ids.circle, ids.gma]);
    t = mark();
    const n2 = await notifyFamily({ userId: ids.mom, level: "high_risk", scamType: "tech_support", source: "screenshot" });
    // Grandma organizes, so she sees her own title for Mom ("Daughter" describes → first name "Mom").
    check("Grandma turned alerts on → gets Mom's alert", n2 === 1 && textsTo(SPACE.gma, t)[0]?.startsWith("⚠️ Family alert: Mom just got a fake tech support scam message."), textsTo(SPACE.gma, t).join(" | "));
    check("family-emergency scam right after an emergency → covered, no duplicate", (await notifyFamily({ userId: ids.mom, level: "high_risk", scamType: "family_emergency", source: "call" })) === 0);
    await query("UPDATE circle_members SET alerts = false WHERE circle_id = $1 AND user_id = $2", [ids.circle, ids.gma]);
  }

  section("privacy");
  {
    check("word never spoken on a call", spoken.length > 10 && spoken.every((s) => !cr.wordsMatch(s, TEST_WORD) && !s.toLowerCase().includes("purple")));
    const leaks = logs.filter((l) => /purple|eleph|elef/i.test(l) && !/^(PASS|FAIL)/.test(l));
    check("word never in logs (DRY_RUN prints included)", leaks.length === 0, leaks.join(" | "));
    const dry = dryRunOutbox.filter((m) => /purple/i.test(m.text));
    check("only the requested word text contains it, flagged sensitive", dry.length === 1 && dry[0].sensitive && dry[0].text.includes("Your family word is"));
    const contentLeak = logs.filter((l) => /jail|bail|crashed|hospital|car accident/i.test(l) && !/^(PASS|FAIL|===)/.test(l));
    check("message / transcript content never logged", contentLeak.length === 0, contentLeak.join(" | "));
    const ev = await query<{ outcome: string; flags: string[]; risk_level: string | null }>(
      "SELECT outcome, flags, risk_level FROM events WHERE user_id = $1 AND source = 'family' ORDER BY created_at",
      [ids.gma],
    );
    const outcomes = ev.rows.map((r) => r.outcome);
    console.log("events:", ev.rows.map((r) => `${r.outcome} [${r.flags.join(",")}]`).join("; "));
    check(
      "events logged with outcome + deciding check",
      ["verified_safe", "failed", "verified_needs_help", "unreachable"].every((o) => outcomes.includes(o)) && ev.rows.every((r) => r.flags.some((f) => f.startsWith("check:"))),
    );
    check("events hold no content", !JSON.stringify(ev.rows).match(/purple|jail|bail|hospital/i));
    const safe = await one("SELECT ciphertext FROM safe_words WHERE circle_id = $1", [ids.circle]);
    check("DB stores ciphertext only", safe && !Buffer.from(safe.ciphertext).toString("utf8").includes("purple"));
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
