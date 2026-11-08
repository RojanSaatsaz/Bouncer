// Post-call webhook test (SPEC Flow 2 step 10, Flow 3 step 8). Runs the real handler in-process
// (a fake call session has to live in the same process), with DRY_RUN on: texts are printed, not sent.
//   npx tsx --env-file=.env scripts/test-postcall.ts
// Uses a fake +15555550141 user and fake conversation ids, and deletes every row it creates.
// Sections (e)–(i) call the real model (OpenRouter / Gemini) and Jev, and print the texts they produce.
// SKIP_MODEL=1 skips them.
export {};
process.env.DRY_RUN = "1";
process.env.PHOTON_SOCKET = "off";

import { createHmac, randomUUID } from "node:crypto";

const logs: string[] = [];
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
    orig(...a);
  };
}

const { Hono } = await import("hono");
const { config } = await import("../src/config.js");
const { query, one, pool } = await import("../src/db.js");
const { getOrCreateUser, saveConversation } = await import("../src/users.js");
const { getOrCreateSession, peekSession } = await import("../src/voice/session.js");
const { resolvePending, peekPending, setPending } = await import("../src/pending.js");
const { handlePostCall, waitForPostCallWork } = await import("../src/voice/webhooks.js");
const { dryRunOutbox } = await import("../src/photon/client.js");
const { encryptWord } = await import("../src/family/crypto.js");
const { contradiction, SUMMARY_MAX_CHARS, FEEDBACK_QUESTION, NO_SIGNS_TEXT } = await import("../src/voice/summary.js");
const { scoreNow, alertsSettled, alertTexts } = await import("../src/voice/score.js");
const { LEVEL_LABEL } = await import("../src/detection/risk.js");
type Level = "safe" | "unsure" | "likely_scam" | "high_risk";

const app = new Hono();
app.post("/elevenlabs/post-call", (c) => handlePostCall(c));

let failures = 0;
const check = (name: string, cond: unknown, detail?: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};
const section = (s: string) => console.log(`\n=== ${s} ===`);

