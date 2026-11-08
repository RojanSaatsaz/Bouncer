// Circle lookups and the plain-words helpers (names, titles, pronouns) Flow 3 texts and speech share.
// Since Nov 8 everyone in a circle is protected: the organizer and every member who joined. Each person
// opts in to instant scam alerts for the whole family (circle_members.alerts), not per member.
import { one, query } from "../db.js";
import type { EncryptedWord } from "./crypto.js";

export interface Circle {
  id: string;
  /** Legacy: the one protected person. New circles set it to the organizer. */
  protected_user_id: string;
  organizer_user_id: string | null;
}

export interface Member {
  id: string;
  circle_id: string;
  user_id: string | null;
  name: string;
  /** What the organizer calls this person ("Mom", "Grandma"). Null for the organizer's own row. */
  title: string | null;
  /** Legacy free-text relationship (seeded circles). */
  relationship: string | null;
  phone: string | null;
  imessage_handle: string | null;
  role: "guardian" | "relative";
  joined: boolean;
  alerts: boolean;
}

/**
 * The family circle this user is in: one they organized first, else one they joined, else a legacy
 * circle that protects them. Every person in it is protected.
 */
export const getCircleForUser = (userId: string) =>
  one<Circle>(
    `SELECT c.* FROM circles c
      WHERE c.organizer_user_id = $1 OR c.protected_user_id = $1
         OR EXISTS (SELECT 1 FROM circle_members m WHERE m.circle_id = c.id AND m.user_id = $1 AND m.joined)
      ORDER BY (c.organizer_user_id = $1) DESC, c.created_at DESC LIMIT 1`,
    [userId],
  );

export async function getJoinedMembers(circleId: string, role?: Member["role"]): Promise<Member[]> {
  const { rows } = await query<Member>(
    `SELECT * FROM circle_members WHERE circle_id = $1 AND joined ${role ? "AND role = $2" : ""} ORDER BY created_at`,
    role ? [circleId, role] : [circleId],
  );
  return rows;
}

/** People Bouncer may call to check they're safe: joined, callable, and not the person being targeted. */
export async function getCallableFamily(circleId: string, targetUserId: string): Promise<Member[]> {
  const rows = await getJoinedMembers(circleId, "relative");
  return rows.filter((m) => m.user_id !== targetUserId && m.phone);
}

/**
 * People who get the instant family alert when `targetUserId` is targeted: joined, opted in (or a legacy
 * guardian), with a Bouncer account, not the target. One per user.
 */
export async function getAlertRecipients(circleId: string, targetUserId: string): Promise<Member[]> {
  const { rows } = await query<Member>(
    `SELECT * FROM circle_members
      WHERE circle_id = $1 AND joined AND (alerts OR role = 'guardian') AND user_id IS NOT NULL AND user_id <> $2
      ORDER BY created_at`,
    [circleId, targetUserId],
  );
  const seen = new Set<string>();
  return rows.filter((m) => !seen.has(m.user_id!) && seen.add(m.user_id!));
}

export const getMember = (id: string) => one<Member>("SELECT * FROM circle_members WHERE id = $1", [id]);

export const getSafeWordRow = (circleId: string) =>
  one<EncryptedWord>("SELECT ciphertext, iv, auth_tag FROM safe_words WHERE circle_id = $1", [circleId]);

/** What Bouncer calls the protected person in texts to the circle and on the Verify call. */
export async function protectedName(userId: string): Promise<string> {
  const u = await one<{ name: string | null }>("SELECT name FROM users WHERE id = $1", [userId]);
  return u?.name?.trim() || "your family member";
}

/**
 * How to name `m` in a text to `viewerUserId`: the organizer sees their own title ("Mom"), everyone else
 * sees the first name. The title is the organizer's word, so it means nothing (or the wrong thing) to others.
 */
export function labelFor(m: Pick<Member, "name" | "title">, viewerIsOrganizer: boolean): string {
  return viewerIsOrganizer && m.title && !DESCRIBES.test(m.title.trim()) ? m.title : m.name;
}

// Titles that describe rather than address ("Grandson", "Wife"): "Calling Jake now", not "Calling Grandson now".
const DESCRIBES =
  /^(my )?(step ?|grand ?|great ?)*(son|daughter|child|kid|nephew|niece|cousin|brother|sister|husband|wife|spouse|partner|friend|boyfriend|girlfriend|fiance|fiancee|grandchild|grandkid|in ?law|(son|daughter|brother|sister|mother|father)[ -]in[ -]law)s?$/i;

// Words people use for the same title, so "my mother" finds the person saved as "Mom".
const SAME: string[][] = [
  ["mom", "mother", "mama", "mommy", "mum", "madre", "mami"],
  ["dad", "father", "papa", "daddy", "pops", "padre", "papi"],
  ["grandma", "grandmother", "granny", "nana", "nanna", "gran", "abuela", "grams", "grammy", "meemaw"],
  ["grandpa", "grandfather", "granddad", "grandad", "abuelo", "pop pop", "papaw", "gramps"],
  ["bro", "brother"],
  ["sis", "sister"],
];

/** Lowercase words of a text or title, possessives dropped ("Mom's" → "mom"). */
const words = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()} `;

/** The spellings a title can show up as in a message: itself plus its synonyms. */
function titleForms(title: string): string[] {
  const t = words(title).trim();
  return SAME.find((g) => g.includes(t)) ?? [t];
}

/**
 * Code-only match of a message against family members: a first name anywhere, or (for the organizer) a
 * title or its synonym. Returns the single member that matches, else null (none, or more than one).
 */
export function matchByName(content: string, family: Member[], viewerIsOrganizer: boolean): Member | null {
  const text = words(content);
  const hits = family.filter((m) => {
    const forms = [words(m.name).trim()];
    if (viewerIsOrganizer && m.title) forms.push(...titleForms(m.title));
    return forms.some((f) => f.length >= 2 && text.includes(` ${f} `));
  });
  return hits.length === 1 ? hits[0] : null;
}

export interface Pronouns {
  he: string; // he / she / they
  him: string; // him / her / them
  his: string; // his / her / their
  heIs: string; // he's / she's / they're
  needs: string; // needs / need
}

const MALE = /\b(grandson|son|brother|bro|nephew|husband|hubby|dad|daddy|father|papa|uncle|grandpa|grandfather|abuelo|boyfriend|stepson|stepdad)\b/i;
const FEMALE = /\b(granddaughter|daughter|sister|sis|niece|wife|mom|mommy|mama|mother|aunt|auntie|grandma|grandmother|granny|nana|abuela|girlfriend|stepdaughter|stepmom)\b/i;

/** Pronouns from a title or relationship ("Grandma" → she). Unknown (incl. "Bae") → they. */
export function pronouns(relationship: string | null | undefined): Pronouns {
  const r = relationship ?? "";
  if (MALE.test(r)) return { he: "he", him: "him", his: "his", heIs: "he's", needs: "needs" };
  if (FEMALE.test(r)) return { he: "she", him: "her", his: "her", heIs: "she's", needs: "needs" };
  return { he: "they", him: "them", his: "their", heIs: "they're", needs: "need" };
}

/** Pronouns for a member: title first, then the legacy relationship. */
export const memberPronouns = (m: Pick<Member, "title" | "relationship"> | null | undefined) =>
  pronouns(`${m?.title ?? ""} ${m?.relationship ?? ""}`);

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
