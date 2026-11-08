// Flow 6 extension: how the live message pipeline does on data/scams_archive_en.csv (synthetic, 2024-2026 era,
// English). Results and method: docs/EVAL_ARCHIVE.md. Call rows ("Phone Call", "Voice Call (Transcript)") are
// excluded; calls are evaluated separately.
//
//   npm run eval:archive -- sample   # stratified TRAIN sample (~800 rows): explore, sweeps, what-ifs
//   npm run eval:archive -- test     # every non-call TEST row, scored once with the current thresholds
//   npm run eval:archive -- report   # both again, from the cache only (no Jev calls)
//
// Same question set (MESSAGE_QUESTIONS), same level logic (riskLevel / flagsFrom via eval-metrics.score) and the
// same thresholds (config/thresholds.json) as live detection. Nothing here changes thresholds or src/.
// State per row = { body }, with "Subject: ...\n" prepended when the row has a subject (emails).
// Jev answers are cached in data/archive_jev_cache.json (git-ignored), keyed by scam_id + model + question hash.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import pLimit from "p-limit";
import { config } from "../src/config.js";
import { askJev, type JevAnswer } from "../src/detection/jev.js";
import { MESSAGE_FLAGS, MESSAGE_QUESTIONS } from "../src/detection/questions.js";
import { atLeast, flagsFrom, LEVEL_ORDER, thresholds, type RiskLevel, type Thresholds } from "../src/detection/risk.js";
import { readCsv, rng, shuffled } from "./eval-data.js";
import * as M from "./eval-metrics.js";

const SEED = 42;
const CONCURRENCY = 8;
const PER_LABEL = 400; // train sample: 400 scam + 400 benign
const CALL_PLATFORMS = new Set(["Phone Call", "Voice Call (Transcript)"]);
const QHASH = createHash("sha256").update(JSON.stringify(MESSAGE_QUESTIONS)).digest("hex").slice(0, 12);
const CACHE = path.resolve("data", "archive_jev_cache.json");

// ---------------------------------------------------------------- data

interface Row {
  id: string; // scam_id
  label: "scam" | "benign";
  split: string;
  platform: string;
  pattern: string;
  template: string;
  body: string; // what Jev sees
  otp: boolean;
  password: boolean;
  payment: boolean;
  remote: boolean;
  link: boolean;
  phone: boolean;
  impersonationTactic: boolean; // scam_tactics contains "impersonation"
  urgencyTechnique: boolean; // manipulation_techniques contains "urgency"
}

function loadArchive(): Row[] {
  const raw = readCsv("scams_archive_en.csv", ["scam_id", "scam_pattern", "platform", "message_text", "subject", "label", "split"]);
  const b = (v: string) => v === "True";
  const rows = raw
    .filter((r) => !CALL_PLATFORMS.has(r.platform))
    .map((r): Row => {
      if (r.label !== "Scam" && r.label !== "Benign") throw new Error(`${r.scam_id}: bad label ${r.label}`);
      const subject = r.subject.trim();
      return {
        id: r.scam_id,
        label: r.label === "Scam" ? "scam" : "benign",
        split: r.split,
        platform: r.platform,
        pattern: r.scam_pattern,
        template: r.generation_template_id,
        body: subject ? `Subject: ${subject}\n${r.message_text}` : r.message_text,
        otp: b(r.requests_otp),
        password: b(r.requests_password),
        payment: b(r.requests_payment),
        remote: b(r.requests_remote_access),
        link: b(r.contains_link),
        phone: b(r.contains_phone_number),
        impersonationTactic: r.scam_tactics.split(";").includes("impersonation"),
        urgencyTechnique: r.manipulation_techniques.split(";").includes("urgency"),
      };
    });
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error("duplicate scam_id");
  return rows;
}

/**
 * Stratified train sample: PER_LABEL rows per label, split evenly across scam_pattern, and within each pattern
 * round-robin across platforms (preferring templates not yet used in that pattern, to limit near-duplicates).
 */
