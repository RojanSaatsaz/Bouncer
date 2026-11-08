// SPEC Flow 3 steps 4–7 and 9–12: coach the targeted family member, decide who to call (anyone else in
// the family, found by the title the organizer gave them or by name), tell them the result, ask about
// losses, alert everyone with family alerts on (type and outcome only) and log the event (no content).
import { randomUUID } from "node:crypto";
import { one, query } from "../db.js";
import { askJev, choice } from "../detection/jev.js";
import { clearPending, registerPendingHandler, setPending } from "../pending.js";
import { sendText } from "../photon/client.js";
import type { InboundMessage } from "../photon/socket.js";
import { textUser, type User } from "../users.js";
import { startRecovery } from "../recovery/index.js";
import {
  cap,
  getAlertRecipients,
  getCallableFamily,
  getCircleForUser,
  getMember,
  getSafeWordRow,
  labelFor,
  matchByName,
  memberPronouns,
  protectedName as loadProtectedName,
  type Member,
} from "./circle.js";
import { decryptWord } from "./crypto.js";
import { familyTimings } from "./timings.js";
import { placeVerificationCall, type VerifyStatus } from "./verify.js";

type Outcome = VerifyStatus | "coached_only" | "call_declined";

interface Emergency {
  id: string;
  userId: string; // the family member being targeted
  circleId: string | null;
  /** Organizer of the circle: sees family by their own titles ("Mom"); everyone else by first name. */
  organizerId: string | null;
  protectedName: string;
  relative: Member | null;
  source: "text" | "call";
  startedAt: number;
  stage: "coached" | "awaiting_yes" | "calling" | "result" | "closed";
  verificationId?: string;
  outcome?: Outcome;
  decidedBy?: string;
  loss?: "yes" | "no";
  alertSent: boolean;
  alertTimer?: NodeJS.Timeout;
  wordTexts: number;
  eventId?: string;
}

/** Active emergency per targeted user. In memory only. */
const emergencies = new Map<string, Emergency>();
const short = (id: string) => id.slice(0, 8);

/** The claimed relative as the targeted person knows them: "Mom" for the organizer, else "Rosa". */
const relLabel = (em: Emergency) => (em.relative ? labelFor(em.relative, em.organizerId === em.userId) : "your family member");

/**
 * True if the family-emergency steps already cover this scam: one is still open for the user, or one
 * ran in the last 30 min and this is the same family-emergency scam (it sends its own family alert).
 */
export function familyEmergencyCovers(userId: string, scamType: string | null | undefined): boolean {
  const e = activeEmergency(userId);
  return !!e && (e.stage !== "closed" || scamType === "family_emergency");
}

function activeEmergency(userId: string): Emergency | null {
  const e = emergencies.get(userId);
  if (!e) return null;
  if (Date.now() - e.startedAt > familyTimings.emergencyTtlMs) {
    clearTimeout(e.alertTimer);
    emergencies.delete(userId);
    return null;
  }
  return e;
}

const textProtected = (em: Emergency, tag: string, lines: string[]) =>
  textUser(em.userId, lines, `family:${em.id}:${tag}`).catch((err) => {
    console.error(`[family] text to protected user ${short(em.userId)} failed: ${err?.message}`);
    return false;
  });

// ---------------------------------------------------------------------------------------------
// Steps 4–7
// ---------------------------------------------------------------------------------------------

