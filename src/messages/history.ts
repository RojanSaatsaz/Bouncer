// Per-user iMessage conversation memory, so Bouncer can follow up instead of answering each text cold.
// In memory only, last 12 turns, dropped 30 minutes after the last activity. Never written to the DB,
// never logged (rule 1, same as call turns). Screenshots are recorded as a one-line note, never the
// extracted text. Texts handled by Flow 3 setup / emergency / Flow 4 recovery are never recorded here
// (inbound.ts records the user's text only after those handlers pass on it), so a safe word can't land
// in this memory or in a Gemini prompt (rule 2).

const TTL_MS = 30 * 60_000;
const MAX_TURNS = 12;
const MAX_CHARS = 700; // per turn: a pasted message is kept long enough to explain a verdict, no more

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
  /** When the user last sent a screenshot (epoch ms). Its caption arrives as a separate text right after. */
  screenshotAt: number | null;
  timer: NodeJS.Timeout;
}

const convos = new Map<string, Convo>();

function touch(userId: string): Convo {
  let c = convos.get(userId);
  if (c) clearTimeout(c.timer);
  else c = { turns: [], verdict: null, screenshotAt: null, timer: undefined as unknown as NodeJS.Timeout };
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
}

export const addUserTurn = (userId: string, text: string) => add(userId, "user", text);
export const addBouncerTurn = (userId: string, text: string) => add(userId, "bouncer", text);

export function setVerdict(userId: string, v: Omit<VerdictMemo, "at">) {
  touch(userId).verdict = { ...v, at: Date.now() };
}

export function markScreenshot(userId: string) {
  touch(userId).screenshotAt = Date.now();
}

/** A copy of the live conversation (empty when none, or expired). */
export function getHistory(userId: string): { turns: Turn[]; verdict: VerdictMemo | null; screenshotAt: number | null } {
  const c = convos.get(userId);
  return c ? { turns: [...c.turns], verdict: c.verdict, screenshotAt: c.screenshotAt } : { turns: [], verdict: null, screenshotAt: null };
}

export function clearHistory(userId: string) {
  const c = convos.get(userId);
  if (c) clearTimeout(c.timer);
  convos.delete(userId);
}
