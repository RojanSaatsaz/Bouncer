// SPEC Flow 3 Setup by text (reworked Nov 8): the organizer builds their family one question at a time.
// Everyone in the family is protected; each person gets a title the organizer picks ("Mom", "Grandma")
// so "Mom is in trouble" finds the right person. Instead of per-member roles, each person makes one
// choice: instant scam alerts for the whole family, on or off (FAMILY ALERTS ON / OFF changes it).
// JOIN codes with a YES to consent; the safe word is encrypted at once, never echoed, logged or kept.
// The conversation draft lives in memory only (30 min). Logs carry ids and step names, never names,
// numbers or the word. Seeded circles (scripts/seed-family.ts) need none of this and keep working.
import { randomInt } from "node:crypto";
import { config } from "../config.js";
import { one, pool, query } from "../db.js";
import type { InboundMessage } from "../photon/socket.js";
import { sendLines } from "../photon/client.js";
import { registerPendingHandler, setPending } from "../pending.js";
import { textUser, toE164, type User } from "../users.js";
import { getCircleForUser } from "./circle.js";
import { encryptWord, normalizeWord } from "./crypto.js";
import { normalizeHandle } from "./seed.js";

type Reply = (lines: string[]) => Promise<void>;
type Step = "organizer_name" | "member_title" | "member_name" | "member_phone" | "alerts" | "safe_word";

interface DraftMember {
  title: string;
  name: string;
  phone: string; // E.164
}

interface Draft {
  step: Step;
  expiresAt: number;
  organizerName?: string;
  members: DraftMember[];
  cur: Partial<DraftMember>;
  /** alerts / safe_word steps: the circle they are for. */
  circleId?: string;
  /** alerts step: the organizer's own member row. */
  selfMemberId?: string;
}

const TTL_MS = 30 * 60_000;
const drafts = new Map<string, Draft>();
const short = (id: string) => id.slice(0, 8);

const SAVED = "Saved and encrypted. I'll never say it on a call. You can delete your message now.";
const ASK_WORD =
  "Pick a word or short phrase you'd never say by accident and tell your family in person. Then text it to me here.";
const ASK_ALERTS = "Want an instant text if anyone in your family is targeted by a scam? Reply YES or NO.";
const ALERTS_HELP = "Text FAMILY ALERTS ON or OFF any time to change it.";

/** Lowercase, apostrophes dropped, other punctuation → spaces. For matching commands only. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9@.+ ]/g, " ")
    .replace(/[.]+(\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const START_RE = /^(please )?(set ?up|start|create|make) (a |my |our |the )?family( circle)?$|^family (circle )?set ?up$|^add (my )?family( members?)?$/;
const WORD_RE = /^(please )?(change|new|reset|update|set|set ?up) (my |the |our |a )?(family safe|family|safe) (word|phrase)$/;
const JOIN_RE = /^join ([a-z0-9]{6})$/;
const ALERTS_RE = /^(?:turn )?(?:family |scam )?alerts? (on|off)$|^turn (on|off) (?:my )?(?:family |scam )?alerts?$|^(?:family |scam )?alerts? (?:to )?(on|off)$/;
const CANCEL_RE = /^(cancel|stop|quit|exit|never ?mind)( setup)?$/;
const DONE_RE = /^(done|im done|finished|thats all|thats it|thats everyone|no more|no one else|nobody else)$/;
const YES_RE = /^(yes|y|yeah|yep|yup|sure|ok|okay|please|yes please|on|turn (it )?on)$/;
const NO_RE = /^(no|n|nope|nah|no thanks|off|keep (them|it) off|not now)$/;

/** True for texts setup handles even from a brand-new user (so the router doesn't stop at the welcome). */
export function isSetupCommand(text: string | null | undefined): boolean {
  const t = norm(text ?? "");
  return START_RE.test(t) || WORD_RE.test(t) || JOIN_RE.test(t) || ALERTS_RE.test(t);
}

function getDraft(userId: string): Draft | null {
  const d = drafts.get(userId);
  if (!d) return null;
  if (d.expiresAt < Date.now()) {
    drafts.delete(userId);
    return null;
  }
  return d;
}

function replyFor(msg: InboundMessage): Reply {
  let n = 0;
  return (lines) =>
    sendLines({ spaceId: msg.spaceId, senderId: msg.agentUserId, keyPrefix: `bouncer:${msg.id}:setup${n++ || ""}` }, lines);
}

