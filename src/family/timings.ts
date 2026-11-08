// Flow 3 timers in one place. Plain object so scripts/test-family.ts can shorten them.
export const familyTimings = {
  /** SPEC step 8: no answer within 90 s → unreachable. */
  verifyNoAnswerMs: 90_000,
  /** If the relative did pick up, give the check this long in total before giving up. */
  verifyHardCapMs: 150_000,
  /** Step 11: wait this long for Grandma's NO/YES before alerting the circle without "No money was sent." */
  alertWaitMs: 2 * 60_000,
  /** Repeat triggers (live listen fires on every turn) inside this window are ignored. */
  retriggerCooldownMs: 5 * 60_000,
  /** How long an emergency stays active for "what's the word?" texts. */
  emergencyTtlMs: 30 * 60_000,
};
