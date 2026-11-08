// Gemini REST client (v1beta generateContent / streamGenerateContent).
// Gemini reads screenshots and writes wording. It never decides whether something is a scam (rule 3).
//
// Two tiers, measured 2026-11-08 3 AM:
//   "quality" = GEMINI_MODEL (gemini-3.5-flash): better vision, but 1.5–17 s and frequent 503s tonight.
//   "fast"    = GEMINI_FAST_MODEL (gemini-3.5-flash-lite): ~0.6 s JSON, ~0.5 s to first streamed token.
// Every call has a timeout and falls back to the other tier on 503 / 429 / timeout.
import { config } from "../config.js";

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
export type Tier = "quality" | "fast";

export interface GenerateArgs {
  tier: Tier;
  system?: string;
  parts: Part[];
  /** OpenAPI-style schema (type/properties/required/nullable). Turns on JSON output. */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Don't retry on the other tier (callers with a tight latency budget). */
  noFallback?: boolean;
}

const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const modelFor = (tier: Tier) => (tier === "quality" ? config.gemini.model : config.gemini.fastModel);
const other = (tier: Tier): Tier => (tier === "quality" ? "fast" : "quality");

function body(a: GenerateArgs, model: string) {
  const generationConfig: Record<string, unknown> = {
    temperature: a.temperature ?? 0.2,
    ...(a.maxOutputTokens ? { maxOutputTokens: a.maxOutputTokens } : {}),
    ...(a.jsonSchema ? { responseMimeType: "application/json", responseSchema: a.jsonSchema } : {}),
  };
  // Non-lite models think by default; thinking adds seconds and isn't needed for transcription/wording.
  if (!model.includes("lite")) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return {
    ...(a.system ? { systemInstruction: { parts: [{ text: a.system }] } } : {}),
    contents: [{ role: "user", parts: a.parts }],
    generationConfig,
  };
}

class Retryable extends Error {}

async function once(a: GenerateArgs, tier: Tier): Promise<string> {
  const model = modelFor(tier);
  let res: Response;
  try {
    res = await fetch(`${BASE}${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": config.gemini.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body(a, model)),
      signal: AbortSignal.timeout(a.timeoutMs ?? (tier === "quality" ? 8_000 : 6_000)),
    });
  } catch (err: any) {
    throw new Retryable(`Gemini ${model} ${err?.name === "TimeoutError" ? "timed out" : err?.message}`);
  }
  if (res.status === 503 || res.status === 429 || res.status >= 500) throw new Retryable(`Gemini ${model} HTTP ${res.status}`);
  const data: any = await res.json();
  if (!res.ok) throw new Error(`Gemini ${model} HTTP ${res.status}: ${data?.error?.message?.slice(0, 200)}`);
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
  if (!text) throw new Retryable(`Gemini ${model} returned no text (finishReason ${data.candidates?.[0]?.finishReason})`);
  return text;
}

/** Plain text (or a JSON string when jsonSchema is set). Tries the requested tier, then the other one. */
export async function generate(a: GenerateArgs): Promise<string> {
  try {
    return await once(a, a.tier);
  } catch (err) {
    if (!(err instanceof Retryable) || a.noFallback) throw err;
    console.warn(`[gemini] ${err.message}; falling back to ${other(a.tier)} tier`);
    return await once(a, other(a.tier));
  }
}

/** Parsed JSON output. */
export async function generateJson<T>(a: GenerateArgs & { jsonSchema: Record<string, unknown> }): Promise<T> {
  return JSON.parse(await generate(a)) as T;
}

/**
 * Streams text chunks (SSE). Used for spoken replies, where time-to-first-token matters.
 * Falls back to the other tier only if the first request fails before any text arrives.
 */
export async function* generateStream(a: GenerateArgs): AsyncGenerator<string> {
  let res: Response | null = null;
  for (const tier of [a.tier, other(a.tier)]) {
    const model = modelFor(tier);
    try {
      const r = await fetch(`${BASE}${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "x-goog-api-key": config.gemini.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body(a, model)),
        signal: AbortSignal.timeout(a.timeoutMs ?? 10_000),
      });
      if (r.ok && r.body) {
        res = r;
        break;
      }
      console.warn(`[gemini] stream ${model} HTTP ${r.status}`);
    } catch (err: any) {
      console.warn(`[gemini] stream ${model} failed: ${err?.message}`);
    }
  }
  if (!res?.body) throw new Error("Gemini stream unavailable on both tiers");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const evt = JSON.parse(line.slice(5));
        const t = (evt.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
        if (t) yield t;
      } catch {
        /* partial/keep-alive line */
      }
    }
  }
}

/** Image buffer → inline part. The caller drops the buffer right after the call (rule 1). */
export const imagePart = (data: Buffer, mimeType: string): Part => ({
  inlineData: { mimeType, data: data.toString("base64") },
});
