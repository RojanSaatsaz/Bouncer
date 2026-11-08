// Creates (or replaces) a family circle without the JOIN-code flow (tonight's trimmed Flow 3).
// Used by scripts/seed-family.ts and scripts/test-family.ts. Never logs or returns the safe word.
import type pg from "pg";
import { pool } from "../db.js";
import { toE164 } from "../users.js";
import { encryptWord, normalizeWord } from "./crypto.js";

export interface SeedMember {
  name: string;
  /** What the protected person (the organizer of a seeded circle) calls them: "Grandson", "Mom". */
  title?: string;
  /** Legacy: used as the title when no title is given. */
  relationship?: string;
  /** Number Bouncer calls for verification. */
  phone?: string;
  /** iMessage handle Bouncer texts alerts to. Defaults to the phone. */
  handle?: string;
  /** Family alerts on for this person. Defaults to true for the legacy role "guardian". */
  alerts?: boolean;
  /** Legacy: "guardian" = alerts on; "relative" = alerts off. Everyone with a phone can be called. */
  role?: "guardian" | "relative";
}

export interface SeedInput {
  protected: { name: string; handle: string };
  members: SeedMember[];
}

export interface SeedSummary {
  circleId: string;
  protectedUserId: string;
  people: Array<{
    name: string;
    role: "protected" | "alerts" | "family";
    memberId: string | null;
    userId: string | null;
    hasThread: boolean;
    phoneLast4: string | null;
  }>;
  warnings: string[];
}

const wantsAlerts = (m: SeedMember) => m.alerts ?? m.role === "guardian";
const capWord = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Phone handles → E.164 so they match what Photon sends; Apple ID emails are kept as typed. */
export const normalizeHandle = (h: string) => toE164(h) ?? h.trim();
const last4 = (s: string | null | undefined) => (s ? s.replace(/\D/g, "").slice(-4) || null : null);

/** Finds (by handle, then by voice phone) or creates a user and sets their name. Also used by setup.ts. */
export async function upsertUser(db: pg.PoolClient, handle: string, name: string) {
  const e164 = toE164(handle);
  let u = (await db.query("SELECT * FROM users WHERE imessage_handle = $1", [handle])).rows[0];
  if (!u && e164) {
    // Someone who only ever called Bouncer has a voice_phone but no handle yet: attach the handle.
    const v = (await db.query("SELECT * FROM users WHERE voice_phone = $1", [e164])).rows[0];
    if (v && !v.imessage_handle) {
      u = (await db.query("UPDATE users SET imessage_handle = $2 WHERE id = $1 RETURNING *", [v.id, handle])).rows[0];
    }
  }
  const phoneTaken =
    e164 && (await db.query("SELECT 1 FROM users WHERE voice_phone = $1 AND imessage_handle IS DISTINCT FROM $2", [e164, handle])).rowCount;
  const voicePhone = e164 && !phoneTaken ? e164 : null;
  if (!u) {
    u = (
      await db.query("INSERT INTO users (imessage_handle, voice_phone, name) VALUES ($1, $2, $3) RETURNING *", [handle, voicePhone, name])
    ).rows[0];
  } else {
    u = (
      await db.query("UPDATE users SET name = $2, voice_phone = COALESCE(voice_phone, $3) WHERE id = $1 RETURNING *", [u.id, name, voicePhone])
    ).rows[0];
  }
  return u as { id: string; space_id: string | null; photon_sender_id: string | null };
}

