// SPEC Flow 4: "I already clicked or paid" recovery. Works out what was lost, then texts a checklist one
// step at a time; DONE / NEXT moves on, STOP ends it.
//
// What was lost comes from, in order: a payment method named in the user's words ("klarna", "on Zelle"),
// the active case (src/messages/case.ts: the call or message Bouncer just saw → "Sounds like you paid with
// Klarna after that call. Is that right?"), Jev on the user's words plus that case, and finally a numbered
// menu. Free-text answers to the menu ("klarna link") are understood too, several losses ("4, 9") are run
// one after another, and once before the last step Bouncer asks whether anything else was shared.
//
// State is in memory per user (30 min, refreshed on every reply). The user's words are only used for the
// one Jev call and never stored or logged (rule 1). The events row holds loss types and the outcome only.
import { randomUUID } from "node:crypto";
import { query } from "../db.js";
import { askJev, choice } from "../detection/jev.js";
import { generate } from "../detection/gemini.js";
import type { InboundMessage } from "../photon/socket.js";
import { textUser, type User } from "../users.js";
import { clearPending, parseYesNo } from "../pending.js";
import { caseForModel, detectPayment, getCase, LOSS_FOR_METHOD, type CaseFile } from "../messages/case.js";
import {
  ALSO_QUESTION,
  ALSO_WHICH,
  DONE_PROMPT,
  FALLBACK_SCRIPT,
  FINAL_STEP,
  LOSS_QUESTION,
  LOSS_QUESTION_WITH_CASE,
  LOSS_TYPES,
  MENU,
  checklist,
  type LossType,
  type Step,
} from "./steps.js";

export { LOSS_TYPES, type LossType } from "./steps.js";

const TTL_MS = 30 * 60_000;
/** First guess from the user's words: high bar, a wrong checklist is worse than the menu. */
const MIN_CONFIDENCE = 0.7;
/** A free-text menu answer is a direct reply to "What happened?", so a lower bar is fine. */
const ANSWER_CONFIDENCE = 0.5;

type Stage = "confirm" | "menu" | "steps" | "also" | "also_which";

interface Recovery {
  id: string;
  userId: string;
  source: "text" | "call" | "family";
  stage: Stage;
  /** Loss whose checklist is running (stage "steps"). */
  loss: LossType | null;
  /** Losses still to do after this one. */
  queue: LossType[];
  /** Losses whose checklist finished (for the events row). */
  done: LossType[];
  /** Index of the step last sent (stage "steps"). */
  step: number;
  /** Pay-later service name when known ("Klarna"), for the pay-later steps. */
  service: string | null;
  /** The loss the case suggested, while asking "Is that right?". */
  suggested: LossType | null;
  askedAlso: boolean;
  /** One "Sorry, which one?" per question, then the text goes back to normal routing. */
  reasked: boolean;
  timer: NodeJS.Timeout;
}

const active = new Map<string, Recovery>();
const short = (id: string) => id.slice(0, 8);

/** (Re)arms the inactivity timer: no reply for 30 minutes = abandoned. */
function touch(r: Recovery) {
  clearTimeout(r.timer);
  r.timer = setTimeout(() => {
    if (active.get(r.userId) === r) finish(r, "abandoned").catch(() => {});
  }, TTL_MS);
  r.timer.unref?.();
}

const lossesOf = (r: Recovery): LossType[] => {
  const all = [...r.done, ...(r.loss ? [r.loss] : []), ...r.queue];
  return [...new Set(all)];
};

/** Step 5: one events row per recovery. Loss types and outcome only; no amounts or details. */
async function finish(r: Recovery, outcome: "completed" | "stopped" | "abandoned") {
  clearTimeout(r.timer);
  if (active.get(r.userId) === r) active.delete(r.userId);
  const losses = lossesOf(r);
  console.log(`[recovery] user ${short(r.userId)} ${outcome} loss=${losses.join("+") || "unknown"} step=${r.step + 1}`);
  try {
    await query("INSERT INTO events (user_id, source, outcome, flags) VALUES ($1, 'recovery', $2, $3)", [
      r.userId,
      outcome,
      losses.length ? losses.map((l) => `loss:${l}`) : ["loss:unknown"],
    ]);
  } catch (err: any) {
    console.error(`[recovery] event insert failed: ${err?.message}`);
  }
}