export async function startFamilyEmergencyImpl(args: { userId: string; content: string; source: "text" | "call" }) {
  const { userId, content, source } = args;
  const prev = activeEmergency(userId);
  if (prev?.relative && source === "text") {
    // The user typed this themselves, and the router sends nothing else: always answer.
    const name = relLabel(prev);
    if (prev.stage === "awaiting_yes") {
      // A text is the go-ahead rule 4 asks for: drop the "Reply YES" question and call now.
      clearPending(userId, "verify_call");
      console.log(`[family] text trigger for user ${short(userId)} during awaiting_yes; calling now`);
      await textProtected(prev, "call-text", [`Calling ${name} now. I'll text you what I find.`]);
      await startCall(prev);
      return;
    }
    if (prev.stage === "coached" || prev.stage === "calling" || prev.stage === "result") {
      console.log(`[family] text trigger for user ${short(userId)} during ${prev.stage}; status sent`);
      const status =
        prev.stage === "result"
          ? `I already checked on ${name}. See my last text, and don't send money.`
          : `I'm already checking on ${name}. I'll text you as soon as I know.`;
      await textProtected(prev, `status-${Date.now()}`, [status]);
      return;
    }
    // closed: a new emergency starts below.
  } else if (prev?.relative) {
    // Live listen fires on every scored turn: ignore repeats while one is in progress or just finished.
    const busy = prev.stage === "awaiting_yes" || prev.stage === "calling" || prev.stage === "result";
    const recent = Date.now() - prev.startedAt < familyTimings.retriggerCooldownMs;
    if (busy || recent) {
      console.log(`[family] emergency already active for user ${short(userId)} (${prev.stage}); trigger ignored`);
      return;
    }
  }
  if (prev) clearTimeout(prev.alertTimer);

  const em: Emergency = {
    id: randomUUID().slice(0, 12),
    userId,
    circleId: null,
    organizerId: null,
    protectedName: "your family member",
    relative: null,
    source,
    startedAt: Date.now(),
    stage: "coached",
    alertSent: false,
    wordTexts: 0,
  };
  emergencies.set(userId, em);

  const circle = await getCircleForUser(userId);
  if (!circle) return coachOnly(em, "no_circle", false);
  em.circleId = circle.id;
  em.organizerId = circle.organizer_user_id;
  em.protectedName = await loadProtectedName(userId);

  // Everyone in the family is protected, so anyone but the targeted person can be the one we call.
  const [family, word] = await Promise.all([getCallableFamily(circle.id, userId), getSafeWordRow(circle.id)]);
  if (!word) return coachOnly(em, "no_safe_word", false);
  if (!family.length) return coachOnly(em, "no_relatives", true);

  const claimed = await findClaimedRelative(content, family, circle.organizer_user_id === userId, circle.organizer_user_id);
  if (!claimed) return coachOnly(em, "no_relative_named", true);
  em.relative = claimed;

  const p = memberPronouns(claimed);
  const label = relLabel(em);
  const coach = `Ask ${p.him} for the family safe word. Don't say it yourself, and don't send money yet.`;
  if (source === "text") {
    await textProtected(em, "coach", [`${coach} I'm checking on ${label}.`]);
    await startCall(em);
  } else {
    // Rule 4: a call-triggered emergency needs a YES by text before Bouncer dials anyone.
    em.stage = "awaiting_yes";
    setPending(userId, "verify_call", { emergencyId: em.id });
    await textProtected(em, "coach", [coach, `Reply YES and I'll call ${label}'s own number to check ${p.heIs} safe.`]);
  }
}

async function coachOnly(em: Emergency, reason: string, hasWord: boolean) {
  const line = hasWord
    ? "Ask the caller for the family safe word. Don't say it yourself, and don't send money yet. Then hang up and call your family member back on their saved number."
    : "Don't send money yet. Hang up and call your family member back on the number you have saved for them.";
  await textProtected(em, "coach", [line]);
  em.stage = "closed";
  em.outcome = "coached_only";
  em.decidedBy = reason;
  await logEvent(em, 0);
}

/**
 * Step 5: who the message says is in trouble. First by code: a first name, or (for the organizer) the title
 * they gave the person or a synonym ("Mom is in jail", "my mother"). Otherwise Jev choice `claimed_relative`,
 * one label per family member plus `none`. Content stays in memory.
 */
