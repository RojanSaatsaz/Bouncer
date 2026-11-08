// OWNER: Flow 3 (family safety). Public entry points other flows call. Foundation stubs.
import type { Context } from "hono";
import type { InboundMessage } from "../photon/socket.js";
import type { User } from "../users.js";
import { speakResponse } from "../voice/sse.js";

/**
 * Flow 3 step 4 trigger. `source: "text"` = Grandma texted about it (call the relative right away);
 * `source: "call"` = live listen saw family_danger ≥ 0.7 (ask "Reply YES and I'll call…" first, rule 4).
 * `content` is the message text or call transcript: in memory only, never stored or logged.
 */
export async function startFamilyEmergency(args: { userId: string; content: string; source: "text" | "call" }): Promise<void> {
  console.log(`[family] startFamilyEmergency stub (source=${args.source})`);
}

/**
 * Called by the iMessage router before normal routing. Returns true if Flow 3 consumed the text
 * (e.g. "what's the word?", "he said the word", the NO/YES loss question during an active emergency).
 */
export async function handleFamilyText(user: User, msg: InboundMessage): Promise<boolean> {
  return false;
}

/** /v1/chat/completions turns whose system prompt carries `verify=<id>` (Bouncer Verify agent). */
export async function handleVerifyTurn(c: Context, body: any, vars: Record<string, string>): Promise<Response> {
  return speakResponse("Thanks. Goodbye.", { model: "bouncer-verify", thenTool: { name: "end_call" } });
}

/** Post-call webhook or call_initiation_failure for a Verify-agent conversation. */
export async function onVerifyCallEnded(conversationId: string, outcome: { failed: boolean }): Promise<void> {
  console.log("[family] onVerifyCallEnded stub");
}