function trainSample(all: Row[]) {
  const train = all.filter((r) => r.split === "train");
  const rand = rng(SEED);
  const sample: Row[] = [];
  const weights: Record<string, number> = {};
  for (const label of ["scam", "benign"] as const) {
    const L = train.filter((r) => r.label === label).sort((a, b) => a.id.localeCompare(b.id));
    const patterns = [...new Set(L.map((r) => r.pattern))].sort();
    patterns.forEach((p, i) => {
      const quota = Math.floor(PER_LABEL / patterns.length) + (i < PER_LABEL % patterns.length ? 1 : 0);
      const byPlat = new Map<string, Row[]>();
      for (const r of shuffled(L.filter((r) => r.pattern === p), rand)) {
        if (!byPlat.has(r.platform)) byPlat.set(r.platform, []);
        byPlat.get(r.platform)!.push(r);
      }
      const plats = shuffled([...byPlat.keys()].sort(), rand);
      const used = new Set<string>();
      let picked = 0;
      while (picked < quota && plats.some((pl) => byPlat.get(pl)!.length)) {
        for (const pl of plats) {
          if (picked >= quota) break;
          const g = byPlat.get(pl)!;
          if (!g.length) continue;
          const k = Math.max(0, g.findIndex((r) => !used.has(r.template)));
          const [r] = g.splice(k, 1);
          used.add(r.template);
          sample.push(r);
          picked++;
        }
      }
    });
    weights[label] = L.length / sample.filter((r) => r.label === label).length; // restores the train mix for precision
  }
  return { sample, weights, train };
}

// ---------------------------------------------------------------- Jev with a disk cache

interface Entry {
  model: string;
  q: string;
  answers: Record<string, JevAnswer>;
}
let calls = 0;

function loadCache(): Record<string, Entry> {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch {
    return {};
  }
}
function saveCache(c: Record<string, Entry>) {
  fs.writeFileSync(CACHE + ".tmp", JSON.stringify(c));
  fs.renameSync(CACHE + ".tmp", CACHE);
}

