// Flow 6: accuracy test (docs/EVAL.md has the method and results).
//
//   JEV_MODEL=jev-1.14.0 npm run eval -- tune      # ~600 train rows -> config/thresholds.json
//   JEV_MODEL=jev-1.14.0 npm run eval -- holdout   # all 1,160 holdout rows, once -> eval_results
//   JEV_MODEL=jev-1.14.0 npm run eval -- scout     # the 30 hand-written US messages -> eval_results
//   npm run eval -- report                         # every number again, from the cache only (no Jev calls)
//   add --run=N to write a new eval_results run id (default 1)
//
// Every Jev answer is cached in data/eval_cache_<dataset>.json (git-ignored; public dataset rows,
// keyed by row id + model) so reruns never pay for the same row twice. Logs show counts, never text.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import pLimit from "p-limit";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { askJev, type JevAnswer } from "../src/detection/jev.js";
import { MESSAGE_QUESTIONS } from "../src/detection/questions.js";
import { atLeast, LEVEL_LABEL, reloadThresholds, thresholds, THRESHOLDS_PATH, type Thresholds } from "../src/detection/risk.js";
import { loadMendeley, loadScout, rng, shuffled, type MendeleyRow, type ScoutRow } from "./eval-data.js";
import * as M from "./eval-metrics.js";

type Dataset = "mendeley" | "test30";
interface Entry {
  model: string; // model Jev says answered
  q: string; // hash of MESSAGE_QUESTIONS: a wording change invalidates the cache
  answers: Record<string, JevAnswer>;
}

const SEED = 42;
const CONCURRENCY = 8;
/** Tuning sample per label (train only). Smishing is oversampled; see docs/EVAL.md "Sample". */
const SAMPLE: Record<string, number> = { ham: 420, smishing: 150, spam: 30 };
/** Flow 1 step 8 values, kept here only to compare against the tuned ones. */
const SPEC_DEFAULTS = { unsure: 0.35, likely: 0.6, high: 0.85 };
const PAIRS: [string, string][] = [["S4", "L2"], ["S6", "L1"], ["S6", "L9"], ["S10", "L11"], ["S1", "L7"]];

const QHASH = createHash("sha256").update(JSON.stringify(MESSAGE_QUESTIONS)).digest("hex").slice(0, 12);
const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
const runArg = Number(process.argv.find((a) => a.startsWith("--run="))?.split("=")[1] ?? 1);
const runId = (kind: string) => `${today}-${kind}-${runArg}`;

// ---------------------------------------------------------------- Jev with a disk cache

const cacheFile = (d: Dataset) => path.resolve("data", `eval_cache_${d}.json`);

function loadCache(d: Dataset): Record<string, Entry> {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(d), "utf8"));
  } catch {
    return {};
  }
}

function saveCache(d: Dataset, cache: Record<string, Entry>) {
  const tmp = cacheFile(d) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, cacheFile(d));
}