/** "grandma" → "Grandma". Letters, spaces, apostrophes, dots and hyphens; up to 4 words / 40 chars. */
function cleanName(raw: string): string | null {
  const s = raw.replace(/[^\p{L}' .-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > 40 || s.split(" ").length > 4 || /\d/.test(raw)) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "my mom" → "Mom". What the organizer calls this person; any word works ("Nana", "Bae", "Tío"). */
function cleanTitle(raw: string): string | null {
  return cleanName(raw.replace(/^\s*(my|our)\s+/i, ""));
}

function question(d: Draft): string {
  const title = d.cur.title ?? "they";
  switch (d.step) {
    case "organizer_name":
      return "First, what's your first name?";
    case "member_title":
      return d.members.length
        ? "Who's next? Text what you call them, or DONE if that's everyone."
        : "Now add your family. Who's first? Text what you call them, like Mom or Grandma.";
    case "member_name":
      return `What's ${title}'s first name?`;
    case "member_phone":
      return `What's ${title}'s cell number?`;
    case "alerts":
      return ASK_ALERTS;
    case "safe_word":
      return ASK_WORD;
  }
}

/** SPEC step 1. Also the entry point for the Jev `setup` intent. */
export async function startSetup(user: User, reply: Reply): Promise<void> {
  const organizerName = user.name?.trim() || undefined;
  const d: Draft = { step: organizerName ? "member_title" : "organizer_name", expiresAt: Date.now() + TTL_MS, organizerName, members: [], cur: {} };
  drafts.set(user.id, d);
  const lines = ["Let's set up your family circle. I'll protect everyone in it. I'll ask one thing at a time. Text CANCEL to stop."];
  const existing = await one("SELECT 1 FROM circles WHERE organizer_user_id = $1 LIMIT 1", [user.id]);
  if (existing) {
    lines.push("You already have a family circle. Finishing this replaces it. To only change the safe word, text CHANGE SAFE WORD.");
  }
  lines.push(question(d));
  console.log(`[setup] user ${short(user.id)} started setup`);
  await reply(lines);
}

/** "change safe word": anyone who organized or joined a circle picks a new word for it. */
export async function startWordChange(user: User, reply: Reply): Promise<void> {
  const c = await getCircleForUser(user.id);
  if (!c) {
    await reply(["You don't have a family circle yet. Text SET UP FAMILY to start one."]);
    return;
  }
  drafts.set(user.id, { step: "safe_word", expiresAt: Date.now() + TTL_MS, members: [], cur: {}, circleId: c.id });
  await reply(["Okay, a new safe word for your family. Text CANCEL to keep the old one.", ASK_WORD]);
}

/** FAMILY ALERTS ON / OFF: one switch for the whole family, for every circle this person is in. */
async function setAlerts(user: User, on: boolean, reply: Reply): Promise<void> {
  const { rowCount } = await query("UPDATE circle_members SET alerts = $2 WHERE user_id = $1 AND joined", [user.id, on]);
  console.log(`[setup] user ${short(user.id)} family alerts ${on ? "on" : "off"} (${rowCount ?? 0} rows)`);
  if (!rowCount) return reply(["You're not in a family circle yet. Text SET UP FAMILY to start one."]);
  return reply([
    on
      ? "Family alerts are on. If anyone in your family is targeted by a scam, I'll text you here. I never share their messages."
      : "Family alerts are off. I'll still protect everyone in your family.",
  ]);
}

/**
 * iMessage router hook (after YES/NO and Flow 3 emergency texts, before intent routing).
 * Returns true if setup consumed the text: start / change-word / JOIN / alerts commands, and every text
 * while a setup conversation is open (including the safe word, which must never reach Jev or Gemini).
 */
export async function handleSetupText(user: User, msg: InboundMessage): Promise<boolean> {
  const text = msg.text ?? "";
  if (!text.trim() || msg.attachmentIds.length) return false;
  const t = norm(text);
  const reply = replyFor(msg);
  const command = START_RE.test(t) ? "start" : WORD_RE.test(t) ? "word" : JOIN_RE.test(t) ? "join" : ALERTS_RE.test(t) ? "alerts" : null;
  const d = getDraft(user.id);
  if (!command && !d) return false;

  try {
    // The safe word goes in a 1:1 thread, and alerts must never go into a group chat.
    if (msg.spaceKind !== "direct") {
      if (!command) return false;
      await reply(["Let's do family setup in a 1:1 chat with me, not a group. Text me directly."]);
      return true;
    }
    if (command === "start") return await startSetup(user, reply).then(() => true);
    if (command === "word") return await startWordChange(user, reply).then(() => true);
    if (command === "join") return await handleJoin(user, msg, JOIN_RE.exec(t)![1].toUpperCase(), reply).then(() => true);
    if (command === "alerts") {
      const m = ALERTS_RE.exec(t)!;
      const on = (m[1] ?? m[2] ?? m[3]) === "on";
      if (d?.step === "alerts") return await answerAlerts(user, d, on, reply).then(() => true);
      return await setAlerts(user, on, reply).then(() => true);
    }

    if (CANCEL_RE.test(t)) {
      drafts.delete(user.id);
      const line =
        d!.step === "safe_word"
          ? "Okay, I didn't save a new safe word."
          : d!.step === "alerts"
            ? `Okay, family alerts stay off. ${ALERTS_HELP}`
            : "Okay, I stopped family setup. Text SET UP FAMILY any time to start again.";
      await reply([line]);
      return true;
    }
    // A link or a long paste mid-setup is almost surely a message to check, not an answer.
    if (text.length > 120 || /https?:\/\/|www\./i.test(text)) {
      drafts.delete(user.id);
      await reply(["I stopped family setup so I can check that. Text SET UP FAMILY to start again."]);
      return false;
    }
    d!.expiresAt = Date.now() + TTL_MS;
    await step(user, d!, text, reply);
    return true;
  } catch (err: any) {
    // Never err.message here: a failed step could be the safe word step. Consume the text either way,
    // so the word can't fall through to Jev / Gemini.
    console.error(`[setup] user ${short(user.id)} ${d?.step ?? command} failed (${err?.code ?? err?.name ?? "error"})`);
    await reply(["Sorry, something went wrong with family setup. Try again in a minute."]).catch(() => {});
    return true;
  }
}

async function step(user: User, d: Draft, text: string, reply: Reply): Promise<void> {
  const t = norm(text);
  switch (d.step) {
    case "organizer_name": {
      const name = cleanName(text);
      if (!name) return reply(["Just your first name, please."]);
      d.organizerName = name;
      await query("UPDATE users SET name = $2 WHERE id = $1", [user.id, name]);
      d.step = "member_title";
      return reply([`Thanks, ${name}.`, question(d)]);
    }

    case "member_title": {
      if (DONE_RE.test(t)) {
        if (!d.members.length) return reply(["Add at least one person first. What do you call them? Like Mom or Grandma."]);
        return createCircle(user, d, reply);
      }
      const title = cleanTitle(text);
      if (!title) return reply(["Just what you call them, like Mom, Grandma or Uncle Joe. Or text DONE if that's everyone."]);
      const dup = d.members.find((m) => m.title.toLowerCase() === title.toLowerCase());
      if (dup) return reply([`You already added ${dup.title} (${dup.name}). Pick a different name for this person, like Grandma Rosa.`]);
      d.cur = { title };
      d.step = "member_name";
      return reply([question(d)]);
    }

    case "member_name": {
      const name = cleanName(text);
      if (!name) return reply([`Just ${d.cur.title}'s first name, please.`]);
      d.cur.name = name;
      d.step = "member_phone";
      return reply([question(d)]);
    }

    case "member_phone": {
      const phone = toE164(text);
      if (!phone) return reply(["That doesn't look like a phone number. Text it like 214-555-0100."]);
      const own = user.imessage_handle ? normalizeHandle(user.imessage_handle) : null;
      if (phone === own || phone === user.voice_phone) return reply([`That's your number. What's ${d.cur.title}'s own number?`]);
      const dup = d.members.find((m) => m.phone === phone);
      if (dup) return reply([`${dup.title} already has that number. What's ${d.cur.title}'s number?`]);
      d.members.push({ title: d.cur.title!, name: d.cur.name!, phone });
      const added = d.cur.name!.toLowerCase() === d.cur.title!.toLowerCase() ? d.cur.title! : `${d.cur.title} (${d.cur.name})`;
      d.cur = {};
      d.step = "member_title";
      return reply([`Added ${added}.`, question(d)]);
    }

    case "alerts": {
      const on = YES_RE.test(t) ? true : NO_RE.test(t) ? false : null;
      if (on === null) return reply(["Reply YES for instant family scam alerts, or NO to keep them off."]);
      return answerAlerts(user, d, on, reply);
    }

    case "safe_word":
      return saveWord(user, d, text, reply);
  }
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0, I/1
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");

/**
 * SPEC step 2: circle + the organizer (joined at once) + members (not joined yet) + a 6-character join code.
 * One row per person, role 'relative' (Bouncer may call them to check they're safe).
 */
async function createCircle(user: User, d: Draft, reply: Reply): Promise<void> {
  const own = user.imessage_handle ? normalizeHandle(user.imessage_handle) : null;
  const ownPhone = (own && toE164(own)) || user.voice_phone || null;
  const db = await pool.connect();
  let circleId: string, code: string, selfId: string;
  try {
    await db.query("BEGIN");
    // Replace this organizer's old circle (members, safe word and verifications cascade).
    await db.query("DELETE FROM circles WHERE organizer_user_id = $1", [user.id]);
    let row: { id: string } | undefined;
    for (let i = 0; i < 5 && !row; i++) {
      code = newCode();
      row = (
        await db.query(
          "INSERT INTO circles (organizer_user_id, protected_user_id, join_code) VALUES ($1, $1, $2) ON CONFLICT (join_code) DO NOTHING RETURNING id",
          [user.id, code],
        )
      ).rows[0];
    }
    if (!row) throw new Error("no free join code");
    circleId = row.id;
    // The organizer is family too: protected, and callable when someone pretends to be them.
    selfId = (
      await db.query(
        `INSERT INTO circle_members (circle_id, user_id, name, title, phone, imessage_handle, role, joined, space_id)
         VALUES ($1, $2, $3, NULL, $4, $5, 'relative', true, $6) RETURNING id`,
        [circleId, user.id, d.organizerName ?? user.name ?? "Me", ownPhone, own, user.space_id],
      )
    ).rows[0].id;
    for (const m of d.members) {
      await db.query(
        `INSERT INTO circle_members (circle_id, name, title, phone, imessage_handle, role, joined)
         VALUES ($1, $2, $3, $4, $4, 'relative', false)`,
        [circleId, m.name, m.title, m.phone],
      );
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }

  d.step = "alerts";
  d.circleId = circleId;
  d.selfMemberId = selfId;
  console.log(`[setup] user ${short(user.id)} created circle ${short(circleId)} (${d.members.length} members)`);
  return reply([
    `Your family circle is ready. Send each person this: "Text JOIN ${code!} to Bouncer at ${config.photon.imessageHandle}". ` +
      "I'll protect each of them once they reply YES.",
    ASK_ALERTS,
  ]);
}

async function answerAlerts(user: User, d: Draft, on: boolean, reply: Reply): Promise<void> {
  await query("UPDATE circle_members SET alerts = $2 WHERE id = $1", [d.selfMemberId, on]);
  console.log(`[setup] user ${short(user.id)} family alerts ${on ? "on" : "off"} at setup`);
  d.step = "safe_word";
  return reply([
    on ? "Family alerts are on." : "Okay, family alerts are off.",
    `${ALERTS_HELP} Last step: the family safe word. ${ASK_WORD}`,
  ]);
}

/** SPEC step 3. The text is normalised + encrypted immediately and never echoed, logged or kept. */
async function saveWord(user: User, d: Draft, text: string, reply: Reply): Promise<void> {
  const words = normalizeWord(text).split(" ").filter(Boolean);
  if (!words.length) return reply(["I couldn't read a word there. Text just the word or short phrase."]);
  if (words.length > 6 || words.join(" ").length > 60) return reply(["That's long for a safe word. Pick a word or short phrase, up to 6 words."]);
  const ok = await one(
    `SELECT 1 FROM circles c WHERE c.id = $1 AND (c.organizer_user_id = $2 OR c.protected_user_id = $2
       OR EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = c.id AND m.user_id = $2 AND m.joined))`,
    [d.circleId, user.id],
  );
  if (!ok) {
    drafts.delete(user.id);
    return reply(["That family circle doesn't exist anymore, so I didn't save anything. Text SET UP FAMILY to start again."]);
  }
  const enc = encryptWord(text, d.circleId!);
  await query(
    `INSERT INTO safe_words (circle_id, ciphertext, iv, auth_tag) VALUES ($1, $2, $3, $4)
     ON CONFLICT (circle_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, updated_at = now()`,
    [d.circleId, enc.ciphertext, enc.iv, enc.auth_tag],
  );
  drafts.delete(user.id);
  console.log(`[setup] user ${short(user.id)} saved the safe word for circle ${short(d.circleId!)}`);
  const lines = [SAVED];
  if (words.join("").length < 6) lines.push("Tip: a longer word or two-word phrase is harder to guess. Text CHANGE SAFE WORD to pick a new one.");
  return reply(lines);
}

const organizerName = async (organizerId: string | null) =>
  (organizerId ? (await one<{ name: string | null }>("SELECT name FROM users WHERE id = $1", [organizerId]))?.name?.trim() : null) ||
  "Your family";

/** SPEC step 2, member side: `JOIN ABC123` from a listed number → consent text → YES (pending "circle_join"). */
async function handleJoin(user: User, msg: InboundMessage, code: string, reply: Reply): Promise<void> {
  const c = await one<{ id: string; organizer_user_id: string | null }>("SELECT id, organizer_user_id FROM circles WHERE join_code = $1", [code]);
  if (!c) return reply(["I couldn't find that code. Check it and text JOIN and the code again."]);
  const handle = normalizeHandle(msg.senderHandle);
  const { rows } = await query<{ id: string; joined: boolean }>(
    "SELECT id, joined FROM circle_members WHERE circle_id = $1 AND (imessage_handle = $2 OR phone = $2)",
    [c.id, handle],
  );
  console.log(`[setup] user ${short(user.id)} JOIN for circle ${short(c.id)}: ${rows.length ? "listed" : "not listed"}`);
  if (!rows.length) return reply(["This number isn't on that family list. Ask the person who sent you the code to add it."]);
  const org = await organizerName(c.organizer_user_id);
  if (rows.every((r) => r.joined)) return reply([`You're already in ${org}'s family circle. ${ALERTS_HELP}`]);
  setPending(user.id, "circle_join", { circleId: c.id, memberIds: rows.map((r) => r.id), spaceId: msg.spaceId, senderId: msg.agentUserId });
  return reply([
    `${org} added you to their Bouncer family circle. If someone pretends to be family to scam you, I'll help you check. ` +
      "I may also call this number once to check you're safe. I never share your messages. Reply YES to join.",
  ]);
}

registerPendingHandler("circle_join", async (userId, data, answer) => {
  const { circleId, spaceId, senderId } = data as { circleId: string; spaceId: string; senderId: string };
  const memberIds = data.memberIds as string[];
  const say = (lines: string[]) => sendLines({ spaceId, senderId, keyPrefix: `setup:join:${short(userId)}:${Date.now()}` }, lines);
  const c = await one<{ organizer_user_id: string | null }>("SELECT organizer_user_id FROM circles WHERE id = $1", [circleId]);
  const { rows: still } = await query<{ id: string }>("SELECT id FROM circle_members WHERE id = ANY($1) AND circle_id = $2", [memberIds, circleId]);
  if (!c || !still.length) {
    await say(["That family invite isn't valid anymore. Ask for a new code."]);
    return true;
  }
  if (answer === "no") {
    await say(["Okay, you're not in the circle. Text JOIN and the code if you change your mind."]);
    return true;
  }
  const { rows } = await query<{ name: string; title: string | null }>(
    "UPDATE circle_members SET joined = true, user_id = $2, space_id = $3 WHERE id = ANY($1) RETURNING name, title",
    [memberIds, userId, spaceId],
  );
  console.log(`[setup] user ${short(userId)} joined circle ${short(circleId)}`);
  const org = await organizerName(c.organizer_user_id);
  // Second question, same YES/NO slot: the whole-family alert switch for this person.
  setPending(userId, "family_alerts", { memberIds, spaceId, senderId });
  await say([`You're in ${org}'s family circle. I'm protecting you now.`, ASK_ALERTS]);
  if (c.organizer_user_id && c.organizer_user_id !== userId) {
    const who = rows[0]?.title ?? rows[0]?.name ?? "A family member";
    await textUser(c.organizer_user_id, [`${who} joined your family circle.`], `setup:joined:${short(userId)}:${short(circleId)}`).catch((err) =>
      console.error(`[setup] organizer notice failed: ${err?.message}`),
    );
  }
  return true;
});

registerPendingHandler("family_alerts", async (userId, data, answer) => {
  const { spaceId, senderId } = data as { spaceId: string; senderId: string };
  const on = answer === "yes";
  await query("UPDATE circle_members SET alerts = $2 WHERE id = ANY($1) AND user_id = $3", [data.memberIds as string[], on, userId]);
  console.log(`[setup] user ${short(userId)} family alerts ${on ? "on" : "off"} at join`);
  await sendLines({ spaceId, senderId, keyPrefix: `setup:alerts:${short(userId)}:${Date.now()}` }, [
    `${on ? "Family alerts are on." : "Okay, family alerts are off."} ${ALERTS_HELP}`,
  ]);
  return true;
});
