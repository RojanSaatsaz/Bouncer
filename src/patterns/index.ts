// SPEC Flow 5: REPORT → anonymised template → count by ZIP3 → spike → one local alert → feeds Flow 1.
// Privacy (rule 1): the reported text lives only in memory until Gemini has templated it. report_templates
// and report_counts never hold a user id, a handle or the original text, and report logs carry no user id.
import { config } from "../config.js";
import { query, one } from "../db.js";
import { textUser, type User } from "../users.js";
import { generate } from "../detection/gemini.js";
import { SCAM_TYPES } from "../detection/questions.js";
import { atLeast, type Risk, type RiskLevel } from "../detection/risk.js";
import type { JevQuestion } from "../detection/jev.js";
import { rememberBody, takeBody } from "./memory.js";
import { makeTemplate, embed, cosine, jaccard, SHORTENERS, type Template } from "./template.js";

export { rememberBody } from "./memory.js";

/** Reports in one ZIP3 within 48 h that make a template spike (SPEC says 5; 3 for the demo). */
export const SPIKE_THRESHOLD = config.spikeThreshold;
// SPEC says 0.88. Measured on gemini-embedding-2 templates (2026-11-08): variants of one scam 0.93–0.94,
// different scams of the same scam_type 0.72–0.76. 0.86 tolerates a variant whose brand Gemini dropped.
const COSINE_MATCH = 0.86;
const JACCARD_MATCH = 0.6;
const UNKNOWN_ZIP3 = "unk";

const NOTHING = "Forward or screenshot the scam message and I'll add it.";
const SORRY = "Sorry, I couldn't add that right now. Reply REPORT again in a minute.";

const zip3Of = (zip: string | null | undefined) => {
  const d = (zip ?? "").replace(/\D/g, "");
  return d.length >= 3 ? d.slice(0, 3) : null;
};

// ---------- Flow 1 hooks ----------

/** Flow 1 step 7: ask only when active_patterns is non-empty. Spread into the Jev question set. */
export const MATCHES_PATTERN_QUESTION: Record<string, JevQuestion> = {
  matches_pattern: { type: "noul", instructions: "The message matches one of the templates in active_patterns." },
};

/** Plain-words red flag for replies, if the lead wants to show it. */
export const PATTERN_FLAG_LABEL = "matches a scam people near you are reporting";

export const PATTERN_FLOOR = 0.8;

/** Flow 1 step 8: matches_pattern ≥ 0.8 → the level is at least Likely scam. */
export function applyPatternFloor(level: RiskLevel, pMatch: number): RiskLevel {
  return pMatch >= PATTERN_FLOOR && !atLeast(level, "likely_scam") ? "likely_scam" : level;
}

/**
 * Same floor on a whole Risk. When the floor lifts the level, the shown confidence becomes Jev's
 * matches_pattern probability (so it never reads "Likely scam (30% sure)").
 */
export function applyPatternFloorToRisk(risk: Risk, pMatch: number): Risk {
  const level = applyPatternFloor(risk.level, pMatch);
  if (level === risk.level) return risk;
  return { ...risk, level, confidence: Math.round(Math.max(risk.p, pMatch) * 100) };
}

/** Templates spiking in this user's ZIP3 (max 5), for Flow 1's Jev state `active_patterns`. Never throws. */
export async function activePatternsFor(user: Pick<User, "zip">): Promise<string[]> {
  const zip3 = zip3Of(user.zip);
  if (!zip3) return [];
  try {
    const { rows } = await query<{ template: string }>(
      `SELECT t.template FROM report_templates t
         JOIN pattern_spikes s ON s.template_id = t.id
        WHERE s.zip3 = $1 AND s.spiked_at > now() - interval '7 days'
        ORDER BY s.spiked_at DESC LIMIT 5`,
      [zip3],
    );
    return rows.map((r) => r.template);
  } catch (err: any) {
    console.error(`[patterns] active patterns lookup failed: ${err?.message}`);
    return [];
  }
}

// ---------- ZIP keyword ----------

