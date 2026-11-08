// OWNER: Flow 2 (voice). Foundation stub: every Listen turn is answered with skip_turn,
// which is enough for the SPEC Flow 2 spike test (silence, caller id present, turn delay).
import type { Context } from "hono";
import { skipTurnResponse, parseSystemVars } from "./sse.js";
import { handleVerifyTurn } from "../family/index.js";

export async function handleChatCompletions(c: Context, body: any): Promise<Response> {
  const vars = parseSystemVars(body?.messages ?? []);
  if (vars.verify !== undefined) return handleVerifyTurn(c, body, vars);

  // Spike-test logging: whether caller id arrives and how many turns ElevenLabs sends. No transcript text (rule 1).
  const userTurns = (body?.messages ?? []).filter((m: any) => m.role === "user").length;
  console.log(
    `[listen] turn conv=${vars.conv?.slice(0, 10) ?? "?"} caller=${vars.caller ? `present(len ${vars.caller.length})` : "EMPTY"} userTurns=${userTurns} stream=${body?.stream}`,
  );
  return skipTurnResponse("bouncer-listen");
}
