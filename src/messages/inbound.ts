// SPEC Flow 1: every inbound iMessage lands here (src/photon/socket.ts), one at a time per conversation.
// Order: YES/NO for a parked action → Flow 3 texts during an emergency → keywords → screenshot or text.
// Message text and images live in memory only for this call (rule 1). Logs carry ids and labels, never content.
import type { InboundMessage } from "../photon/socket.js";
import { voiceNumberForText, getOrCreateUser, saveConversation, setOptedIn, markListenPending, type User } from "../users.js";
import { sendLines, setTyping, downloadAttachment } from "../photon/client.js";
import { parseYesNo, resolvePending } from "../pending.js";
import { handleFamilyText, startFamilyEmergency } from "../family/index.js";
import { startRecovery, handleRecoveryText, recoveryAwaitsYesNo } from "../recovery/index.js";
import { handleSetupText, startSetup, isSetupCommand } from "../family/setup.js";
import { askJev, choice, noul, type JevQuestion } from "../detection/jev.js";
import {
  handleReport,
  rememberBody,
  setZipFromText,
  activePatternsFor,
  MATCHES_PATTERN_QUESTION,
  applyPatternFloorToRisk,
} from "../patterns/index.js";
import { extractScreenshot, type Extracted } from "../detection/extract.js";
import { isKnownContact, scoreAnswers, updateContactMemory, logEvent, type MessageState, type ScanResult } from "../detection/scan.js";
import { MESSAGE_QUESTIONS } from "../detection/questions.js";
import { atLeast, LEVEL_LABEL } from "../detection/risk.js";
import { writeVerdictReply, answerChat, pickFresh, topFlags, type ChatKind } from "../detection/reply.js";
import { addUserTurn, addBouncerTurn, getHistory, setVerdict } from "./history.js";
import { getCase, openCase, caseForModel, detectPayment, detectAmounts } from "./case.js";

const SORRY = "Sorry, I couldn't check that right now. Try again in a minute.";

/**
 * Same as scan.ts scanMessage, but with a tight Jev budget for a live user (the defaults of 20 s × 3
 * retries suit the eval, not a chat): one retry, 4 s per try, so a failure surfaces in ~8 s at worst.
 */
async function scanLive(state: MessageState, extra: Record<string, JevQuestion> = {}, patterns: string[] = []): Promise<ScanResult> {
  // Flow 5 step 8: scam templates spiking in the user's area are checked too (only asked when there are any).
  const qs = { ...MESSAGE_QUESTIONS, ...(patterns.length ? MATCHES_PATTERN_QUESTION : {}), ...extra };
  const r = await askJev(patterns.length ? { ...state, active_patterns: patterns } : state, qs, { retries: 1, timeoutMs: 4_000 });
  const scan = scoreAnswers(r, !!state.known_contact);
  if (patterns.length) scan.risk = applyPatternFloorToRisk(scan.risk, noul(r, "matches_pattern"));
  return scan;
}

/** Rejects after `ms`. The losing promise is left to settle on its own (its result is dropped). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Attachment bytes with a time limit. Photon can hold the request ~10 s on ATTACHMENT_NOT_READY, and
 * the client takes no AbortSignal, so race it: 5 s, then one retry while the total stays under ~9 s.
 */
async function fetchImage(id: string, t0: number): Promise<{ data: Buffer; contentType: string }> {
  try {
    return await withTimeout(downloadAttachment(id), 5_000, "attachment download");
  } catch (err: any) {
    const left = t0 + 9_000 - Date.now();
    if (left < 1_500) throw err;
    console.warn(`[inbound] ${err?.message}; retrying once`);
    return await withTimeout(downloadAttachment(id), left, "attachment download retry");
  }
}

/** A brand-new user's first text that is more than a hello: probably a pasted message to check. */
const looksLikeContent = (text: string) =>
  text.trim().length > 25 || /https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\/?\b|\d{3,}/i.test(text);

const CALL_NUMBER = voiceNumberForText();
const WELCOME =
  "Hi, I'm Bouncer from T-Mobile. Send me any text, DM or screenshot you're unsure about and I'll check it. " +
  `If a call ever feels off, call me at ${CALL_NUMBER} or merge me into the call and I'll listen quietly and text you warnings. ` +
  `Save ${CALL_NUMBER} in your contacts as "Bouncer" so it's easy to find. Reply YES to turn on call protection and alerts.`;

