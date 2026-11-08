// SPEC Flow 1: every inbound iMessage lands here (src/photon/socket.ts), one at a time per conversation.
// Order: YES/NO for a parked action → Flow 3 texts during an emergency → keywords → screenshot or text.
// Message text and images live in memory only for this call (rule 1). Logs carry ids and labels, never content.
import type { InboundMessage } from "../photon/socket.js";
import { getOrCreateUser, saveConversation, setOptedIn, markListenPending, type User } from "../users.js";
import { sendLines, setTyping, downloadAttachment } from "../photon/client.js";
import { parseYesNo, resolvePending } from "../pending.js";
import { handleFamilyText, startFamilyEmergency } from "../family/index.js";
import { choice, type JevQuestion } from "../detection/jev.js";
import { extractScreenshot, type Extracted } from "../detection/extract.js";
import { isKnownContact, scanMessage, updateContactMemory, logEvent, type MessageState, type ScanResult } from "../detection/scan.js";
import { writeVerdictReply, answerQuestion } from "../detection/reply.js";

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

const RECOVERY =
  "Act fast: 1) Card or bank payment: call the number on the back of your card now and ask to stop or dispute it. " +
  "2) Gift card: call the gift card company with the card number and receipt. " +
  "3) Shared a code or password: change that password now, plus anywhere you reused it. " +
  "4) Gave your SSN: freeze your credit and go to IdentityTheft.gov.";

const LISTEN_RE = /^\s*(listen|listen in|start listening)\s*[.!]?\s*$/i;

export async function handleInbound(msg: InboundMessage): Promise<void> {
  const t0 = Date.now();
  const { user, created } = await getOrCreateUser(msg.senderHandle);
  await saveConversation(user.id, msg.spaceId, msg.agentUserId);
  const say = (lines: string[], tag = "1") =>
    sendLines({ spaceId: msg.spaceId, senderId: msg.agentUserId, keyPrefix: `bouncer:${msg.id}:${tag}` }, lines);
  const uid = user.id.slice(0, 8);

  if (created) {
    await say([WELCOME], "w");
    console.log(`[inbound] new user ${uid}`);
    if (!msg.attachmentIds.length) return; // a screenshot as the very first message still gets checked
  }

  if (msg.attachmentIds.length) return handleScreenshot(user, msg, say, t0);
  const text = msg.text ?? "";

  // 1. YES / NO for an action another flow parked (verify call, loss question, call feedback, …).
  const yn = parseYesNo(text);
  if (yn && (await resolvePending(user.id, yn))) return;

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

  // 4. Route with Jev and score the message in the same request.
  setTyping(msg.spaceId, msg.agentUserId, true);
  try {
    const state: MessageState = { body: text };
    const scan = await scanMessage(state, INTENT);
    const intent = choice(scan.jev, "intent");
    console.log(`[inbound] user ${uid} text intent=${intent.label} (${intent.confidence.toFixed(2)}) level=${scan.risk.level}`);

    switch (intent.label) {
      case "family_emergency":
        // Flow 3 sends the coach text itself; no reply from here.
        await startFamilyEmergency({ userId: user.id, content: text, source: "text" });
        return;
      case "already_paid":
        await say([RECOVERY, "If you lost money, also report it at reportfraud.ftc.gov."]);
        await logEvent({ userId: user.id, source: "imessage", outcome: "recovery_checklist", latencyMs: Date.now() - t0 });
        return;
      case "report":
        await say(["Thanks for telling me. Forward the scam text to 7726 (SPAM) so T-Mobile can block it, then delete it."]);
        return;
      case "setup":
        await say(["I can't set up a family circle by text yet. Once one is set up, I can check on a relative when someone claims they're in trouble."]);
        return;
      case "question":
        // A long text that Jev also thinks is risky is almost certainly a pasted message: check it.
        if (!(text.length > 80 && scan.risk.level !== "safe")) {
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
  await say(["Looking at it now..."], "look");
  setTyping(msg.spaceId, msg.agentUserId, true);
  try {
    let extracted: Extracted[];
    try {
      extracted = await Promise.all(
        msg.attachmentIds.slice(0, 3).map(async (id) => {
          let img: { data: Buffer; contentType: string } | null = await downloadAttachment(id);
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
    const scan = await scanMessage(state);
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
  const lines = await writeVerdictReply(scan, body, claimedBrand);
  await say(lines.filter((l) => l.trim()));
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
