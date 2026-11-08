// Flow 7 step 2: dataset rows for the simulated carrier feed, plus fictional to/from/ZIP values.
// Sources (train splits only, so the holdout stays untouched):
//   data/mendeley_clean.csv          split = train (ham / spam / smishing)
//   data/scams_archive_en.csv        platform = SMS, split = train (Scam / Benign)
// data/*.csv is git- and docker-ignored, so the server falls back to src/carrier/sample.json
// (written by `npm run replay -- --write-sample`) on Railway.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, rng, shuffled } from "../../scripts/eval-data.js";
import { normLabel, type CarrierEvent } from "./ingest.js";

export interface ReplayRow {
  body: string;
  label: string; // scam | legit | spam
  source: "mendeley" | "archive";
}

const DATA = path.resolve(process.cwd(), "data");
export const SAMPLE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "sample.json");

// The feed is on a projector: skip garbled rows and anything crude from 2012-era personal SMS.
const CRUDE =
  /\b(fuck\w*|shit\w*|sex\w*|nig\w*|bitch\w*|porn\w*|slut\w*|wank\w*|kiss\w*|love\w*|fantas\w*|horny|hot|pussy|dick|cock|naked|nude|boobs?|tits?|bastard|cum|bed|gay|damn|hell|ass|arse|lesbian|dating|babe|luv|xxx)\b/i;
const ok = (t: string) =>
  t.length >= 25 && t.length <= 400 && !t.includes("\uFFFD") && !/&(lt|gt|amp);/.test(t) && !CRUDE.test(t);

function readCsvIfPresent(file: string): Record<string, string>[] {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) return [];
  const [header, ...body] = parseCsv(fs.readFileSync(p, "utf8"));
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, j) => [h, r[j]])));
}

export function loadDatasetRows(which: "mendeley" | "archive" | "both" = "both"): ReplayRow[] {
  const out: ReplayRow[] = [];
  if (which !== "archive") {
    for (const r of readCsvIfPresent("mendeley_clean.csv")) {
      const label = normLabel(r.label);
      if (r.split === "train" && label && ok(r.text)) out.push({ body: r.text.trim(), label, source: "mendeley" });
    }
  }
  if (which !== "mendeley") {
    for (const r of readCsvIfPresent("scams_archive_en.csv")) {
      const label = normLabel(r.label);
      if (r.split === "train" && r.platform === "SMS" && label && ok(r.message_text))
        out.push({ body: r.message_text.trim(), label, source: "archive" });
    }
  }
  return out;
}

export function loadSample(): ReplayRow[] {
  try {
    return JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8")) as ReplayRow[];
  } catch {
    return [];
  }
}

/**
 * A replay mix: about 40% scam, 15% spam, 45% legit, shuffled. Each label is drawn about half from the
 * modern archive SMS and half from Mendeley (spam is Mendeley only). Uses the CSVs, else sample.json.
 */
export function replayMix(n: number, which: "mendeley" | "archive" | "both" = "both", seed = Date.now()): ReplayRow[] {
  let rows = loadDatasetRows(which);
  if (!rows.length) rows = loadSample();
  if (!rows.length) return [];
  const rand = rng(seed);
  const pick = (label: string, k: number) => {
    const a = shuffled(rows.filter((r) => r.label === label && r.source === "archive"), rand);
    const m = shuffled(rows.filter((r) => r.label === label && r.source === "mendeley"), rand);
    const fromA = a.slice(0, Math.max(Math.ceil(k / 2), k - m.length));
    return [...fromA, ...m.slice(0, k - fromA.length)];
  };
  const mix = [...pick("scam", Math.round(n * 0.4)), ...pick("spam", Math.round(n * 0.15)), ...pick("legit", Math.round(n * 0.45))];
  return shuffled(mix, rand).slice(0, n);
}

// ---- fictional event fields ----
export const NORTH_TEXAS_ZIPS = ["75201", "75074", "75061", "76010", "76102", "76201"];
const AREA_CODES = ["214", "469", "972", "817", "682", "940"];

const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pickOne = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** Fictional recipient: 555-0100..555-0199 (reserved for fiction). */
export const fictionalTo = () => `+1${pickOne(AREA_CODES)}5550${randInt(100, 199)}`;
/** Random 10-digit sender, or a 5-digit short code for spam. Only the last 4 digits are ever stored. */
export const randomFrom = (label: string) =>
  label === "spam" ? String(randInt(20000, 99999)) : `+1${pickOne(AREA_CODES)}${randInt(2, 9)}${String(randInt(0, 999999)).padStart(6, "0")}`;

let seq = 0;
export function toEvent(row: ReplayRow, bulk = true): CarrierEvent {
  return {
    event_id: `replay-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: "sms",
    to: fictionalTo(),
    from: randomFrom(row.label),
    body: row.body,
    zip: pickOne(NORTH_TEXAS_ZIPS),
    ts: new Date().toISOString(),
    true_label: row.label,
    bulk,
  };
}

/** Flow 7 demo: one fixed, realistic toll-scam text (modelled on the scout set's S1). */
export const TOLL_SCAM = {
  from: "+14695550147",
  zip: "75201",
  body: "NTTA Notice: Your TollTag account has an unpaid toll balance of $4.35. Pay by 11:59 PM today to avoid a $50 late fee and a registration hold: ntta-tollpay.co/pay",
};

export function tollEvent(to: string): CarrierEvent {
  return {
    event_id: `demo-toll-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: "sms",
    to,
    from: TOLL_SCAM.from,
    body: TOLL_SCAM.body,
    zip: TOLL_SCAM.zip,
    ts: new Date().toISOString(),
    true_label: "scam",
    bulk: false,
  };
}
