// What happens when a call ends (SPEC Flow 2 step 10, Flow 3 step 8). Called by the post-call webhook
// after the signature check. Never logs payload content: only type, agent and a conversation id prefix.
import { config } from "../config.js";
import { endSession, peekSession } from "./session.js";
import { onVerifyCallEnded } from "../family/index.js";
import { getUserById, textUser } from "../users.js";
import { logEvent } from "../detection/scan.js";
import { alertTexts, callerTranscript } from "./score.js";
import { writeCallSummary } from "./summary.js";
import { atLeast } from "../detection/risk.js";
import { openCase, detectPayment, detectAmounts, setCaseContact, type CaseFile } from "../messages/case.js";
import { findOfficialContact, contactLine } from "../contacts/index.js";
import { addBouncerTurn } from "../messages/history.js";

/** Fields we read from the webhook body. Shapes per https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks */
export interface PostCallEvent {
  type?: string; // "post_call_transcription" | "call_initiation_failure" | "post_call_audio" | ...
  event_timestamp?: number;
  data?: {
    agent_id?: string;
    conversation_id?: string;
    metadata?: { call_duration_secs?: number } & Record<string, unknown>;
    failure_reason?: string; // call_initiation_failure: "busy" | "no-answer" | "unknown"
  };
}

const short = (s: string) => s.slice(0, 12);
/** First `max` characters, cut at a sentence end when possible. */
const clip = (t: string, max: number) => {
  const flat = t.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const end = flat.lastIndexOf(". ", max);
  return (end > max / 2 ? flat.slice(0, end + 1) : flat.slice(0, max)) + " …";
};

export async function onCallEnded(evt: PostCallEvent): Promise<void> {
  const type = evt.type ?? "";
  const agentId = evt.data?.agent_id ?? "";
  const conv = evt.data?.conversation_id ?? "";
  const agent =
    agentId === config.elevenlabs.verifyAgentId ? "verify" : agentId === config.elevenlabs.listenAgentId ? "listen" : "other";
  console.log(`[post-call] ${type || "?"} agent=${agent} conv=${short(conv) || "?"}`);
  if (!conv) return;

  if (type !== "post_call_transcription" && type !== "call_initiation_failure") return; // e.g. audio: ignore

  if (agent === "verify") {
    await onVerifyCallEnded(conv, { failed: type === "call_initiation_failure" });
    return;
  }

  // Listen agent (or an unknown agent: sessions only exist for Listen calls, so this is a no-op then).
  // endSession() clears Bouncer's spoken replies: copy them first for the summary (memory only, rule 1).
  const replies = new Map(peekSession(conv)?.replies ?? []);
  const s = endSession(conv);
  if (!s) return;
  try {
    await finishListenCall(s, type, evt, replies);
  } finally {
    // Rule 1: the transcript existed only for the summary; drop it now (the object is garbage soon anyway).
    s.turns.length = 0;
    replies.clear();
  }
}

async function finishListenCall(
  s: NonNullable<ReturnType<typeof endSession>>,
  type: string,
  evt: PostCallEvent,
  replies: Map<number, string>,
): Promise<void> {
  const conv = s.conv;
  if (!s.userId || s.userId === "unknown") return;
  if (type === "call_initiation_failure") return; // inbound calls never get here; nothing to summarize

  const flags = [...s.alerted];
  const payloadSecs = evt.data?.metadata?.call_duration_secs;
  const durationS =
    typeof payloadSecs === "number" && Number.isFinite(payloadSecs)
      ? Math.round(payloadSecs)
      : Math.round((Date.now() - s.startedAt) / 1000);

  // The call's key facts become the user's active case before the transcript is dropped, so their next
  // texts ("I already paid", "klarna") are understood. Code reads the transcript here; no model call, and
  // nothing but labels, amounts and a payment method is kept (memory only, 30 min, rule 1).
  let kase: CaseFile | null = null;
  if (flags.length || atLeast(s.level, "unsure")) {
    const transcript = callerTranscript(s);
    const c = (kase = openCase(s.userId, {
      source: "call",
      level: s.level,
      scamType: s.scamType,
      flags: [...s.flags],
      brand: s.brand,
      payment: detectPayment(transcript),
      amounts: detectAmounts(transcript),
      durationS,
    }));
    console.log(`[post-call] conv=${short(conv)} case opened: payment=${c.payment?.method ?? "none"} amounts=${c.amounts.length}`);
  }

  await logEvent({
    userId: s.userId,
    source: "call",
    level: s.level,
    p: s.p,
    scamType: s.scamType,
    flags,
    alertCount: s.alertCount,
    durationS,
  });

  const u = await getUserById(s.userId);
  if (!u?.space_id || !u.photon_sender_id) {
    console.warn(`[post-call] no iMessage thread for user ${s.userId.slice(0, 8)}; summary not sent`);
    return;
  }

  const keyPrefix = `bouncer:postcall:${conv}`;
  const talkUsed = s.botTurns.size > 0 || replies.size > 0;
  const summary = await writeCallSummary(
    {
      level: s.level,
      p: s.p,
      scamType: s.scamType,
      alerted: flags,
      crossed: [...s.flags],
      probs: { ...s.probs },
      alertsSent: alertTexts(s),
      durationS,
      talkUsed,
    },
    { turns: s.turns, botTurns: s.botTurns, replies },
    s.userId,
  );
  // Names and timings only, never the text (rule 1).
  console.log(
    `[post-call] conv=${short(conv)} summary=${summary.source}${summary.reason ? ` (${summary.reason})` : ""} chars=${summary.text.length} ${summary.ms}ms`,
  );
  await textUser(s.userId, [summary.text], keyPrefix);
  // Chat memory gets a short note of what Bouncer texted (the case already holds the facts), so a
  // follow-up like "what should I do now?" isn't answered cold. Memory only, like every chat turn.
  addBouncerTurn(s.userId, `[Bouncer texted a call summary] ${clip(summary.text, 320)}`);

  // The caller claimed to be a company or agency: text its real, verified number and website (src/contacts).
  if (kase?.brand) {
    const oc = await findOfficialContact(kase.brand, { scamType: s.scamType, timeoutMs: 5_000 });
    if (oc) {
      setCaseContact(s.userId, oc);
      const line = contactLine(oc, "call");
      await textUser(s.userId, [line], `${keyPrefix}:contact`);
      addBouncerTurn(s.userId, line);
    }
  }
}