const ZIP_RE = /^\s*zip(?:\s*code)?\s*[:#-]?\s*(\d{5})(?:-\d{4})?\s*[.!]?\s*$/i;
const ZIP_TRY_RE = /^\s*zip(?:\s*code)?\s*[:#-]?\s*(\d[\d\s-]*)?\s*[.!?]?\s*$/i;

/** "ZIP 75080" → saves users.zip and returns the reply text. Null when the text isn't a ZIP command. */
export async function setZipFromText(user: Pick<User, "id" | "opted_in">, text: string): Promise<string | null> {
  const m = ZIP_RE.exec(text);
  if (!m) return ZIP_TRY_RE.test(text) ? "Send ZIP and your 5-digit ZIP code, like: ZIP 75080" : null;
  await query("UPDATE users SET zip = $2 WHERE id = $1", [user.id, m[1]]);
  return (
    `Got it, ZIP ${m[1]}. Your reports now count for your area, and I'll warn you when a scam is spiking near you.` +
    (user.opted_in ? "" : " Reply YES to turn on alerts.")
  );
}

// ---------- REPORT ----------

const REPORT_PREFIX_RE = /^\s*(?:i\s+(?:want|would\s+like|wanna)\s+to\s+)?report(?:ing)?(?:\s+(?:this|it|a\s+scam|scam))?\s*[:\-–—]?\s*/i;

/** A pasted scam rather than "I want to report a scam": has a link, phone number, amount or code, or is long. */
function pastedScam(text: string): string | null {
  const t = text.replace(REPORT_PREFIX_RE, "").trim();
  if (t.length < 20) return null;
  const hasDetail =
    /https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\/|\b[a-z0-9-]+\.(?:com|net|org|top|xyz|info|site|online|io|co|us|me|vip|live|shop|click|link)\b/i.test(t) ||
    /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/.test(t) ||
    /[$€£]\s?\d/.test(t) ||
    /\b\d{4,}\b/.test(t);
  return hasDetail || t.length >= 100 ? t : null;
}

/**
 * Flow 5 steps 1–7. REPORT keyword or a text Jev routed as `report`.
 * `explicitText`: the user's text, used when it looks like a pasted scam (else the remembered body is used).
 * `scamType`: Jev's scam_type for `explicitText` from Flow 1's scan, if the caller has it.
 */
export async function handleReport(
  user: User,
  reply: (lines: string[]) => Promise<void>,
  explicitText?: string,
  scamType?: string | null,
): Promise<void> {
  let body: string | null = explicitText ? pastedScam(explicitText) : null;
  let jevType: string | null = body ? (scamType ?? null) : null;
  if (!body) {
    const remembered = takeBody(user.id);
    body = remembered?.body ?? null;
    jevType = remembered?.scamType ?? null;
  }
  if (!body) {
    await reply([NOTHING]);
    return;
  }

  let t: Template;
  try {
    t = await makeTemplate(body, jevType);
  } catch (err: any) {
    console.error(`[patterns] templating failed: ${err?.message}`);
    if (!explicitText || !pastedScam(explicitText)) rememberBody(user.id, body, jevType); // allow a retry
    await reply([SORRY]);
    return;
  }
  body = null; // the original text is dropped here (step 3)

  const zip3 = zip3Of(user.zip) ?? UNKNOWN_ZIP3;
  let templateId: string, isNew: boolean, why: string, near: number, spiked: boolean;
  try {
    ({ templateId, isNew, why } = await matchOrCreate(t));
    await query(
      `INSERT INTO report_counts (template_id, zip3, day, count) VALUES ($1, $2, current_date, 1)
       ON CONFLICT (template_id, zip3, day) DO UPDATE SET count = report_counts.count + 1`,
      [templateId, zip3],
    );
    near = await countSince(templateId, zip3, 6); // last 7 days, for the reply
    const recent = await countSince(templateId, zip3, 1); // today + yesterday ≈ 48 h, for the spike rule
    spiked = zip3 !== UNKNOWN_ZIP3 && recent >= SPIKE_THRESHOLD && (await claimSpike(templateId, zip3));
    console.log(
      `[patterns] report → template ${templateId.slice(0, 8)} (${isNew ? "new" : "matched"}${why ? ` ${why}` : ""}) zip3=${zip3} 48h=${recent}${spiked ? " SPIKE" : ""}`,
    );
  } catch (err: any) {
    console.error(`[patterns] saving report failed: ${err?.message}`);
    await reply([SORRY]);
    return;
  }

  const lines = [
    zip3 === UNKNOWN_ZIP3
      ? "Thanks. I added it (anonymously). Text ZIP and your ZIP code (like ZIP 75080) so reports count for your area."
      : `Thanks. I added it (anonymously). ${near === 1 ? "You're the first near you to report this one." : `${near} people near you reported this one.`}`,
  ];
  if (spiked) lines.push("It's spiking near you, so I'm warning other Bouncer users in your area.");
  await reply(lines);

  if (spiked) {
    await expireSpikes().catch(() => {});
    await sendLocalAlerts(templateId, zip3, t, user.id).catch((err) =>
      console.error(`[patterns] local alerts failed: ${err?.message}`),
    );
  }
}

/** Step 5: same scam_type, seen in the last 7 days, and (cosine ≥ 0.88 or same link domain or word overlap ≥ 0.6). */
async function matchOrCreate(t: Template): Promise<{ templateId: string; isNew: boolean; why: string }> {
  const vec = await embed(t.template);
  const { rows } = await query<{ id: string; template: string; link_domain: string | null; embedding: number[] | null }>(
    `SELECT id, template, link_domain, embedding FROM report_templates
      WHERE scam_type = $1 AND last_seen > now() - interval '7 days'
      ORDER BY last_seen DESC LIMIT 200`,
    [t.scamType],
  );
  let best: { id: string; score: number; why: string } | null = null;
  for (const r of rows) {
    const cos = vec && r.embedding ? cosine(vec, r.embedding) : null;
    const jac = jaccard(t.template, r.template);
    const sameDomain = !!t.linkDomain && t.linkDomain === r.link_domain && !SHORTENERS.has(t.linkDomain);
    if (!((cos ?? 0) >= COSINE_MATCH || sameDomain || jac >= JACCARD_MATCH)) continue;
    const score = Math.max(cos ?? 0, jac, sameDomain ? 0.95 : 0);
    if (!best || score > best.score) {
      const why = [cos !== null ? `cos=${cos.toFixed(2)}` : "", `jac=${jac.toFixed(2)}`, sameDomain ? "domain" : ""];
      best = { id: r.id, score, why: why.filter(Boolean).join(" ") };
    }
  }
  if (best) {
    await query(
      `UPDATE report_templates
          SET last_seen = now(), brand = COALESCE(brand, $2), link_domain = COALESCE(link_domain, $3),
              embedding = COALESCE(embedding, $4::real[])
        WHERE id = $1`,
      [best.id, t.brand, t.linkDomain, vec],
    );
    return { templateId: best.id, isNew: false, why: best.why };
  }
  const row = await one<{ id: string }>(
    `INSERT INTO report_templates (template, brand, scam_type, link_domain, embedding)
     VALUES ($1, $2, $3, $4, $5::real[]) RETURNING id`,
    [t.template, t.brand, t.scamType, t.linkDomain, vec],
  );
  return { templateId: row!.id, isNew: true, why: vec ? "" : "no embedding" };
}

async function countSince(templateId: string, zip3: string, daysBack: number): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT COALESCE(sum(count), 0) AS n FROM report_counts
      WHERE template_id = $1 AND zip3 = $2 AND day >= current_date - $3::int`,
    [templateId, zip3, daysBack],
  );
  return Number(row?.n ?? 0);
}

/** True once per template per ZIP3 (re-armed after 7 days). Also marks the template as spiking (step 6). */
async function claimSpike(templateId: string, zip3: string): Promise<boolean> {
  const row = await one(
    `INSERT INTO pattern_spikes (template_id, zip3) VALUES ($1, $2)
     ON CONFLICT (template_id, zip3) DO UPDATE SET spiked_at = now(), alerts_sent = 0
       WHERE pattern_spikes.spiked_at < now() - interval '7 days'
     RETURNING template_id`,
    [templateId, zip3],
  );
  if (!row) return false;
  await query("UPDATE report_templates SET status = 'spiking' WHERE id = $1", [templateId]);
  return true;
}

/** Templates whose every spike is older than 7 days go back to 'active' (the dashboard reads status). */
export async function expireSpikes(): Promise<void> {
  await query(
    `UPDATE report_templates t SET status = 'active'
      WHERE status = 'spiking'
        AND NOT EXISTS (SELECT 1 FROM pattern_spikes s WHERE s.template_id = t.id AND s.spiked_at > now() - interval '7 days')`,
  );
}

// ---------- local alert (step 7) ----------

function areaName(zip3: string): string {
  const n = Number(zip3);
  if ((n >= 750 && n <= 754) || (n >= 760 && n <= 764)) return "North Texas";
  if (n >= 770 && n <= 775) return "the Houston area";
  if (n >= 786 && n <= 787) return "the Austin area";
  if (n >= 780 && n <= 782) return "the San Antonio area";
  return "your area";
}

const ALERT_SYSTEM =
  "You are Bouncer, T-Mobile's scam helper. Write ONE line under 200 characters, plain words, sixth-grade " +
  "reading level, warning people that a scam text is spiking near them. Start with \"Heads up:\". Say what the " +
  "scam looks like and give one safe tip. No links, phone numbers, names or placeholders in braces. Never call " +
  "anything 100% safe. Example: \"Heads up: fake toll texts are spiking in North Texas. Real toll agencies don't " +
  "text you a payment link.\"";

/** Gemini words the alert (wording only, rule 3); a fixed line if Gemini is slow or down. */
async function writeLocalAlert(t: Template, area: string): Promise<string> {
  const kind = SCAM_TYPES[t.scamType] ?? "scam";
  const fallback = `Heads up: fake ${t.brand ? `${t.brand} ` : ""}texts are spiking in ${area}. Don't tap links in texts; use the official app or website instead.`;
  try {
    const text = await generate({
      tier: "fast",
      system: ALERT_SYSTEM,
      parts: [{ text: `Area: ${area}\nScam kind: ${kind}\nClaims to be from: ${t.brand ?? "unknown"}\nTemplate: ${t.template}` }],
      temperature: 0.4,
      maxOutputTokens: 120,
      timeoutMs: 5_000,
    });
    const line = text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean)
      ?.replace(/^["']|["']$/g, "");
    if (!line || /[{}]|https?:|www\.|\d{3}[\s.-]?\d{4}|100%\s*safe/i.test(line) || line.length > 280) return fallback;
    return line;
  } catch (err: any) {
    console.warn(`[patterns] alert wording failed (${err?.message}); using the fixed line`);
    return fallback;
  }
}

/** Once per template per ZIP3; each opted-in user with a thread gets at most one local alert per 24 h. */
async function sendLocalAlerts(templateId: string, zip3: string, t: Template, reporterId: string): Promise<number> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users
      WHERE opted_in AND space_id IS NOT NULL AND photon_sender_id IS NOT NULL
        AND left(zip, 3) = $1 AND id <> $2
        AND (last_local_alert_at IS NULL OR last_local_alert_at < now() - interval '24 hours')`,
    [zip3, reporterId],
  );
  if (!rows.length) {
    console.log(`[patterns] spike ${templateId.slice(0, 8)} zip3=${zip3}: nobody to alert`);
    return 0;
  }
  const line = await writeLocalAlert(t, areaName(zip3));
  let sent = 0;
  for (const { id } of rows) {
    // Claim the daily slot first, so two spikes at once can't both alert the same person.
    const claimed = await one(
      `UPDATE users SET last_local_alert_at = now()
        WHERE id = $1 AND (last_local_alert_at IS NULL OR last_local_alert_at < now() - interval '24 hours')
        RETURNING id`,
      [id],
    );
    if (!claimed) continue;
    try {
      if (await textUser(id, [line], `bouncer:local:${templateId}:${zip3}:${id}`)) sent++;
      else await query("UPDATE users SET last_local_alert_at = NULL WHERE id = $1", [id]);
    } catch (err: any) {
      console.error(`[patterns] local alert send failed: ${err?.message}`);
      await query("UPDATE users SET last_local_alert_at = NULL WHERE id = $1", [id]).catch(() => {});
    }
  }
  await query("UPDATE pattern_spikes SET alerts_sent = alerts_sent + $3 WHERE template_id = $1 AND zip3 = $2", [templateId, zip3, sent]);
  console.log(`[patterns] spike ${templateId.slice(0, 8)} zip3=${zip3}: ${sent} local alert(s) sent`);
  return sent;
}
