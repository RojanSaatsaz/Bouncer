// SPEC Flow 3 steps 7–8: call the real relative and check the family word, without ever saying it.
// The ElevenLabs "Bouncer Verify" agent speaks its own greeting ("…Are you safe right now?"); every
// later turn comes to /v1/chat/completions and is answered here. Call state lives in memory only.
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { one, query } from "../db.js";
import { askJev, noul } from "../detection/jev.js";
import { speakResponse } from "../voice/sse.js";
import { toE164 } from "../users.js";
import { getSafeWordRow, protectedName as loadProtectedName, type Member } from "./circle.js";
import { decryptWord, wordsMatch, type EncryptedWord } from "./crypto.js";
import { familyTimings } from "./timings.js";
import { onVerificationResult } from "./emergency.js";

export type VerifyStatus = "verified_safe" | "verified_needs_help" | "failed" | "unreachable";

interface VerifySession {
  verifyId: string;
  circleId: string;
  relativeId: string;
  conversationId: string | null;
  protectedName: string;
  startedAt: number;
  phase: "ask_safe" | "ask_word" | "done";
  finalizing: boolean;
  answered: boolean;
  firstTurnIndex: number | null;
  saysUnsafe: number;
  /** User-turn indexes that didn't contain the word (a Set, so a re-sent turn isn't counted twice). */
  misses: Set<number>;
  enc: EncryptedWord | null;
  timer?: NodeJS.Timeout;
}

const sessions = new Map<string, VerifySession>(); // verify id → session
const byConversation = new Map<string, string>(); // ElevenLabs conversation id → verify id

const OUTBOUND_URL = "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call";
const isUuid = (s: string | undefined) => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const short = (id: string) => id.slice(0, 8);

// ---------------------------------------------------------------------------------------------
// Step 7: place the call
// ---------------------------------------------------------------------------------------------

/**
 * Inserts a `verifications` row and rings the relative's saved number from the Verify agent.
 * Honours DRY_RUN: logs "would call relative <member id>" and uses a fake conversation id.
 */
export async function placeVerificationCall(args: {
  circleId: string;
  relative: Member;
  protectedName: string;
}): Promise<{ verifyId: string; conversationId: string | null }> {
  const { circleId, relative } = args;
  const row = await one<{ id: string }>(
    "INSERT INTO verifications (circle_id, relative_id, status) VALUES ($1, $2, 'calling') RETURNING id",
    [circleId, relative.id],
  );
  const verifyId = row!.id;
  const s: VerifySession = {
    verifyId,
    circleId,
    relativeId: relative.id,
    conversationId: null,
    protectedName: args.protectedName,
    startedAt: Date.now(),
    phase: "ask_safe",
    finalizing: false,
    answered: false,
    firstTurnIndex: null,
    saysUnsafe: 0,
    misses: new Set(),
    enc: await getSafeWordRow(circleId),
  };
  sessions.set(verifyId, s);

  const raw = relative.phone?.trim() ?? "";
  const to = toE164(raw) ?? (/^\+\d{10,15}$/.test(raw) ? raw : null);
  if (!to) {
    console.warn(`[family] relative ${short(relative.id)} has no callable number`);
    await finalizeVerification(verifyId, "unreachable", "no_phone");
    return { verifyId, conversationId: null };
  }

  // Names go into the agent's spoken greeting: make sure neither one happens to be the safe word.
  let relativeName = relative.name;
  let protectedName = args.protectedName;
  const secret = s.enc ? decryptWord(s.enc, circleId) : null;
  if (secret && wordsMatch(`${relativeName} ${protectedName}`, secret)) {
    relativeName = "there";
    protectedName = "your family";
  }

  let conversationId: string | null;
  try {
    conversationId = await outboundCall(verifyId, relative.id, to, relativeName, protectedName);
  } catch (err: any) {
    console.error(`[family] outbound call for verification ${short(verifyId)} failed: ${err?.message}`);
    await finalizeVerification(verifyId, "unreachable", "call_api_error");
    return { verifyId, conversationId: null };
  }
  s.conversationId = conversationId;
  if (conversationId) {
    byConversation.set(conversationId, verifyId);
    await query("UPDATE verifications SET conversation_id = $2, updated_at = now() WHERE id = $1", [verifyId, conversationId]);
  }
  armTimer(s, familyTimings.verifyNoAnswerMs);
  console.log(`[family] verification ${short(verifyId)} calling (conv ${conversationId?.slice(0, 12) ?? "?"})`);
  return { verifyId, conversationId };
}

