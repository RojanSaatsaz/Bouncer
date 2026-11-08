// Jev question sets for live calls (SPEC Flow 2 steps 6 and 8). Wording changes the calibration.
import type { JevQuestion } from "../detection/jev.js";
import { SCAM_TYPES } from "../detection/questions.js";

/** Step 6: asked together in ONE request on the whole transcript so far. */
export const CALL_QUESTIONS: Record<string, JevQuestion> = {
  impersonation: {
    type: "noul",
    instructions: "Someone on the call claims to be from a company, a government agency, the police, or a relative.",
  },
  money_or_code: {
    type: "noul",
    instructions:
      "Someone asks for money, gift cards, cryptocurrency, a transfer to a 'safe' account, or a verification code.",
  },
  urgency_secrecy: {
    type: "noul",
    instructions: "Someone pressures the listener to act now, stay on the line, or keep this secret.",
  },
  asks_code: { type: "noul", instructions: "Someone asks the listener to read out a one-time code, password or PIN." },
  remote_access: {
    type: "noul",
    instructions: "Someone asks the listener to install an app or give access to their phone or computer.",
  },
  family_danger: {
    type: "noul",
    // Covers first-person voice-clone calls ("It's me, I'm in trouble"): 11 → 22 of 50 caught, no new legit triggers (docs/EVAL_CALLS.md).
    instructions:
      "Someone on the call says that they, or a member of the listener's family, have been hurt, arrested, in an accident, kidnapped or are in serious trouble.",
  },
  is_scam: { type: "noul", instructions: "This call is a scam." },
  scam_type: { type: "choice", instructions: "What kind of scam this call is, or would be.", criteria: SCAM_TYPES },
};

/** Flags that can trigger a text during the call (names only are ever logged). */
export const CALL_FLAGS = ["asks_code", "remote_access", "money_or_code", "impersonation", "urgency_secrecy", "family_danger"];

/** Step 8: is a turn in talk mode still meant for Bouncer? (state = last 3 turns) */
export const ADDRESSED_QUESTION: Record<string, JevQuestion> = {
  addressed_to_bouncer: {
    type: "noul",
    instructions: "The latest turn speaks to the assistant called Bouncer, not to another person on the call.",
  },
};

/**
 * Step 9 helper: the user asked Bouncer, out loud, to check on a relative. Nothing happens from voice
 * alone (rule 4): this only starts Flow 3, which texts "Reply YES and I'll call …" first.
 */
export const ACTION_QUESTION: Record<string, JevQuestion> = {
  wants_family_check: {
    type: "noul",
    instructions:
      "In the latest turn, the speaker asks Bouncer to call, check on, or contact one of their family members.",
  },
};
