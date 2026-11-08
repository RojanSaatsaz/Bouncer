// SPEC Flow 2 steps 2–8: every turn of the Bouncer Listen agent comes through here.
// Silence is enforced in code: every turn gets skip_turn right away unless "Hey Bouncer" talk mode
// applies. Jev scoring and alerts run in the background (score.ts). Turn text stays in memory (rule 1).
import type { Context } from "hono";
import { skipTurnResponse, parseSystemVars, messageText } from "./sse.js";
import { handleVerifyTurn } from "../family/index.js";
import { getOrCreateSession, type CallSession } from "./session.js";
import { identify, scheduleScore } from "./score.js";
import { maybeTalk, WAKE, THANKS } from "./talk.js";

export async function handleChatCompletions(c: Context, body: any): Promise<Response> {
  const messages: any[] = body?.messages ?? [];
  const vars = parseSystemVars(messages);
  if (vars.verify !== undefined) return handleVerifyTurn(c, body, vars);

  const conv = vars.conv?.trim();
  if (!conv || conv.startsWith("{{")) {
    console.warn("[listen] turn without a conversation id; staying silent");
    return skipTurnResponse("bouncer-listen");
  }

  const s = getOrCreateSession(conv);
  if (s.userId === null) void identify(s, vars.caller);

  // Speculative turns: ElevenLabs can send the same user-turn count twice, and revise the last turn's
  // text. Store by index (replace, never append) so duplicates don't double the transcript.
  const userTexts = messages.filter((m) => m?.role === "user").map((m) => messageText(m).trim());
  const idx = userTexts.length - 1;
  if (idx < 0) return skipTurnResponse("bouncer-listen");
  if (updateTurns(s, userTexts)) scheduleScore(s);

  const last = userTexts[idx];
  console.log(
    `[listen] turn conv=${conv.slice(0, 10)} idx=${idx} mode=${s.mode} len=${last.length}${WAKE.test(last) ? " wake" : ""}${THANKS.test(last) ? " thanks" : ""}`,
  );

  if (last && (s.mode === "talking" || WAKE.test(last) || THANKS.test(last))) {
    try {
      const res = await maybeTalk(s, idx, last);
      if (res) return res;
    } catch (err: any) {
      console.error(`[listen] talk failed: ${err?.message}`);
    }
  }
  return skipTurnResponse("bouncer-listen");
}

/** Returns true if any turn was added or revised. Older (stale) requests never shrink the list. */
function updateTurns(s: CallSession, userTexts: string[]): boolean {
  let changed = false;
  userTexts.forEach((t, i) => {
    if (s.turns[i] !== t) {
      s.turns[i] = t;
      changed = true;
    }
  });
  if (changed) s.version++;
  return changed;
}
