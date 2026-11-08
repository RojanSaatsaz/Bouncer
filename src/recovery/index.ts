// SPEC Flow 4: "I already clicked or paid" recovery. Works out what was lost (Jev, or a numbered menu),
// then texts a checklist one step at a time; DONE / NEXT moves on, STOP ends it.
// State is in memory per user (30 min, refreshed on every reply). The user's words are only used for the
// one Jev call and never stored or logged (rule 1). The events row holds the loss type and outcome only.
import { randomUUID } from "node:crypto";
import { query } from "../db.js";
import { askJev, choice } from "../detection/jev.js";
import { generate } from "../detection/gemini.js";
import type { InboundMessage } from "../photon/socket.js";
import { textUser, type User } from "../users.js";
import { DONE_PROMPT, FALLBACK_SCRIPT, LOSS_QUESTION, LOSS_TYPES, MENU, stepsFor, type LossType } from "./steps.js";

export { LOSS_TYPES, type LossType } from "./steps.js";

const TTL_MS = 30 * 60_000;
const MIN_CONFIDENCE = 0.6;

interface Recovery {
  id: string;
  userId: string;
  source: "text" | "call" | "family";
  stage: "menu" | "steps";
  loss: LossType | null;
  /** Index of the step last sent (stage "steps"). */
  step: number;
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

/** Step 5: one events row per recovery. Loss type and outcome only; no amounts or details. */
async function finish(r: Recovery, outcome: "completed" | "stopped" | "abandoned") {
  clearTimeout(r.timer);
  if (active.get(r.userId) === r) active.delete(r.userId);
  console.log(`[recovery] user ${short(r.userId)} ${outcome} loss=${r.loss ?? "unknown"} step=${r.step + 1}`);
  try {
    await query("INSERT INTO events (user_id, source, outcome, flags) VALUES ($1, 'recovery', $2, $3)", [
      r.userId,
      outcome,
      [`loss:${r.loss ?? "unknown"}`],
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

/** Step 2: Jev Choice `loss_type` on the user's words. null when unsure or Jev fails (→ menu). */
async function classify(text: string): Promise<LossType | null> {
  try {
    const r = await askJev(
      { user_message: text.slice(0, 2000) },
      LOSS_QUESTION,
      { retries: 1, timeoutMs: 4_000 },
    );
    const c = choice(r, "loss_type");
    console.log(`[recovery] loss_type=${c.label} (${c.confidence.toFixed(2)}) jev=${r.ms}ms`);
    return c.confidence >= MIN_CONFIDENCE && (LOSS_TYPES as readonly string[]).includes(c.label ?? "")
      ? (c.label as LossType)
      : null;
  } catch (err: any) {
    console.error(`[recovery] loss_type failed: ${err?.message}`);
    return null;
  }
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

/** Sends step `r.step` (one step per message; the bank script follows its step). */
async function sendStep(r: Recovery) {
  const steps = stepsFor(r.loss!);
  const s = steps[r.step];
  const head = `Step ${r.step + 1} of ${steps.length}: ${s.text}`;
  if (!s.bankScript) {
    await send(r, `step${r.step + 1}`, [`${head}\n\n${DONE_PROMPT}`]);
    return;
  }
  const script = bankScript(s.bankScript); // starts while the step is sent
  await send(r, `step${r.step + 1}`, [head]);
  await send(r, `step${r.step + 1}-script`, [
    `Here's what you can say (fill in the blanks):\n${await script}\n\nOnly share account details with the bank on that call, never with me or anyone who calls you.\n\n${DONE_PROMPT}`,
  ]);
}

async function beginSteps(r: Recovery, loss: LossType) {
  r.loss = loss;
  r.stage = "steps";
  r.step = 0;
  console.log(`[recovery] user ${short(r.userId)} checklist loss=${loss}`);
  await sendStep(r);
}

/**
 * SPEC Flow 4 steps 1–3. `text` is the user's own words (message text or the call turn): in memory only.
 * No text, or Jev below 0.6 → the numbered menu. Replaces any recovery already running for this user.
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
      step: 0,
      timer: undefined as unknown as NodeJS.Timeout,
    };
    const loss = args.text?.trim() ? await classify(args.text) : null;
    // Claim the slot before texting, so a fast reply finds it.
    active.set(r.userId, r);
    touch(r);
    if (loss) {
      await beginSteps(r, loss);
    } else {
      console.log(`[recovery] user ${short(r.userId)} asking what happened (source=${r.source})`);
      const sent = await send(r, "menu", [`I'm sorry that happened. Let's fix it one step at a time. ${MENU}`]);
      if (!sent) {
        // No iMessage thread for this user: nothing to continue.
        clearTimeout(r.timer);
        active.delete(r.userId);
      }
    }
  } catch (err: any) {
    console.error(`[recovery] startRecovery failed: ${err?.message}`);
  }
}

const norm = (t: string) => t.trim().toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const MENU_RE = /^\s*#?\s*([1-9])(?![0-9])/;
const ADVANCE_RE = /^(done|next|skip|did it|i did it|ok done|okay done|done next)$/;
const STOP_RE = /^(stop|cancel|quit|end|stop steps|cancel steps)$/;

/**
 * Called by the iMessage router. Returns true when the text belonged to an active recovery:
 * a menu number 1–9 while the menu is open, DONE / NEXT / SKIP during the checklist, or STOP / CANCEL.
 * Anything else returns false and normal routing continues (the recovery stays open).
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

    if (r.stage === "menu") {
      const m = MENU_RE.exec(msg.text);
      if (!m || msg.text.trim().length > 40) return false;
      touch(r);
      await beginSteps(r, LOSS_TYPES[Number(m[1]) - 1]);
      return true;
    }

    if (!ADVANCE_RE.test(t)) return false;
    touch(r);
    const steps = stepsFor(r.loss!);
    if (r.step + 1 >= steps.length) {
      await finish(r, "completed");
      await send(r, "end", ["That's everything. You did the right things fast."]);
      return true;
    }
    r.step++;
    await sendStep(r);
    return true;
  } catch (err: any) {
    console.error(`[recovery] handleRecoveryText failed: ${err?.message}`);
    return false;
  }
}

/** True while this user has a recovery open (menu or checklist). */
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
