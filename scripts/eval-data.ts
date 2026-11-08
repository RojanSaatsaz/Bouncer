// Flow 6 data loading: a small RFC 4180 CSV parser (quoted fields, "" escapes, newlines in quotes)
// and loaders for the two eval datasets. No dependencies.
import fs from "node:fs";
import path from "node:path";

const DATA = path.resolve(process.cwd(), "data");

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // skip BOM
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row);
      (row = []), (field = "");
    } else field += c;
  }
  if (quoted) throw new Error("CSV: unterminated quoted field at end of file");
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => !(r.length === 1 && r[0] === "")); // blank lines
}

/** Parse a CSV file into objects keyed by header, checking every row has the header's width. */
export function readCsv(file: string, required: string[]): Record<string, string>[] {
  const [header, ...body] = parseCsv(fs.readFileSync(path.join(DATA, file), "utf8"));
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`${file}: missing columns ${missing.join(", ")} (header: ${header.join(", ")})`);
  return body.map((r, n) => {
    if (r.length !== header.length) throw new Error(`${file}: data row ${n + 1} has ${r.length} fields, expected ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, r[j]]));
  });
}

export type MLabel = "ham" | "spam" | "smishing";
export interface MendeleyRow {
  id: number;
  label: MLabel;
  split: "train" | "holdout";
  text: string;
}

/** data/mendeley_clean.csv, verified against data/holdout.json before it is returned. */
export function loadMendeley(): MendeleyRow[] {
  const rows = readCsv("mendeley_clean.csv", ["id", "label", "split", "text"]).map((r) => ({
    id: Number(r.id),
    label: r.label as MLabel,
    split: r.split as MendeleyRow["split"],
    text: r.text,
  }));
  for (const r of rows) {
    if (!Number.isInteger(r.id)) throw new Error(`mendeley_clean.csv: bad id ${r.id}`);
    if (!["ham", "spam", "smishing"].includes(r.label)) throw new Error(`mendeley_clean.csv: id ${r.id} bad label ${r.label}`);
    if (!["train", "holdout"].includes(r.split)) throw new Error(`mendeley_clean.csv: id ${r.id} bad split ${r.split}`);
  }
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error("mendeley_clean.csv: duplicate ids");

  const { holdout_ids } = JSON.parse(fs.readFileSync(path.join(DATA, "holdout.json"), "utf8")) as { holdout_ids: number[] };
  const fromJson = new Set(holdout_ids);
  const fromCsv = new Set(rows.filter((r) => r.split === "holdout").map((r) => r.id));
  const onlyJson = [...fromJson].filter((id) => !fromCsv.has(id));
  const onlyCsv = [...fromCsv].filter((id) => !fromJson.has(id));
  if (fromJson.size !== holdout_ids.length || onlyJson.length || onlyCsv.length) {
    throw new Error(
      `holdout.json does not match the split column: ${onlyJson.length} ids only in json, ${onlyCsv.length} only in csv, ` +
        `${holdout_ids.length - fromJson.size} duplicates. Stop: the split must be fixed before tuning.`,
    );
  }
  return rows;
}

export interface ScoutRow {
  id: string; // S1..S18, L1..L12
  index: number; // 1-based file order, used as eval_results.row_index
  expected: string; // scam | legit | spam | scam_or_unsure
  category: string;
  from: string;
  text: string;
}

export function loadScout(): ScoutRow[] {
  return readCsv("scout_test_messages.csv", ["id", "expected", "category", "from", "text"]).map((r, n) => ({
    id: r.id,
    index: n + 1,
    expected: r.expected,
    category: r.category,
    from: r.from,
    text: r.text,
  }));
}

/** Deterministic PRNG (mulberry32) so the tuning sample is the same on every run. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(xs: T[], rand: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
