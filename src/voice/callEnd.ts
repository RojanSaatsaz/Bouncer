// What happens when a call ends (SPEC Flow 2 step 10, Flow 3 step 8). Called by the post-call webhook
// after the signature check. Never logs payload content: only type, agent and a conversation id prefix.
import { config } from "../config.js";
import { query } from "../db.js";
import { endSession } from "./session.js";
import { onVerifyCallEnded } from "../family/index.js";
import { setPending, registerPendingHandler } from "../pending.js";
import { getUserById, textUser } from "../users.js";
import { logEvent } from "../detection/scan.js";
import { FLAG_LABELS } from "../detection/questions.js";

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
  const s = endSession(conv); // rule 1: turn text is dropped here
  if (!s || !s.userId || s.userId === "unknown") return;
  if (type === "call_initiation_failure") return; // inbound calls never get here; nothing to summarize

  const flags = [...s.alerted];
  const payloadSecs = evt.data?.metadata?.call_duration_secs;
  const durationS =
    typeof payloadSecs === "number" && Number.isFinite(payloadSecs)
      ? Math.round(payloadSecs)
      : Math.round((Date.now() - s.startedAt) / 1000);

  const eventId = await logEvent({
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
  if (flags.length === 0) {
    await textUser(s.userId, ["Call ended. I didn't hear any scam signs."], keyPrefix);
    return;
  }

  const n = flags.length;
  const list = flags.map((f) => FLAG_LABELS[f] ?? f.replace(/_/g, " ")).join("; ");
  const summary = `Call summary: Bouncer spotted ${n} red flag${n === 1 ? "" : "s"}: ${list}.`;
  // ifFree: never overwrite a live action (e.g. "Reply YES and I'll call Jake"). If the slot is taken,
  // don't ask the question either, or the user's YES would go to the other action.
  const asked = eventId ? setPending(s.userId, "call_feedback", { eventId }, 30 * 60_000, { ifFree: true }) : false;
  await textUser(s.userId, [asked ? `${summary} Was it a scam? Reply YES or NO.` : summary], keyPrefix);
}

registerPendingHandler("call_feedback", async (userId, data, answer) => {
  const eventId = typeof data.eventId === "string" ? data.eventId : null;
  await query("INSERT INTO feedback (user_id, event_id, answer) VALUES ($1, $2, $3)", [userId, eventId, answer]);
  await textUser(
    userId,
    [answer === "yes" ? "Thanks for telling me. That helps me catch the next one." : "Thanks. Glad it was a real call."],
    `bouncer:feedback:${eventId ?? Date.now()}`,
  );
});
