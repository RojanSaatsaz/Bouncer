// Post-call webhook test (SPEC Flow 2 step 10, Flow 3 step 8). Runs the real handler in-process
// (a fake call session has to live in the same process), with DRY_RUN on: texts are printed, not sent.
//   npx tsx --env-file=.env scripts/test-postcall.ts
// Uses a fake +15555550141 user and fake conversation ids, and deletes every row it creates.
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
    check("summary text sent", /Call summary: Bouncer spotted 2 red flags: .* Was it a scam\? Reply YES or NO\./.test(out));
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
    check("no-scam text sent", out.includes("Call ended. I didn't hear any scam signs."));
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
    check("summary sent without question", out.includes("Bouncer spotted 1 red flag:") && !out.includes("Reply YES"));
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
} catch (err: any) {
  console.error(`test crashed: ${err?.stack ?? err}`);
  failures++;
} finally {
  if (uid) {
    await query("DELETE FROM feedback WHERE user_id = $1", [uid]);
    await query("DELETE FROM events WHERE user_id = $1", [uid]);
    await query("DELETE FROM users WHERE id = $1", [uid]);
  }
  if (verifyIds.length) await query("DELETE FROM verifications WHERE id = ANY($1)", [verifyIds]);
  await pool.end();
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