const secret = config.elevenlabs.webhookSecret;
const sign = (body: string, key = secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v0=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;

async function post(payload: unknown, sig?: string) {
  const body = JSON.stringify(payload);
  const res = await app.request("/elevenlabs/post-call", {
    method: "POST",
    headers: { "content-type": "application/json", "elevenlabs-signature": sig ?? sign(body) },
    body,
  });
  await waitForPostCallWork();
  return res.status;
}

const transcription = (agentId: string, conv: string, secs = 42) => ({
  type: "post_call_transcription",
  event_timestamp: Math.floor(Date.now() / 1000),
  data: { agent_id: agentId, conversation_id: conv, status: "done", metadata: { call_duration_secs: secs } },
});
const initFailure = (agentId: string, conv: string) => ({
  type: "call_initiation_failure",
  event_timestamp: Math.floor(Date.now() / 1000),
  data: { agent_id: agentId, conversation_id: conv, failure_reason: "no-answer", metadata: { type: "sip", body: {} } },
});

const HANDLE = "+15555550141";
const LISTEN = config.elevenlabs.listenAgentId;
const VERIFY = config.elevenlabs.verifyAgentId;
const tag = randomUUID().slice(0, 8);
const verifyIds: string[] = [];
let uid = "";


// ---- Model-written texts (summary.ts) ----------------------------------------------------------

const WORD = "purple elephant";
const leaks = (t: string) => /purple|elephant/i.test(t);

/** Texts sent since outbox index `from` (DRY_RUN keeps them in memory). */
const sentSince = (from: number) => dryRunOutbox.slice(from).map((m) => m.text);

async function seedSafeWord() {
  await query("DELETE FROM circles WHERE protected_user_id = $1", [uid]);
  const c = await one("INSERT INTO circles (organizer_user_id, protected_user_id) VALUES ($1, $1) RETURNING id", [uid]);
  const enc = encryptWord(WORD, c.id);
  await query("INSERT INTO safe_words (circle_id, ciphertext, iv, auth_tag) VALUES ($1, $2, $3, $4)", [c.id, enc.ciphertext, enc.iv, enc.auth_tag]);
}

/** Runs the post-call webhook for a session and checks the one summary text it sends. */
async function endAndCheck(
  name: string,
  conv: string,
  want: { level: Level; question: boolean; source?: "model" | "template"; warm?: boolean },
  secs = 180,
): Promise<string> {
  const from = dryRunOutbox.length;
  const mark = logs.length;
  const t0 = Date.now();
  await post(transcription(LISTEN, conv, secs));
  const ms = Date.now() - t0;
  const texts = sentSince(from);
  const text = texts.find((t) => t.startsWith("📞 Call summary") || t.startsWith("Call ended")) ?? texts[0] ?? "";
  const meta = logs.slice(mark).find((l) => l.includes("summary=")) ?? "";
  console.log(`\n----- ${name} (${ms} ms end to end; ${meta.replace(/^.*summary=/, "summary=")}) -----\n${text}\n-----`);
  check(`${name}: one summary text`, texts.length === 1 && !!text, `${texts.length} texts`);
  check(`${name}: length ≤ ${SUMMARY_MAX_CHARS}`, text.length <= SUMMARY_MAX_CHARS, `${text.length}`);
  check(`${name}: no safe word`, !leaks(text));
  check(`${name}: safe word / transcript never logged`, !logs.slice(mark).some((l) => leaks(l) && !l.includes("dry-run")));
  check(`${name}: never 100% / guaranteed`, !/100\s?%|guarantee/i.test(text));
  if (want.source) check(`${name}: written by ${want.source}`, meta.includes(`summary=${want.source}`), meta);
  if (want.warm) {
    check(`${name}: warm note, no verdict line`, !text.startsWith("📞") && text.length < 320, text.slice(0, 40));
  } else {
    const label = LEVEL_LABEL[want.level];
    check(`${name}: verdict line from Jev (${label})`, text.startsWith(`📞 Call summary: `) && text.split("\n")[0].includes(label), text.split("\n")[0]);
    const body = text.split("\n").slice(1).join("\n").replace(FEEDBACK_QUESTION, "");
    check(`${name}: body consistent with level ${want.level}`, contradiction(body, want.level) === null, contradiction(body, want.level) ?? "");
  }
  check(
    `${name}: feedback question ${want.question ? "asked" : "not asked"}`,
    text.includes(FEEDBACK_QUESTION) === want.question && /Reply YES/.test(text) === want.question,
  );
  return text;
}

/** Appends turns and runs real Jev scoring + alerts on them (like the live call does after each turn). */
async function sayAndScore(s: any, lines: string[]) {
  for (const l of lines) s.turns.push(l);
  s.version++;
  await scoreNow(s, 30_000);
  for (;;) {
    const p = alertsSettled(s);
    await p;
    if (alertsSettled(s) === p) break;
  }
}

async function modelSections() {
  await seedSafeWord();

  section("(e) Chase 'fraud department' call, scored live by Jev → model-written alerts, then summary");
  {
    const conv = `conv_test_e_${tag}`;
    const s: any = getOrCreateSession(conv);
    s.userId = uid;
    const from = dryRunOutbox.length;
    const mark = logs.length;
    const stages = [
      [
        "Hello, this is Mark from the Chase fraud department. We flagged a $940 charge at a Best Buy in Miami on your debit card.",
        "No, I didn't buy anything in Miami.",
        "Okay ma'am, we need to verify you right now or the account gets frozen in ten minutes. Please stay on the line and don't hang up.",
      ],
      [
        "I just sent a six digit code to your phone. Read me that code so I can cancel the charge.",
        "Um, it says don't share this code with anyone.",
        "That's normal, that message is for scammers. I'm Chase. Read it to me quickly.",
      ],
      [
        "Next, to protect your money we have to move it. Go to Target and buy five hundred dollars in Apple gift cards and read me the numbers on the back.",
        "Gift cards? Why would the bank want gift cards?",
        "It's a secure holding method. Don't tell the cashier what it's for, they're part of the investigation.",
      ],
    ];
    for (const st of stages) await sayAndScore(s, st);
    const alerts = sentSince(from);
    const serverLogs = logs.slice(mark).filter((l) => !l.includes("dry-run")); // before this test prints them
    const wording = serverLogs.filter((l) => l.includes("alert wording"));
    console.log(`\n  Jev: level=${s.level} p=${s.p.toFixed(2)} type=${s.scamType} flags=[${[...s.flags].join(",")}]`);
    for (const w of wording) console.log(`  ${w.replace(/^.*alert wording/, "wording")}`);
    console.log(`\n  In-call alerts (${alerts.length}):\n${alerts.map((a) => `    ${a}`).join("\n")}`);
    check("(e) alerts were texted", alerts.length >= 2, `${alerts.length}`);
    check("(e) every alert starts with ⚠️ Likely scam: / ⚠️ High risk:", alerts.every((a) => /^⚠️ (Likely scam|High risk): /.test(a)));
    check("(e) alerts all differ", new Set(alerts.map((a) => a.toLowerCase())).size === alerts.length);
    check("(e) alertTexts() matches what was sent", JSON.stringify(alertTexts(s)) === JSON.stringify(alerts));
    check("(e) at least one alert worded by the model", alerts.some((a) => /code|gift|chase/i.test(a) && !/^⚠️ High risk: hang up\. Never read a code/.test(a)));
    check("(e) alerts end with an action", alerts.every((a) => /hang up|don'?t|do not|never|call .*back|stop/i.test(a)));
    check("(e) alerts / transcript never logged", !serverLogs.some((l) => alerts.some((a) => l.includes(a.slice(15, 60))) || /Best Buy|Mark from/i.test(l)));
    const want = s.level as Level;
    const text = await endAndCheck("(e) Chase summary", conv, { level: want, question: true, source: "model" });
    check("(e) names Chase and the code / gift cards", /chase/i.test(text) && /code|gift card/i.test(text));
    check("(e) points to recovery", /already paid/i.test(text));
    setPending(uid, "noop", {}, -1);
  }

  section("(f) family-emergency call (fake facts: likely_scam) → summary; safe word said on the call is never written");
  {
    const conv = `conv_test_f_${tag}`;
    const s: any = getOrCreateSession(conv);
    s.userId = uid;
    s.turns.push(
      "Grandma? It's me, it's Jake. I'm in trouble. I crashed the car and the police took me to jail.",
      "Jake? You sound different.",
      "I hurt my nose in the crash. Please don't tell Mom. A lawyer, Mr. Davis, will call you. I need two thousand dollars for bail today.",
      "Okay honey. Jake, what's our family word? Is it purple elephant?",
      "Yeah, yeah, purple elephant, that's it. Please hurry, the lawyer says you can send it by Zelle or Walmart gift cards.",
    );
    Object.assign(s, { level: "likely_scam", p: 0.82, scamType: "family_emergency", alertCount: 1 });
    s.probs = { family_danger: 0.95, money_or_code: 0.9, urgency_secrecy: 0.88, impersonation: 0.8, asks_code: 0.05, remote_access: 0.02, is_scam: 0.82 };
    for (const f of ["family_danger", "money_or_code", "urgency_secrecy", "impersonation"]) s.flags.add(f);
    for (const f of ["family_danger", "money_or_code", "urgency_secrecy"]) s.alerted.add(f);
    const text = await endAndCheck("(f) family emergency summary", conv, { level: "likely_scam", question: true, source: "model" });
    check("(f) specific: Jake / bail / jail", /jake|bail|jail/i.test(text));
    setPending(uid, "noop", {}, -1);
  }

  section("(g) safe call with a talk-mode exchange about an Amazon text → warm, specific note, no question");
  {
    const conv = `conv_test_g_${tag}`;
    const s: any = getOrCreateSession(conv);
    s.userId = uid;
    s.turns.push(
      "Hi, this is Dr. Patel's office calling to confirm your cleaning on Tuesday at 3 PM.",
      "Yes, that works. Thank you.",
      "Hey Bouncer, I got a text saying my Amazon package is on hold and I need to pay a two dollar fee with a link. Is that real?",
      "Okay, thanks Bouncer.",
    );
    s.botTurns.add(2);
    s.botTurns.add(3);
    s.replies.set(2, "That sounds like a common fake delivery text. Don't tap the link; check your orders in the Amazon app instead.");
    Object.assign(s, { level: "safe", p: 0.06 });
    s.probs = { impersonation: 0.3, money_or_code: 0.05, urgency_secrecy: 0.04, asks_code: 0.01, remote_access: 0.01, family_danger: 0.01, is_scam: 0.06 };
    const text = await endAndCheck("(g) safe call + talk mode", conv, { level: "safe", question: false, source: "model", warm: true }, 95);
    check("(g) refers to the Amazon advice", /amazon|package|delivery/i.test(text));
    check("(g) no pending question", peekPending(uid) === null);
  }

  section("(h) model failure (OPENROUTER_MODEL=does-not-exist) → richer template fallback");
  {
    const or = (config as any).openrouter;
    const saved = or ? { model: or.model } : null;
    const savedGemini = (config as any).gemini.model;
    if (or) or.model = "does-not-exist/model";
    else (config as any).gemini.model = "does-not-exist";
    try {
      const conv = `conv_test_h_${tag}`;
      const s: any = getOrCreateSession(conv);
      s.userId = uid;
      s.turns.push("This is the IRS. You owe back taxes. Pay with Apple gift cards today or a deputy will arrest you.");
      Object.assign(s, { level: "high_risk", p: 0.95, scamType: "government", alertCount: 1 });
      s.probs = { impersonation: 0.9, money_or_code: 0.93, urgency_secrecy: 0.9, asks_code: 0.1, is_scam: 0.95 };
      for (const f of ["impersonation", "money_or_code", "urgency_secrecy"]) s.flags.add(f);
      s.alerted.add("money_or_code");
      s.alerted.add("urgency_secrecy");
      const text = await endAndCheck("(h) model failure", conv, { level: "high_risk", question: true, source: "template" });
      check("(h) template has reasons, a next step and recovery", /Real agencies send letters first/.test(text) && /What to do now/.test(text) && /already paid/.test(text));
      check("(h) template carries no call content", !/deputy|arrest/i.test(text));
    } finally {
      if (or && saved) or.model = saved.model;
      (config as any).gemini.model = savedGemini;
      setPending(uid, "noop", {}, -1);
    }
  }

  section("(i) unsure call, flags crossed but none alerted → careful summary, no 'scam' verdict, no question");
  {
    const conv = `conv_test_i_${tag}`;
    const s: any = getOrCreateSession(conv);
    s.userId = uid;
    s.turns.push(
      "Hi, this is Jessica from Spectrum. We're upgrading equipment in your area and need to schedule a technician visit.",
      "Oh, okay. When?",
      "We have openings tomorrow. We'll need to confirm the account holder's date of birth before I book it.",
    );
    Object.assign(s, { level: "unsure", p: 0.44, scamType: "other" });
    s.probs = { impersonation: 0.75, money_or_code: 0.2, urgency_secrecy: 0.3, asks_code: 0.2, is_scam: 0.44 };
    s.flags.add("impersonation");
    const text = await endAndCheck("(i) unsure call", conv, { level: "unsure", question: false });
    check("(i) mentions Spectrum", /spectrum/i.test(text));
  }

  await query("DELETE FROM circles WHERE protected_user_id = $1", [uid]);
}

try {
  const { user } = await getOrCreateUser(HANDLE);
  uid = user.id;
  await saveConversation(uid, "tsp-space-0141", "tsp-agent");

  section("(a) Listen call with red flags → event, summary, call_feedback, YES → feedback row");
  {
    const conv = `conv_test_a_${tag}`;
    const s = getOrCreateSession(conv);
    Object.assign(s, { userId: uid, level: "high_risk", p: 0.93, scamType: "bank_impersonation", alertCount: 2 });
    s.alerted.add("asks_code");
    s.alerted.add("urgency_secrecy");
    s.turns.push("this text must never be stored");
    const mark = logs.length;
    const status = await post(transcription(LISTEN, conv, 42));
    check("200 for a valid signature", status === 200, `got ${status}`);
    check("session removed from memory", peekSession(conv) === null);
    const ev = await one(
      "SELECT * FROM events WHERE user_id = $1 AND source = 'call' ORDER BY created_at DESC LIMIT 1",
      [uid],
    );
    check("events row inserted", !!ev);
    check(
      "events row fields",
      ev?.risk_level === "high_risk" &&
        Math.abs(ev?.p_scam - 0.93) < 1e-4 &&
        ev?.scam_type === "bank_impersonation" &&
        ev?.alert_count === 2 &&
        ev?.duration_s === 42 &&
        [...ev?.flags].sort().join(",") === "asks_code,urgency_secrecy",
      JSON.stringify(ev),
    );
    const out = logs.slice(mark).join("\n");
    check(
      "summary sent (no transcript → template): verdict line, reasons, question",
      out.includes("📞 Call summary: ⚠️ High risk scam (93% sure).") && out.includes("code, password or PIN") && out.includes(FEEDBACK_QUESTION),
    );
    check("template points to recovery (code was asked)", out.includes('"I already paid"'));
    check("transcript never logged", !out.includes("never be stored"));
    const p = peekPending(uid);
    check("call_feedback pending set", p?.kind === "call_feedback" && p.data.eventId === ev?.id);
    const consumed = await resolvePending(uid, "yes");
    check("YES consumed by call_feedback", consumed);
    const fb = await one("SELECT * FROM feedback WHERE event_id = $1", [ev?.id]);
    check("feedback row = yes", fb?.answer === "yes" && fb?.user_id === uid, JSON.stringify(fb));
    check("thanks text sent", logs.slice(mark).some((l) => l.includes("Thanks for telling me")));
  }

  section("(a2) Listen call, no flags → short summary, no question, no pending");
  {
    const conv = `conv_test_a2_${tag}`;
    const s = getOrCreateSession(conv);
    s.userId = uid;
    s.startedAt = Date.now() - 10_000;
    const mark = logs.length;
    const status = await post({ ...transcription(LISTEN, conv), data: { agent_id: LISTEN, conversation_id: conv } });
    check("200", status === 200);
    const out = logs.slice(mark).join("\n");
    check("no-scam text sent", out.includes(NO_SIGNS_TEXT));
    check("no question asked", !out.includes("Reply YES"));
    check("no pending", peekPending(uid) === null);
    const ev = await one(
      "SELECT * FROM events WHERE user_id = $1 AND source = 'call' ORDER BY created_at DESC LIMIT 1",
      [uid],
    );
    check("duration falls back to session (~10 s)", ev?.duration_s >= 9 && ev?.duration_s <= 12, `got ${ev?.duration_s}`);
  }

  section("(a3) Listen call with flags while another action is pending → no question, slot kept");
  {
    setPending(uid, "verify_call", { test: true });
    const conv = `conv_test_a3_${tag}`;
    const s = getOrCreateSession(conv);
    s.userId = uid;
    s.alerted.add("money_or_code");
    const mark = logs.length;
    await post(transcription(LISTEN, conv));
    const out = logs.slice(mark).join("\n");
    check("summary sent without question", out.includes("📞 Call summary:") && !out.includes("Reply YES"));
    check("never says 100%", !/100\s?%/.test(out));
    check("verify_call still pending", peekPending(uid)?.kind === "verify_call");
    // Clear the fake slot without running a handler.
    setPending(uid, "noop", {}, -1);
  }

  section("(a4) Unknown caller → session dropped, nothing logged or texted");
  {
    const conv = `conv_test_a4_${tag}`;
    const s = getOrCreateSession(conv);
    s.userId = "unknown";
    s.alerted.add("asks_code");
    const before = (await one("SELECT count(*)::int AS n FROM events WHERE source = 'call'"))?.n;
    const mark = logs.length;
    await post(transcription(LISTEN, conv));
    const after = (await one("SELECT count(*)::int AS n FROM events WHERE source = 'call'"))?.n;
    check("session removed", peekSession(conv) === null);
    check("no events row", before === after);
    check("no text", !logs.slice(mark).some((l) => l.includes("dry-run")));
  }

  section("(b) Verify call ended → onVerifyCallEnded(failed=false)");
  {
    const conv = `conv_test_b_${tag}`;
    const v = await one("INSERT INTO verifications (conversation_id) VALUES ($1) RETURNING id", [conv]);
    verifyIds.push(v.id);
    const status = await post(transcription(VERIFY, conv));
    check("200", status === 200);
    const row = await one("SELECT status FROM verifications WHERE id = $1", [v.id]);
    check("verification finalized as unreachable (hung up / no answer)", row?.status === "unreachable", row?.status);
    check(
      "decided by no_answer",
      logs.some((l) => l.includes(`verification ${v.id.slice(0, 8)}`) && l.includes("no_answer")),
    );
  }

  section("(c) call_initiation_failure for Verify → onVerifyCallEnded(failed=true)");
  {
    const conv = `conv_test_c_${tag}`;
    const v = await one("INSERT INTO verifications (conversation_id) VALUES ($1) RETURNING id", [conv]);
    verifyIds.push(v.id);
    const status = await post(initFailure(VERIFY, conv));
    check("200", status === 200);
    const row = await one("SELECT status FROM verifications WHERE id = $1", [v.id]);
    check("verification unreachable", row?.status === "unreachable", row?.status);
    check(
      "decided by call_initiation_failure",
      logs.some((l) => l.includes(`verification ${v.id.slice(0, 8)}`) && l.includes("call_initiation_failure")),
    );
  }

  section("(d) bad signatures → 401");
  {
    const conv = `conv_test_d_${tag}`;
    const s = getOrCreateSession(conv);
    s.userId = uid;
    const payload = transcription(LISTEN, conv);
    const body = JSON.stringify(payload);
    check("wrong secret → 401", (await post(payload, sign(body, "not-the-secret"))) === 401);
    check("missing header → 401", (await post(payload, "")) === 401);
    check("stale timestamp → 401", (await post(payload, sign(body, secret, Math.floor(Date.now() / 1000) - 3600))) === 401);
    check("tampered body → 401", (await post({ ...payload, type: "x" }, sign(body))) === 401);
    check("session untouched by rejected requests", peekSession(conv) !== null);
    check("retry with good signature → 200", (await post(payload)) === 200);
  }

  if (process.env.SKIP_MODEL !== "1") await modelSections();
} catch (err: any) {
  console.error(`test crashed: ${err?.stack ?? err}`);
  failures++;
} finally {
  if (uid) {
    await query("DELETE FROM safe_words WHERE circle_id IN (SELECT id FROM circles WHERE protected_user_id = $1)", [uid]);
    await query("DELETE FROM circles WHERE protected_user_id = $1", [uid]);
    await query("DELETE FROM feedback WHERE user_id = $1", [uid]);
    await query("DELETE FROM events WHERE user_id = $1", [uid]);
    await query("DELETE FROM users WHERE id = $1", [uid]);
  }
  if (verifyIds.length) await query("DELETE FROM verifications WHERE id = ANY($1)", [verifyIds]);
  await pool.end();
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
