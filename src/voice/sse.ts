// OpenAI-style chat.completion.chunk SSE responses for ElevenLabs' custom LLM (SPEC Flow 2 step 5).
// Shared by the Listen agent (Flow 2) and the Verify agent (Flow 3).

const enc = new TextEncoder();
const chunk = (id: string, model: string, delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

// THE TALK-MODE "STALL" BUG: @hono/node-server writes `Content-Length` INTO the plain headers object of
// a string-body Response (responseViaCache). With one shared HEADERS object, the first skip_turn response
// (441 bytes) left "Content-Length: 441" in it, so every later streamed reply was cut off after 441 bytes
// (head + "One moment..." + a few bytes, no [DONE]). Always hand each Response its own fresh headers.
const headers = (): Record<string, string> => ({
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
});

/** Silence: answer the turn with the skip_turn system tool. Returned immediately, before any Jev work. */
export function skipTurnResponse(model = "bouncer-listen"): Response {
  const id = "s" + Date.now();
  const toolCall = { index: 0, id: "call_skip", type: "function", function: { name: "skip_turn", arguments: "{}" } };
  const body =
    chunk(id, model, { role: "assistant", tool_calls: [toolCall] }) + chunk(id, model, {}, "tool_calls") + "data: [DONE]\n\n";
  return new Response(body, { headers: headers() });
}

export interface SpeakOptions {
  model?: string;
  thenTool?: { name: string; arguments?: Record<string, unknown> };
  /** Filler said if the source has no text yet after `fallbackAfterMs`. A function is called only when the filler is actually needed. */
  firstChunkFallback?: string | (() => string);
  fallbackAfterMs?: number;
  /** When the turn arrived (default: now). The filler timer counts from here, so time spent deciding counts too. */
  startedAt?: number;
  /** Said if the source fails before producing any text. */
  errorLine?: string;
  /** Called once when the response finishes or the client (ElevenLabs) cancels it. */
  onEnd?: (info: { cancelled: boolean; spoke: boolean }) => void;
}

const TIMEOUT = Symbol("timeout");

/**
 * Speaks text as it arrives (e.g. from Gemini's stream), then optionally calls a tool such as end_call.
 * `firstChunkFallback` is sent if the source hasn't produced text within `fallbackAfterMs`.
 *
 * Pull-based: each pull() enqueues at most one chunk, so every piece is flushed as soon as it exists,
 * the filler timer can't race the source loop, and a client cancel stops the source (iterator.return())
 * instead of enqueuing into a closed stream. (The actual "stall" was the shared-headers bug above.)
 */
export function speakResponse(source: AsyncIterable<string> | string, opts: SpeakOptions = {}): Response {
  const model = opts.model ?? "bouncer-listen";
  const id = "r" + Date.now();
  const iter: AsyncIterator<string> | null = typeof source === "string" ? null : source[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<string>> | null = null;
  let phase: "head" | "body" | "tail" = "head";
  let spoke = false; // anything sent, including the filler
  let gotContent = false; // real text from the source
  let ended = false;
  const startedAt = opts.startedAt ?? Date.now();

  const finish = (cancelled: boolean) => {
    if (ended) return;
    ended = true;
    try {
      opts.onEnd?.({ cancelled, spoke });
    } catch (err: any) {
      console.error("[sse] onEnd failed:", err?.message);
    }
  };

  const tail = () => {
    let out = "";
    if (opts.thenTool) {
      const call = {
        index: 0,
        id: "call_" + opts.thenTool.name,
        type: "function",
        function: { name: opts.thenTool.name, arguments: JSON.stringify(opts.thenTool.arguments ?? {}) },
      };
      out += chunk(id, model, { tool_calls: [call] }) + chunk(id, model, {}, "tool_calls");
    } else {
      out += chunk(id, model, {}, "stop");
    }
    return out + "data: [DONE]\n\n";
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const send = (s: string) => controller.enqueue(enc.encode(s));
        if (phase === "head") {
          send(chunk(id, model, { role: "assistant", content: "" }));
          phase = "body";
          return;
        }
        if (phase === "body") {
          if (!iter) {
            send(chunk(id, model, { content: source as string }));
            spoke = gotContent = true;
            phase = "tail";
            return;
          }
          try {
            pending ??= iter.next();
            let r: IteratorResult<string> | typeof TIMEOUT;
            if (!spoke && opts.firstChunkFallback) {
              const wait = Math.max(0, (opts.fallbackAfterMs ?? 700) - (Date.now() - startedAt));
              let timer: NodeJS.Timeout | undefined;
              r = await Promise.race([
                pending,
                new Promise<typeof TIMEOUT>((res) => (timer = setTimeout(() => res(TIMEOUT), wait))),
              ]);
              clearTimeout(timer);
            } else {
              r = await pending;
            }
            if (r === TIMEOUT) {
              // Source is slow: say the filler now, keep waiting on the same pending read next pull.
              const filler = typeof opts.firstChunkFallback === "function" ? opts.firstChunkFallback() : opts.firstChunkFallback;
              send(chunk(id, model, { content: filler }));
              spoke = true;
              return;
            }
            pending = null;
            if (r.done) {
              phase = "tail";
            } else if (r.value) {
              spoke = gotContent = true;
              send(chunk(id, model, { content: r.value }));
              return;
            } else {
              return; // empty piece: pull again
            }
          } catch (err: any) {
            console.error("[sse] source failed:", err?.message);
            pending = null;
            if (!gotContent) send(chunk(id, model, { content: opts.errorLine ?? "Sorry, I'll text you instead." }));
            spoke = true;
            phase = "tail";
            return;
          }
        }
        // tail
        send(tail());
        controller.close();
        finish(false);
      },
      cancel() {
        finish(true);
        iter?.return?.().catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(stream, { headers: headers() });
}

/** Reads `key=value` pairs out of the agent's system prompt (e.g. "conv=abc caller=+1214…"). */
export function parseSystemVars(messages: Array<{ role: string; content?: unknown }>): Record<string, string> {
  const sys = messages.find((m) => m.role === "system");
  const text = typeof sys?.content === "string" ? sys.content : Array.isArray(sys?.content) ? sys!.content.map((p: any) => p?.text ?? "").join(" ") : "";
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/(\w+)=(\S*)/g)) out[m[1]] = m[2];
  return out;
}

/** Text of a chat message whose content is a string or an array of {type:"text", text} parts. */
export function messageText(m: { content?: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join(" ");
  return "";
}