const send = (r: Recovery, tag: string, lines: string[]) =>
  textUser(r.userId, lines, `recovery:${r.id}:${tag}`).catch((err) => {
    console.error(`[recovery] text to ${short(r.userId)} failed: ${err?.message}`);
    return false;
  });

/** Step 2: Jev Choice `loss_type` on the user's words (and the active case, if any). null when unsure. */
async function classify(text: string, kase: CaseFile | null, minConfidence = MIN_CONFIDENCE): Promise<LossType | null> {
  try {
    const state = kase ? { user_message: text.slice(0, 2000), recent_case: caseForModel(kase) } : { user_message: text.slice(0, 2000) };
    const r = await askJev(state, kase ? LOSS_QUESTION_WITH_CASE : LOSS_QUESTION, { retries: 1, timeoutMs: 4_000 });
    const c = choice(r, "loss_type");
    console.log(`[recovery] loss_type=${c.label} (${c.confidence.toFixed(2)}) case=${kase ? "yes" : "no"} jev=${r.ms}ms`);
    return c.confidence >= minConfidence && (LOSS_TYPES as readonly string[]).includes(c.label ?? "") ? (c.label as LossType) : null;
  } catch (err: any) {
    console.error(`[recovery] loss_type failed: ${err?.message}`);
    return null;
  }
}

