// What happens when a call ends (SPEC Flow 2 step 10, Flow 3 step 8). Called by the post-call webhook
// after the signature check. Never logs payload content: only type, agent and a conversation id prefix.
import { config } from "../config.js";
import { endSession, peekSession } from "./session.js";
import { onVerifyCallEnded } from "../family/index.js";
import { getUserById, textUser } from "../users.js";
import { logEvent } from "../detection/scan.js";
import { alertTexts } from "./score.js";
import { writeCallSummary } from "./summary.js";

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
}
