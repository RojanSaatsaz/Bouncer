// SPEC Flow 3 Setup steps 1–3 by text: build a family circle one question at a time, JOIN codes with a
// YES to consent, and the safe word (encrypted at once, never echoed, logged or kept in memory).
// The conversation draft lives in memory only (30 min). Logs carry ids and step names, never names,
// numbers or the word. Seeded circles (scripts/seed-family.ts) need none of this and keep working.
import { randomInt } from "node:crypto";
import { config } from "../config.js";
import { one, pool, query } from "../db.js";
import type { InboundMessage } from "../photon/socket.js";
import { sendLines } from "../photon/client.js";
import { registerPendingHandler, setPending } from "../pending.js";
import { getUserByHandle, getUserByVoicePhone, textUser, toE164, type User } from "../users.js";
import { getCircleForProtected, protectedName } from "./circle.js";
import { encryptWord, normalizeWord } from "./crypto.js";
import { normalizeHandle, upsertUser } from "./seed.js";

type Reply = (lines: string[]) => Promise<void>;
type Role = "guardian" | "relative";
type Step =
  | "organizer_name"
  | "protected_name"
  | "protected_phone"
  | "member_name"
  | "member_relationship"
  | "member_phone"
  | "member_role"
  | "safe_word";

interface DraftMember {
  name: string;
  relationship: string;
  phone: string; // E.164
  roles: Role[];
}

interface Draft {
  step: Step;
  expiresAt: number;
  organizerName?: string;
  protectedName?: string;
  /** E.164 / Apple ID of the protected person; null = the organizer is protecting themselves ("me"). */
  protectedHandle?: string | null;
  members: DraftMember[];
  cur: Partial<DraftMember>;
  /** safe_word step: the circle the next text is the word for. */
  circleId?: string;
}

const TTL_MS = 30 * 60_000;
const drafts = new Map<string, Draft>();
const short = (id: string) => id.slice(0, 8);

const SAVED = "Saved and encrypted. I'll never say it on a call. You can delete your message now.";
const ASK_WORD =
  "Pick a word or short phrase you'd never say by accident and tell your family in person. Then text it to me here.";

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
const CANCEL_RE = /^(cancel|stop|quit|exit|never ?mind)( setup)?$/;
const DONE_RE = /^(done|im done|finished|thats all|thats it|thats everyone|no more|no one else|nobody else)$/;
const ME_RE = /^(me|myself|its me|for me|me please)$/;