async function findClaimedRelative(
  content: string,
  family: Member[],
  viewerIsOrganizer: boolean,
  organizerId: string | null,
): Promise<Member | null> {
  const direct = matchByName(content, family, viewerIsOrganizer);
  if (direct) {
    console.log(`[family] claimed_relative → member ${short(direct.id)} (title/name match)`);
    return direct;
  }
  const orgName = organizerId && !viewerIsOrganizer ? await loadProtectedName(organizerId) : null;
  const byLabel = new Map<string, Member>();
  const criteria: Record<string, string> = {};
  for (const m of family) {
    const base = m.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "relative";
    let label = base === "none" ? "relative_none" : base;
    for (let i = 2; byLabel.has(label); i++) label = `${base}_${i}`;
    byLabel.set(label, m);
    // The title is the organizer's word: "the writer's Mom" for them, "whom Daniel calls Mom" for others.
    const desc = !m.title
      ? `${m.relationship ?? ""} ${m.name}`.trim()
      : viewerIsOrganizer
        ? `The writer's ${m.title} (${m.name})`
        : `${m.name}, whom ${orgName ?? "the family"} calls ${m.title}`;
    criteria[label] = cap(desc);
  }
  criteria.none = "None of these people, or the message doesn't say which family member it is";
  try {
    const r = await askJev(content, {
      claimed_relative: {
        type: "choice",
        instructions: "Which family member the caller or message claims to be, or says is in trouble.",
        criteria,
      },
    });
    const { label, confidence } = choice(r, "claimed_relative");
    const m = label && label !== "none" && confidence >= 0.5 ? byLabel.get(label) ?? null : null;
    console.log(`[family] claimed_relative → ${m ? `member ${short(m.id)}` : "none"} (confidence ${confidence.toFixed(2)})`);
    return m;
  } catch (err: any) {
    console.error(`[family] Jev claimed_relative failed: ${err?.message}`);
    return null;
  }
}

async function startCall(em: Emergency) {
  if (!em.circleId || !em.relative) return;
  em.stage = "calling";
  const { verifyId } = await placeVerificationCall({
    circleId: em.circleId,
    relative: em.relative,
    protectedName: em.protectedName,
    targetUserId: em.userId,
  });
  em.verificationId ??= verifyId;
}

registerPendingHandler("verify_call", async (userId, data, answer) => {
  const em = activeEmergency(userId);
  if (!em || em.id !== data.emergencyId || em.stage !== "awaiting_yes" || !em.relative) return false; // stale: router replies
  if (answer === "yes") {
    await textProtected(em, "call-yes", [`Calling ${relLabel(em)} now. I'll text you what I find.`]);
    await startCall(em);
  } else {
    em.stage = "closed";
    em.outcome = "call_declined";
    em.decidedBy = "user_said_no";
    await textProtected(em, "call-no", ["Okay, I won't call. Don't send money, and ask the caller for the family safe word."]);
    await logEvent(em, 0);
  }
  return true;
});

// ---------------------------------------------------------------------------------------------
// Steps 9–12
// ---------------------------------------------------------------------------------------------