async function outboundCall(verifyId: string, relativeId: string, to: string, relativeName: string, protectedName: string) {
  if (config.photon.dryRun) {
    console.log(`[family:dry-run] would call relative ${relativeId}`);
    return `dry_conv_${randomUUID().slice(0, 12)}`;
  }
  const res = await fetch(OUTBOUND_URL, {
    method: "POST",
    headers: { "xi-api-key": config.elevenlabs.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: config.elevenlabs.verifyAgentId,
      agent_phone_number_id: config.elevenlabs.phoneNumberId,
      to_number: to,
      conversation_initiation_client_data: {
        dynamic_variables: { verify_id: verifyId, relative_name: relativeName, protected_name: protectedName },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    // Strip anything that looks like a phone number before logging the error text.
    const msg = String(body?.message ?? body?.detail?.[0]?.msg ?? body?.detail ?? "").replace(/\+?\d[\d\s().-]{6,}\d/g, "<num>");
    throw new Error(`ElevenLabs outbound-call HTTP ${res.status}: ${msg.slice(0, 200)}`);
  }
  // Response (SDK SipTrunkOutboundCallResponse): { success, message, conversation_id: string|null, sip_call_id: string|null }.
  return (body?.conversation_id as string | undefined) ?? null;
}

function armTimer(s: VerifySession, ms: number) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    onTimer(s).catch((err) => console.error(`[family] verification ${short(s.verifyId)} timer failed: ${err?.message}`));
  }, ms);
  s.timer.unref?.();
}

async function onTimer(s: VerifySession) {
  if (s.phase === "done" || s.finalizing) return;
  const elapsed = Date.now() - s.startedAt;
  if (s.answered && elapsed < familyTimings.verifyHardCapMs) {
    armTimer(s, familyTimings.verifyHardCapMs - elapsed); // they picked up: let the check finish
    return;
  }
  await finalizeVerification(s.verifyId, s.misses.size ? "failed" : "unreachable", s.answered ? "timer_no_word" : "timer_no_answer");
}

// ---------------------------------------------------------------------------------------------
// Step 8: drive the call, one turn at a time
// ---------------------------------------------------------------------------------------------

const ASK_WORD = "Thanks. Please say your family safe word.";
const ASK_AGAIN = "Thanks. Please say the family safe word one more time.";
// end_call args per ElevenLabs docs: { reason (required), message? }. We speak the goodbye ourselves, so no `message`.
const endCall = (text: string, reason: string) =>
  speakResponse(text, { model: "bouncer-verify", thenTool: { name: "end_call", arguments: { reason } } });
const say = (text: string) => speakResponse(text, { model: "bouncer-verify" });

