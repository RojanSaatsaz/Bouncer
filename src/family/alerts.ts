// Instant family alerts (Nov 8 rework): when anyone in a family circle gets a Likely-or-worse scam (text,
// screenshot, call or carrier feed), everyone in the circle who turned family alerts on gets one text.
// Type and level only (rule 1): never the message, the sender, the number or an amount.
import { atLeast, type RiskLevel } from "../detection/risk.js";
import { one } from "../db.js";
import { textUser } from "../users.js";
import { getAlertRecipients, getCircleForUser, labelFor, memberPronouns } from "./circle.js";
import { familyEmergencyCovers } from "./emergency.js";

const KIND: Record<string, string> = {
  toll_or_delivery: "a fake toll or delivery",
  bank_or_card: "a fake bank or card",
  crypto: "a crypto",
  government: "a fake government",
  tech_support: "a fake tech support",
  family_emergency: "a fake family emergency",
  job_or_prize: "a fake job or prize",
  marketplace: "a marketplace",
  romance_or_investment: "a romance or investment",
};

const WHAT: Record<"text" | "screenshot" | "call", string> = { text: "text", screenshot: "message", call: "call" };

/** One alert per targeted person and scam type per 30 min (a call can also arrive as a text, a carrier event, …). */
const recent = new Map<string, number>();
const COOLDOWN_MS = 30 * 60_000;
const short = (id: string) => id.slice(0, 8);

/**
 * Fire-and-forget from Flow 1 (verdict sent), Flow 2 (post-call) and Flow 7 (carrier alert sent).
 * Never throws. Returns how many family members were texted.
 */
export async function notifyFamily(e: {
  userId: string;
  level: RiskLevel;
  scamType?: string | null;
  source: "text" | "screenshot" | "call";
}): Promise<number> {
  try {
    if (!atLeast(e.level, "likely_scam")) return 0;
    // The family-emergency steps send their own alert with the verification outcome.
    if (familyEmergencyCovers(e.userId, e.scamType)) return 0;
    const key = `${e.userId}:${e.scamType ?? "scam"}`;
    for (const [k, at] of recent) if (Date.now() - at > COOLDOWN_MS) recent.delete(k);
    if (recent.has(key)) return 0;

    const circle = await getCircleForUser(e.userId);
    if (!circle) return 0;
    const recipients = await getAlertRecipients(circle.id, e.userId);
    if (!recipients.length) return 0;
    recent.set(key, Date.now());

    const target = await one<{ name: string; title: string | null; relationship: string | null }>(
      `SELECT m.name, m.title, m.relationship FROM circle_members m WHERE m.circle_id = $1 AND m.user_id = $2 ORDER BY m.created_at LIMIT 1`,
      [circle.id, e.userId],
    );
    const user = await one<{ name: string | null }>("SELECT name FROM users WHERE id = $1", [e.userId]);
    const fallback = user?.name?.trim() || target?.name || "Someone in your family";
    const kind = e.scamType ? KIND[e.scamType] : undefined;
    const sure = e.level === "high_risk" ? "" : "likely ";
    const what = kind ? `${kind} scam ${WHAT[e.source]}` : `a ${sure}scam ${WHAT[e.source]}`;

    let sent = 0;
    for (const r of recipients) {
      const isOrg = r.user_id === circle.organizer_user_id;
      const who = target ? labelFor(target, isOrg) : fallback;
      const p = isOrg && target ? memberPronouns(target) : memberPronouns(null);
      const lines = [
        `⚠️ Family alert: ${who} just got ${what}. I warned ${p.him} and said what to do. A quick call to check in could help.`,
      ];
      const ok = await textUser(r.user_id!, lines, `family:alert:${short(e.userId)}:${e.scamType ?? "scam"}:${Date.now()}:${short(r.id)}`).catch(
        (err) => {
          console.error(`[family] scam alert to member ${short(r.id)} failed: ${err?.message}`);
          return false;
        },
      );
      if (ok) sent++;
    }
    console.log(`[family] scam alert for user ${short(e.userId)} (${e.level}, ${e.scamType ?? "?"}): ${sent}/${recipients.length} texted`);
    return sent;
  } catch (err: any) {
    console.error(`[family] notifyFamily failed: ${err?.message}`);
    return 0;
  }
}
