// "Reply YES to confirm" actions (CLAUDE.md rule 4: nothing happens from voice alone).
// Any flow can park an action for a user; the iMessage router (Flow 1) calls resolvePending()
// when that user texts YES / NO. Lives in memory only, expires after 10 minutes.

export interface PendingAction {
  kind: string; // e.g. "verify_call", "circle_alert", "call_feedback"
  data: Record<string, unknown>;
  expiresAt: number;
}

/**
 * Returns false when the action turned out to be stale (e.g. the emergency it belonged to expired):
 * resolvePending then reports "not consumed" so the router handles the YES / NO normally and the user
 * still gets a reply. true / undefined = handled (the handler sent its own reply).
 */
type Handler = (userId: string, data: Record<string, unknown>, answer: "yes" | "no") => Promise<boolean | void>;

const pending = new Map<string, PendingAction>();
const handlers = new Map<string, Handler>();

export function registerPendingHandler(kind: string, handler: Handler) {
  handlers.set(kind, handler);
}

/**
 * Parks an action until the user texts YES / NO. Each user has one slot. Low-priority actions
 * (e.g. "call_feedback") pass `ifFree: true` so they never overwrite a live action such as
 * "verify_call"; returns false when they were skipped.
 */
export function setPending(
  userId: string,
  kind: string,
  data: Record<string, unknown> = {},
  ttlMs = 10 * 60_000,
  opts: { ifFree?: boolean } = {},
): boolean {
  if (opts.ifFree && peekPending(userId)) return false;
  pending.set(userId, { kind, data, expiresAt: Date.now() + ttlMs });
  return true;
}

export function peekPending(userId: string): PendingAction | null {
  const p = pending.get(userId);
  if (!p) return null;
  if (p.expiresAt < Date.now()) {
    pending.delete(userId);
    return null;
  }
  return p;
}

/** Drops the user's parked action (only if it is of `kind`, when given). */
export function clearPending(userId: string, kind?: string): void {
  const p = pending.get(userId);
  if (p && (!kind || p.kind === kind)) pending.delete(userId);
}

/** Returns true if a pending action consumed this YES/NO (false if none, or its handler declined it). */
export async function resolvePending(userId: string, answer: "yes" | "no"): Promise<boolean> {
  const p = peekPending(userId);
  if (!p) return false;
  pending.delete(userId);
  const h = handlers.get(p.kind);
  if (!h) {
    console.warn(`[pending] no handler registered for "${p.kind}"`);
    return false;
  }
  return (await h(userId, p.data, answer)) !== false;
}

/** YES / NO detection for short replies ("yes", "Yes!", "y", "yeah", "no", "nope"). */
export function parseYesNo(text: string): "yes" | "no" | null {
  const t = text.trim().toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (/^(yes|y|yeah|yep|yup|ok|okay|sure|confirm|do it)$/.test(t)) return "yes";
  if (/^(no|n|nope|nah|stop|cancel|dont)$/.test(t)) return "no";
  return null;
}
