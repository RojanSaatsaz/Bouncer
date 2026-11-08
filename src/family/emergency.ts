// SPEC Flow 3 steps 4–7 and 9–12: coach Grandma, decide who to call, tell her the result,
// ask about losses, alert the circle (type and outcome only) and log the event (no content).
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
  getCircleForProtected,
  getJoinedMembers,
  getMember,
  getSafeWordRow,
  pronouns,
  protectedName as loadProtectedName,
  type Member,
} from "./circle.js";
import { decryptWord } from "./crypto.js";
import { familyTimings } from "./timings.js";
import { placeVerificationCall, type VerifyStatus } from "./verify.js";

type Outcome = VerifyStatus | "coached_only" | "call_declined";

interface Emergency {
  id: string;
  userId: string; // the protected person
  circleId: string | null;
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

/** Active emergency per protected user. In memory only. */
const emergencies = new Map<string, Emergency>();
const short = (id: string) => id.slice(0, 8);

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
    const name = prev.relative.name;
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
    protectedName: "your family member",
    relative: null,
    source,
    startedAt: Date.now(),
    stage: "coached",
    alertSent: false,
    wordTexts: 0,
  };
  emergencies.set(userId, em);

  const circle = await getCircleForProtected(userId);
  if (!circle) return coachOnly(em, "no_circle", false);
  em.circleId = circle.id;
  em.protectedName = await loadProtectedName(userId);

  const [relatives, word] = await Promise.all([getJoinedMembers(circle.id, "relative"), getSafeWordRow(circle.id)]);
  if (!word) return coachOnly(em, "no_safe_word", false);
  if (!relatives.length) return coachOnly(em, "no_relatives", true);

  const claimed = await findClaimedRelative(content, relatives);
  if (!claimed) return coachOnly(em, "no_relative_named", true);
  em.relative = claimed;

  const p = pronouns(claimed.relationship);
  const coach = `Ask ${p.him} for the family safe word. Don't say it yourself, and don't send money yet.`;
  if (source === "text") {
    await textProtected(em, "coach", [`${coach} I'm checking on ${claimed.name}.`]);
    await startCall(em);
  } else {
    // Rule 4: a call-triggered emergency needs a YES by text before Bouncer dials anyone.
    em.stage = "awaiting_yes";
    setPending(userId, "verify_call", { emergencyId: em.id });
    await textProtected(em, "coach", [coach, `Reply YES and I'll call ${claimed.name}'s own number to check ${p.heIs} safe.`]);
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

/** Step 5: Jev choice `claimed_relative`, one label per joined relative plus `none`. Content stays in memory. */
async function findClaimedRelative(content: string, relatives: Member[]): Promise<Member | null> {
  const byLabel = new Map<string, Member>();
  const criteria: Record<string, string> = {};
  for (const m of relatives) {
    const base = m.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "relative";
    let label = base === "none" ? "relative_none" : base;
    for (let i = 2; byLabel.has(label); i++) label = `${base}_${i}`;
    byLabel.set(label, m);
    criteria[label] = cap(`${m.relationship ?? ""} ${m.name}`.trim());
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
  const { verifyId } = await placeVerificationCall({ circleId: em.circleId, relative: em.relative, protectedName: em.protectedName });
  em.verificationId ??= verifyId;
}

registerPendingHandler("verify_call", async (userId, data, answer) => {
  const em = activeEmergency(userId);
  if (!em || em.id !== data.emergencyId || em.stage !== "awaiting_yes" || !em.relative) return false; // stale: router replies
  if (answer === "yes") {
    await textProtected(em, "call-yes", [`Calling ${em.relative.name} now. I'll text you what I find.`]);
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
  const circle = await one<{ protected_user_id: string }>("SELECT protected_user_id FROM circles WHERE id = $1", [r.circleId]);
  if (!circle) return;
  let em = activeEmergency(circle.protected_user_id);
  if (em && em.verificationId && em.verificationId !== r.verificationId) em = null;
  if (!em) {
    // Server restarted mid-call (or an old call finished): rebuild what the texts need from the database.
    em = {
      id: randomUUID().slice(0, 12),
      userId: circle.protected_user_id,
      circleId: r.circleId,
      protectedName: await loadProtectedName(circle.protected_user_id),
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

  const name = em.relative?.name ?? "your family member";
  const p = pronouns(em.relative?.relationship);
  const result: Record<VerifyStatus, string> = {
    verified_safe: `${name} just answered ${p.his} own phone and said the family word. ${cap(p.heIs)} safe. The call you're on is a scam: hang up.`,
    verified_needs_help: `${name} answered and gave the family word, but says ${p.he} ${p.needs} help. Call ${p.him} back on ${p.his} own number, or 911 in an emergency.`,
    failed: `Someone answered ${name}'s number but couldn't give the family word. Don't send money. Hang up and try ${name} yourself.`,
    unreachable: `I couldn't reach ${name}. That doesn't mean ${p.heIs} in trouble. Don't send money; ask the caller for the family word.`,
  };

  // Step 10 before the text goes out, so a fast NO/YES can't miss the pending slot.
  setPending(em.userId, "loss_question", { emergencyId: em.id });
  await textProtected(em, "result", [result[r.status], "Did you send money or share any codes? Reply NO or YES."]);

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
    await sendCircleAlert(em);
  } else {
    if (answer === "no") await alertGuardians(em, [`Update: ${em.protectedName} says no money was sent.`], "update");
    if (em.eventId) await query("UPDATE events SET flags = $2 WHERE id = $1", [em.eventId, eventFlags(em)]);
  }
  return true;
});

/** Step 11: type and outcome only. "No money was sent." only after an explicit NO. */
async function sendCircleAlert(em: Emergency) {
  if (em.alertSent) return;
  em.alertSent = true;
  clearTimeout(em.alertTimer);
  const name = em.relative?.name ?? "their family member";
  const p = pronouns(em.relative?.relationship);
  const P = em.protectedName;
  const line: Record<VerifyStatus, string> = {
    verified_safe: `${P} received a likely family-emergency scam. ${name} is safe.`,
    verified_needs_help: `${P} got a family-emergency call. ${name} gave the family word and says ${p.he} ${p.needs} help. Please check on ${p.him}.`,
    failed: `${P} received a likely family-emergency scam. I couldn't confirm ${name} is safe. Please check on ${p.him}.`,
    unreachable: `${P} received a likely family-emergency scam. I couldn't reach ${name}. Please check on ${p.him}.`,
  };
  const outcome = (em.outcome ?? "unreachable") as VerifyStatus;
  const text = (line[outcome] ?? line.unreachable) + (em.loss === "no" ? " No money was sent." : "");
  const count = await alertGuardians(em, [text], "alert");
  em.stage = "closed";
  await logEvent(em, count);
}

async function alertGuardians(em: Emergency, lines: string[], tag: string): Promise<number> {
  if (!em.circleId) return 0;
  const guardians = await getJoinedMembers(em.circleId, "guardian");
  let sent = 0;
  for (const g of guardians) {
    if (!g.user_id) {
      console.warn(`[family] guardian ${short(g.id)} has no Bouncer account yet; alert not sent`);
      continue;
    }
    const ok = await textUser(g.user_id, lines, `family:${em.id}:${tag}:${short(g.id)}`).catch((err) => {
      console.error(`[family] alert to guardian ${short(g.id)} failed: ${err?.message}`);
      return false;
    });
    if (ok) sent++;
  }
  console.log(`[family] circle ${tag}: ${sent}/${guardians.length} guardians texted`);
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
  const p = pronouns(em.relative?.relationship);

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
