// OpenRouter chat-completions backend (OpenAI format) for src/detection/gemini.ts's generate / generateStream.
// Default model deepseek/deepseek-v4.1-flash: text + image input, response_format json_schema. Verified live
// 2026-11-08: with reasoning disabled, ~0.4–0.6 s chat, ~0.25 s JSON, 0.5–1.2 s screenshot transcription,
// ~0.25 s to the first streamed token. With reasoning ON (the default) short max_tokens returned no text.
// It never decides whether something is a scam (rule 3): Jev does.
import type { GenerateArgs, Part, Tier } from "./gemini.js";

const URL = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterRetryable extends Error {}

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  fastModel: string;
}

const modelFor = (c: OpenRouterConfig, tier: Tier) => (tier === "quality" ? c.model : c.fastModel);

/** Gemini's OpenAPI-style schema → JSON Schema (`nullable: true` → `type: [t, "null"]`). */
function toJsonSchema(s: any): any {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "nullable") continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as any).map(([pk, pv]) => [pk, toJsonSchema(pv)])) : toJsonSchema(v);
  }
  if (s.nullable && typeof s.type === "string") out.type = [s.type, "null"];
  return out;
}

function content(parts: Part[]) {
  if (!parts.some((p) => "inlineData" in p)) return parts.map((p) => ("text" in p ? p.text : "")).join("\n");
  return parts.map((p) =>
    "text" in p
      ? { type: "text", text: p.text }
      : { type: "image_url", image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } },
  );
}

function body(a: GenerateArgs, model: string, stream: boolean) {
  return {
    model,
    stream,
    // Thinking adds latency and, with a small max_tokens, can eat the whole budget: off unless asked for.
    reasoning: !a.reasoning || a.reasoning === "off" ? { enabled: false } : { effort: a.reasoning, exclude: true },
    provider: { sort: "latency" }, // measured: steadier first-token times across hosts (spoken replies)
    temperature: a.temperature ?? 0.2,
    // With reasoning on, max_tokens also covers the hidden thinking: leave room for it.
    ...(a.maxOutputTokens ? { max_tokens: a.maxOutputTokens + (a.reasoning && a.reasoning !== "off" ? 2000 : 0) } : {}),
    ...(a.presencePenalty !== undefined ? { presence_penalty: a.presencePenalty } : {}),
    ...(a.frequencyPenalty !== undefined ? { frequency_penalty: a.frequencyPenalty } : {}),
    ...(a.jsonSchema
      ? { response_format: { type: "json_schema", json_schema: { name: "output", strict: false, schema: toJsonSchema(a.jsonSchema) } } }
      : {}),
    messages: [...(a.system ? [{ role: "system", content: a.system }] : []), { role: "user", content: content(a.parts) }],
  };
}

const headers = (c: OpenRouterConfig) => ({
  Authorization: `Bearer ${c.apiKey}`,
  "Content-Type": "application/json",
  "X-Title": "Bouncer",
});

async function post(c: OpenRouterConfig, a: GenerateArgs, tier: Tier, stream: boolean): Promise<Response> {
  const model = modelFor(c, tier);
  let res: Response;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: headers(c),
      body: JSON.stringify(body(a, model, stream)),
      signal: AbortSignal.timeout(a.timeoutMs ?? (stream ? 10_000 : 8_000)),
    });
  } catch (err: any) {
    throw new OpenRouterRetryable(`OpenRouter ${model} ${err?.name === "TimeoutError" ? "timed out" : err?.message}`);
  }
  if (res.status === 429 || res.status === 408 || res.status >= 500) throw new OpenRouterRetryable(`OpenRouter ${model} HTTP ${res.status}`);
  if (!res.ok) {
    // Error bodies can echo the request (message text): log the status and OpenRouter's short code only.
    const code = await res.json().then((j: any) => j?.error?.code ?? "", () => "");
    throw new Error(`OpenRouter ${model} HTTP ${res.status} ${code}`);
  }
  return res;
}

export async function openRouterOnce(c: OpenRouterConfig, a: GenerateArgs, tier: Tier): Promise<string> {
  const res = await post(c, a, tier, false);
  const data: any = await res.json();
  if (data?.error) throw new OpenRouterRetryable(`OpenRouter ${modelFor(c, tier)} error ${data.error.code ?? ""}`);
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new OpenRouterRetryable(`OpenRouter ${modelFor(c, tier)} returned no text (${data?.choices?.[0]?.finish_reason})`);
  return text;
}

/** SSE stream of content deltas. Lines starting with ":" are OpenRouter keep-alive comments. */
export async function* openRouterStream(c: OpenRouterConfig, a: GenerateArgs, tiers: Tier[]): AsyncGenerator<string> {
  let res: Response | null = null;
  for (const tier of tiers) {
    try {
      res = await post(c, a, tier, true);
      if (res.body) break;
    } catch (err: any) {
      if (!(err instanceof OpenRouterRetryable)) throw err;
      console.warn(`[llm] stream: ${err.message}`);
      res = null;
    }
  }
  if (!res?.body) throw new Error("OpenRouter stream unavailable");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const evt = JSON.parse(payload);
          const t = evt.choices?.[0]?.delta?.content;
          if (t) yield t;
        } catch {
          /* partial line */
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
