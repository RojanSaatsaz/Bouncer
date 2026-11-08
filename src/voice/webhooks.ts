// POST /elevenlabs/post-call  — HMAC-signed (elevenlabs-signature), events: post_call_transcription
//                               (transcript excluded in workspace settings) and call_initiation_failure.
//                               Work happens in callEnd.ts after we answer 200.
// POST /elevenlabs/init       — conversation-initiation webhook, auth with BOUNCER_INIT_TOKEN (not yet
//                               configured in ElevenLabs; Flow 2 decides whether to use it).
import type { Context } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { onCallEnded, type PostCallEvent } from "./callEnd.js";

/**
 * Same scheme as @elevenlabs/elevenlabs-js `webhooks.constructEvent` (wrapper/webhooks.js, v2.77.0):
 * header "t=<unix secs>,v0=<hex hmac>", HMAC-SHA256(secret, `${t}.${rawBody}`), rejected if t is older
 * than 30 minutes. We compare in constant time.
 */
export function verifyElevenLabsSignature(rawBody: string, sigHeader: string | undefined, secret: string): boolean {
  if (!sigHeader || !secret) return false;
  const parts = sigHeader.split(",");
  const t = parts.find((p) => p.startsWith("t="))?.substring(2);
  const v0 = parts.find((p) => p.startsWith("v0="));
  if (!t || !v0) return false;
  const ts = Number(t) * 1000;
  if (!Number.isFinite(ts) || ts < Date.now() - 30 * 60_000) return false;
  const want = Buffer.from("v0=" + createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  const got = Buffer.from(v0);
  return got.length === want.length && timingSafeEqual(got, want);
}

// In-flight post-call work (we answer 200 first). Tests await it with waitForPostCallWork().
const inFlight = new Set<Promise<void>>();
export async function waitForPostCallWork(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

export async function handlePostCall(c: Context): Promise<Response> {
  const raw = await c.req.text();
  if (!verifyElevenLabsSignature(raw, c.req.header("elevenlabs-signature"), config.elevenlabs.webhookSecret)) {
    console.warn("[post-call] bad or missing signature");
    return c.json({ error: "invalid signature" }, 401);
  }
  let evt: PostCallEvent;
  try {
    evt = JSON.parse(raw);
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  const work = onCallEnded(evt)
    .catch((err: any) => console.error(`[post-call] handling failed: ${err?.message}`))
    .finally(() => inFlight.delete(work));
  inFlight.add(work);
  return c.json({ ok: true });
}

export async function handleInit(c: Context): Promise<Response> {
  return c.json({ type: "conversation_initiation_client_data", dynamic_variables: {} });
}
