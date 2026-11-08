// OpenAI-style chat.completion.chunk SSE responses for ElevenLabs' custom LLM (SPEC Flow 2 step 5).
// Shared by the Listen agent (Flow 2) and the Verify agent (Flow 3).

const enc = new TextEncoder();
const chunk = (id: string, model: string, delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" };

/** Silence: answer the turn with the skip_turn system tool. Returned immediately, before any Jev work. */
export function skipTurnResponse(model = "bouncer-listen"): Response {
  const id = "s" + Date.now();
  const toolCall = { index: 0, id: "call_skip", type: "function", function: { name: "skip_turn", arguments: "{}" } };
  const body =
    chunk(id, model, { role: "assistant", tool_calls: [toolCall] }) + chunk(id, model, {}, "tool_calls") + "data: [DONE]\n\n";
  return new Response(body, { headers: HEADERS });
}

/**
 * Speaks text as it arrives (e.g. from Gemini's stream), then optionally calls a tool such as end_call.
 * `firstChunkFallback` is sent if the source hasn't produced text within `fallbackAfterMs`.
 */
export function speakResponse(
  source: AsyncIterable<string> | string,
  opts: {
    model?: string;
    thenTool?: { name: string; arguments?: Record<string, unknown> };
    firstChunkFallback?: string;
    fallbackAfterMs?: number;
  } = {},
): Response {
  const model = opts.model ?? "bouncer-listen";
  const id = "r" + Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s));
      send(chunk(id, model, { role: "assistant", content: "" }));
      let started = false;
      let timer: NodeJS.Timeout | undefined;
      if (opts.firstChunkFallback) {
        timer = setTimeout(() => {
          if (!started) {
            started = true;
            send(chunk(id, model, { content: opts.firstChunkFallback }));
          }
        }, opts.fallbackAfterMs ?? 700);
      }
      try {
        if (typeof source === "string") {
          started = true;
          send(chunk(id, model, { content: source }));
        } else {
          for await (const piece of source) {
            started = true;
            send(chunk(id, model, { content: piece }));
          }
        }
      } catch (err: any) {
        console.error("[sse] source failed:", err?.message);
        if (!started) send(chunk(id, model, { content: "Sorry, I'll text you instead." }));
      } finally {
        clearTimeout(timer);
      }
      if (opts.thenTool) {
        const call = {
          index: 0,
          id: "call_" + opts.thenTool.name,
          type: "function",
          function: { name: opts.thenTool.name, arguments: JSON.stringify(opts.thenTool.arguments ?? {}) },
        };
        send(chunk(id, model, { tool_calls: [call] }));
        send(chunk(id, model, {}, "tool_calls"));
      } else {
        send(chunk(id, model, {}, "stop"));
      }
      send("data: [DONE]\n\n");
      controller.close();
    },
  });
  return new Response(stream, { headers: HEADERS });
}

/** Reads `key=value` pairs out of the agent's system prompt (e.g. "conv=abc caller=+1214…"). */
export function parseSystemVars(messages: Array<{ role: string; content?: unknown }>): Record<string, string> {
  const sys = messages.find((m) => m.role === "system");
  const text = typeof sys?.content === "string" ? sys.content : Array.isArray(sys?.content) ? sys!.content.map((p: any) => p?.text ?? "").join(" ") : "";
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(\w+)=(\S*)/g)) out[m[1]] = m[2];
  return out;
}
