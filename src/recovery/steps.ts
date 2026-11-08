// SPEC Flow 4 steps 2–3: loss types, the numbered menu and the one-step-per-message checklists.
// Wording only, no logic. Plain words, sixth-grade reading level.
import type { JevQuestion } from "../detection/jev.js";
import { fromDirectory, resource } from "../contacts/index.js";

/** Menu order: "1" = clicked_only … "9" = shared_ssn, "10" = paid_bnpl. */
export const LOSS_TYPES = [
  "clicked_only",
  "entered_password",
  "shared_code",
  "paid_card",
  "paid_gift_card",
  "paid_crypto",
  "paid_bank_or_p2p",
  "installed_app",
  "shared_ssn",
  "paid_bnpl",
] as const;
export type LossType = (typeof LOSS_TYPES)[number];

/** Step 2: one Jev Choice on the user's own words. */
export const LOSS_QUESTION: Record<string, JevQuestion> = {
  loss_type: {
    type: "choice",
    instructions:
      "A user told Bouncer, a scam-help assistant, that they already fell for a scam. What did they give or do? If they did several, pick the one that can lose the most money.",
    criteria: {
      clicked_only: "They only clicked or opened a link or page; they did not type anything, pay, or install anything",
      entered_password: "They typed a password or login details into a page, or told someone their password",
      shared_code: "They gave someone a one-time code, verification code or PIN that was sent to them",
      paid_card: "They paid with a debit or credit card (not through a pay-later service)",
      paid_gift_card: "They bought gift cards and gave the numbers, or paid with gift cards",
      paid_crypto: "They sent cryptocurrency or put cash into a Bitcoin ATM",
      paid_bank_or_p2p: "They sent money by bank transfer, wire, Zelle, Venmo, Cash App, PayPal, or handed over cash",
      installed_app: "They installed an app or program, or let someone control their phone or computer",
      shared_ssn: "They gave their Social Security number",
      paid_bnpl: "They paid through a buy-now-pay-later service such as Klarna, Afterpay, Affirm or Sezzle, or a payment link from one",
    },
  },
};

/** Same question when there is an active case: the call or message Bouncer just saw fills in what the words leave out. */
export const LOSS_QUESTION_WITH_CASE: Record<string, JevQuestion> = {
  loss_type: {
    ...LOSS_QUESTION.loss_type,
    instructions:
      (LOSS_QUESTION.loss_type as { instructions: string }).instructions +
      " If user_message doesn't say how, use recent_case (what Bouncer saw on the user's call or message a few minutes ago) to decide.",
  } as JevQuestion,
};

export const MENU =
  "What happened? Reply 1 clicked a link, 2 typed a password, 3 shared a code, 4 paid by card, 5 gift card, " +
  "6 crypto, 7 bank transfer or Zelle, 8 installed an app, 9 gave my SSN, 10 Klarna, Afterpay or Affirm. " +
  "If it was more than one, send them all, like 4, 9.";

/** Asked once, before the last step: people often gave more than the first thing they mention. */
export const ALSO_QUESTION =
  "One more check: did you also share a password, a code or your Social Security number, or install anything they asked you to? Reply NO, or tell me which.";
export const ALSO_WHICH = "Which one? Reply 2 password, 3 code, 8 installed an app, 9 SSN, or tell me in your own words.";

export const DONE_PROMPT = "Reply DONE when you've done it, or NEXT to skip.";

export interface Step {
  text: string;
  /** Send the bank call script (SPEC step 4) with this step. */
  bankScript?: "card" | "bank";
}

const CHANGE_REUSED: Step = { text: "Did you use the same password anywhere else? Change it there too." };
const SIGN_OUT: Step = {
  text: "In that account's settings, choose \"Sign out of all devices\". This kicks the scammer out.",
};

