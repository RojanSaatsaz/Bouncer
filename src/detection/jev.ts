// TypeSafe Jev client. Jev makes every scam decision (CLAUDE.md rule 3).
// One request per decision: send every question together. Verified against the live API:
//   noul   → { type: "noul", noul: 0..1 }
//   choice → { type: "choice", choice, confidence, probabilities: { label: p } }
//   score  → needs criteria: string[]; → { type: "score", score, confidence, legend, probabilities }
// `state` may be a string or a JSON object.
import { config } from "../config.js";

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> };

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  ms: number;
}

const URL = "https://api.typesafe.ai/v1/systemone";

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<JevResult> {
  const retries = opts.retries ?? 3;
  const t0 = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.typesafe.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: config.typesafe.model, questions }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Jev HTTP ${res.status}`);
        const retryAfter = Number(res.headers.get("retry-after")) * 1000;
        await sleep(retryAfter || 500 * 2 ** attempt + Math.random() * 250);
        continue;
      }
      if (!res.ok) {
        // 4xx other than 429: a bug in our question set. Body is a validation message, not user content.
        throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as { model: string; answers: Record<string, JevAnswer> };
      return { model: body.model, answers: body.answers, ms: Date.now() - t0 };
    } catch (err: any) {
      lastErr = err;
      if (String(err?.message).startsWith("Jev HTTP 4")) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Probability from a noul answer, 0 when the question wasn't asked. */
export const noul = (r: JevResult, key: string): number => {
  const a = r.answers[key];
  return a?.type === "noul" ? a.noul : 0;
};

/** Winning label and its confidence for a choice answer. */
export const choice = (r: JevResult, key: string): { label: string | null; confidence: number } => {
  const a = r.answers[key];
  return a?.type === "choice" ? { label: a.choice, confidence: a.confidence } : { label: null, confidence: 0 };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
