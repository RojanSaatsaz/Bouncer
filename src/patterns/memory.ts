// SPEC Flow 1 step 11 / Flow 5 step 2: the last analysed message per user, in memory only, for 10 minutes,
// so a REPORT reply can use it. Never written to disk or the DB, never logged (rule 1).

const TTL_MS = 10 * 60_000;

interface Remembered {
  body: string;
  scamType: string | null;
  timer: NodeJS.Timeout;
}

const bodies = new Map<string, Remembered>();

/** Keeps `body` for this user for 10 minutes (replacing any earlier one). */
export function rememberBody(userId: string, body: string, scamType: string | null = null): void {
  forget(userId);
  if (!body?.trim()) return;
  const timer = setTimeout(() => bodies.delete(userId), TTL_MS);
  timer.unref(); // don't keep the process (or a test script) alive just for this
  bodies.set(userId, { body, scamType, timer });
}

/** Returns the remembered body and drops it (a message is reported once). */
export function takeBody(userId: string): { body: string; scamType: string | null } | null {
  const r = bodies.get(userId);
  if (!r) return null;
  forget(userId);
  return { body: r.body, scamType: r.scamType };
}

export function forget(userId: string): void {
  const r = bodies.get(userId);
  if (r) clearTimeout(r.timer);
  bodies.delete(userId);
}
