// OWNER: Flow 3 (family safety). Public entry points other flows call.
//   emergency.ts — steps 4–7 (coach, claimed relative, YES gate) and 9–12 (result texts, loss question,
//                  circle alert, event log), plus texts from Grandma during an emergency.
//   verify.ts    — the outbound verification call and the Verify agent's turns (step 8).
//   crypto.ts    — safe word AES-256-GCM + fuzzy compare.  seed.ts — demo circle setup.
import type { Context } from "hono";
import type { InboundMessage } from "../photon/socket.js";
import type { User } from "../users.js";
import { handleFamilyTextImpl, startFamilyEmergencyImpl } from "./emergency.js";
import { handleVerifyTurnImpl, onVerifyCallEndedImpl } from "./verify.js";
import { speakResponse } from "../voice/sse.js";

export { familyTimings } from "./timings.js";

/**
 * Flow 3 step 4 trigger. `source: "text"` = Grandma texted about it (call the relative right away);
 * `source: "call"` = live listen saw family_danger ≥ 0.7 (ask "Reply YES and I'll call…" first, rule 4).
 * `content` is the message text or call transcript: in memory only, never stored or logged.
 * Safe to call repeatedly: repeat triggers during an active emergency are ignored.
 */
export async function startFamilyEmergency(args: { userId: string; content: string; source: "text" | "call" }): Promise<void> {
  try {
    await startFamilyEmergencyImpl(args);
  } catch (err: any) {
    console.error(`[family] startFamilyEmergency failed: ${err?.message}`);
  }
}

/**
 * Called by the iMessage router before normal routing (after resolvePending, which handles YES/NO).
 * Returns true if Flow 3 consumed the text ("what's the word?", "he said the word", …) during an
 * active emergency for this user.
 */
export async function handleFamilyText(user: User, msg: InboundMessage): Promise<boolean> {
  try {
    return await handleFamilyTextImpl(user, msg);
  } catch (err: any) {
    console.error(`[family] handleFamilyText failed: ${err?.message}`);
    return false;
  }
}

/** /v1/chat/completions turns whose system prompt carries `verify=<id>` (Bouncer Verify agent). */
export async function handleVerifyTurn(c: Context, body: any, vars: Record<string, string>): Promise<Response> {
  try {
    return await handleVerifyTurnImpl(body, vars);
  } catch (err: any) {
    console.error(`[family] verify turn failed: ${err?.message}`);
    return speakResponse("Sorry, something went wrong. Goodbye.", {
      model: "bouncer-verify",
      thenTool: { name: "end_call", arguments: { reason: "server error" } },
    });
  }
}

/** Post-call webhook or call_initiation_failure for a Verify-agent conversation. */
export async function onVerifyCallEnded(conversationId: string, outcome: { failed: boolean }): Promise<void> {
  try {
    await onVerifyCallEndedImpl(conversationId, outcome);
  } catch (err: any) {
    console.error(`[family] onVerifyCallEnded failed: ${err?.message}`);
  }
}