/** True for texts setup handles even from a brand-new user (so the router doesn't stop at the welcome). */
export function isSetupCommand(text: string | null | undefined): boolean {
  const t = norm(text ?? "");
  return START_RE.test(t) || WORD_RE.test(t) || JOIN_RE.test(t);
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

function cleanRelationship(raw: string): string | null {
  const s = raw.replace(/[^\p{L}' -]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return s && s.length <= 30 && s.split(" ").length <= 4 ? s : null;
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

function parseRole(raw: string): Role[] | null {
  const t = norm(raw);
  if (/\b(both|all|either)\b/.test(t)) return ["guardian", "relative"];
  if (/\b(alerts?|guardian|texts?)\b/.test(t)) return ["guardian"];
  if (/\b(call|calls|relative|check)\b/.test(t)) return ["relative"];
  return null;
}

const pName = (d: Draft) => d.protectedName ?? "them";

function question(d: Draft): string {
  const P = pName(d);
  const name = d.cur.name ?? "they";
  switch (d.step) {
    case "organizer_name":
      return "First, what's your first name?";
    case "protected_name":
      return "Who should I protect? Text their name, like Grandma, or ME if it's you.";
    case "protected_phone":
      return `What's ${P}'s cell number? It should be the phone ${P} texts me from.`;
    case "member_name":
      return d.members.length
        ? "Who's next? Text their name, or DONE if that's everyone."
        : "Now add family. What's the first person's name?";
    case "member_relationship":
      return `How is ${name} related to ${d.protectedHandle === null ? "you" : P}? For example: grandson or daughter.`;
    case "member_phone":
      return `What's ${name}'s cell number?`;
    case "member_role":
      return (
        `What should ${name} do? Reply ALERTS (gets a text if someone targets ${d.protectedHandle === null ? "you" : P}), ` +
        `CALL (I may call ${name} to check they're safe), or BOTH.`
      );
    case "safe_word":
      return ASK_WORD;
  }
}

/** Finds the protected person's user row by handle, or by voice phone for someone who only called. */
async function findUser(handle: string): Promise<User | null> {
  const byHandle = await getUserByHandle(handle);
  if (byHandle) return byHandle;
  const e164 = toE164(handle);
  return e164 ? getUserByVoicePhone(e164) : null;
}

const hasThread = (u: { space_id: string | null; photon_sender_id: string | null } | null) => !!(u?.space_id && u.photon_sender_id);

/** Only the circle's organizer, or the protected person themselves, may replace an existing circle. */
async function mayReplace(protectedUserId: string, organizerId: string): Promise<boolean> {
  if (protectedUserId === organizerId) return true;
  const c = await getCircleForProtected(protectedUserId);
  return !c || c.organizer_user_id === organizerId;
}

function threadWarning(P: string): string {
  return (
    `Heads up: ${P} hasn't texted me yet, so I can't reach them in an emergency. ` +
    `Ask ${P} to text "hi" to me at ${config.photon.imessageHandle} once.`
  );
}

/** SPEC step 1. Also the entry point for the Jev `setup` intent. */
export async function startSetup(user: User, reply: Reply): Promise<void> {
  const organizerName = user.name?.trim() || undefined;
  const d: Draft = { step: organizerName ? "protected_name" : "organizer_name", expiresAt: Date.now() + TTL_MS, organizerName, members: [], cur: {} };
  drafts.set(user.id, d);
  const lines = ["Let's set up your family circle. I'll ask one thing at a time. Text CANCEL to stop."];
  const existing = await one<{ protected_user_id: string }>(
    "SELECT protected_user_id FROM circles WHERE organizer_user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [user.id],
  );
  if (existing) {
    lines.push(
      `You already have a circle for ${await protectedName(existing.protected_user_id)}. Finishing this replaces it. ` +
        "To only change the safe word, text CHANGE SAFE WORD.",
    );
  }
  lines.push(question(d));
  console.log(`[setup] user ${short(user.id)} started setup`);
  await reply(lines);
}

/** "change safe word": the organizer (or the protected person) picks a new word for their circle. */
export async function startWordChange(user: User, reply: Reply): Promise<void> {
  const c = await one<{ id: string; protected_user_id: string }>(
    `SELECT id, protected_user_id FROM circles WHERE organizer_user_id = $1 OR protected_user_id = $1
     ORDER BY (organizer_user_id = $1) DESC, created_at DESC LIMIT 1`,
    [user.id],
  );
  if (!c) {
    await reply(["You don't have a family circle yet. Text SET UP FAMILY to start one."]);
    return;
  }
  drafts.set(user.id, { step: "safe_word", expiresAt: Date.now() + TTL_MS, members: [], cur: {}, circleId: c.id });
  const whose = c.protected_user_id === user.id ? "your" : `${await protectedName(c.protected_user_id)}'s`;
  await reply([`Okay, a new safe word for ${whose} circle. Text CANCEL to keep the old one.`, ASK_WORD]);
}

/**
 * iMessage router hook (after YES/NO and Flow 3 emergency texts, before intent routing).
 * Returns true if setup consumed the text: start / change-word / JOIN commands, and every text while
 * a setup conversation is open (including the safe word, which must never reach Jev or Gemini).
 */
export async function handleSetupText(user: User, msg: InboundMessage): Promise<boolean> {
  const text = msg.text ?? "";
  if (!text.trim() || msg.attachmentIds.length) return false;
  const t = norm(text);
  const reply = replyFor(msg);
  const command = START_RE.test(t) ? "start" : WORD_RE.test(t) ? "word" : JOIN_RE.test(t) ? "join" : null;
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

    if (CANCEL_RE.test(t)) {
      drafts.delete(user.id);
      await reply([
        d!.step === "safe_word" ? "Okay, I didn't save a new safe word." : "Okay, I stopped family setup. Text SET UP FAMILY any time to start again.",
      ]);
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
      d.step = "protected_name";
      return reply([`Thanks, ${name}.`, question(d)]);
    }

    case "protected_name": {
      if (ME_RE.test(t)) {
        d.protectedName = d.organizerName ?? user.name ?? "you";
        d.protectedHandle = null;
        return afterProtected(user, d, reply);
      }
      const name = cleanName(text);
      if (!name) return reply(["Just their name, like Grandma or Rosa."]);
      d.protectedName = name;
      d.step = "protected_phone";
      return reply([question(d)]);
    }

    case "protected_phone": {
      const own = user.imessage_handle ? normalizeHandle(user.imessage_handle) : null;
      let handle: string | null;
      if (ME_RE.test(t)) handle = null;
      else {
        handle = toE164(text) ?? (isEmail(text) ? text.trim().toLowerCase() : null);
        if (!handle) return reply(["That doesn't look like a phone number. Text it like 214-555-0100."]);
        if (handle === own) handle = null;
      }
      d.protectedHandle = handle;
      return afterProtected(user, d, reply);
    }

    case "member_name": {
      if (DONE_RE.test(t)) {
        if (!d.members.length) return reply(["Add at least one person first. What's their name?"]);
        return createCircle(user, d, reply);
      }
      const name = cleanName(text);
      if (!name) return reply(["Just their name, please. Or text DONE if that's everyone."]);
      d.cur = { name };
      d.step = "member_relationship";
      return reply([question(d)]);
    }

    case "member_relationship": {
      const rel = cleanRelationship(text);
      if (!rel) return reply(["A word or two is fine, like grandson, daughter or friend."]);
      d.cur.relationship = rel;
      d.step = "member_phone";
      return reply([question(d)]);
    }

    case "member_phone": {
      const phone = toE164(text);
      if (!phone) return reply(["That doesn't look like a phone number. Text it like 214-555-0100."]);
      const protectedHandle = d.protectedHandle ?? (user.imessage_handle ? normalizeHandle(user.imessage_handle) : null);
      if (phone === protectedHandle) return reply([`That's ${d.protectedHandle === null ? "your" : `${pName(d)}'s`} number. What's ${d.cur.name}'s own number?`]);
      const dup = d.members.find((m) => m.phone === phone);
      if (dup) return reply([`${dup.name} already has that number. What's ${d.cur.name}'s number?`]);
      d.cur.phone = phone;
      d.step = "member_role";
      return reply([question(d)]);
    }

    case "member_role": {
      const roles = parseRole(text);
      if (!roles) return reply([`Reply ALERTS, CALL or BOTH for ${d.cur.name}.`]);
      d.members.push({ name: d.cur.name!, relationship: d.cur.relationship!, phone: d.cur.phone!, roles });
      const added = d.cur.name!;
      d.cur = {};
      d.step = "member_name";
      return reply([`Added ${added}.`, question(d)]);
    }

    case "safe_word":
      return saveWord(user, d, text, reply);
  }
}

/** After the protected person is known: refuse someone else's circle, warn if they've never texted. */
async function afterProtected(user: User, d: Draft, reply: Reply): Promise<void> {
  const P = pName(d);
  const pu = d.protectedHandle === null ? user : await findUser(d.protectedHandle!);
  if (pu && !(await mayReplace(pu.id, user.id))) {
    drafts.delete(user.id);
    return reply([`${P} already has a family circle. Only the person who set it up can change it.`]);
  }
  d.step = "member_name";
  const lines: string[] = [];
  if (d.protectedHandle !== null && !hasThread(pu)) lines.push(threadWarning(P));
  lines.push(question(d));
  return reply(lines);
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0, I/1
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");

/** SPEC step 2: circle + members (not joined yet) + a 6-character join code. */
async function createCircle(user: User, d: Draft, reply: Reply): Promise<void> {
  const own = user.imessage_handle ? normalizeHandle(user.imessage_handle) : null;
  const db = await pool.connect();
  let circleId: string, code: string, protectedUser: { id: string; space_id: string | null; photon_sender_id: string | null };
  let organizerListed = false;
  try {
    await db.query("BEGIN");
    protectedUser = d.protectedHandle === null ? user : await upsertUser(db, d.protectedHandle!, d.protectedName!);
    const other = (
      await db.query("SELECT 1 FROM circles WHERE protected_user_id = $1 AND organizer_user_id IS DISTINCT FROM $2", [protectedUser.id, user.id])
    ).rowCount;
    if (other && protectedUser.id !== user.id) {
      await db.query("ROLLBACK");
      drafts.delete(user.id);
      return reply([`${pName(d)} already has a family circle. Only the person who set it up can change it.`]);
    }
    // Replace this person's old circle (members, safe word and verifications cascade).
    await db.query("DELETE FROM circles WHERE protected_user_id = $1", [protectedUser.id]);
    let row: { id: string } | undefined;
    for (let i = 0; i < 5 && !row; i++) {
      code = newCode();
      row = (
        await db.query(
          "INSERT INTO circles (organizer_user_id, protected_user_id, join_code) VALUES ($1, $2, $3) ON CONFLICT (join_code) DO NOTHING RETURNING id",
          [user.id, protectedUser.id, code],
        )
      ).rows[0];
    }
    if (!row) throw new Error("no free join code");
    circleId = row.id;
    for (const m of d.members) {
      // The organizer listing themselves has already agreed by setting this up: joined right away.
      const self = m.phone === own;
      if (self) organizerListed = true;
      for (const role of m.roles) {
        await db.query(
          `INSERT INTO circle_members (circle_id, user_id, name, relationship, phone, imessage_handle, role, joined, space_id)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8)`,
          [circleId, self ? user.id : null, m.name, m.relationship, m.phone, role, self, self ? user.space_id : null],
        );
      }
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }

  d.step = "safe_word";
  d.circleId = circleId;
  console.log(`[setup] user ${short(user.id)} created circle ${short(circleId)} (${d.members.length} members)`);
  const others = d.members.filter((m) => m.phone !== own).length;
  const lines = [
    others
      ? `Your circle is ready. Send each family member this: "Text JOIN ${code!} to Bouncer at ${config.photon.imessageHandle}". ` +
        "Nobody gets alerts or calls until they reply YES."
      : "Your circle is ready.",
  ];
  if (organizerListed) lines[0] += " You're already in.";
  if (d.protectedHandle !== null && !hasThread(protectedUser!)) lines.push(threadWarning(pName(d)));
  lines.push(`Last step: the family safe word. ${ASK_WORD}`);
  return reply(lines);
}

/** SPEC step 3. The text is normalised + encrypted immediately and never echoed, logged or kept. */
async function saveWord(user: User, d: Draft, text: string, reply: Reply): Promise<void> {
  const words = normalizeWord(text).split(" ").filter(Boolean);
  if (!words.length) return reply(["I couldn't read a word there. Text just the word or short phrase."]);
  if (words.length > 6 || words.join(" ").length > 60) return reply(["That's long for a safe word. Pick a word or short phrase, up to 6 words."]);
  const c = await one<{ organizer_user_id: string | null; protected_user_id: string }>(
    "SELECT organizer_user_id, protected_user_id FROM circles WHERE id = $1",
    [d.circleId],
  );
  if (!c || (c.organizer_user_id !== user.id && c.protected_user_id !== user.id)) {
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

/** SPEC step 2, member side: `JOIN ABC123` from a listed number → consent text → YES (pending "circle_join"). */
async function handleJoin(user: User, msg: InboundMessage, code: string, reply: Reply): Promise<void> {
  const c = await one<{ id: string; protected_user_id: string; organizer_user_id: string | null }>(
    "SELECT id, protected_user_id, organizer_user_id FROM circles WHERE join_code = $1",
    [code],
  );
  if (!c) return reply(["I couldn't find that code. Check it and text JOIN and the code again."]);
  const handle = normalizeHandle(msg.senderHandle);
  const { rows } = await query<{ id: string; joined: boolean }>(
    "SELECT id, joined FROM circle_members WHERE circle_id = $1 AND (imessage_handle = $2 OR phone = $2)",
    [c.id, handle],
  );
  console.log(`[setup] user ${short(user.id)} JOIN for circle ${short(c.id)}: ${rows.length ? "listed" : "not listed"}`);
  if (!rows.length) return reply(["This number isn't on that family list. Ask the person who sent you the code to add it."]);
  const P = await protectedName(c.protected_user_id);
  if (rows.every((r) => r.joined)) return reply([`You're already in ${P}'s circle.`]);
  const org = c.organizer_user_id ? await one<{ name: string | null }>("SELECT name FROM users WHERE id = $1", [c.organizer_user_id]) : null;
  setPending(user.id, "circle_join", { circleId: c.id, memberIds: rows.map((r) => r.id), spaceId: msg.spaceId, senderId: msg.agentUserId });
  return reply([
    `${org?.name?.trim() || "Your family"} added you to ${P}'s Bouncer circle. You'll get the scam type and outcome if someone targets them, ` +
      "never their messages. Relatives may get one verification call from Bouncer. Reply YES to join.",
  ]);
}

registerPendingHandler("circle_join", async (userId, data, answer) => {
  const { circleId, spaceId, senderId } = data as { circleId: string; spaceId: string; senderId: string };
  const memberIds = data.memberIds as string[];
  const say = (lines: string[]) => sendLines({ spaceId, senderId, keyPrefix: `setup:join:${short(userId)}:${Date.now()}` }, lines);
  const c = await one<{ protected_user_id: string; organizer_user_id: string | null }>(
    "SELECT protected_user_id, organizer_user_id FROM circles WHERE id = $1",
    [circleId],
  );
  const { rows: still } = await query<{ id: string }>("SELECT id FROM circle_members WHERE id = ANY($1) AND circle_id = $2", [memberIds, circleId]);
  if (!c || !still.length) {
    await say(["That family invite isn't valid anymore. Ask for a new code."]);
    return true;
  }
  if (answer === "no") {
    await say(["Okay, you're not in the circle. Text JOIN and the code if you change your mind."]);
    return true;
  }
  const { rows } = await query<{ name: string; role: Role }>(
    "UPDATE circle_members SET joined = true, user_id = $2, space_id = $3 WHERE id = ANY($1) RETURNING name, role",
    [memberIds, userId, spaceId],
  );
  console.log(`[setup] user ${short(userId)} joined circle ${short(circleId)} (${rows.map((r) => r.role).join("+")})`);
  const P = await protectedName(c.protected_user_id);
  const roles = new Set(rows.map((r) => r.role));
  const lines = [`You're in ${P}'s circle.`];
  if (roles.has("guardian")) lines.push(`If someone targets ${P}, I'll text you here with the scam type and outcome.`);
  if (roles.has("relative")) lines.push(`If someone pretends to be you to ${P}, I may call this number to check you're safe.`);
  await say([lines.join(" ")]);
  if (c.organizer_user_id && c.organizer_user_id !== userId) {
    await textUser(c.organizer_user_id, [`${rows[0]?.name ?? "A family member"} joined ${P}'s circle.`], `setup:joined:${short(userId)}:${short(circleId)}`).catch(
      (err) => console.error(`[setup] organizer notice failed: ${err?.message}`),
    );
  }
  return true;
});