/** Called once per verification when its status becomes final (verify.ts). */
export async function onVerificationResult(r: {
  verificationId: string;
  circleId: string;
  relativeId: string;
  status: VerifyStatus;
  decidedBy: string;
}): Promise<void> {
  // Whose emergency this was: the verification's target (any family member), else a legacy circle's protected user.
  const row = await one<{ target: string | null; organizer: string | null }>(
    `SELECT COALESCE(v.target_user_id, c.protected_user_id) AS target, c.organizer_user_id AS organizer
       FROM circles c LEFT JOIN verifications v ON v.id = $2 WHERE c.id = $1`,
    [r.circleId, r.verificationId],
  );
  if (!row?.target) return;
  let em = activeEmergency(row.target);
  // A call that fails at once finalizes before startCall has stored the verification id: that's still ours.
  if (em && em.verificationId && em.verificationId !== r.verificationId) em = null;
  if (!em) {
    // Server restarted mid-call (or an old call finished): rebuild what the texts need from the database.
    em = {
      id: randomUUID().slice(0, 12),
      userId: row.target,
      circleId: r.circleId,
      organizerId: row.organizer,
      protectedName: await loadProtectedName(row.target),
      relative: await getMember(r.relativeId),
      source: "text",
      startedAt: Date.now(),
      stage: "calling",
      alertSent: false,
      wordTexts: 0,
    };
    emergencies.set(em.userId, em);
  }
  em.verificationId = r.verificationId;
  em.stage = "result";
  em.outcome = r.status;
  em.decidedBy = r.decidedBy;

  const name = relLabel(em);
  const p = memberPronouns(em.relative);
  const result: Record<VerifyStatus, string> = {
    verified_safe: `${name} just answered ${p.his} own phone and said the family word. ${cap(p.heIs)} safe. The call you're on is a scam: hang up.`,
    verified_needs_help: `${name} answered and gave the family word, but says ${p.he} ${p.needs} help. Call ${p.him} back on ${p.his} own number, or 911 in an emergency.`,
    failed: `Someone answered ${name}'s number but couldn't give the family word. Don't send money. Hang up and try ${name} yourself.`,
    unreachable: `I couldn't reach ${name}. That doesn't mean ${p.heIs} in trouble. Don't send money; ask the caller for the family word.`,
  };

  // Step 10 before the text goes out, so a fast NO/YES can't miss the pending slot.
  setPending(em.userId, "loss_question", { emergencyId: em.id });
  await textProtected(em, "result", [result[r.status], "Did you send money or share any codes? Reply NO or YES."]);
  // The person the scammer used gets their own text right away (alerts on or off), not the generic alert.
  await textRelative(em, r.status);

  const target = em;
  clearTimeout(em.alertTimer);
  em.alertTimer = setTimeout(() => {
    sendCircleAlert(target).catch((err) => console.error(`[family] circle alert for ${short(target.userId)} failed: ${err?.message}`));
  }, familyTimings.alertWaitMs);
  em.alertTimer.unref?.();
}

registerPendingHandler("loss_question", async (userId, data, answer) => {
  const em = activeEmergency(userId);
  if (!em || em.id !== data.emergencyId) return false; // stale: router replies
  em.loss = answer;
  if (answer === "yes") {
    // Flow 4: asks what happened (numbered menu), then texts the checklist one step at a time.
    await startRecovery({ userId: em.userId, source: "family" });
  } else {
    await textProtected(em, "loss-no", ["Good. Never send money or codes to someone who calls in a hurry."]);
  }
  if (!em.alertSent) {
    await sendCircleAlert(em); // already says "No money was sent." on a NO
    // The relative isn't in that alert (they got their own text), so tell them too.
    const relId = em.relative?.user_id;
    if (answer === "no" && relId && relId !== em.userId) {
      await textUser(relId, [`Update: ${em.protectedName} says no money was sent.`], `family:${em.id}:relative-update`).catch((err) =>
        console.error(`[family] update to relative failed: ${err?.message}`),
      );
    }
  } else {
    if (answer === "no") await alertFamily(em, [`Update: ${em.protectedName} says no money was sent.`], "update", { includeRelative: true });
    if (em.eventId) await query("UPDATE events SET flags = $2 WHERE id = $1", [em.eventId, eventFlags(em)]);
  }
  return true;
});

/** Step 11: type and outcome only, to everyone with family alerts on. "No money was sent." only after an explicit NO. */
async function sendCircleAlert(em: Emergency) {
  if (em.alertSent) return;
  em.alertSent = true;
  clearTimeout(em.alertTimer);
  const p = memberPronouns(em.relative);
  const P = em.protectedName;
  const outcome = (em.outcome ?? "unreachable") as VerifyStatus;
  const count = await alertFamily(
    em,
    (viewerIsOrganizer) => {
      const name = em.relative ? labelFor(em.relative, viewerIsOrganizer) : "their family member";
      const line: Record<VerifyStatus, string> = {
        verified_safe: `${P} received a likely family-emergency scam. ${name} is safe.`,
        verified_needs_help: `${P} got a family-emergency call. ${name} gave the family word and says ${p.he} ${p.needs} help. Please check on ${p.him}.`,
        failed: `${P} received a likely family-emergency scam. I couldn't confirm ${name} is safe. Please check on ${p.him}.`,
        unreachable: `${P} received a likely family-emergency scam. I couldn't reach ${name}. Please check on ${p.him}.`,
      };
      return [(line[outcome] ?? line.unreachable) + (em.loss === "no" ? " No money was sent." : "")];
    },
    "alert",
  );
  em.stage = "closed";
  await logEvent(em, count);
}