async function answersFor(name: string, rows: Row[], model: string, allowCalls: boolean) {
  const cache = loadCache();
  const key = (id: string) => `${id}|${model}`;
  const out = new Map<string, Entry>();
  const todo: Row[] = [];
  for (const r of rows) {
    const e = cache[key(r.id)];
    if (e && e.q === QHASH) out.set(r.id, e);
    else todo.push(r);
  }
  console.error(`[jev] ${name}: ${rows.length} rows, ${out.size} cached, ${todo.length} ${allowCalls ? "to ask" : "missing (not asking)"}`);
  if (!todo.length || !allowCalls) return { out, missing: todo.length };
  const limit = pLimit(CONCURRENCY);
  let done = 0;
  let failed = 0;
  let unsaved = 0;
  const t0 = Date.now();
  await Promise.all(
    todo.map((r) =>
      limit(async () => {
        try {
          calls++;
          const res = await askJev({ body: r.body }, MESSAGE_QUESTIONS);
          cache[key(r.id)] = { model: res.model, q: QHASH, answers: res.answers };
          out.set(r.id, cache[key(r.id)]);
          if (++unsaved >= 50) saveCache(cache), (unsaved = 0);
        } catch (err: any) {
          failed++;
          console.error(`[jev] ${r.id} failed: ${String(err?.message ?? err).split(":")[0]}`);
        }
        if (++done % 100 === 0 || done === todo.length)
          console.error(`[jev] ${name}: ${done}/${todo.length} asked, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }),
    ),
  );
  saveCache(cache);
  return { out, missing: failed };
}

function pinnedModel(): string {
  const m = config.typesafe.model;
  if (!/^jev-\d+(\.\d+)+$/.test(m)) {
    console.error("JEV_MODEL is an alias, not a versioned model. Pin one (e.g. jev-1.14.0).");
    process.exit(1);
  }
  if (thresholds.jev_model !== m) {
    console.error(`config/thresholds.json was tuned with ${thresholds.jev_model}, not ${m}.`);
    process.exit(1);
  }
  return m;
}

// ---------------------------------------------------------------- scoring and what-ifs

type S = M.Scored & { row: Row };
const NON_IMP = MESSAGE_FLAGS.filter((f) => f !== "impersonation");
const lp = (l: RiskLevel) => atLeast(l, "likely_scam");
const up = (l: RiskLevel) => atLeast(l, "unsure");
const pct = M.pct;
const count = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const excerpt = (r: Row, n = 90) => {
  const t = r.body.replace(/\s+/g, " ").replace(/\|/g, "/");
  return `"${t.length > n ? t.slice(0, n) + "…" : t}"`;
};

/** HANDOFF item 6: Likely or above needs a red flag other than impersonation, unless severe; else cap at Unsure. */
function ruleNeedsFlag(s: M.Scored, t: Thresholds): RiskLevel {
  if (!lp(s.level) || s.severe) return s.level;
  return flagsFrom(s.probs, NON_IMP, t).length ? s.level : "unsure";
}

function scoreAll(rows: Row[], out: Map<string, Entry>, t: Thresholds = thresholds): S[] {
  return rows.map((r) => ({ ...M.score(r.id, r.label, out.get(r.id)!.answers, t), row: r }));
}

interface Head {
  scams: number;
  benign: number;
  caught: number;
  caughtUnsure: number;
  scamHigh: number;
  scamSafe: number;
  fa: number;
  faHigh: number;
  benignUnsure: number;
  prec: number;
  precW: number;
  auc: number;
}

function head(xs: { label: string; level: RiskLevel; p: number }[], w: Record<string, number> = {}): Head {
  const sc = xs.filter((x) => x.label === "scam");
  const be = xs.filter((x) => x.label === "benign");
  const caught = count(sc, (x) => lp(x.level));
  const fa = count(be, (x) => lp(x.level));
  const ws = w.scam ?? 1;
  const wb = w.benign ?? 1;
  return {
    scams: sc.length,
    benign: be.length,
    caught,
    caughtUnsure: count(sc, (x) => up(x.level)),
    scamHigh: count(sc, (x) => x.level === "high_risk"),
    scamSafe: count(sc, (x) => x.level === "safe"),
    fa,
    faHigh: count(be, (x) => x.level === "high_risk"),
    benignUnsure: count(be, (x) => x.level === "unsure"),
    prec: caught / (caught + fa),
    precW: (ws * caught) / (ws * caught + wb * fa),
    auc: M.auc(sc.map((x) => x.p), be.map((x) => x.p)),
  };
}

function headTable(cols: [string, Head][], weighted: boolean) {
  const f = (n: number, d: number) => `${n} / ${d} (${pct(n, d)})`;
  const rows: [string, (h: Head) => string][] = [
    ["Scams caught (Likely+)", (h) => f(h.caught, h.scams)],
    ["Scams at Unsure+", (h) => f(h.caughtUnsure, h.scams)],
    ["Scams at High risk", (h) => f(h.scamHigh, h.scams)],
    ["Scams rated Looks safe", (h) => f(h.scamSafe, h.scams)],
    ["Benign flagged (Likely+) = false alarms", (h) => f(h.fa, h.benign)],
    ["Benign at High risk", (h) => f(h.faHigh, h.benign)],
    ["Benign at Unsure", (h) => f(h.benignUnsure, h.benign)],
    [weighted ? "Flags right (precision at Likely+), reweighted to train mix" : "Flags right (precision at Likely+)", (h) => pct(weighted ? h.precW : h.prec, 1)],
    ["AUC of is_scam (scam vs benign)", (h) => h.auc.toFixed(4)],
  ];
  return M.md(["metric", ...cols.map((c) => c[0])], rows.map(([name, fn]) => [name, ...cols.map((c) => fn(c[1]))]));
}

function levelTable(xs: S[]) {
  return M.md(
    ["label", ...LEVEL_ORDER, "total"],
    ["scam", "benign"].map((l) => {
      const g = xs.filter((x) => x.label === l);
      return [l, ...LEVEL_ORDER.map((lv) => `${count(g, (x) => x.level === lv)} (${pct(count(g, (x) => x.level === lv), g.length)})`), g.length];
    }),
  );
}

function platformTable(xs: S[]) {
  const plats = [...new Set(xs.map((x) => x.row.platform))].sort();
  return M.md(
    ["platform", "scams", "caught (Likely+)", "Unsure+", "benign", "benign at Likely+", "benign at Unsure"],
    plats.map((p) => {
      const sc = xs.filter((x) => x.row.platform === p && x.label === "scam");
      const be = xs.filter((x) => x.row.platform === p && x.label === "benign");
      return [
        p,
        sc.length,
        sc.length ? `${count(sc, (x) => lp(x.level))} (${pct(count(sc, (x) => lp(x.level)), sc.length)})` : "-",
        sc.length ? `${count(sc, (x) => up(x.level))} (${pct(count(sc, (x) => up(x.level)), sc.length)})` : "-",
        be.length,
        be.length ? `${count(be, (x) => lp(x.level))} (${pct(count(be, (x) => lp(x.level)), be.length)})` : "-",
        be.length ? `${count(be, (x) => x.level === "unsure")}` : "-",
      ];
    }),
  );
}

function patternTable(xs: S[], label: "scam" | "benign") {
  const g = xs.filter((x) => x.label === label);
  const pats = [...new Set(g.map((x) => x.row.pattern))];
  const body = pats
    .map((p) => {
      const ps = g.filter((x) => x.row.pattern === p);
      const types = new Map<string, number>();
      for (const x of ps) types.set(x.scamType ?? "none", (types.get(x.scamType ?? "none") ?? 0) + 1);
      const top = [...types.entries()].sort((a, b) => b[1] - a[1])[0];
      const flagRate = (f: string) => count(ps, (x) => x.flags.includes(f));
      const topFlags = MESSAGE_FLAGS.map((f) => [f, flagRate(f)] as const)
        .filter(([, n]) => n / ps.length >= 0.5)
        .map(([f]) => f)
        .join(", ");
      return {
        p,
        n: ps.length,
        lpN: count(ps, (x) => lp(x.level)),
        upN: count(ps, (x) => up(x.level)),
        highN: count(ps, (x) => x.level === "high_risk"),
        med: median(ps.map((x) => x.p)),
        top: `${top[0]} (${top[1]})`,
        topFlags: topFlags || "-",
      };
    })
    .sort((a, b) => (label === "scam" ? a.lpN / a.n - b.lpN / b.n : b.lpN / b.n - a.lpN / a.n) || a.p.localeCompare(b.p));
  return M.md(
    ["scam_pattern", "rows", "Likely+", "Unsure+", "High", "median is_scam", "Jev scam_type (top)", "flags on >= 50% of rows"],
    body.map((b) => [b.p, b.n, `${b.lpN} (${pct(b.lpN, b.n)})`, `${b.upN} (${pct(b.upN, b.n)})`, b.highN, M.fmtP(b.med), b.top, b.topFlags]),
  );
}

/** Jev red flags vs the dataset's own annotation columns. Flags use the live thresholds (flag / callback_flag). */
function flagAccuracy(xs: S[]) {
  const maps: [string, string, (r: Row) => boolean][] = [
    ["asks_code", "requests_otp", (r) => r.otp],
    ["asks_code", "requests_otp or requests_password", (r) => r.otp || r.password],
    ["money_or_code", "requests_payment or requests_otp", (r) => r.payment || r.otp],
    ["callback", "contains_link or contains_phone_number", (r) => r.link || r.phone],
    ["link_mismatch", "contains_link or contains_phone_number", (r) => r.link || r.phone],
    ["impersonation", "scam_tactics has impersonation", (r) => r.impersonationTactic],
    ["urgency_secrecy", "manipulation_techniques has urgency", (r) => r.urgencyTechnique],
  ];
  const sc = xs.filter((x) => x.label === "scam");
  const be = xs.filter((x) => x.label === "benign");
  return M.md(
    ["Jev flag", "dataset column", "column true (scams)", "recall: flag fires when column true", "flag fires when column false (scams)", "precision (scams)", "flag fires on benign"],
    maps.map(([f, col, fn]) => {
      const pos = sc.filter((x) => fn(x.row));
      const neg = sc.filter((x) => !fn(x.row));
      const fired = (x: S) => x.flags.includes(f);
      const tp = count(pos, fired);
      const fp = count(neg, fired);
      return [f, col, pos.length, `${tp} (${pct(tp, pos.length)})`, `${fp} / ${neg.length} (${pct(fp, neg.length)})`, pct(tp, tp + fp), `${count(be, fired)} / ${be.length} (${pct(count(be, fired), be.length)})`];
    }),
  );
}

function remoteAccess(xs: S[]) {
  const ra = xs.filter((x) => x.label === "scam" && x.row.remote);
  if (!ra.length) return "_No requests_remote_access rows._";
  const fl = MESSAGE_FLAGS.map((f) => `${f} ${pct(count(ra, (x) => x.flags.includes(f)), ra.length)}`).join(", ");
  return (
    `- Rows with requests_remote_access = True: ${ra.length} (patterns: ${[...new Set(ra.map((x) => x.row.pattern))].join(", ")})\n` +
    `- Caught (Likely+): ${count(ra, (x) => lp(x.level))} (${pct(count(ra, (x) => lp(x.level)), ra.length)}); Unsure+: ${count(ra, (x) => up(x.level))}\n` +
    `- Red flags shown on them: ${fl}\n` +
    `- There is no remote-access question in MESSAGE_QUESTIONS (FLAG_LABELS has a remote_access label, but nothing sets it).`
  );
}

function severeLines(xs: S[], t: Thresholds) {
  const be = xs.filter((x) => x.label === "benign");
  const sc = xs.filter((x) => x.label === "scam");
  const ac = (x: S) => (x.probs.asks_code ?? 0) >= t.asks_code_severe;
  const onlySevere = (x: S) => x.severe && x.p < t.likely;
  return [
    `- Benign with severe = true: ${count(be, (x) => x.severe)} (asks_code >= ${t.asks_code_severe}: ${count(be, ac)})`,
    `- Scams lifted to High only by the severe rule (is_scam < likely): ${count(sc, onlySevere)}`,
  ].join("\n");
}

function whatIf(xs: S[], t: Thresholds, w: Record<string, number>) {
  const ruled = xs.map((x) => ({ ...x, level: ruleNeedsFlag(x, t) }));
  const before = head(xs, w);
  const after = head(ruled, w);
  const lost = ruled.filter((x, i) => x.label === "scam" && lp(xs[i].level) && !lp(x.level));
  const fixed = ruled.filter((x, i) => x.label === "benign" && lp(xs[i].level) && !lp(x.level));
  const byPat = (g: S[]) => {
    const m = new Map<string, number>();
    for (const x of g) m.set(x.row.pattern, (m.get(x.row.pattern) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(", ") || "none";
  };
  return (
    `${headTable([["current", before], ["with the rule", after]], Object.keys(w).length > 0)}\n\n` +
    `- Scams moved from Likely+ down to Unsure: ${lost.length} (${byPat(lost)})\n` +
    `- Benign false alarms removed: ${fixed.length} (${byPat(fixed)})`
  );
}

/** Likely threshold sweep on this set: current logic and the what-if rule. Sample only (never tune on test). */
function sweep(xs: S[], t: Thresholds) {
  const grid = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.62, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
  const sc = xs.filter((x) => x.label === "scam");
  const be = xs.filter((x) => x.label === "benign");
  return M.md(
    ["likely", "scams Likely+", "benign Likely+", "scams Likely+ (rule)", "benign Likely+ (rule)"],
    grid.map((g) => {
      const tt = { ...t, likely: g, high: Math.max(g, t.high) };
      const lv = (x: S) => M.score(x.id, x.label, { ...fakeAnswers(x.probs) }, tt);
      const L = (x: S) => lp(lv(x).level);
      const R = (x: S) => lp(ruleNeedsFlag(lv(x), tt));
      return [
        `${g}${g === t.likely ? " (current)" : ""}`,
        `${count(sc, L)} (${pct(count(sc, L), sc.length)})`,
        `${count(be, L)} (${pct(count(be, L), be.length)})`,
        `${count(sc, R)} (${pct(count(sc, R), sc.length)})`,
        `${count(be, R)} (${pct(count(be, R), be.length)})`,
      ];
    }),
  );
}
const fakeAnswers = (probs: Record<string, number>): Record<string, JevAnswer> =>
  Object.fromEntries(Object.entries(probs).map(([k, v]) => [k, { type: "noul", noul: v } as JevAnswer]));

/** Which noul signals separate missed scams from benign rows (helps choose a better level rule). */
function signalTable(xs: S[], t: Thresholds) {
  const missed = xs.filter((x) => x.label === "scam" && !lp(x.level));
  const caught = xs.filter((x) => x.label === "scam" && lp(x.level));
  const be = xs.filter((x) => x.label === "benign");
  const fl = (x: S, f: string) => (x.probs[f] ?? 0) >= (f === "callback" ? t.callback_flag : t.flag);
  return M.md(
    ["flag (live bar)", "missed scams", "caught scams", "benign"],
    [...MESSAGE_FLAGS, "is_scam>=unsure"].map((f) => {
      const fn = f === "is_scam>=unsure" ? (x: S) => x.p >= t.unsure : (x: S) => fl(x, f);
      return [f, `${count(missed, fn)} / ${missed.length} (${pct(count(missed, fn), missed.length)})`, pct(count(caught, fn), caught.length), `${count(be, fn)} / ${be.length} (${pct(count(be, fn), be.length)})`];
    }),
  );
}

function worst(xs: S[], n = 15) {
  const misses = xs.filter((x) => x.label === "scam" && !lp(x.level)).sort((a, b) => a.p - b.p).slice(0, n);
  const fas = xs.filter((x) => x.label === "benign" && lp(x.level)).sort((a, b) => b.p - a.p).slice(0, n);
  const row = (x: S) => [x.id, x.row.pattern, x.row.platform, x.level, M.fmtP(x.p), x.flags.join(", ") || "-", x.scamType ?? "-", excerpt(x.row)];
  const head = ["scam_id", "pattern", "platform", "level", "is_scam", "flags", "Jev scam_type", "excerpt"];
  return `**Missed scams (below Likely), lowest is_scam first:**\n\n${misses.length ? M.md(head, misses.map(row)) : "_none_"}\n\n` + `**Benign false alarms (Likely+), highest is_scam first:**\n\n${fas.length ? M.md(head, fas.map(row)) : "_none_"}`;
}

function section(title: string, xs: S[], t: Thresholds, w: Record<string, number>, opts: { sweep: boolean }) {
  const weighted = Object.keys(w).length > 0;
  console.log(`## ${title}\n`);
  console.log(`${headTable([[title.split(" (")[0], head(xs, w)]], weighted)}\n`);
  console.log(`### Levels\n\n${levelTable(xs)}\n`);
  console.log(`### Per platform\n\n${platformTable(xs)}\n`);
  console.log(`### Per scam_pattern (scams), worst first\n\n${patternTable(xs, "scam")}\n`);
  console.log(`### Benign kinds (false alarms), worst first\n\n${patternTable(xs, "benign")}\n`);
  console.log(`### Red flags vs dataset columns (scams; flag = live bar, callback ${t.callback_flag}, others ${t.flag})\n\n${flagAccuracy(xs)}\n`);
  console.log(`### Remote access\n\n${remoteAccess(xs)}\n`);
  console.log(`### Severe rule\n\n${severeLines(xs, t)}\n`);
  console.log(`### What-if: Likely+ needs a red flag other than impersonation, unless severe (HANDOFF item 6)\n\n${whatIf(xs, t, w)}\n`);
  console.log(`### Signals on missed scams vs benign\n\n${signalTable(xs, t)}\n`);
  if (opts.sweep) console.log(`### Likely-threshold sweep (high = max(likely, ${t.high}))\n\n${sweep(xs, t)}\n`);
  console.log(`### Worst cases\n\n${worst(xs)}\n`);
}

// ---------------------------------------------------------------- commands

async function runSample(allowCalls: boolean, model: string) {
  const { sample, weights, train } = trainSample(loadArchive());
  const { out, missing } = await answersFor("train sample", sample, model, allowCalls);
  if (missing) return console.log(`_Train sample: ${missing} rows missing from the cache; skipped._\n`);
  const xs = scoreAll(sample, out);
  const mix = (["scam", "benign"] as const).map((l) => `${l} ${sample.filter((r) => r.label === l).length} of ${train.filter((r) => r.label === l).length} train (weight ${weights[l].toFixed(2)})`);
  console.log(`_Sample: ${sample.length} train rows, seed ${SEED}: ${mix.join("; ")}. ${new Set(sample.map((r) => r.template)).size} distinct templates._\n`);
  section(`Train sample (${sample.length} rows)`, xs, thresholds, weights, { sweep: true });
}

async function runTest(allowCalls: boolean, model: string) {
  const rows = loadArchive().filter((r) => r.split === "test");
  const { out, missing } = await answersFor("test", rows, model, allowCalls);
  if (missing) return console.log(`_Test: ${missing} rows missing from the cache; skipped._\n`);
  section(`Test split (${rows.length} rows, scored once)`, scoreAll(rows, out), thresholds, {}, { sweep: false });
}

const cmd = process.argv.slice(2).find((a) => !a.startsWith("--"));
try {
  const model = pinnedModel();
  const t = thresholds;
  const header = `# Archive eval (${model}, questions ${QHASH}; unsure ${t.unsure} / likely ${t.likely} / high ${t.high}; flag ${t.flag}, callback ${t.callback_flag})\n`;
  if (cmd === "sample") console.log(header), await runSample(true, model);
  else if (cmd === "test") console.log(header), await runTest(true, model);
  else if (cmd === "report") console.log(header), await runSample(false, model), await runTest(false, model);
  else {
    console.error("Usage: npm run eval:archive -- <sample|test|report>");
    process.exitCode = 1;
  }
  console.error(`[jev] calls made this run: ${calls}`);
} catch (err: any) {
  console.error(`[eval-archive] ${err?.message ?? err}`);
  process.exitCode = 1;
}