/** Step 3: first step is the most time-critical. FINAL_STEP is added to every list. */
export const CHECKLISTS: Record<LossType, Step[]> = {
  paid_card: [
    { text: "Lock your card now. Open your bank's app and tap \"Lock card\" or \"Freeze card\". This stops new charges." },
    {
      text: "Call the number on the back of your card. Say it was a scam and ask them to dispute the charge.",
      bankScript: "card",
    },
  ],
  paid_bank_or_p2p: [
    {
      text:
        "Call your bank now. Use the number on your card or in your bank's app, not one the scammer gave you. " +
        "Ask them to stop or recall the payment. Transfers are hard to undo later, so call right away.",
      bankScript: "bank",
    },
    { text: "If you paid with Zelle, Venmo or Cash App, also report the payment as a scam inside that app." },
  ],
  paid_gift_card: [
    {
      text:
        "Call the gift card company now. Use the phone number on the back of the card. " +
        "Say it was a scam and ask them to freeze the money on the card.",
    },
    { text: "Keep the gift cards and the store receipt. Take a photo of both. Never give the card numbers to anyone else." },
  ],
  paid_crypto: [
    {
      text:
        "Open your crypto app yourself (not a link someone sent you) and contact its support. " +
        "Say it was a scam and ask them to stop the payment.",
    },
    { text: "Report it at ic3.gov. That's the FBI's website for online crime." },
  ],
  entered_password: [
    { text: "Change that password now. Open the real app or type the website yourself. Don't use the link from the message." },
    CHANGE_REUSED,
    SIGN_OUT,
  ],
  shared_code: [
    {
      text:
        "Someone may be getting into your account with that code. Open the real app yourself now and change your password.",
    },
    CHANGE_REUSED,
    SIGN_OUT,
  ],
  installed_app: [
    { text: "Turn off Wi-Fi and mobile data on that phone or computer now. This cuts the scammer off." },
    { text: "Delete the app they told you to install." },
    { text: "Use a different phone or computer to change your bank and email passwords." },
  ],
  shared_ssn: [
    { text: "Go to IdentityTheft.gov. It makes a free recovery plan for you." },
    {
      text:
        "Freeze your credit with all three credit bureaus: Equifax, Experian and TransUnion. " +
        "It's free, and it stops anyone opening new accounts in your name.",
    },
  ],
  clicked_only: [{ text: "Close that page now and don't type anything into it. Just clicking usually can't hurt you." }],
  // {app} / {Service} / {service} are filled by checklist(): "the Klarna app" / "Klarna" when we know the
  // service, generic words when we don't.
  paid_bnpl: [
    {
      text:
        "Open {app} yourself (not a link anyone sent you). Find that purchase, tap it, and report a problem or dispute it. " +
        "Say it was a scam. This can pause the payments while they look into it.",
    },
    {
      text:
        "{Service} takes its payments from your card or bank. Call the number on that card or in your bank's app, " +
        "say it was a scam, and ask them to watch for or block more {service} payments.",
    },
  ],
};

// Numbers below come from config/contacts.json (verified on each organization's own site).
const FTC = resource("ftc_report");
const ELDER = resource("elder_fraud");
export const FINAL_STEP: Step = {
  text:
    "If the scam came by text, forward it to 7726 (that spells SPAM) so T-Mobile can block it. " +
    `Then report it at ReportFraud.ftc.gov${FTC?.phone ? ` or call the FTC at ${FTC.phone}` : ""}.` +
    (ELDER?.phone ? ` If you're 60 or older, the National Elder Fraud Hotline (${ELDER.phone}) gives free help.` : ""),
};

/** The loss-specific steps, with the pay-later service filled in ("Klarna", or generic when unknown). */
export function checklist(loss: LossType, service: string | null = null): Step[] {
  const known = !!service && !/pay-later/i.test(service);
  return CHECKLISTS[loss].map((s) => ({
    ...s,
    text: s.text
      .replace("{app}", known ? `the ${service} app` : "the pay-later app you used (Klarna, Afterpay or Affirm)")
      .replace("{Service}", known ? service! : "That service")
      .replace("more {service} payments", known ? `more ${service} payments` : "more of those payments"),
  })).map((s, i) => {
    // Pay-later step 1: the service's verified phone number, if we have one.
    const dir = loss === "paid_bnpl" && i === 0 && known ? fromDirectory(service!) : null;
    return dir?.phone ? { ...s, text: `${s.text} You can also call ${dir.name} at ${dir.phone}.` } : s;
  });
}

/** Steps for one loss followed by the final reporting step. */
export const stepsFor = (loss: LossType, service: string | null = null): Step[] => [...checklist(loss, service), FINAL_STEP];

/** Used when Gemini is slow or down (SPEC step 4 shape: 4 lines with blanks, no account numbers). */
export const FALLBACK_SCRIPT: Record<"card" | "bank", string> = {
  card: [
    "Hi, I'm calling to report fraud on my card.",
    "On [date] I paid [amount] to [who you paid] after a scam.",
    "Please dispute the charge and block any more payments to them.",
    "Please send me a new card and give me a case number.",
  ].join("\n"),
  bank: [
    "Hi, I'm calling to report fraud on my account.",
    "On [date] I sent [amount] to [who you paid] after a scam.",
    "Please stop or recall the payment right away.",
    "Please freeze or watch my account and give me a case number.",
  ].join("\n"),
};