/**
 * Texts the family member the scammer claimed was in trouble (Y), in their own words: they were checked on,
 * and what the targeted person (X) was told. Sent whatever Y's alert switch says: it's about them.
 */
async function textRelative(em: Emergency, status: VerifyStatus): Promise<void> {
  const y = em.relative;
  if (!y?.user_id || !em.circleId || y.user_id === em.userId) return;
  const xRow = await one<{ name: string; title: string | null; relationship: string | null }>(
    "SELECT name, title, relationship FROM circle_members WHERE circle_id = $1 AND user_id = $2 ORDER BY created_at LIMIT 1",
    [em.circleId, em.userId],
  );
  const yIsOrganizer = y.user_id === em.organizerId;
  const X = xRow ? labelFor(xRow, yIsOrganizer) : em.protectedName;
  const lead = `Heads up: a scammer told ${X} you were in trouble.`;
  const text: Record<VerifyStatus, string> = {
    verified_safe: `${lead} You gave the family word, so I told ${X} you're safe and it's a scam.`,
    verified_needs_help: `${lead} You said you need help, so I asked ${X} to call you back on your own number. If it's an emergency, call 911.`,
    failed: `${lead} I called your number to check, but whoever answered couldn't give the family word. Please call ${X} yourself.`,
    unreachable: `${lead} I tried your phone to check on you. Please call ${X} to say you're okay.`,
  };
  const ok = await textUser(y.user_id, [text[status]], `family:${em.id}:relative`).catch((err) => {
    console.error(`[family] text to relative ${short(y.id)} failed: ${err?.message}`);
    return false;
  });
  console.log(`[family] relative ${short(y.id)} told about the scam: ${ok ? "sent" : "not sent (no thread)"}`);
}

/**
 * Texts every family member who turned family alerts on. Never the targeted person, and never the relative
 * the scammer used (they got their own text) unless `includeRelative` (the "no money was sent" update).
 */
async function alertFamily(
  em: Emergency,
  lines: string[] | ((viewerIsOrganizer: boolean) => string[]),
  tag: string,
  opts: { includeRelative?: boolean } = {},
): Promise<number> {
  if (!em.circleId) return 0;
  const relId = em.relative?.user_id;
  let recipients = await getAlertRecipients(em.circleId, em.userId);
  if (relId && !opts.includeRelative) recipients = recipients.filter((g) => g.user_id !== relId);
  else if (relId && opts.includeRelative && !recipients.some((g) => g.user_id === relId) && em.relative) recipients.push(em.relative);
  let sent = 0;
  for (const g of recipients) {
    const text = typeof lines === "function" ? lines(g.user_id === em.organizerId) : lines;
    const ok = await textUser(g.user_id!, text, `family:${em.id}:${tag}:${short(g.id)}`).catch((err) => {
      console.error(`[family] alert to member ${short(g.id)} failed: ${err?.message}`);
      return false;
    });
    if (ok) sent++;
  }
  console.log(`[family] circle ${tag}: ${sent}/${recipients.length} family members texted`);
  return sent;
}

// Step 12: no content, sender or word. Which check decided it goes in flags.
const eventFlags = (em: Emergency) => [`check:${em.decidedBy ?? "unknown"}`, `trigger:${em.source}`, `loss:${em.loss ?? "unknown"}`];