/** "4", "4, 9", "#7 and 9" → menu losses (deduplicated, in order). null if the text isn't just numbers. */
function menuNumbers(text: string): LossType[] | null {
  const t = text.trim();
  if (t.length > 40 || !/^[\s#,.&+/0-9]*(?:and[\s#,.&+/0-9]*)*$/i.test(t)) return null;
  const nums = [...t.matchAll(/(?<!\d)(10|[1-9])(?!\d)/g)].map((m) => Number(m[1]));
  if (!nums.length || nums.some((n) => n < 1 || n > LOSS_TYPES.length)) return null;
  return [...new Set(nums.map((n) => LOSS_TYPES[n - 1]))];
}

/** A payment method named in the user's words → its checklist (and the service name for pay-later). */
function fromPayment(text: string): { loss: LossType; service: string | null } | null {
  const p = detectPayment(text);
  return p ? { loss: LOSS_FOR_METHOD[p.method], service: p.method === "bnpl" ? p.label : null } : null;
}

// ---- Step 4: bank call script ------------------------------------------------------------------

const SCRIPT_SYSTEM =
  "You write short phone scripts for people calling their bank after a scam. Plain words, sixth-grade reading level. " +
  "Never include or ask for account numbers, card numbers, names or any real details: use the blanks you are given.";

const scriptCache = new Map<"card" | "bank", Promise<string>>();

/** Gemini writes it once per kind (it has no user details, so it can be reused); template on any problem. */
function bankScript(kind: "card" | "bank"): Promise<string> {
  let p = scriptCache.get(kind);
  if (!p) {
    const what = kind === "card" ? "the card company, about a scam payment made with a debit or credit card" : "the bank, about a scam bank transfer, wire, Zelle, Venmo or Cash App payment";
    p = generate({
      tier: "fast",
      system: SCRIPT_SYSTEM,
      parts: [
        {
          text:
            `Write a 4-line script for calling ${what}. Use these blanks exactly as written: [date], [amount], [who you paid]. ` +
            "Line 1: say you're calling to report fraud. Line 2: say that on [date] you paid [amount] to [who you paid] because of a scam. " +
            `Line 3: ask them to ${kind === "card" ? "dispute the charge" : "stop or recall the payment"}. ` +
            "Line 4: ask them to freeze or watch the account and for a case number. " +
            "Return only the 4 lines, one per line, no numbering, no quotes, no markdown.",
        },
      ],
      temperature: 0.3,
      maxOutputTokens: 200,
      timeoutMs: 4_000,
    }).then((raw) => {
      const lines = raw.replace(/[*_#`"]/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
      const text = lines.join("\n");
      // Must keep the blanks, stay short, and carry no long numbers.
      const ok = lines.length >= 3 && lines.length <= 5 && text.length < 500 && /\[amount\]/.test(text) && !/\d{4,}/.test(text);
      if (!ok) throw new Error("script failed the shape check");
      return text;
    });
    p.catch((err) => {
      console.warn(`[recovery] bank script (${kind}) fell back to template: ${err?.message}`);
      scriptCache.delete(kind);
    });
    scriptCache.set(kind, p);
  }
  return p.catch(() => FALLBACK_SCRIPT[kind]);
}

// ---- Checklist ---------------------------------------------------------------------------------

/** The running loss's steps; the final reporting step is added only after the last queued loss. */
const currentSteps = (r: Recovery): Step[] => {
  const steps = checklist(r.loss!, r.service);
  return r.queue.length ? steps : [...steps, FINAL_STEP];
};

/** Sends step `r.step` (one step per message; the bank script follows its step). */
async function sendStep(r: Recovery) {
  const steps = currentSteps(r);
  const s = steps[r.step];
  const head = `Step ${r.step + 1} of ${steps.length}: ${s.text}`;
  if (!s.bankScript) {
    await send(r, `${r.loss}:step${r.step + 1}`, [`${head}\n\n${DONE_PROMPT}`]);
    return;
  }
  const script = bankScript(s.bankScript); // starts while the step is sent
  await send(r, `${r.loss}:step${r.step + 1}`, [head]);
  await send(r, `${r.loss}:step${r.step + 1}-script`, [
    `Here's what you can say (fill in the blanks):\n${await script}\n\nOnly share account details with the bank on that call, never with me or anyone who calls you.\n\n${DONE_PROMPT}`,
  ]);
}

/** Starts the checklists for these losses, in order (the first is the most time-critical one given). */
async function beginSteps(r: Recovery, losses: LossType[], service: string | null = r.service) {
  const fresh = losses.filter((l) => l !== r.loss && !r.done.includes(l));
  if (!fresh.length) {
    // Nothing new (e.g. "also" answered with what we already covered): go on to the last step.
    r.stage = "steps";
    r.step = currentSteps(r).length - 1;
    await sendStep(r);
    return;
  }
  if (r.loss) r.done.push(r.loss);
  r.loss = fresh[0];
  r.queue = [...fresh.slice(1), ...r.queue.filter((l) => !fresh.includes(l))];
  r.service = service;
  r.stage = "steps";
  r.step = 0;
  r.reasked = false;
  if (fresh.length > 1) r.askedAlso = true; // they already listed several
  console.log(`[recovery] user ${short(r.userId)} checklist loss=${r.loss}${r.queue.length ? ` then ${r.queue.join(",")}` : ""}`);
  await sendStep(r);
}

/** DONE / NEXT: the next step, the next queued loss, the "anything else?" check, or the end. */
async function advance(r: Recovery) {
  const steps = currentSteps(r);
  const next = r.step + 1;
  if (next < steps.length) {
    if (steps[next] === FINAL_STEP && !r.askedAlso) {
      r.askedAlso = true;
      r.stage = "also";
      r.reasked = false;
      await send(r, "also", [ALSO_QUESTION]);
      return;
    }
    r.step = next;
    await sendStep(r);
    return;
  }
  if (r.queue.length) {
    r.done.push(r.loss!);
    r.loss = r.queue.shift()!;
    r.step = 0;
    console.log(`[recovery] user ${short(r.userId)} next checklist loss=${r.loss}`);
    await sendStep(r);
    return;
  }
  await finish(r, "completed");
  await send(r, "end", ["That's everything. You did the right things fast."]);
}

/** Jumps to the final reporting step (after "NO, nothing else"). */
async function toFinalStep(r: Recovery) {
  r.stage = "steps";
  r.step = currentSteps(r).length - 1;
  await sendStep(r);
}

/**
 * SPEC Flow 4 steps 1–3. `text` is the user's own words (message text or the call turn): in memory only.
 * Replaces any recovery already running for this user.
 */
export async function startRecovery(args: { userId: string; text?: string; source: "text" | "call" | "family" }): Promise<void> {
  try {
    const old = active.get(args.userId);
    if (old) await finish(old, "abandoned");
    const r: Recovery = {
      id: randomUUID(),
      userId: args.userId,
      source: args.source,
      stage: "menu",
      loss: null,
      queue: [],
      done: [],
      step: 0,
      service: null,
      suggested: null,
      askedAlso: false,
      reasked: false,
      timer: undefined as unknown as NodeJS.Timeout,
    };
    // They've just said they paid: the post-call "Was it a scam? Reply YES or NO" is answered, and must not
    // catch the YES / NO answers that come next.
    clearPending(args.userId, "call_feedback");
    const text = args.text?.trim() ?? "";
    const kase = getCase(args.userId);
    // Claim the slot before texting, so a fast reply finds it.
    active.set(r.userId, r);
    touch(r);

    const named = text ? fromPayment(text) : null;
    if (named) {
      await beginSteps(r, [named.loss], named.service);
      return;
    }
    if (kase?.payment) {
      r.stage = "confirm";
      r.suggested = LOSS_FOR_METHOD[kase.payment.method];
      r.service = kase.payment.method === "bnpl" ? kase.payment.label : null;
      const after = kase.source === "call" ? "after that call" : "for that message";
      console.log(`[recovery] user ${short(r.userId)} confirming loss=${r.suggested} from the case`);
      const sent = await send(r, "confirm", [
        `I'm sorry that happened. Let's fix it one step at a time. It sounds like you paid with ${kase.payment.label} ${after}. Is that right? Reply YES, or tell me how you paid.`,
      ]);
      if (!sent) drop(r);
      return;
    }
    const loss = text ? await classify(text, kase) : null;
    if (loss) {
      await beginSteps(r, [loss]);
      return;
    }
    console.log(`[recovery] user ${short(r.userId)} asking what happened (source=${r.source})`);
    const sent = await send(r, "menu", [`I'm sorry that happened. Let's fix it one step at a time. ${MENU}`]);
    if (!sent) drop(r);
  } catch (err: any) {
    console.error(`[recovery] startRecovery failed: ${err?.message}`);
  }
}

/** No iMessage thread for this user: nothing to continue. */
function drop(r: Recovery) {
  clearTimeout(r.timer);
  if (active.get(r.userId) === r) active.delete(r.userId);
}

/**
 * Plain answers to "what else did you share?", read in code. Only used for direct answers to Bouncer's
 * question (menu / "anything else?"), where a bare "my SSN" or "the code" is unambiguous.
 */
const ANSWER_WORDS: Array<[RegExp, LossType]> = [
  [/\b(ssn|social security|social)\b/i, "shared_ssn"],
  [/\b(password|passcode|log ?in|login|sign ?in)\b/i, "entered_password"],
  [/\b(code|pin|otp|verification)\b/i, "shared_code"],
  [/\b(installed|downloaded|anydesk|teamviewer|remote|screen ?shar\w*|control of)\b/i, "installed_app"],
];
const SAYS_NOTHING_ELSE = /^\s*(no|nope|nah|nothing|none|neither|not really|i (didn'?t|did not|haven'?t)|never)\b/i;

/** A reply to "What happened?" / "Is that right?" / "Which one?": numbers, a payment method, words, or Jev. */
async function lossesFromAnswer(r: Recovery, text: string): Promise<{ losses: LossType[]; service: string | null } | null> {
  const nums = menuNumbers(text);
  if (nums) return { losses: nums, service: r.service };
  const named = fromPayment(text);
  if (named) return { losses: [named.loss], service: named.service ?? r.service };
  if (text.trim().length > 200) return null; // a pasted message, not an answer
  const words = [...new Set(ANSWER_WORDS.filter(([re]) => re.test(text)).map(([, l]) => l))];
  if (words.length) return { losses: words, service: r.service };
  // "Anything else?" is about OTHER things: the case (which names the first loss) would bias Jev toward it.
  const kase = r.stage === "also" || r.stage === "also_which" ? null : getCase(r.userId);
  const loss = await classify(text, kase, ANSWER_CONFIDENCE);
  return loss ? { losses: [loss], service: r.service } : null;
}

const norm = (t: string) => t.trim().toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const ADVANCE_RE = /^(done|next|skip|did it|i did it|ok done|okay done|done next)$/;
const STOP_RE = /^(stop|cancel|quit|end|stop steps|cancel steps)$/;

/** True while recovery is waiting on a YES / NO ("Is that right?", "anything else?"): the router asks it first. */
export const recoveryAwaitsYesNo = (userId: string) => {
  const s = active.get(userId)?.stage;
  return s === "confirm" || s === "also";
};

/**
 * Called by the iMessage router. Returns true when the text belonged to an active recovery: an answer
 * while Bouncer is asking a question (menu, "Is that right?", "anything else?"), DONE / NEXT / SKIP during
 * the checklist, or STOP / CANCEL. Anything else returns false and normal routing continues (the
 * recovery stays open).
 */
export async function handleRecoveryText(user: User, msg: InboundMessage): Promise<boolean> {
  try {
    const r = active.get(user.id);
    if (!r || !msg.text || msg.attachmentIds.length) return false;
    const t = norm(msg.text);

    if (STOP_RE.test(t)) {
      await finish(r, "stopped");
      await send(r, "stopped", ["Okay, I stopped the steps. Text me anytime if you need help."]);
      return true;
    }

    if (r.stage === "steps") {
      if (!ADVANCE_RE.test(t)) return false;
      touch(r);
      await advance(r);
      return true;
    }

    const yn = parseYesNo(msg.text);
    if (r.stage === "confirm" && yn) {
      touch(r);
      if (yn === "yes") await beginSteps(r, [r.suggested!]);
      else {
        r.stage = "menu";
        r.service = null;
        await send(r, "menu", [`Okay. ${MENU}`]);
      }
      return true;
    }
    if ((r.stage === "also" || r.stage === "also_which") && !yn && SAYS_NOTHING_ELSE.test(msg.text)) {
      touch(r);
      await toFinalStep(r);
      return true;
    }
    if (r.stage === "also" && yn) {
      touch(r);
      if (yn === "no") await toFinalStep(r);
      else {
        r.stage = "also_which";
        r.reasked = false;
        await send(r, "also-which", [ALSO_WHICH]);
      }
      return true;
    }
    // Stage menu / confirm / also / also_which: anything not YES / NO is an answer to the question.
    if (r.stage === "menu" && ADVANCE_RE.test(t)) return false; // nothing to move on from yet
    const answer = await lossesFromAnswer(r, msg.text);
    if (answer) {
      touch(r);
      await beginSteps(r, answer.losses, answer.service);
      return true;
    }
    if (r.reasked) return false; // asked twice: let normal routing (chat) take it
    r.reasked = true;
    touch(r);
    const again =
      r.stage === "also" || r.stage === "also_which"
        ? "Sorry, I didn't catch that. Reply NO if nothing else happened, or tell me what else you shared."
        : `Sorry, I didn't catch that. ${MENU}`;
    await send(r, `reask:${r.stage}`, [again]);
    return true;
  } catch (err: any) {
    console.error(`[recovery] handleRecoveryText failed: ${err?.message}`);
    return false;
  }
}

/** True while this user has a recovery open (any stage). */
export const hasActiveRecovery = (userId: string) => active.has(userId);

/**
 * Flow 2 step 7 helper: the caller told Bouncer, out loud, that they already paid, sent money, gave a
 * code, clicked or installed something. Instant regex on the latest turn (Jev still makes every scam
 * decision; this only picks the spoken "I've sent the steps to your phone." over a Gemini answer).
 */
const PAID_RES = [
  /\bi(?: have|'ve| already| just| already have)*\s+(?:paid|payed)\b/i,
  /\bi(?: have|'ve| already| just)*\s+(?:sent|wired|transferred|gave|zelled|venmoed)\b[^.?!]{0,40}\b(?:money|cash|dollars|bucks|payment|bitcoin|crypto|gift ?cards?|zelle|venmo|cash ?app|wire|\$)/i,
  /\bi(?: have|'ve| already| just)*\s+(?:gave|told|read|sent|shared|typed|entered|put in)\b[^.?!]{0,40}\b(?:code|password|pin|social security|ssn|card number|bank (?:info|details|account))/i,
  /\bi(?: have|'ve| already| just)*\s+bought\b[^.?!]{0,30}\bgift ?cards?/i,
  /\bi(?: have|'ve| already| just)*\s+(?:clicked|installed|downloaded)\b/i,
];
export const saysAlreadyPaid = (turn: string) => PAID_RES.some((re) => re.test(turn));
