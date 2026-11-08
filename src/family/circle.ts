// Circle lookups and the plain-words helpers (names, pronouns) Flow 3 texts and speech share.
import { one, query } from "../db.js";
import type { EncryptedWord } from "./crypto.js";

export interface Circle {
  id: string;
  protected_user_id: string;
  organizer_user_id: string | null;
}

export interface Member {
  id: string;
  circle_id: string;
  user_id: string | null;
  name: string;
  relationship: string | null;
  phone: string | null;
  imessage_handle: string | null;
  role: "guardian" | "relative";
  joined: boolean;
}

/** The newest circle where this user is the protected person. */
export const getCircleForProtected = (userId: string) =>
  one<Circle>("SELECT * FROM circles WHERE protected_user_id = $1 ORDER BY created_at DESC LIMIT 1", [userId]);

export async function getJoinedMembers(circleId: string, role?: Member["role"]): Promise<Member[]> {
  const { rows } = await query<Member>(
    `SELECT * FROM circle_members WHERE circle_id = $1 AND joined ${role ? "AND role = $2" : ""} ORDER BY created_at`,
    role ? [circleId, role] : [circleId],
  );
  return rows;
}

export const getMember = (id: string) => one<Member>("SELECT * FROM circle_members WHERE id = $1", [id]);

export const getSafeWordRow = (circleId: string) =>
  one<EncryptedWord>("SELECT ciphertext, iv, auth_tag FROM safe_words WHERE circle_id = $1", [circleId]);

/** What Bouncer calls the protected person in texts to the circle and on the Verify call. */
export async function protectedName(userId: string): Promise<string> {
  const u = await one<{ name: string | null }>("SELECT name FROM users WHERE id = $1", [userId]);
  return u?.name?.trim() || "your family member";
}

export interface Pronouns {
  he: string; // he / she / they
  him: string; // him / her / them
  his: string; // his / her / their
  heIs: string; // he's / she's / they're
  needs: string; // needs / need
}

const MALE = /\b(grandson|son|brother|nephew|husband|dad|father|uncle|grandpa|grandfather|boyfriend|stepson)\b/i;
const FEMALE = /\b(granddaughter|daughter|sister|niece|wife|mom|mother|aunt|grandma|grandmother|girlfriend|stepdaughter)\b/i;

/** Pronouns from the relationship ("grandson" → he). Unknown → they. */
export function pronouns(relationship: string | null | undefined): Pronouns {
  const r = relationship ?? "";
  if (MALE.test(r)) return { he: "he", him: "him", his: "his", heIs: "he's", needs: "needs" };
  if (FEMALE.test(r)) return { he: "she", him: "her", his: "her", heIs: "she's", needs: "needs" };
  return { he: "they", him: "them", his: "their", heIs: "they're", needs: "need" };
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