async function logEvent(em: Emergency, alertCount: number) {
  try {
    const row = await one<{ id: string }>(
      `INSERT INTO events (user_id, source, scam_type, flags, outcome, alert_count, duration_s)
       VALUES ($1, 'family', 'family_emergency', $2, $3, $4, $5) RETURNING id`,
      [em.userId, eventFlags(em), em.outcome ?? null, alertCount, Math.round((Date.now() - em.startedAt) / 1000)],
    );
    em.eventId = row?.id;
  } catch (err: any) {
    console.error(`[family] event log failed: ${err?.message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Texts from the protected person during an emergency
// ---------------------------------------------------------------------------------------------

const WORDISH = "(safe ?word|family word|code ?word|secret word|the word|our word|password|passcode)";
const ASK_WORD = new RegExp(
  `\\b(what('?s| is| was)|whats|tell me|remind me|send me|give me|forgot|forget|don'?t remember|don'?t know|do not remember|do not know)\\b.*\\b${WORDISH}`,
  "i",
);
const ASK_WORD_SHORT = new RegExp(`^\\s*${WORDISH}\\s*\\?+\\s*$`, "i");
const GAVE_WORD = /\b(said|knew|knows|gave|got|told me|say)\b.{0,25}\bword\b/i;
const NEGATION = /\b(didn'?t|did not|doesn'?t|does not|don'?t|couldn'?t|could not|can'?t|wrong|not|no|refused|won'?t)\b/i;
const NEEDS_JEV = /\b(word|code|password|phrase|knew|know|knows|said|says|right one|correct)\b/i;

type FamilyIntent = "ask_word" | "caller_gave_word" | "caller_failed_word" | "other";

async function classifyFamilyText(text: string): Promise<FamilyIntent> {
  if (ASK_WORD.test(text) || ASK_WORD_SHORT.test(text)) return "ask_word";
  if (GAVE_WORD.test(text) && !NEGATION.test(text)) return "caller_gave_word";
  if (!NEEDS_JEV.test(text)) return "other";
  try {
    const r = await askJev(
      `Bouncer told the writer to ask a caller for the family safe word. The writer then texted: "${text}"`,
      {
        family_text: {
          type: "choice",
          instructions: "What the writer's text means.",
          criteria: {
            ask_word: "The writer asks what the family safe word is, or says they forgot it",
            caller_gave_word: "The writer says the caller said, knew or gave the right family safe word",
            caller_failed_word: "The writer says the caller didn't know the safe word, refused, or gave a wrong one",
            other: "Anything else",
          },
        },
      },
    );
    const { label, confidence } = choice(r, "family_text");
    return confidence >= 0.6 && label ? (label as FamilyIntent) : "other";
  } catch (err: any) {
    console.error(`[family] Jev family_text failed: ${err?.message}`);
    return "other";
  }
}

export async function handleFamilyTextImpl(user: User, msg: InboundMessage): Promise<boolean> {
  const em = activeEmergency(user.id);
  if (!em || !msg.text || msg.text.length > 300) return false;
  const intent = await classifyFamilyText(msg.text);
  if (intent === "other") return false;

  const reply = (tag: string, text: string) =>
    sendText({ spaceId: msg.spaceId, senderId: msg.agentUserId, text, idempotencyKey: `family:${em.id}:${tag}:${msg.id}` });
  const p = memberPronouns(em.relative);

  if (intent === "ask_word") {
    // Text only, and only to the protected person in their own one-to-one thread (never voice, never a group).
    if (msg.spaceKind !== "direct") {
      await reply("word-group", "I can only send the family word in your private chat with me.");
      return true;
    }
    const enc = em.circleId ? await getSafeWordRow(em.circleId) : null;
    if (!enc || !em.circleId) {
      await reply("word-none", "There's no family word saved yet. Ask the caller something only the real person would know.");
      return true;
    }
    if (em.wordTexts >= 3) {
      await reply("word-limit", "I've already sent it. Scroll up in this chat to find it.");
      return true;
    }
    em.wordTexts++;
    await sendText({
      spaceId: msg.spaceId,
      senderId: msg.agentUserId,
      text: `Your family word is: ${decryptWord(enc, em.circleId)}. Delete this after the call.`,
      idempotencyKey: `family:${em.id}:word-${em.wordTexts}:${msg.id}`,
      sensitive: true, // rule 2: DRY_RUN prints only its length
    });
    console.log(`[family] sent the family word to protected user ${short(user.id)} (text only)`);
    return true;
  }

  if (intent === "caller_gave_word") {
    await reply("gave-word", `Then it's very likely really ${p.him}. Call ${p.him} back on ${p.his} saved number to be sure.`);
    return true;
  }

  // caller_failed_word
  await reply("failed-word", "Then treat it as a scam. Hang up and don't send money.");
  return true;
}