export async function seedCircle(input: SeedInput, safeWord: string): Promise<SeedSummary> {
  const warnings: string[] = [];
  if (!input.protected?.name?.trim() || !input.protected?.handle?.trim()) throw new Error("The protected person needs a name and an iMessage handle.");
  if (!normalizeWord(safeWord)) throw new Error("The safe word is empty.");
  for (const m of input.members) {
    if (!m.name?.trim()) throw new Error("Every member needs a name.");
    if (m.role && m.role !== "guardian" && m.role !== "relative") throw new Error(`Member ${m.name}: role must be guardian or relative.`);
    if (!m.handle && !m.phone) throw new Error(`${m.name} needs a phone number or iMessage handle.`);
  }
  if (!input.members.some((m) => m.phone)) warnings.push("Nobody in the circle has a phone: Bouncer will coach but can't make a verification call.");
  if (!input.members.some(wantsAlerts)) warnings.push("Nobody has family alerts on: nobody will get the circle alert.");
  if (normalizeWord(safeWord).replace(/ /g, "").length < 4) warnings.push("The safe word is very short; a longer word or short phrase is harder to guess.");

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const protectedHandle = normalizeHandle(input.protected.handle);
    const pu = await upsertUser(db, protectedHandle, input.protected.name.trim());

    // Replace any existing circle for this person (members, safe word and verifications cascade).
    await db.query("DELETE FROM circles WHERE protected_user_id = $1 OR organizer_user_id = $1", [pu.id]);

    const people: SeedSummary["people"] = [
      { name: input.protected.name.trim(), role: "protected", memberId: null, userId: pu.id, hasThread: !!(pu.space_id && pu.photon_sender_id), phoneLast4: last4(protectedHandle) },
    ];
    const memberUsers: Array<{ m: SeedMember; handle: string | null; user: Awaited<ReturnType<typeof upsertUser>> | null }> = [];
    for (const m of input.members) {
      const raw = m.handle ?? m.phone ?? null;
      const handle = raw ? normalizeHandle(raw) : null;
      memberUsers.push({ m, handle, user: handle ? await upsertUser(db, handle, m.name.trim()) : null });
    }
    // The protected person organizes a seeded circle, so titles are theirs ("Grandson", "Mom"). Everyone
    // in it is protected, the protected person included (a member row, so others' emergencies can call them).
    const circle = (
      await db.query("INSERT INTO circles (organizer_user_id, protected_user_id) VALUES ($1, $1) RETURNING id", [pu.id])
    ).rows[0] as { id: string };
    const selfPhone = toE164(protectedHandle);
    people[0].memberId = (
      await db.query(
        `INSERT INTO circle_members (circle_id, user_id, name, phone, imessage_handle, role, joined, space_id)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`,
        [circle.id, pu.id, input.protected.name.trim(), selfPhone, protectedHandle, "relative", pu.space_id],
      )
    ).rows[0].id;

    for (const { m, handle, user } of memberUsers) {
      const phone = m.phone ? normalizeHandle(m.phone) : null;
      const title = m.title?.trim() || (m.relationship?.trim() ? capWord(m.relationship.trim()) : null);
      const row = (
        await db.query(
          `INSERT INTO circle_members (circle_id, user_id, name, title, relationship, phone, imessage_handle, role, joined, space_id, alerts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10) RETURNING id`,
          [
            circle.id,
            user?.id ?? null,
            m.name.trim(),
            title,
            m.relationship?.trim() || null,
            phone,
            handle,
            "relative", // new model: one row per person; anyone with a phone can be called
            user?.space_id ?? null,
            wantsAlerts(m),
          ],
        )
      ).rows[0] as { id: string };
      people.push({
        name: m.name.trim(),
        role: wantsAlerts(m) ? "alerts" : "family",
        memberId: row.id,
        userId: user?.id ?? null,
        hasThread: !!(user?.space_id && user?.photon_sender_id),
        phoneLast4: last4(phone ?? handle),
      });
    }

    const enc = encryptWord(safeWord, circle.id);
    await db.query(
      `INSERT INTO safe_words (circle_id, ciphertext, iv, auth_tag) VALUES ($1, $2, $3, $4)
       ON CONFLICT (circle_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, updated_at = now()`,
      [circle.id, enc.ciphertext, enc.iv, enc.auth_tag],
    );
    await db.query("COMMIT");

    for (const p of people) {
      if (!p.hasThread && p.role !== "family") {
        warnings.push(`${p.name} (${p.role}) hasn't texted Bouncer yet. The shared line can't text first, so ask them to text "hi" to Bouncer once before the demo.`);
      }
    }
    return { circleId: circle.id, protectedUserId: pu.id, people, warnings };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
