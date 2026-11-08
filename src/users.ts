// Users table helpers shared by every flow, plus "text this user" for alerts.
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { query, one } from "./db.js";
import { sendLines } from "./photon/client.js";

export interface User {
  id: string;
  imessage_handle: string | null;
  voice_phone: string | null;
  name: string | null;
  zip: string | null;
  space_id: string | null;
  photon_sender_id: string | null;
  opted_in: boolean;
  listen_pending_at: Date | null;
  created_at: Date;
}

/** E.164 for US-default numbers, or null if it isn't a phone number (e.g. an Apple ID email). */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const p = parsePhoneNumberFromString(raw.trim(), "US");
  return p?.isValid() ? p.number : null;
}

export const getUserById = (id: string) => one<User>("SELECT * FROM users WHERE id = $1", [id]);
export const getUserByHandle = (handle: string) =>
  one<User>("SELECT * FROM users WHERE imessage_handle = $1", [handle]);
export const getUserByVoicePhone = (e164: string) => one<User>("SELECT * FROM users WHERE voice_phone = $1", [e164]);

/** Creates the user on first contact. voice_phone defaults to the handle when the handle is a phone number. */
export async function getOrCreateUser(handle: string): Promise<{ user: User; created: boolean }> {
  const existing = await getUserByHandle(handle);
  if (existing) return { user: existing, created: false };
  const row = await one<User>(
    `INSERT INTO users (imessage_handle, voice_phone) VALUES ($1, $2)
     ON CONFLICT (imessage_handle) DO UPDATE SET imessage_handle = EXCLUDED.imessage_handle
     RETURNING *`,
    [handle, toE164(handle)],
  );
  return { user: row!, created: true };
}

/** Remembers where to text this user later (alerts can't start a new conversation on the shared line). */
export async function saveConversation(userId: string, spaceId: string, photonSenderId: string) {
  await query("UPDATE users SET space_id = $2, photon_sender_id = $3 WHERE id = $1", [userId, spaceId, photonSenderId]);
}

export async function setOptedIn(userId: string, optedIn: boolean) {
  await query("UPDATE users SET opted_in = $2 WHERE id = $1", [userId, optedIn]);
}

export async function markListenPending(userId: string) {
  await query("UPDATE users SET listen_pending_at = now() WHERE id = $1", [userId]);
}

/** The user who texted "listen" in the last 2 minutes (Flow 2 step 3 fallback). */
export const getListenPendingUser = () =>
  one<User>(
    "SELECT * FROM users WHERE listen_pending_at > now() - interval '2 minutes' ORDER BY listen_pending_at DESC LIMIT 1",
  );

/**
 * Texts a user in their existing Bouncer thread. Returns false (and sends nothing) when we have
 * no thread for them yet: the shared line cannot send the first message.
 */
export async function textUser(userId: string, lines: string[], keyPrefix: string): Promise<boolean> {
  const u = await getUserById(userId);
  if (!u?.space_id || !u.photon_sender_id) {
    console.warn(`[users] can't text user ${userId.slice(0, 8)}: no saved iMessage thread yet`);
    return false;
  }
  await sendLines({ spaceId: u.space_id, senderId: u.photon_sender_id, keyPrefix }, lines);
  return true;
}
