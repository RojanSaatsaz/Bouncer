// SPEC Flow 1: every inbound iMessage lands here (src/photon/socket.ts), one at a time per conversation.
// Order: YES/NO for a parked action → Flow 3 texts during an emergency → keywords → screenshot or text.
// Message text and images live in memory only for this call (rule 1). Logs carry ids and labels, never content.
import type { InboundMessage } from "../photon/socket.js";
import { getOrCreateUser, saveConversation, setOptedIn, markListenPending, type User } from "../users.js";
import { sendLines, setTyping, downloadAttachment } from "../photon/client.js";
import { parseYesNo, resolvePending } from "../pending.js";
import { handleFamilyText, startFamilyEmergency } from "../family/index.js";
import { startRecovery, handleRecoveryText } from "../recovery/index.js";
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
import { atLeast } from "../detection/risk.js";
import { writeVerdictReply, answerQuestion } from "../detection/reply.js";

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

const WELCOME =
  "Hi, I'm Bouncer from T-Mobile. Send me any text, DM or screenshot you're unsure about and I'll check it. " +
  "Reply YES to turn on call protection and alerts.";

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

export async function handleInbound(msg: InboundMessage): Promise<void> {
  const t0 = Date.now();
  const { user, created } = await getOrCreateUser(msg.senderHandle);
  // Only a 1:1 thread becomes the user's alert thread: alerts must never go into a group chat.
  if (msg.spaceKind === "direct") await saveConversation(user.id, msg.spaceId, msg.agentUserId);
  const say = (lines: string[], tag = "1") =>
    sendLines({ spaceId: msg.spaceId, senderId: msg.agentUserId, keyPrefix: `bouncer:${msg.id}:${tag}` }, lines);
  const uid = user.id.slice(0, 8);
  const text = msg.text ?? "";

  if (created) {
    await say([WELCOME], "w");
    console.log(`[inbound] new user ${uid}`);
    // A screenshot or a pasted message as the very first text still gets checked; a hello or YES stops here.
    if (!msg.attachmentIds.length && !looksLikeContent(text) && !isSetupCommand(text)) return;
  }

  if (msg.attachmentIds.length) return handleScreenshot(user, msg, say, t0);

  // 1. YES / NO for an action another flow parked (verify call, loss question, call feedback, …).
  const yn = parseYesNo(text);
  if (yn && (await resolvePending(user.id, yn))) return;

  // 1b. Flow 3 setup by text: an open setup conversation, "set up family", "JOIN ABC123", "change safe word".
  // Before everything else so answers like "done" and the safe word itself never reach Jev or Gemini.
  if (await handleSetupText(user, msg)) return;

  // 1c. Flow 4: menu number / DONE / NEXT / STOP while a recovery checklist is open.
  if (await handleRecoveryText(user, msg)) return;

  // 2. Flow 3 texts during an active emergency ("what's the word?", "he said the word").
  if (await handleFamilyText(user, msg)) return;

  // 3. Keywords.
  if (yn === "yes") {
    if (!user.opted_in) await setOptedIn(user.id, true);
    await say(["You're all set. Text me anything suspicious, or call this contact's number and say \"Hey Bouncer\" if a call feels off."]);
    return;
  }
  if (yn === "no") {
    await say(["Okay. Send me anything you'd like checked."]);
    return;
  }
  if (LISTEN_RE.test(text)) {
    await markListenPending(user.id);
    await say(["Okay. Merge me into your call in the next 2 minutes and I'll listen quietly and text you warnings."]);
    return;
  }
  // Flow 5: "ZIP 75080" sets the area for local alerts; a bare REPORT reports the last checked message.
  const zipReply = await setZipFromText(user, text);
  if (zipReply) {
    await say([zipReply]);
    return;
  }
  if (/^\s*report\s*[.!]?\s*$/i.test(text)) {
    await handleReport(user, (l) => say(l, "rep"));
    return;
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
      await say([SORRY], "err");
      return;
    }
    const intent = choice(scan.jev, "intent");
    console.log(`[inbound] user ${uid} text intent=${intent.label} (${intent.confidence.toFixed(2)}) level=${scan.risk.level}`);

    switch (intent.label) {
      case "family_emergency":
        // Flow 3 sends the coach text itself; no reply from here.
        await startFamilyEmergency({ userId: user.id, content: text, source: "text" });
        return;
      case "already_paid":
        await startRecovery({ userId: user.id, text, source: "text" });
        return;
      case "report":
        await handleReport(user, (l) => say(l, "rep"), text, scan.scamType);
        return;
      case "setup":
        await startSetup(user, (lines) => say(lines, "setup"));
        return;
      case "question":
        // Jev's scan wins (rule 3): Likely scam or above always gets the verdict, at any length. A long
        // text that Jev also thinks is risky is almost certainly a pasted message: check it too.
        if (!atLeast(scan.risk.level, "likely_scam") && !(text.length > 80 && scan.risk.level !== "safe")) {
          await say([await answerQuestion(text)]);
          return;
        }
    }
    await reply(user, msg, say, scan, text, null, null, t0);
  } finally {
    setTyping(msg.spaceId, msg.agentUserId, false);
  }
}

type Say = (lines: string[], tag?: string) => Promise<void>;

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
      await say(["Sorry, I couldn't read that picture. Try again, or paste the message text here."], "err");
      return;
    }
    const withText = extracted.filter((x) => x.body.length >= 3);
    if (!withText.length) {
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
      await say([SORRY], "err");
      return;
    }
    console.log(`[inbound] user ${user.id.slice(0, 8)} screenshot level=${scan.risk.level} flags=${scan.flags.join(",")}`);
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
  }
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
