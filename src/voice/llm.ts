// SPEC Flow 2 steps 2–8: every turn of the Bouncer Listen agent comes through here.
// Silence is enforced in code: every turn gets skip_turn right away unless "Hey Bouncer" talk mode
// applies. Jev scoring and alerts run in the background (score.ts). Turn text stays in memory (rule 1).
import type { Context } from "hono";
import { skipTurnResponse, parseSystemVars, messageText } from "./sse.js";
import { handleVerifyTurn } from "../family/index.js";
import { getOrCreateSession, isEnded, type CallSession } from "./session.js";
import { identify, scheduleScore } from "./score.js";
import { maybeTalk, isWake, isSignOff } from "./talk.js";

export async function handleChatCompletions(c: Context, body: any): Promise<Response> {
  const t0 = Date.now();
  const messages: any[] = body?.messages ?? [];
  const vars = parseSystemVars(messages);
  if (vars.verify !== undefined) return handleVerifyTurn(c, body, vars);

  const conv = vars.conv?.trim();
  if (!conv || conv.startsWith("{{")) {
    console.warn("[listen] turn without a conversation id; staying silent");
    return skipTurnResponse("bouncer-listen");
  }

  // A late turn after the post-call webhook: answer silently and store nothing (rule 1).
  if (isEnded(conv)) {
    console.log(`[listen] late turn for ended call conv=${conv.slice(0, 10)}; skip_turn, nothing stored`);
    return skipTurnResponse("bouncer-listen");
  }

  const s = getOrCreateSession(conv);
  if (s.userId === null) void identify(s, vars.caller);

  // Speculative turns: ElevenLabs can send the same user-turn count twice, and revise the last turn's
  // text. Store by index (replace, never append) so duplicates don't double the transcript.
  const userTexts = messages.filter((m) => m?.role === "user").map((m) => messageText(m).trim());
  const idx = userTexts.length - 1;
  if (idx < 0) return skipTurnResponse("bouncer-listen");
  const last = userTexts[idx];
  const wake = isWake(last);
  const signOff = isSignOff(last);
  if (wake || signOff) s.botTurns.add(idx);
  if (updateTurns(s, userTexts)) scheduleScore(s);
  rememberSpokenReplies(s, messages);

  console.log(
    `[listen] turn conv=${conv.slice(0, 10)} idx=${idx} mode=${s.mode} len=${last.length}${wake ? " wake" : ""}${signOff ? " sign-off" : ""}`,
  );

  if (last && (s.mode === "talking" || wake || signOff)) {
    try {
      const res = await maybeTalk(s, idx, last, t0);
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

/**
 * ElevenLabs sends what the agent actually said as assistant messages (cut short if the user talked over
 * it). Those replace our own record of Bouncer's replies, keyed by the user turn they answered, so the
 * next prompt holds the real dialogue. In memory only (rule 1).
 */
function rememberSpokenReplies(s: CallSession, messages: any[]) {
  const said = new Map<number, string>();
  let idx = -1;
  for (const m of messages) {
    if (m?.role === "user") idx++;
    else if (m?.role === "assistant" && idx >= 0) {
      const t = messageText(m).trim();
      if (t) said.set(idx, said.has(idx) ? `${said.get(idx)} ${t}` : t);
    }
  }
  for (const [i, t] of said) s.replies.set(i, t);
}