/** Cached answers for every item; asks Jev (8 at a time) for the rest when allowed. */
async function answersFor(d: Dataset, items: { id: number | string; state: unknown }[], model: string, allowCalls: boolean) {
  const cache = loadCache(d);
  const key = (id: number | string) => `${id}|${model}`;
  const out = new Map<number | string, Entry>();
  const todo: typeof items = [];
  for (const it of items) {
    const e = cache[key(it.id)];
    if (e && e.q === QHASH) out.set(it.id, e);
    else todo.push(it);
  }
  console.error(`[jev] ${d}: ${items.length} rows, ${out.size} cached, ${todo.length} ${allowCalls ? "to ask" : "missing (not asking)"}`);
  if (!todo.length || !allowCalls) return { out, missing: todo.length };

  const limit = pLimit(CONCURRENCY);
  let done = 0;
  let failed = 0;
  let unsaved = 0;
  const t0 = Date.now();
  await Promise.all(
    todo.map((it) =>
      limit(async () => {
        try {
          const r = await askJev(it.state, MESSAGE_QUESTIONS);
          const e: Entry = { model: r.model, q: QHASH, answers: r.answers };
          cache[key(it.id)] = e;
          out.set(it.id, e);
          if (++unsaved >= 50) saveCache(d, cache), (unsaved = 0);
        } catch (err: any) {
          failed++;
          console.error(`[jev] row ${it.id} failed: ${String(err?.message ?? err).split(":")[0]}`); // status only
        }
        if (++done % 100 === 0 || done === todo.length)
          console.error(`[jev] ${d}: ${done}/${todo.length} asked, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }),
    ),
  );
  saveCache(d, cache);
  return { out, missing: failed };
}

/** The eval must measure a pinned model, the same string production will run. */
function pinnedModel(): string {
  const m = config.typesafe.model;
  if (!/^jev-\d+(\.\d+)+$/.test(m)) {
    console.error("JEV_MODEL is an alias, not a versioned model. Pin one for the eval, e.g.\n  JEV_MODEL=jev-1.14.0 npm run eval -- tune");
    process.exit(1);
  }
  return m;
}

function oneModel(entries: Entry[], requested: string): string {
  const models = [...new Set(entries.map((e) => e.model))];
  if (models.length !== 1 || models[0] !== requested)
    console.error(`[eval] WARNING: asked for ${requested}, Jev answered with ${models.join(", ")}`);
  return models.join(",");
}

// ---------------------------------------------------------------- eval_results

interface DbRow {
  rowIndex: number;
  split: string | null;
  label: string;
  s: M.Scored;
  model: string;
}

async function saveRows(run: string, dataset: Dataset, rows: DbRow[]) {
  const COLS = 10;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const params: unknown[] = [];
    const values = chunk.map((r, j) => {
      params.push(run, dataset, r.rowIndex, r.split, r.label, r.s.p, r.s.level, r.s.flags, r.s.scamType, r.model);
      return `(${Array.from({ length: COLS }, (_, k) => `$${j * COLS + k + 1}`).join(", ")})`;
    });
    await pool.query(
      `INSERT INTO eval_results (run_id, dataset, row_index, split, label, p_scam, level, flags, scam_type, jev_model)
       VALUES ${values.join(", ")}
       ON CONFLICT (run_id, dataset, row_index) DO UPDATE SET split = EXCLUDED.split, label = EXCLUDED.label,
         p_scam = EXCLUDED.p_scam, level = EXCLUDED.level, flags = EXCLUDED.flags, scam_type = EXCLUDED.scam_type,
         jev_model = EXCLUDED.jev_model, created_at = now()`,
      params,
    );
  }
  console.error(`[db] eval_results: ${rows.length} rows saved as ${run} (${dataset})`);
}

// ---------------------------------------------------------------- tune (Flow 6 step 4)

function tuneSample(rows: MendeleyRow[]) {
  const holdout = new Set(rows.filter((r) => r.split === "holdout").map((r) => r.id));
  const train = rows.filter((r) => r.split === "train");
  const rand = rng(SEED);
  const sample: MendeleyRow[] = [];
  const weights: M.Weights = {};
  for (const [label, n] of Object.entries(SAMPLE)) {
    const group = train.filter((r) => r.label === label).sort((a, b) => a.id - b.id);
    sample.push(...shuffled(group, rand).slice(0, n));
    weights[label] = group.length / n; // inverse sampling rate: restores the real train mix for precision
  }
  if (sample.some((r) => holdout.has(r.id))) throw new Error("tune sample contains a holdout row");
  return { sample: sample.sort((a, b) => a.id - b.id), weights, train };
}

async function tuneData(allowCalls: boolean, model: string) {
  const { sample, weights, train } = tuneSample(loadMendeley());
  const { out, missing } = await answersFor("mendeley", sample.map((r) => ({ id: r.id, state: { body: r.text } })), model, allowCalls);
  return { sample, weights, train, out, missing };
}

function tuneSection(data: Awaited<ReturnType<typeof tuneData>>, base: Thresholds, tuned: Thresholds, picks: M.Picks) {
  const { sample, weights, train, out } = data;
  const probsRows = sample.filter((r) => r.label !== "spam").map((r) => ({ label: r.label, probs: M.nouls(out.get(r.id)!.answers) }));
  const scoredWith = (t: Thresholds) => sample.map((r) => M.score(r.id, r.label, out.get(r.id)!.answers, t));
  const tunedRows = scoredWith(tuned);
  const specRows = scoredWith({ ...tuned, ...SPEC_DEFAULTS });
  const nTrain = (l: string) => train.filter((r) => r.label === l).length;
  console.log(`## Tuning sample (train only, seed ${SEED})\n`);
  console.log(
    M.md(
      ["label", "train rows", "sampled", "weight"],
      Object.keys(SAMPLE).map((l) => [l, nTrain(l), sample.filter((r) => r.label === l).length, weights[l].toFixed(2)]),
    ),
  );
  console.log(`\n### Picks\n\n${picks.why.map((w) => `- ${w}`).join("\n")}\n`);
  console.log(`### Sweep (severe rule on: asks_code >= ${base.asks_code_severe} or combo >= ${base.combo_severe})\n`);
  console.log(M.sweepTable(probsRows, base, weights));
  console.log(`\n### Tuned thresholds on the tuning sample\n\n${M.headlineText(M.headline(tunedRows, weights), { weighted: true })}\n`);
  console.log(M.levelTable(tunedRows));
  console.log(`\n### Spec defaults (${SPEC_DEFAULTS.unsure} / ${SPEC_DEFAULTS.likely} / ${SPEC_DEFAULTS.high}) on the same sample\n`);
  console.log(`${M.headlineText(M.headline(specRows, weights), { weighted: true })}\n`);
  console.log(`### Severe rule\n\n${M.severeTable(tunedRows, tuned)}\n`);
  console.log(`### Red flags (share of rows at or above each threshold)\n\n${M.flagTable(tunedRows)}\n\n${M.flagSummary(tunedRows, tuned)}\n`);
  return tunedRows;
}

async function tune() {
  const model = pinnedModel();
  const data = await tuneData(true, model);
  if (data.missing) throw new Error(`${data.missing} rows failed; rerun tune (cached answers are reused)`);
  const jevModel = oneModel([...data.out.values()], model);
  const base: Thresholds = { ...thresholds }; // severe, flag and known-contact values are kept as they are
  const rows = data.sample.filter((r) => r.label !== "spam").map((r) => ({ label: r.label, probs: M.nouls(data.out.get(r.id)!.answers) }));
  const picks = M.pickThresholds(rows, base, data.weights);
  const tuned: Thresholds = { ...base, jev_model: jevModel, unsure: picks.unsure, likely: picks.likely, high: picks.high };
  const tunedRows = tuneSection(data, base, tuned, picks);

  const existing = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, "utf8"));
  const counts = Object.entries(SAMPLE).map(([l, n]) => `${n} ${l}`).join(", ");
  const next = {
    ...existing,
    ...tuned,
    note: `Tuned ${today} by \`npm run eval -- tune\` on ${data.sample.length} train rows (${counts}; seed ${SEED}) with ${jevModel}. See docs/EVAL.md.`,
  };
  fs.writeFileSync(THRESHOLDS_PATH, JSON.stringify(next, null, 2) + "\n");
  reloadThresholds();
  console.error(`[eval] wrote ${path.relative(process.cwd(), THRESHOLDS_PATH)}: unsure ${tuned.unsure}, likely ${tuned.likely}, high ${tuned.high}`);

  await saveRows(
    runId("tune"),
    "mendeley",
    data.sample.map((r, i) => ({ rowIndex: r.id, split: "train", label: r.label, s: tunedRows[i], model: data.out.get(r.id)!.model })),
  );
}

// ---------------------------------------------------------------- holdout (Flow 6 steps 5-6)

async function holdoutData(allowCalls: boolean, model: string) {
  const rows = loadMendeley().filter((r) => r.split === "holdout");
  const { out, missing } = await answersFor("mendeley", rows.map((r) => ({ id: r.id, state: { body: r.text } })), model, allowCalls);
  return { rows, out, missing };
}

function holdoutSection(data: Awaited<ReturnType<typeof holdoutData>>, t: Thresholds) {
  const scored = data.rows.map((r) => M.score(r.id, r.label, data.out.get(r.id)!.answers, t));
  console.log(`## Holdout (${data.rows.length} rows, scored once with unsure ${t.unsure} / likely ${t.likely} / high ${t.high})\n`);
  console.log(`${M.headlineText(M.headline(scored))}\n`);
  console.log(`${M.levelTable(scored)}\n`);
  console.log(`### Scam types (Jev's scam_type answer on smishing rows)\n\n${M.scamTypeTable(scored)}\n`);
  console.log(`### Severe rule\n\n${M.severeTable(scored, t)}\n`);
  console.log(`### Red flags\n\n${M.flagTable(scored)}\n\n${M.flagSummary(scored, t)}\n`);
  return scored;
}

function requireTuned(model: string) {
  if (thresholds.jev_model !== model) {
    console.error(`config/thresholds.json was tuned with ${thresholds.jev_model ?? "nothing"}, not ${model}. Run tune with this model first.`);
    process.exit(1);
  }
}

async function holdout() {
  const model = pinnedModel();
  requireTuned(model);
  const data = await holdoutData(true, model);
  if (data.missing) throw new Error(`${data.missing} rows failed; rerun holdout (cached answers are reused, nothing is re-scored)`);
  oneModel([...data.out.values()], model);
  const scored = holdoutSection(data, thresholds);
  await saveRows(
    runId("holdout"),
    "mendeley",
    data.rows.map((r, i) => ({ rowIndex: r.id, split: "holdout", label: r.label, s: scored[i], model: data.out.get(r.id)!.model })),
  );
}

// ---------------------------------------------------------------- scout (30 hand-written US messages)

async function scoutData(allowCalls: boolean, model: string) {
  const rows = loadScout();
  const { out, missing } = await answersFor("test30", rows.map((r) => ({ id: r.id, state: { body: r.text, sender: r.from } })), model, allowCalls);
  return { rows, out, missing };
}

function scoutSection(data: Awaited<ReturnType<typeof scoutData>>, t: Thresholds) {
  const by = new Map<string, { r: ScoutRow; s: M.Scored }>();
  const scored = data.rows.map((r) => {
    const s = M.score(r.id, r.expected, data.out.get(r.id)!.answers, t);
    by.set(r.id, { r, s });
    return s;
  });
  const lp = (s: M.Scored) => M.likelyPlus(s.level);
  const of = (exp: string) => data.rows.filter((r) => r.expected === exp).map((r) => by.get(r.id)!.s);
  const scams = of("scam");
  const legit = of("legit");
  console.log(`## Scout set (30 hand-written US messages, state = { body, sender })\n`);
  console.log(
    [
      `- Scams at Likely or above: **${scams.filter(lp).length} of ${scams.length}**; at Unsure or above: ${scams.filter((s) => atLeast(s.level, "unsure")).length} of ${scams.length}`,
      `- Legit at Likely or above (false alarms): **${legit.filter(lp).length} of ${legit.length}**; rated Safe: ${legit.filter((s) => s.level === "safe").length} of ${legit.length}`,
      ...of("scam_or_unsure").map((s) => `- ${s.id} (scam_or_unsure): ${LEVEL_LABEL[s.level]}`),
      ...of("spam").map((s) => `- ${s.id} (spam, reported separately): ${LEVEL_LABEL[s.level]}`),
    ].join("\n") + "\n",
  );
  console.log(
    M.md(
      ["id", "expected", "category", "level", "confidence", "is_scam", "flags", "scam_type"],
      data.rows.map((r) => {
        const s = by.get(r.id)!.s;
        const ok = r.expected === "scam" ? lp(s) : r.expected === "legit" ? s.level === "safe" : true;
        return [r.id, r.expected, r.category, `${LEVEL_LABEL[s.level]}${ok ? "" : " **(miss)**"}`, `${s.confidence}%`, M.fmtP(s.p), s.flags.join(", ") || "-", s.scamType ?? "-"];
      }),
    ),
  );
  console.log(`\n### Key pairs (scam vs the legit message it imitates)\n`);
  console.log(
    M.md(
      ["pair", "scam level (is_scam)", "legit level (is_scam)", "result"],
      PAIRS.map(([a, b]) => {
        const sa = by.get(a)!.s;
        const sb = by.get(b)!.s;
        const result = lp(sa) && sb.level === "safe" ? "separated" : lp(sa) && sb.level === "unsure" ? "partly (legit lands Unsure)" : "not separated";
        return [`${a} vs ${b}`, `${LEVEL_LABEL[sa.level]} (${M.fmtP(sa.p)})`, `${LEVEL_LABEL[sb.level]} (${M.fmtP(sb.p)})`, result];
      }),
    ),
  );
  console.log();
  return scored;
}

async function scout() {
  const model = pinnedModel();
  requireTuned(model);
  const data = await scoutData(true, model);
  if (data.missing) throw new Error(`${data.missing} rows failed; rerun scout (cached answers are reused)`);
  oneModel([...data.out.values()], model);
  const scored = scoutSection(data, thresholds);
  await saveRows(
    runId("scout"),
    "test30",
    data.rows.map((r, i) => ({ rowIndex: r.index, split: null, label: r.expected, s: scored[i], model: data.out.get(r.id)!.model })),
  );
}

// ---------------------------------------------------------------- report (cache only)

async function report() {
  const model = thresholds.jev_model;
  if (!model) throw new Error("config/thresholds.json has no jev_model: run tune first");
  console.log(`# Bouncer eval report (from cache, ${model}, questions ${QHASH})\n`);

  const td = await tuneData(false, model);
  if (td.missing) console.log(`_Tune sample: ${td.missing} rows not cached; skipped._\n`);
  else {
    const rows = td.sample.filter((r) => r.label !== "spam").map((r) => ({ label: r.label, probs: M.nouls(td.out.get(r.id)!.answers) }));
    const picks = M.pickThresholds(rows, thresholds, td.weights);
    const same = picks.unsure === thresholds.unsure && picks.likely === thresholds.likely && picks.high === thresholds.high;
    if (!same) console.log(`_Note: the picker now chooses ${picks.unsure} / ${picks.likely} / ${picks.high}; the file has ${thresholds.unsure} / ${thresholds.likely} / ${thresholds.high}._\n`);
    tuneSection(td, thresholds, thresholds, picks);
  }

  const hd = await holdoutData(false, model);
  if (hd.missing) console.log(`_Holdout: ${hd.missing} rows not cached; skipped._\n`);
  else holdoutSection(hd, thresholds);

  const sd = await scoutData(false, model);
  if (sd.missing) console.log(`_Scout: ${sd.missing} rows not cached; skipped._\n`);
  else scoutSection(sd, thresholds);
}

// ---------------------------------------------------------------- main

const cmd = process.argv.slice(2).find((a) => !a.startsWith("--"));
const commands: Record<string, () => Promise<void>> = { tune, holdout, scout, report };
try {
  if (!cmd || !commands[cmd]) {
    console.error("Usage: npm run eval -- <tune|holdout|scout|report> [--run=N]");
    process.exitCode = 1;
  } else await commands[cmd]();
} catch (err: any) {
  console.error(`[eval] ${err?.message ?? err}`);
  if (/ECONNRESET|ECONNREFUSED|connect/i.test(String(err?.message)))
    console.error("[eval] Postgres tunnel down? Run: railway connect Postgres --tunnel-only --port 54329  (cached Jev answers are kept)");
  process.exitCode = 1;
} finally {
  await pool.end();
}
