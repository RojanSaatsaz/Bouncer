// OWNER: Flow 2 (voice). Foundation stubs.
// POST /elevenlabs/post-call  — HMAC-signed (elevenlabs-signature), events: post_call_transcription
//                               (transcript excluded in workspace settings) and call_initiation_failure.
//                               Verify-agent calls must be handed to family.onVerifyCallEnded().
// POST /elevenlabs/init       — conversation-initiation webhook, auth with BOUNCER_INIT_TOKEN (not yet
//                               configured in ElevenLabs; Flow 2 decides whether to use it).
import type { Context } from "hono";

export async function handlePostCall(c: Context): Promise<Response> {
  console.log("[post-call] received (stub)");
  return c.json({ ok: true });
}

export async function handleInit(c: Context): Promise<Response> {
  return c.json({ type: "conversation_initiation_client_data", dynamic_variables: {} });
}
