// Per-user iMessage conversation memory, so Bouncer can follow up instead of answering each text cold.
// In memory only, last 12 turns, dropped 30 minutes after the last activity. Never written to the DB,
// never logged (rule 1, same as call turns). Screenshots are recorded as a one-line note, never the
// extracted text. Texts handled by Flow 3 setup / emergency / Flow 4 recovery are never recorded here
// (inbound.ts records the user's text only after those handlers pass on it), so a safe word can't land
// in this memory or in a Gemini prompt (rule 2).
//
// Compaction keeps the prompt small: past COMPACT_AT turns, the oldest ones are folded (one background
// fast-model call) into a ≤ 280-character summary and only the last KEEP turns stay word for word. The
// summary is memory too: same 30-minute life, never stored or logged.
import { generate } from "../detection/gemini.js";

const TTL_MS = 30 * 60_000;
const MAX_TURNS = 12;
const MAX_CHARS = 700; // per turn: a pasted message is kept long enough to explain a verdict, no more
const COMPACT_AT = 8;
const KEEP = 4;
const SUMMARY_MAX = 280;

export interface Turn {
  role: "user" | "bouncer";
  text: string;
  at: number;
}

/** The last verdict, as decided by Jev and code (rule 3). Chat answers explain it; they never change it. */
export interface VerdictMemo {
  level: string; // RiskLevel
  label: string; // "Likely scam"
  confidence: number;
  capped: boolean;
  flags: string[]; // flag names
  scamType: string | null;
  claimedBrand: string | null;
  source: "text" | "screenshot";
  at: number;
}

interface Convo {
  turns: Turn[];
  verdict: VerdictMemo | null;
  /** Older turns, compressed. */
  summary: string | null;
  compacting: boolean;
  timer: NodeJS.Timeout;
}

const convos = new Map<string, Convo>();

function touch(userId: string): Convo {
  let c = convos.get(userId);
  if (c) clearTimeout(c.timer);
  else c = { turns: [], verdict: null, summary: null, compacting: false, timer: undefined as unknown as NodeJS.Timeout };
  c.timer = setTimeout(() => convos.delete(userId), TTL_MS);
  c.timer.unref(); // don't keep the process (or a test script) alive just for this
  convos.set(userId, c);
  return c;
}

function add(userId: string, role: Turn["role"], text: string) {
  const t = text.trim();
  if (!t) return;
  const c = touch(userId);
  c.turns.push({ role, text: t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + "…" : t, at: Date.now() });
  if (c.turns.length > MAX_TURNS) c.turns.splice(0, c.turns.length - MAX_TURNS);
  if (c.turns.length > COMPACT_AT && !c.compacting) void compact(userId, c);
}

const COMPACT_SYSTEM =
  "You compress a text chat between a user and Bouncer, a scam-checking assistant, into memory notes for Bouncer. " +
  "Write at most 2 short sentences, under 280 characters in total: what the user checked or asked, Bouncer's verdicts, " +
  "what the user said they did or paid, and anything still open. Leave out names, phone numbers, links, codes, " +
  "account numbers and exact message wording. Plain text only.";

/** Folds all but the last KEEP turns into the summary. On any failure the turns simply stay (MAX_TURNS caps them). */
export async function compact(userId: string, c = convos.get(userId)): Promise<void> {
  if (!c || c.compacting || c.turns.length <= KEEP) return;
  c.compacting = true;
  const old = c.turns.slice(0, c.turns.length - KEEP);
  const lines = old.map((t) => `${t.role === "user" ? "User" : "Bouncer"}: ${t.text}`).join("\n");
  try {
    const out = await generate({
      tier: "fast",
      system: COMPACT_SYSTEM,
      parts: [{ text: `${c.summary ? `Earlier notes: ${c.summary}\n\n` : ""}Chat to add:\n${lines}\n\nWrite the updated notes.` }],
      temperature: 0.2,
      maxOutputTokens: 120,
      timeoutMs: 4_000,
    });
    const sum = out.replace(/\s+/g, " ").replace(/^(notes|summary):\s*/i, "").trim();
    if (convos.get(userId) !== c || !sum) return; // expired meanwhile, or nothing usable
    c.summary = sum.length > SUMMARY_MAX ? sum.slice(0, sum.lastIndexOf(" ", SUMMARY_MAX)) + "…" : sum;
    c.turns = c.turns.filter((t) => !old.includes(t));
    console.log(`[history] compacted ${old.length} turns into ${c.summary.length} chars`); // sizes only (rule 1)
  } catch (err: any) {
    console.warn(`[history] compaction failed: ${err?.message}`);
  } finally {
    c.compacting = false;
  }
}

export const addUserTurn = (userId: string, text: string) => add(userId, "user", text);
export const addBouncerTurn = (userId: string, text: string) => add(userId, "bouncer", text);

export function setVerdict(userId: string, v: Omit<VerdictMemo, "at">) {
  touch(userId).verdict = { ...v, at: Date.now() };
}

/** A copy of the live conversation (empty when none, or expired). */
export function getHistory(userId: string): { turns: Turn[]; verdict: VerdictMemo | null; summary: string | null } {
  const c = convos.get(userId);
  return c ? { turns: [...c.turns], verdict: c.verdict, summary: c.summary } : { turns: [], verdict: null, summary: null };
}

export function clearHistory(userId: string) {
  const c = convos.get(userId);
  if (c) clearTimeout(c.timer);
  convos.delete(userId);
}