/** Flow 1 step 4. Asked in the same Jev request as the message questions (one round trip). */
const INTENT: Record<string, JevQuestion> = {
  intent: {
    type: "choice",
    instructions: "The text was sent by a user to Bouncer, a scam-checking assistant. What does the user want?",
    criteria: {
      check_message: "A pasted or forwarded message, email, DM or link the user got from someone else, to be judged. Pasted messages are often written to the reader, e.g. 'I sent you money by mistake' or 'Your account is locked'",
      family_emergency: "The user says a relative or friend is calling or texting them in trouble, hurt, arrested or needing money right now",
      already_paid: "The user, in their own words, says they already clicked a scam link, paid a scammer, or shared a code, password or personal info, and wants help",
      report: "The user wants to report a scam",
      setup: "The user wants to set up a family circle or a safe word",
      question: "A general question, greeting or chat with Bouncer",
    },
  },
};

const LISTEN_RE = /^\s*(listen|listen in|start listening)\s*[.!]?\s*$/i;

/** Greetings, thanks and small talk: answered as chat without a Jev round trip (nothing to judge). */
const SMALLTALK_RE =
  /^\s*(hi|hello|hey|hiya|yo|sup|howdy|good (morning|afternoon|evening|night)|what'?s up|wh?at'?s up|wassup|how are (you|u)( doing)?|how'?s it going|thanks?|thank (you|u)|thx|ty|appreciate it|cool|nice|great|awesome|got it|lol|haha+|perfect|bye|goodbye|see (ya|you)|later)( (so much|again|a lot|bouncer|there|man|buddy|today))*\s*[!.?,]*\s*(\p{Extended_Pictographic}\s*)*$/iu;

/**
 * A follow-up about the last verdict ("why?", "are you sure?", "what should I do?"): short, no link or long
 * number. Answered as chat that explains the stored verdict (its numbers come from Jev, rule 3).
 */
const FOLLOWUP_RE =
  /^\s*(but |so |ok(ay)?,? |wait,? |hm+,? |um+,? )?(why\b|how come|are (you|u) sure|r u sure|u sure|you sure|really\b|seriously|how do (you|u) know|how can (you|u) tell|explain|what (does|do) (that|you) mean|what (should|do|can) i do|what now|now what|should i\b|can i\b|is (it|this|that) (really |actually |definitely |even )?(a )?(scam|real|legit|safe|fake|ok)|what (red )?flags|how sure|it (looks|seems) (real|legit)|what makes|but it'?s from)/i;
/**
 * "Is this text from my bank a scam?" with nothing pasted: a question ABOUT a message, not the message.
 * Short, phrased as a question, no link, number or quote. Only used when Jev scores it below Likely.
 */
const ASKS_ABOUT_MISSING_RE =
  /^\s*(is|are|was|could|can (you|u) (tell|check)|does|do (you|u) think)\b.{0,60}\b(scam|scams|legit|real|safe|fake|spam|phishing)\b[^"“]*\?*\s*$/i;
const asksAboutMissing = (text: string) =>
  text.length <= 90 && !/https?:|www\.|\.[a-z]{2,4}\/|\d{4,}|["“]/i.test(text) && ASKS_ABOUT_MISSING_RE.test(text);
const isFollowup = (text: string) => text.length <= 80 && !/https?:|www\.|\d{4,}/i.test(text) && FOLLOWUP_RE.test(text);
/**
 * A short reply ("klarna link", "what do I do now", "he said 1.5k") rather than a message to check: no link,
 * email or long number. During an active case these are about the case and are never scanned as a new message.
 */
const isShortReply = (text: string) =>
  text.length <= 80 && text.trim().split(/\s+/).length <= 10 && !/https?:|www\.|\.[a-z]{2,4}\/|@|\d{4,}/i.test(text);

const OPT_IN = [
  `You're all set. Text me anything suspicious, or call me at ${CALL_NUMBER} (or merge me into a call that feels off) and I'll text you warnings.`,
  `Done, call protection and alerts are on. If a call feels off, add ${CALL_NUMBER} to it and merge, and I'll quietly listen and text you.`,
  `Great, you're protected. Send me anything sketchy, and merge ${CALL_NUMBER} into any call that doesn't feel right.`,
];
const ACK = ["👍", "Got it.", "Sounds good.", "Okay!"];
const NO_REPLY = ["Okay, no problem.", "No worries. I'm here if you need me.", "Okay. Send me anything you'd like checked."];
const LISTEN_REPLY = [
  `Okay. Add ${CALL_NUMBER} to your call and merge in the next 2 minutes, and I'll listen quietly and text you warnings.`,
  `Ready. Tap Add Call, dial ${CALL_NUMBER}, then Merge within 2 minutes. I'll stay quiet and text you if anything's off.`,
];

export async function handleInbound(msg: InboundMessage): Promise<void> {
  const t0 = Date.now();
  const { user, created } = await getOrCreateUser(msg.senderHandle);
  // Only a 1:1 thread becomes the user's alert thread: alerts must never go into a group chat.
  if (msg.spaceKind === "direct") await saveConversation(user.id, msg.spaceId, msg.agentUserId);
  // Everything Bouncer says through here also goes into the 30-minute chat memory (history.ts, memory only).
  const say: Say = async (lines, tag = "1") => {
    await sendLines({ spaceId: msg.spaceId, senderId: msg.agentUserId, keyPrefix: `bouncer:${msg.id}:${tag}` }, lines);
    if (tag !== "look") addBouncerTurn(user.id, lines.filter((l) => l.trim()).join("\n"));
  };
  const uid = user.id.slice(0, 8);
  const text = msg.text ?? "";

  if (created) {
    // A screenshot or a pasted message as the very first text still gets checked; a hello or YES stops here.
    const helloOnly = !msg.attachmentIds.length && !looksLikeContent(text) && !isSetupCommand(text);
    if (helloOnly) addUserTurn(user.id, text);
    await say([WELCOME], "w");
    console.log(`[inbound] new user ${uid}`);
    if (helloOnly) return;
  }

  if (msg.attachmentIds.length) return handleScreenshot(user, msg, say, t0);

  // 1. YES / NO for an action another flow parked (verify call, loss question, call feedback, …).
  // Recovery asking "Is that right?" / "anything else?" goes first: that question is the newest one.
  const yn = parseYesNo(text);
  if (yn && recoveryAwaitsYesNo(user.id) && (await handleRecoveryText(user, msg))) return;
  if (yn && (await resolvePending(user.id, yn))) return;

  // 1b. Flow 3 setup by text: an open setup conversation, "set up family", "JOIN ABC123", "change safe word".
  // Before everything else so answers like "done" and the safe word itself never reach Jev or Gemini.
  if (await handleSetupText(user, msg)) return;

  // 1c. Flow 4: menu number / DONE / NEXT / STOP while a recovery checklist is open.
  if (await handleRecoveryText(user, msg)) return;

  // 2. Flow 3 texts during an active emergency ("what's the word?", "he said the word").
  if (await handleFamilyText(user, msg)) return;

  // From here on the text is not a setup / emergency / recovery answer, so it may enter chat memory
  // (a safe word typed during setup never gets this far, rule 2).
  const history = getHistory(user.id);
  const lastBouncer = [...history.turns].reverse().find((t) => t.role === "bouncer")?.text ?? "";
  const answersQuestion = /\?\s*$/.test(lastBouncer);

  // 3. Keywords. A YES / NO that answers a question Bouncer just asked in chat goes to chat instead.
  if (yn === "yes" && !(user.opted_in && answersQuestion)) {
    addUserTurn(user.id, text);
    if (!user.opted_in) await setOptedIn(user.id, true);
    await say([pickFresh(user.opted_in ? ACK : OPT_IN, history.turns)]);
    return;
  }
  if (yn === "no" && !answersQuestion) {
    addUserTurn(user.id, text);
    await say([pickFresh(NO_REPLY, history.turns)]);
    return;
  }
  if (LISTEN_RE.test(text)) {
    addUserTurn(user.id, text);
    await markListenPending(user.id);
    await say([pickFresh(LISTEN_REPLY, history.turns)]);
    return;
  }
  // Flow 5: "ZIP 75080" sets the area for local alerts; a bare REPORT reports the last checked message.
  const zipReply = await setZipFromText(user, text);
  if (zipReply) {
    addUserTurn(user.id, "[sent a ZIP code]");
    await say([zipReply]);
    return;
  }
  if (/^\s*report\s*[.!]?\s*$/i.test(text)) {
    addUserTurn(user.id, text);
    await handleReport(user, (l) => say(l, "rep"));
    return;
  }

  // 3b. Chat that needs no Jev routing: small talk, a YES / NO to Bouncer's question, or a follow-up about
  // the last verdict. One Gemini call (or a template), ~3 s budget.
  const fastKind: ChatKind | null =
    history.verdict && isFollowup(text) ? "followup" : SMALLTALK_RE.test(text) || yn ? "smalltalk" : null;
  if (fastKind) {
    setTyping(msg.spaceId, msg.agentUserId, true);
    try {
      await chat(user, text, fastKind, say, Date.now() + 3_000, history);
      console.log(`[inbound] user ${uid} chat kind=${fastKind} in ${Date.now() - t0} ms`);
    } finally {
      setTyping(msg.spaceId, msg.agentUserId, false);
    }
    return;
  }

  // 3c. A short reply while a scam case is active (the call or message Bouncer just saw, case.ts): it is
  // about that case, not a new message to judge. Jev routes it with the case (intent only, no scam
  // questions, so scan calibration is untouched); chat answers it with the case in view.
  const kase = getCase(user.id);
  let caseLabel: string | null = null;
  if (kase && isShortReply(text)) {
    setTyping(msg.spaceId, msg.agentUserId, true);
    try {
      const r = await askJev({ user_message: text, recent_case: caseForModel(kase) }, INTENT, { retries: 1, timeoutMs: 4_000 });
      caseLabel = choice(r, "intent").label;
    } catch (err: any) {
      console.warn(`[inbound] case routing failed (${err?.message}); answering as chat`);
      caseLabel = "question";
    } finally {
      setTyping(msg.spaceId, msg.agentUserId, false);
    }
    console.log(`[inbound] user ${uid} case reply intent=${caseLabel ?? "?"} (case ${kase.source})`);
  }
  // A pasted message of 6+ words that Jev calls check_message still gets the full scan below; a few words
  // ("klarna link") are an answer about the case.
  const scanAnyway = caseLabel === "check_message" && text.trim().split(/\s+/).length >= 6;
  if (caseLabel && !scanAnyway) {
    switch (caseLabel) {
      case "already_paid":
        addUserTurn(user.id, text);
        await startRecovery({ userId: user.id, text, source: "text" });
        addBouncerTurn(user.id, "[Bouncer started the step-by-step recovery checklist by text]");
        return;
      case "family_emergency":
        addUserTurn(user.id, text);
        await startFamilyEmergency({ userId: user.id, content: text, source: "text" });
        addBouncerTurn(user.id, "[Bouncer started the family-emergency steps by text: ask for the family safe word, offer to call the relative's own number]");
        return;
      case "setup":
        addUserTurn(user.id, "[asked to set up family or a safe word]");
        await startSetup(user, (lines) => say(lines, "setup"));
        return;
      default: {
        setTyping(msg.spaceId, msg.agentUserId, true);
        try {
          const kind: ChatKind = history.verdict && isFollowup(text) ? "followup" : "question";
          await chat(user, text, kind, say, Math.max(t0 + 4_500, Date.now() + 1_500), history);
          console.log(`[inbound] user ${uid} chat kind=${kind} (case) in ${Date.now() - t0} ms`);
        } finally {
          setTyping(msg.spaceId, msg.agentUserId, false);
        }
        return;
      }
    }
  }

  // 4. Route with Jev and score the message in the same request.
  setTyping(msg.spaceId, msg.agentUserId, true);
  try {
    const state: MessageState = { body: text };
    let scan: ScanResult;
    try {
      scan = await scanLive(state, INTENT, await activePatternsFor(user));
    } catch (err: any) {
      console.error(`[inbound] text scan failed for ${msg.id} after ${Date.now() - t0} ms: ${err?.message}`);
      addUserTurn(user.id, text);
      await say([SORRY], "err");
      return;
    }
    const intent = choice(scan.jev, "intent");
    console.log(`[inbound] user ${uid} text intent=${intent.label} (${intent.confidence.toFixed(2)}) level=${scan.risk.level}`);

    switch (intent.label) {
      case "family_emergency":
        // Flow 3 sends the coach text itself; no reply from here. Chat memory gets a note, not the texts.
        addUserTurn(user.id, text);
        await startFamilyEmergency({ userId: user.id, content: text, source: "text" });
        addBouncerTurn(user.id, "[Bouncer started the family-emergency steps by text: ask for the family safe word, offer to call the relative's own number]");
        return;
      case "already_paid":
        addUserTurn(user.id, text);
        await startRecovery({ userId: user.id, text, source: "text" });
        addBouncerTurn(user.id, "[Bouncer started the step-by-step recovery checklist by text]");
        return;
      case "report":
        addUserTurn(user.id, text);
        await handleReport(user, (l) => say(l, "rep"), text, scan.scamType);
        return;
      case "setup":
        // Not the text itself: it may hold a would-be safe word (rule 2).
        addUserTurn(user.id, "[asked to set up family or a safe word]");
        await startSetup(user, (lines) => say(lines, "setup"));
        return;
      case "check_message":
        // "Is this text from my bank a scam?" with nothing pasted: there is no message to judge, so chat asks
        // for it. Jev's scan still wins at Likely or above (rule 3).
        if (atLeast(scan.risk.level, "likely_scam") || !asksAboutMissing(text)) break;
      // falls through
      case "question":
        // Jev's scan wins (rule 3): Likely scam or above always gets the verdict, at any length. A long
        // text that Jev also thinks is risky is almost certainly a pasted message: check it too.
        if (!atLeast(scan.risk.level, "likely_scam") && !(text.length > 80 && scan.risk.level !== "safe")) {
          const kind: ChatKind = history.verdict && isFollowup(text) ? "followup" : "question";
          await chat(user, text, kind, say, Math.max(t0 + 4_500, Date.now() + 1_500), history);
          console.log(`[inbound] user ${uid} chat kind=${kind} in ${Date.now() - t0} ms`);
          return;
        }
    }
    addUserTurn(user.id, text);
    await reply(user, msg, say, scan, text, null, null, t0);
  } finally {
    setTyping(msg.spaceId, msg.agentUserId, false);
  }
}

type Say = (lines: string[], tag?: string) => Promise<void>;

/** One chat answer: sees the conversation before this text (and the active case), then both sides are added to memory. */
async function chat(user: User, text: string, kind: ChatKind, say: Say, deadline: number, history = getHistory(user.id)) {
  addUserTurn(user.id, text);
  const answer = await answerChat(text, {
    turns: history.turns,
    summary: history.summary,
    verdict: history.verdict,
    case: getCase(user.id),
    kind,
    firstContact: !history.turns.length && !history.summary,
    deadline,
  });
  await say([answer], "chat");
}

async function handleScreenshot(user: User, msg: InboundMessage, say: Say, t0: number) {
  // Start downloading while "Looking at it now..." is sent (the download is 1–3.5 s of the 6 s budget).
  const downloads = msg.attachmentIds.slice(0, 3).map((id) => fetchImage(id, t0));
  downloads.forEach((p) => p.catch(() => {})); // handled below; avoids an unhandled rejection meanwhile
  await say(["Looking at it now..."], "look");
  setTyping(msg.spaceId, msg.agentUserId, true);
  try {
    let extracted: Extracted[];
    try {
      extracted = await Promise.all(
        downloads.map(async (download) => {
          let img: { data: Buffer; contentType: string } | null = await download;
          if (!img.contentType.startsWith("image/")) return null;
          try {
            return await extractScreenshot(img.data, img.contentType);
          } finally {
            img = null; // drop the image as soon as Gemini returns (rule 1)
          }
        }),
      ).then((xs) => xs.filter((x): x is Extracted => !!x));
    } catch (err: any) {
      console.error(`[inbound] screenshot read failed for ${msg.id}: ${err?.message}`);
      addUserTurn(user.id, "[screenshot: couldn't be read]");
      await say(["Sorry, I couldn't read that picture. Try again, or paste the message text here."], "err");
      return;
    }
    const withText = extracted.filter((x) => x.body.length >= 3);
    if (!withText.length) {
      addUserTurn(user.id, "[screenshot: no message found in it]");
      await say(["I couldn't find a message in that picture. Send a screenshot of the text, DM or email, or paste the words here."], "empty");
      return;
    }
    const first = withText.find((x) => x.sender) ?? withText[0];
    const knownContact = await isKnownContact(user.id, first.sender);
    const state: MessageState = {
      body: withText.map((x) => x.body).join("\n---\n"),
      sender: first.sender,
      sender_type: first.sender_type,
      urls: withText.flatMap((x) => x.urls),
      claimed_brand: first.claimed_brand,
      known_contact: knownContact,
    };
    let scan: ScanResult;
    try {
      scan = await scanLive(state, {}, await activePatternsFor(user));
    } catch (err: any) {
      console.error(`[inbound] screenshot scan failed for ${msg.id} after ${Date.now() - t0} ms: ${err?.message}`);
      addUserTurn(user.id, "[screenshot: not checked]");
      await say([SORRY], "err");
      return;
    }
    console.log(`[inbound] user ${user.id.slice(0, 8)} screenshot level=${scan.risk.level} flags=${scan.flags.join(",")}`);
    // Chat memory gets a one-line note, never the extracted text (rule 1).
    addUserTurn(user.id, `[screenshot: ${first.claimed_brand ?? "unknown sender"}, verdict ${LEVEL_LABEL[scan.risk.level]}]`);
    await reply(user, msg, say, scan, state.body, first.claimed_brand, first.sender, t0);
  } finally {
    setTyping(msg.spaceId, msg.agentUserId, false);
  }
}

/** Steps 9–12: word, send, log (no content), update contact memory. */
async function reply(
  user: User,
  msg: InboundMessage,
  say: Say,
  scan: ScanResult,
  body: string,
  claimedBrand: string | null,
  sender: string | null,
  t0: number,
) {
  // Wording must finish by t0 + 5.5 s; past ~4.5 s elapsed the template is used (6 s target).
  const lines = (await writeVerdictReply(scan, body, claimedBrand, { deadline: t0 + 5_500 })).filter((l) => l.trim());
  // Flow 1 step 13 / Flow 5: invite a report on Likely+ verdicts. The body stays in memory 10 min for it.
  if (atLeast(scan.risk.level, "likely_scam")) {
    lines[lines.length - 1] += " Reply REPORT to warn people near you.";
    rememberBody(user.id, body, scan.scamType);
    // The key facts (never the text) become the active case, so "I already paid" etc. are understood.
    openCase(user.id, {
      source: msg.attachmentIds.length ? "screenshot" : "text",
      level: scan.risk.level,
      scamType: scan.scamType,
      flags: scan.flags,
      brand: claimedBrand,
      payment: detectPayment(body),
      amounts: detectAmounts(body),
      durationS: null,
    });
  }
  setVerdict(user.id, {
    level: scan.risk.level,
    label: LEVEL_LABEL[scan.risk.level],
    confidence: scan.risk.confidence,
    capped: scan.risk.capped,
    flags: topFlags(scan),
    scamType: scan.scamType,
    claimedBrand,
    source: msg.attachmentIds.length ? "screenshot" : "text",
  });
  await say(lines);
  const latencyMs = Date.now() - t0;
  console.log(`[inbound] replied to ${msg.id} in ${latencyMs} ms`);
  await logEvent({
    userId: user.id,
    source: "imessage",
    level: scan.risk.level,
    p: scan.risk.p,
    scamType: scan.risk.level === "safe" ? null : scan.scamType,
    flags: scan.flags,
    latencyMs,
  });
  await updateContactMemory(user.id, sender, scan.risk).catch((err) =>
    console.error(`[inbound] contact memory update failed: ${err?.message}`),
  );
}