/** "Sorry, what?" style replies don't count as a wrong word. */
const REPEAT_REQUEST = /^(what|sorry|pardon|huh|come again|say (that|it) again|repeat( that)?|what was that|i didn'?t (hear|catch) (that|you))\b/;

const contentText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join(" ") : "";

export async function handleVerifyTurnImpl(body: any, vars: Record<string, string>): Promise<Response> {
  const s = await findSession(vars);
  if (!s || s.phase === "done") return endCall("Thanks. Goodbye.", "verification already finished");

  const messages: Array<{ role: string; content?: unknown }> = body?.messages ?? [];
  const userIndex = messages.filter((m) => m.role === "user").length;
  const last = messages[messages.length - 1];
  const text = last?.role === "user" ? contentText(last.content).trim() : "";

  // No new words from the relative (re-engagement, silence, empty transcript): ask again, change nothing.
  if (!text.replace(/[^\p{L}\p{N}]/gu, "")) {
    return say(s.phase === "ask_safe" ? "Are you safe right now?" : "Please say your family safe word.");
  }
  s.answered = true;

  // Turn 1 is the answer to "Are you safe right now?" (or ElevenLabs re-sending that same turn).
  if (s.phase === "ask_safe" || s.firstTurnIndex === userIndex) {
    s.firstTurnIndex = userIndex;
    const r = await firstTurnChecks(text);
    if (r.voicemail >= 0.7) {
      finalizeInBackground(s.verifyId, "unreachable", "voicemail");
      return endCall(`Please call ${s.protectedName} when you get this. Goodbye.`, "reached voicemail");
    }
    s.saysUnsafe = r.saysUnsafe;
    s.phase = "ask_word";
    return say(ASK_WORD);
  }

  // Later turns: compare with the decrypted word. The plain word stays in this function's scope.
  if (!s.enc) s.enc = await getSafeWordRow(s.circleId);
  const matched = s.enc ? wordsMatch(text, decryptWord(s.enc, s.circleId)) : false;
  if (matched) {
    const status: VerifyStatus = s.saysUnsafe >= 0.6 ? "verified_needs_help" : "verified_safe";
    finalizeInBackground(s.verifyId, status, "safe_word");
    let goodbye = `Thank you, that's right. I'll let ${s.protectedName} know. Goodbye.`;
    if (wordsMatch(goodbye, decryptWord(s.enc!, s.circleId))) goodbye = "Thank you, that's right. Goodbye.";
    return endCall(goodbye, "safe word confirmed");
  }

  if (REPEAT_REQUEST.test(text.toLowerCase()) && text.split(/\s+/).length <= 6) return say("Please say your family safe word.");

  s.misses.add(userIndex);
  if (s.misses.size >= 2) {
    finalizeInBackground(s.verifyId, "failed", "safe_word_missed_twice");
    return endCall("Thanks, I'll pass that on. Goodbye.", "safe word not confirmed");
  }
  return say(ASK_AGAIN);
}

/** Jev on the answer to "Are you safe right now?" (in memory only). Falls back to a keyword check. */
async function firstTurnChecks(answer: string): Promise<{ saysUnsafe: number; voicemail: number }> {
  try {
    const r = await askJev(
      `Phone call. Bouncer asked: "Are you safe right now?" The person who picked up answered: "${answer}"`,
      {
        says_unsafe: { type: "noul", instructions: "The speaker says they are not safe or need help." },
        is_voicemail: {
          type: "noul",
          instructions: "This is a voicemail greeting or an automated phone message, not a person answering live.",
        },
      },
      { retries: 0, timeoutMs: 2_500 },
    );
    return { saysUnsafe: noul(r, "says_unsafe"), voicemail: noul(r, "is_voicemail") };
  } catch (err: any) {
    console.warn(`[family] Jev says_unsafe failed (${err?.message}); using keyword fallback`);
    const unsafe = /\b(help|not safe|not okay|not ok|trouble|hurt|emergency|scared|police|jail|hospital)\b/i.test(answer);
    return { saysUnsafe: unsafe ? 1 : 0, voicemail: 0 };
  }
}

/** Finds the call's session by verify id, then conversation id, then (after a restart) the database. */
async function findSession(vars: Record<string, string>): Promise<VerifySession | null> {
  const id = vars.verify;
  if (id && sessions.has(id)) return sessions.get(id)!;
  const viaConv = vars.conv ? byConversation.get(vars.conv) : undefined;
  if (viaConv && sessions.has(viaConv)) return sessions.get(viaConv)!;

  const where = isUuid(id) ? ["v.id = $1", id] : vars.conv ? ["v.conversation_id = $1", vars.conv] : null;
  if (!where) return null;
  const row = await one<{ id: string; circle_id: string; relative_id: string; status: string; conversation_id: string | null; protected_user_id: string; created_at: Date }>(
    `SELECT v.id, v.circle_id, v.relative_id, v.status, v.conversation_id, v.created_at, c.protected_user_id
       FROM verifications v JOIN circles c ON c.id = v.circle_id WHERE ${where[0]}`,
    [where[1]],
  );
  if (!row) return null;
  const s: VerifySession = {
    verifyId: row.id,
    circleId: row.circle_id,
    relativeId: row.relative_id,
    conversationId: row.conversation_id ?? vars.conv ?? null,
    protectedName: await loadProtectedName(row.protected_user_id),
    startedAt: row.created_at.getTime(),
    phase: row.status === "calling" ? "ask_safe" : "done",
    finalizing: row.status !== "calling",
    answered: false,
    firstTurnIndex: null,
    saysUnsafe: 0,
    misses: new Set(),
    enc: await getSafeWordRow(row.circle_id),
  };
  sessions.set(s.verifyId, s);
  if (s.conversationId) byConversation.set(s.conversationId, s.verifyId);
  if (s.phase !== "done") armTimer(s, Math.max(1_000, familyTimings.verifyHardCapMs - (Date.now() - s.startedAt)));
  return s;
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/** Sets the final status once (only from `calling`), then hands off to steps 9–12. */
export async function finalizeVerification(verifyId: string, status: VerifyStatus, decidedBy: string): Promise<boolean> {
  const s = sessions.get(verifyId);
  if (s) {
    s.phase = "done";
    s.finalizing = true;
    clearTimeout(s.timer);
  }
  const row = await one<{ id: string; circle_id: string; relative_id: string }>(
    `UPDATE verifications SET status = $2, updated_at = now() WHERE id = $1 AND status = 'calling'
     RETURNING id, circle_id, relative_id`,
    [verifyId, status],
  );
  if (!row) return false; // already final
  console.log(`[family] verification ${short(verifyId)} → ${status} (check: ${decidedBy})`);
  try {
    await onVerificationResult({ verificationId: row.id, circleId: row.circle_id, relativeId: row.relative_id, status, decidedBy });
  } catch (err: any) {
    console.error(`[family] follow-up for verification ${short(verifyId)} failed: ${err?.message}`);
  }
  return true;
}

/** For the call turns: the spoken reply goes out now, the result texts follow. Never an unhandled rejection. */
function finalizeInBackground(verifyId: string, status: VerifyStatus, decidedBy: string): void {
  finalizeVerification(verifyId, status, decidedBy).catch((err) =>
    console.error(`[family] finalizing verification ${short(verifyId)} failed: ${err?.message}`),
  );
}

/** Post-call webhook (Flow 2) or call_initiation_failure for a Verify-agent conversation. */
export async function onVerifyCallEndedImpl(conversationId: string, outcome: { failed: boolean }): Promise<void> {
  let verifyId = byConversation.get(conversationId);
  if (!verifyId) {
    const row = await one<{ id: string }>("SELECT id FROM verifications WHERE conversation_id = $1", [conversationId]);
    verifyId = row?.id;
  }
  if (!verifyId) {
    console.warn(`[family] call ended for unknown verify conversation ${conversationId.slice(0, 12)}`);
    return;
  }
  const s = sessions.get(verifyId);
  if (!s?.finalizing) {
    const missed = (s?.misses.size ?? 0) > 0;
    const status: VerifyStatus = !outcome.failed && missed ? "failed" : "unreachable";
    const decidedBy = outcome.failed
      ? "call_initiation_failure"
      : missed
        ? "hung_up_after_wrong_word"
        : s?.answered
          ? "hung_up_before_word"
          : "no_answer";
    await finalizeVerification(verifyId, status, decidedBy);
  }
  // Rule 1: call state is dropped when the call ends.
  if (s) clearTimeout(s.timer);
  sessions.delete(verifyId);
  byConversation.delete(conversationId);
}
