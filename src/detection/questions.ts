// Jev question sets shared by Flow 1 (live messages) and Flow 6 (eval).
// Changing any wording changes the calibration: re-run `npm run eval` afterwards.
import type { JevQuestion } from "./jev.js";

export const SCAM_TYPES: Record<string, string> = {
  toll_or_delivery: "Unpaid toll, parking ticket, or package delivery problem",
  bank_or_card: "Bank, credit card, or payment app account alert",
  crypto: "Cryptocurrency account, wallet, or exchange",
  government: "IRS, Social Security, police, court, DMV or another government agency",
  tech_support: "Tech support, virus warning, or account security from a tech company",
  family_emergency: "A relative or friend in trouble who needs money fast",
  job_or_prize: "Job offer, prize, lottery, refund, or free gift",
  marketplace: "Buying or selling on a marketplace, overpayment, or shipping a sold item",
  romance_or_investment: "Romance, new friend, or investment opportunity",
  other: "Anything else",
};

/** Flow 1 step 7 plus our `callback` question (CLAUDE.md). `matches_pattern` is Flow 5, out of scope. */
export const MESSAGE_QUESTIONS: Record<string, JevQuestion> = {
  impersonation: {
    type: "noul",
    instructions: "The message pretends to be from a company, a government agency, or someone the reader knows.",
  },
  money_or_code: {
    type: "noul",
    instructions: "The message asks for money, gift cards, cryptocurrency, payment details, or a verification code.",
  },
  urgency_secrecy: {
    type: "noul",
    instructions: "The message pressures the reader to act fast or to keep it secret.",
  },
  link_mismatch: {
    type: "noul",
    instructions: "A link or phone number does not belong to the brand or person the message claims to be.",
  },
  asks_code: {
    type: "noul",
    instructions: "The message asks the reader to share a one-time code, password or PIN.",
  },
  callback: {
    type: "noul",
    instructions:
      "The message tells the reader to contact a phone number or link given in the message, instead of the company's official app, website or the number on their card.",
  },
  is_scam: { type: "noul", instructions: "This message is a scam." },
  scam_type: { type: "choice", instructions: "What kind of scam this message is, or would be.", criteria: SCAM_TYPES },
};

/** Noul questions that count as red flags in replies (names only are ever logged). */
export const MESSAGE_FLAGS = ["impersonation", "money_or_code", "urgency_secrecy", "link_mismatch", "asks_code", "callback"];

/** Plain-words label for each flag, for replies and alerts. */
export const FLAG_LABELS: Record<string, string> = {
  impersonation: "pretends to be a company, agency or someone you know",
  money_or_code: "asks for money, gift cards, crypto or a code",
  urgency_secrecy: "rushes you or asks you to keep it secret",
  link_mismatch: "the link or number doesn't match who it claims to be",
  asks_code: "asks for a one-time code, password or PIN",
  callback: "tells you to call or tap a number or link in the message",
  remote_access: "asks you to install an app or give access to your device",
  family_danger: "says a family member is in trouble",
};
