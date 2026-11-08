// Live-listen accuracy on phone calls (Flow 2 step 6). Measures what score.ts would do on call
// transcripts: detection on scam call scripts, false alarms on normal calls, and how many turns pass
// before the first text alert.
//
//   npm run eval:calls              # ask Jev for anything not cached, then print the report
//   npm run eval:calls -- report    # cache only, no Jev calls
//
// Same Jev request as production: state = { transcript: turns.join("\n") }, questions = CALL_QUESTIONS,
// level = riskLevel() from src/detection/risk.ts with config/thresholds.json, no known_contact.
//
// The alert logic in src/voice/score.ts (scoreOnce + alert) is not exported and its module imports the
// DB, Photon and Flow 3 code, so simulate() below MIRRORS it line by line as a pure function. Keep the
// two in sync. The one thing it can't reproduce is the Gemini brand lookup, which only changes the
// wording of the impersonation line, except that an impersonation line with no brand is skipped when
// family_danger is set. Here "no brand" is approximated as scam_type = family_emergency.
// Both alert rules are reported: OLD (level ≥ likely_scam) and NEW (commit 9636c0e: also needs one of
// asks_code / remote_access / money_or_code ≥ 0.7 at some point in the call). callerTranscript() only
// drops speech aimed at Bouncer, which these datasets don't contain, so the transcript is the same.
// Sections 3-5 are what-ifs (gate variants, family_danger rewording, an extra asks_personal_info
// question); 4 and 5 cost extra Jev calls the first time and are cached like everything else.
//
// Answers are cached in data/calls_jev_cache.json (git-ignored), keyed by a hash of the transcript, the
// model and the question wording. No transcript text is stored in the cache. Per-row results (ids,
// numbers, levels, alerts) go to data/calls_eval_results.json.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { askJev, noul, choice, type JevAnswer, type JevQuestion, type JevResult } from "../src/detection/jev.js";
import { riskLevel, atLeast, LEVEL_ORDER, thresholds, type RiskLevel, type Thresholds } from "../src/detection/risk.js";
import { CALL_QUESTIONS, CALL_FLAGS } from "../src/voice/questions.js";
import { config } from "../src/config.js";
import { readCsv, rng, shuffled } from "./eval-data.js";
import { md } from "./eval-metrics.js";

const CONCURRENCY = 6;
const FLAG_ALERT = 0.7; // score.ts FLAG_ALERT (not exported)
const SEED = 42;
const PER_STRATUM = 50; // train sample: up to 50 rows per (platform, scam_pattern)
const CACHE = path.resolve("data", "calls_jev_cache.json");
const RESULTS = path.resolve("data", "calls_eval_results.json");
const qhashOf = (q: Record<string, JevQuestion>) => crypto.createHash("sha256").update(JSON.stringify(q)).digest("hex").slice(0, 12);
const QHASH = qhashOf(CALL_QUESTIONS);

const mode = process.argv[2] === "report" ? "report" : "run";
const model = config.typesafe.model;
if (/latest|^jev$/i.test(model)) {
  console.error("JEV_MODEL is an alias. Pin a versioned model, e.g. JEV_MODEL=jev-1.14.0 npm run eval:calls");
  process.exit(1);
}
if (thresholds.jev_model && thresholds.jev_model !== model)
  console.error(`[warn] thresholds were tuned with ${thresholds.jev_model}, scoring with ${model}`);

// ---------------------------------------------------------------- transcripts

/** Archive "Phone Call" rows are one monologue script: one sentence per turn, like ASR utterances. */
function phoneTurns(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Archive "Voice Call (Transcript)" rows: quoted lines separated by [Transcript]. Meta markers such as
 * "[Voice call transcript, caller ID spoofed as uncle]" or "[Transcript flagged by carrier as likely
 * synthetic voice]" would never come out of speech-to-text and give the answer away, so they are removed.
 */
function voiceTurns(text: string): string[] {
  return text
    .replace(/\[(?!Transcript\])[^\]]*\]/g, " ")
    .split(/\[Transcript\]/)
    .map((t) => t.trim().replace(/^['"‘“]+|['"’”]+$/g, "").trim())
    .filter(Boolean);
}

/**
 * BETTER30 TEXT cells: some hold two speakers joined with "[Step: n]" (or a stage marker such as
 * "[Attack Formulation]"); each piece becomes its own turn. Template placeholders get a plain value.
 */
function better30Turns(text: string): string[] {
  return text
    .replace(/\[Your Name\]/g, "Alex")
    .replace(/\[Fake Charity Name\]/g, "Hope Relief Fund")
    .replace(/\[Region\]/g, "the coast")
    .split(/\s*\[[^\]]*\]\s*/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- datasets

interface ArchiveRow {
  id: string;
  pattern: string;
  platform: string;
  split: string;
  set: "train_sample" | "val_test";
  turns: string[];
}

function loadArchive(): { rows: ArchiveRow[]; trainCounts: Record<string, number> } {
  const all = readCsv("scams_archive_en.csv", ["scam_id", "scam_pattern", "platform", "message_text", "label", "split"]).filter(
    (r) => r.platform === "Phone Call" || r.platform === "Voice Call (Transcript)",
  );
  const toRow = (r: Record<string, string>, set: ArchiveRow["set"]): ArchiveRow => ({
    id: r.scam_id,
    pattern: r.scam_pattern,
    platform: r.platform === "Phone Call" ? "phone" : "voice",
    split: r.split,
    set,
    turns: r.platform === "Phone Call" ? phoneTurns(r.message_text) : voiceTurns(r.message_text),
  });
  const strata = new Map<string, Record<string, string>[]>();
  for (const r of all.filter((r) => r.split === "train")) {
    const k = `${r.platform === "Phone Call" ? "phone" : "voice"}/${r.scam_pattern}`;
    strata.set(k, [...(strata.get(k) ?? []), r]);
  }
  const rand = rng(SEED);
  const rows: ArchiveRow[] = [];
  const trainCounts: Record<string, number> = {};
  for (const k of [...strata.keys()].sort()) {
    const xs = strata.get(k)!;
    trainCounts[k] = xs.length;
    for (const r of shuffled(xs, rand).slice(0, PER_STRATUM)) rows.push(toRow(r, "train_sample"));
  }
  for (const r of all.filter((r) => r.split === "val" || r.split === "test")) rows.push(toRow(r, "val_test"));
  return { rows, trainCounts };
}

const SCAM_LABELS = new Set(["scam", "scam_response", "potential_scam", "highly_suspicious"]);
const LEGIT_LABELS = new Set(["neutral", "legitimate"]);
const SUSPICIOUS_LABELS = new Set(["suspicious", "slightly_suspicious", ...SCAM_LABELS]);
type Truth = "scam" | "legit" | "ambiguous";

interface Step {
  step: number;
  label: string;
  turns: string[];
}
interface Conversation {
  id: string;
  truth: Truth;
  steps: Step[];
  firstScamStep: number | null; // first step labeled scam/scam_response/potential_scam/highly_suspicious
  firstSuspStep: number | null; // first step labeled anything suspicious or worse
  opener: string; // short excerpt of the caller's first line, for the doc
}

function loadBetter30(): { convs: Conversation[]; dupRows: number; dupDiffer: number; junkLabels: Record<string, number> } {
  const rows = readCsv("better30_en.csv", ["CONVERSATION_ID", "CONVERSATION_STEP", "TEXT", "LABEL"]);
  const by = new Map<string, Map<number, Record<string, string>>>();
  let dupRows = 0;
  let dupDiffer = 0;
  const junkLabels: Record<string, number> = {};
  for (const r of rows) {
    const id = r.CONVERSATION_ID.trim();
    const step = Number(r.CONVERSATION_STEP);
    const m = by.get(id) ?? new Map();
    by.set(id, m);
    // Some conversations repeat a block of steps further down the file: keep the first copy.
    if (m.has(step)) {
      dupRows++;
      if (m.get(step)!.TEXT !== r.TEXT || m.get(step)!.LABEL !== r.LABEL) dupDiffer++;
      continue;
    }
    m.set(step, r);
  }
  const convs: Conversation[] = [];
  for (const [id, m] of by) {
    const steps = [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([step, r]) => ({ step, label: r.LABEL.trim().toLowerCase(), turns: better30Turns(r.TEXT) }));
    for (const s of steps) if (!SUSPICIOUS_LABELS.has(s.label) && !LEGIT_LABELS.has(s.label)) junkLabels[s.label] = (junkLabels[s.label] ?? 0) + 1;
    // Ground truth: any scam-type step → scam; every step neutral/legitimate → legit; otherwise
    // (suspicious / slightly_suspicious, or unknown labels, with no scam step) → ambiguous.
    const truth: Truth = steps.some((s) => SCAM_LABELS.has(s.label))
      ? "scam"
      : steps.every((s) => LEGIT_LABELS.has(s.label))
        ? "legit"
        : "ambiguous";
    const opener = (steps[1]?.turns[0] ?? steps[0].turns[0] ?? "").slice(0, 90);
    convs.push({
      id,
      truth,
      steps,
      firstScamStep: steps.find((s) => SCAM_LABELS.has(s.label))?.step ?? null,
      firstSuspStep: steps.find((s) => SUSPICIOUS_LABELS.has(s.label))?.step ?? null,
      opener,
    });
  }
  convs.sort((a, b) => Number(a.id) - Number(b.id));
  return { convs, dupRows, dupDiffer, junkLabels };
}

// ---------------------------------------------------------------- Jev with a disk cache

type Answers = Record<string, JevAnswer>;
interface Entry {
  model: string;
  q: string;
  answers: Answers;
}

const keyOf = (transcript: string, qh = QHASH) => crypto.createHash("sha256").update(`${model}|${qh}|${transcript}`).digest("hex");

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

let jevCalls = 0;
let jevFailed = 0;
async function answersFor(transcripts: string[], allowCalls: boolean, questions = CALL_QUESTIONS): Promise<Map<string, Answers>> {
  const qh = qhashOf(questions);
  const cache = loadCache();
  const out = new Map<string, Answers>();
  const todo = new Set<string>();
  for (const t of transcripts) {
    const e = cache[keyOf(t, qh)];
    if (e && e.q === qh && e.model === model) out.set(t, e.answers);
    else todo.add(t);
  }
  console.error(`[jev] ${new Set(transcripts).size} distinct transcripts, ${out.size} cached, ${todo.size} ${allowCalls ? "to ask" : "missing"}`);
  if (!todo.size || !allowCalls) return out;
  const limit = pLimit(CONCURRENCY);
  let done = 0;
  let unsaved = 0;
  const t0 = Date.now();
  await Promise.all(
    [...todo].map((t) =>
      limit(async () => {
        try {
          // Same call as score.ts: state { transcript }, CALL_QUESTIONS (or a what-if variant), one request.
          const r = await askJev({ transcript: t }, questions, { retries: 3 });
          jevCalls++;
          if (r.model !== model) console.error(`[warn] Jev answered with ${r.model}, asked for ${model}`);
          cache[keyOf(t, qh)] = { model: r.model, q: qh, answers: r.answers };
          out.set(t, r.answers);
          if (++unsaved >= 50) saveCache(cache), (unsaved = 0);
        } catch (err: any) {
          jevFailed++;
          console.error(`[jev] failed: ${String(err?.message ?? err).split(":")[0]}`);
        }
        if (++done % 100 === 0 || done === todo.size)
          console.error(`[jev] ${done}/${todo.size} asked, ${jevFailed} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }),
    ),
  );
  saveCache(cache);
  return out;
}

// ---------------------------------------------------------------- score.ts, mirrored

/** Optional what-ifs for the recommendations. Production = {}. */
interface Policy {
  t?: Thresholds;
  /** family_danger starts Flow 3 only when the call's level is at least this (production: no gate). */
  familyMinLevel?: RiskLevel;
  /** false = text flag lines as soon as a flag crosses, as the SPEC text reads (production waits for likely_scam). */
  flagGate?: boolean;
  /** Flag threshold (production 0.7). */
  flagAlert?: number;
  /** Extra noul question (not in production) that also counts as a concrete ask for the gate. */
  extraAsk?: string;
  /**
   * score.ts gate added 2026-11-08 after a live false alarm: no flag or level text unless at least one of
   * CONCRETE_ASKS crossed 0.7 at some point in the call (s.flags). family_danger is not affected.
   */
  concreteAskGate?: boolean;
  /** What-if: the concrete-ask gate is also passed when the session level reaches this. */
  gateBypassLevel?: RiskLevel;
  /** What-if: the concrete-ask gate is also passed after this many consecutive scorings at Likely+. */
  gateBypassStreak?: number;
  /** Both bypass conditions must hold (instead of either). */
  bothBypass?: boolean;
}

const CONCRETE_ASKS = ["asks_code", "remote_access", "money_or_code"]; // score.ts CONCRETE_ASKS
/** The two rules reported side by side: before and after the concrete-ask gate. */
const OLD: Policy = {};
const NEW: Policy = { concreteAskGate: true };

interface Sim {
  level: RiskLevel;
  p: number;
  scamType: string | null;
  flags: Set<string>;
  alerted: Set<string>;
  alertedLevel: RiskLevel;
  familyStarted: boolean;
  streak: number; // what-if only: consecutive scorings whose own level was Likely+
}
const newSim = (): Sim => ({
  streak: 0,
  level: "safe",
  p: 0,
  scamType: null,
  flags: new Set(),
  alerted: new Set(),
  alertedLevel: "safe",
  familyStarted: false,
});

interface StepOut {
  level: RiskLevel; // the session's level after this scoring (max so far)
  stepLevel: RiskLevel; // this scoring alone
  p: number;
  probs: Record<string, number>;
  scamType: string | null;
  texts: string[]; // alert keys texted after this scoring
}

const FLAG_ORDER = ["asks_code", "remote_access", "money_or_code", "impersonation"]; // Object.keys(FLAG_LINES)
const LEVEL_LINE_LEVELS: RiskLevel[] = ["likely_scam", "high_risk"]; // LEVEL_LINES keys

/** scoreOnce() lines after Jev answers, then alert(), for a known user, assuming every send succeeds. */
function simulate(s: Sim, answers: Answers, pol: Policy = {}): StepOut {
  const r: JevResult = { model, answers, ms: 0 };
  const probs: Record<string, number> = {};
  for (const f of [...CALL_FLAGS, "is_scam"]) probs[f] = noul(r, f);
  if (pol.extraAsk) probs[pol.extraAsk] = noul(r, pol.extraAsk);
  const risk = riskLevel(
    {
      is_scam: probs.is_scam,
      asks_code: probs.asks_code,
      money_or_code: probs.money_or_code,
      urgency_secrecy: probs.urgency_secrecy,
      impersonation: probs.impersonation,
    },
    pol.t ?? thresholds,
  );
  const st = choice(r, "scam_type");
  const raised = LEVEL_ORDER.indexOf(risk.level) > LEVEL_ORDER.indexOf(s.level);
  if (raised) {
    s.level = risk.level;
    s.p = risk.p;
    if (st.label && atLeast(risk.level, "unsure")) s.scamType = st.label;
  } else if (risk.level === s.level) {
    s.p = Math.max(s.p, risk.p);
  }
  const crossed = CALL_FLAGS.filter((f) => probs[f] >= (pol.flagAlert ?? FLAG_ALERT));
  for (const f of crossed) s.flags.add(f);
  if (pol.extraAsk && probs[pol.extraAsk] >= (pol.flagAlert ?? FLAG_ALERT)) s.flags.add(pol.extraAsk); // no line of its own

  // alert()
  const texts: string[] = [];
  const familyGateOk = !pol.familyMinLevel || atLeast(s.level, pol.familyMinLevel);
  if (s.flags.has("family_danger") && !s.familyStarted && familyGateOk) {
    s.familyStarted = true;
    s.alerted.add("family_danger");
    texts.push("family_danger"); // Flow 3 always texts coaching (coachOnly or the YES prompt)
  }
  const asks = pol.extraAsk ? [...CONCRETE_ASKS, pol.extraAsk] : CONCRETE_ASKS;
  s.streak = atLeast(risk.level, "likely_scam") ? s.streak + 1 : 0;
  const byLevel = pol.gateBypassLevel !== undefined && atLeast(s.level, pol.gateBypassLevel);
  const byStreak = pol.gateBypassStreak !== undefined && s.streak >= pol.gateBypassStreak;
  const askOk =
    !pol.concreteAskGate || asks.some((f) => s.flags.has(f)) || (pol.bothBypass ? byLevel && byStreak : byLevel || byStreak);
  if ((pol.flagGate === false || atLeast(s.level, "likely_scam")) && askOk) {
    let sentFlagLine = false;
    for (const f of FLAG_ORDER) {
      if (!s.flags.has(f) || s.alerted.has(f)) continue;
      s.alerted.add(f);
      const brand = f === "impersonation" ? st.label !== "family_emergency" : false; // see header
      if (f === "impersonation" && !brand && s.flags.has("family_danger")) continue;
      texts.push(f);
      sentFlagLine = true;
    }
    if (s.flags.has("urgency_secrecy")) s.alerted.add("urgency_secrecy");
    if (LEVEL_ORDER.indexOf(s.level) > LEVEL_ORDER.indexOf(s.alertedLevel)) {
      s.alertedLevel = s.level;
      if (!sentFlagLine && LEVEL_LINE_LEVELS.includes(s.level)) texts.push(`level:${s.level}`);
    }
  }
  return { level: s.level, stepLevel: risk.level, p: risk.p, probs, scamType: s.scamType ?? st.label, texts };
}

// ---------------------------------------------------------------- helpers

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const f2 = (x: number) => x.toFixed(2);
const transcriptOf = (turns: string[]) => turns.filter((t) => t?.trim()).join("\n"); // score.ts line 79
const LABEL: Record<RiskLevel, string> = { safe: "Safe", unsure: "Unsure", likely_scam: "Likely", high_risk: "High" };

function quantiles(xs: number[]) {
  if (!xs.length) return "n/a";
  const a = [...xs].sort((x, y) => x - y);
  const q = (p: number) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
  return `min ${a[0]}, median ${median(a)}, p90 ${q(0.9)}, max ${a[a.length - 1]}`;
}
function median(xs: number[]): number | string {
  if (!xs.length) return "-";
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---------------------------------------------------------------- main

const { rows: archive, trainCounts } = loadArchive();
const b30 = loadBetter30();

// Every transcript to score: archive rows once (whole call); BETTER30 as the call grows, step by step.
const archiveT = new Map(archive.map((r) => [r.id, transcriptOf(r.turns)]));
const prefixT = new Map<string, string[]>(); // conv id → transcript after step i
for (const c of b30.convs) {
  const turns: string[] = [];
  prefixT.set(
    c.id,
    c.steps.map((s) => (turns.push(...s.turns), transcriptOf(turns))),
  );
}
const allT = [...archiveT.values(), ...[...prefixT.values()].flat()];
const answers = await answersFor(allT, mode === "run");
const answersMain = answers;
const missing = allT.filter((t) => !answers.has(t)).length;
if (missing) console.error(`[warn] ${missing} transcripts have no answer; those rows are skipped`);

const out: string[] = [];
const say = (s = "") => out.push(s);

// ======== 1. Archive call scripts (all scams)

interface ArchiveResult {
  id: string;
  pattern: string;
  platform: string;
  set: string;
  level: RiskLevel;
  p: number;
  probs: Record<string, number>;
  scamType: string | null;
  texts: string[]; // new rule (concrete-ask gate)
  textsOld: string[]; // old rule
  turns: number;
}
const arch: ArchiveResult[] = [];
for (const r of archive) {
  const a = answers.get(archiveT.get(r.id)!);
  if (!a) continue;
  const o = simulate(newSim(), a, NEW);
  const old = simulate(newSim(), a, OLD);
  arch.push({ id: r.id, pattern: r.pattern, platform: r.platform, set: r.set, level: o.level, p: o.p, probs: o.probs, scamType: o.scamType, texts: o.texts, textsOld: old.texts, turns: r.turns.length });
}

function archiveTable(rows: ArchiveResult[]) {
  const groups = new Map<string, ArchiveResult[]>();
  for (const r of rows) {
    const k = `${r.platform}/${r.pattern}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const line = (k: string, xs: ArchiveResult[]) => [
    k,
    xs.length,
    pct(xs.filter((x) => atLeast(x.level, "likely_scam")).length, xs.length),
    pct(xs.filter((x) => atLeast(x.level, "unsure")).length, xs.length),
    pct(xs.filter((x) => x.textsOld.length).length, xs.length),
    pct(xs.filter((x) => x.texts.length).length, xs.length),
    pct(xs.filter((x) => x.level === "high_risk").length, xs.length),
    pct(xs.filter((x) => x.level === "safe").length, xs.length),
    f2(xs.reduce((s, x) => s + x.probs.is_scam, 0) / xs.length),
  ];
  return md(
    ["platform/pattern", "rows", "Likely+", "Unsure+", "text alert (old rule)", "text alert (new gate)", "High", "Safe (missed)", "mean is_scam"],
    [...[...groups.keys()].sort().map((k) => line(k, groups.get(k)!)), line("**all**", rows)],
  );
}

const sample = arch.filter((r) => r.set === "train_sample");
const valtest = arch.filter((r) => r.set === "val_test");
say("## 1. Archive call scripts (every row is a scam)");
say();
say(`Train sample (seed ${SEED}, up to ${PER_STRATUM} per platform/pattern; train sizes ${JSON.stringify(trainCounts)}):`);
say();
say(archiveTable(sample));
say();
// Weighted to the train mix: each stratum counts by its train size.
{
  let w = 0, wl = 0, wu = 0;
  for (const [k, n] of Object.entries(trainCounts)) {
    const xs = sample.filter((r) => `${r.platform}/${r.pattern}` === k);
    if (!xs.length) continue;
    w += n;
    wl += (n * xs.filter((x) => atLeast(x.level, "likely_scam")).length) / xs.length;
    wu += (n * xs.filter((x) => atLeast(x.level, "unsure")).length) / xs.length;
  }
  say(`Train sample reweighted to the train mix: Likely+ ${pct(wl, w)}, Unsure+ ${pct(wu, w)}.`);
}
say();
say("Val + test (all Phone Call rows, scored once):");
say();
say(archiveTable(valtest));
say();

{
  const all = arch;
  const count = (pick: (r: ArchiveResult) => string[]) => {
    const m = new Map<string, number>();
    for (const r of all) for (const t of pick(r)) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const cOld = count((r) => r.textsOld);
  const cNew = count((r) => r.texts);
  say(`Which texts would fire (archive, ${all.length} rows; one scoring of the whole script):`);
  say();
  say(
    md(
      ["alert", "old rule", "new gate"],
      [...cOld.keys(), ...[...cNew.keys()].filter((k) => !cOld.has(k))]
        .sort((a, b) => (cOld.get(b) ?? 0) - (cOld.get(a) ?? 0))
        .map((k) => [k, `${cOld.get(k) ?? 0} (${pct(cOld.get(k) ?? 0, all.length)})`, `${cNew.get(k) ?? 0} (${pct(cNew.get(k) ?? 0, all.length)})`]),
    ),
  );
  say();
  const lost = all.filter((r) => r.textsOld.length && !r.texts.length);
  const lostBy = new Map<string, number>();
  for (const r of lost) lostBy.set(r.pattern, (lostBy.get(r.pattern) ?? 0) + 1);
  const text0 = new Map(archive.map((r) => [r.id, transcriptOf(r.turns).replace(/\n/g, " ")]));
  say(`Silenced by the new gate (Likely+ but no concrete ask ≥ 0.7): ${lost.length} of ${all.length} (${[...lostBy.entries()].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}).`);
  say();
  if (lost.length)
    say(
      md(
        ["id", "pattern", "level", "is_scam", "asks_code", "remote_access", "money_or_code", "excerpt"],
        lost.slice(0, 12).map((r) => [r.id, r.pattern, LABEL[r.level], f2(r.p), f2(r.probs.asks_code), f2(r.probs.remote_access), f2(r.probs.money_or_code), `"${text0.get(r.id)!.slice(0, 120).replace(/\|/g, "/")}…"`]),
      ),
    );
  say();
  const flagRate = CALL_FLAGS.map((f) => [f, ...["phone", "voice"].map((pl) => {
    const xs = all.filter((r) => r.platform === pl);
    return pct(xs.filter((x) => x.probs[f] >= FLAG_ALERT).length, xs.length);
  })]);
  say("Flag ≥ 0.7 rate by platform:");
  say();
  say(md(["flag", "phone scripts", "voice transcripts"], flagRate));
  say();
  const st = new Map<string, Map<string, number>>();
  for (const r of all) {
    const m = st.get(r.pattern) ?? new Map();
    st.set(r.pattern, m);
    m.set(r.scamType ?? "-", (m.get(r.scamType ?? "-") ?? 0) + 1);
  }
  say("scam_type by pattern (top 3):");
  say();
  say(md(["pattern", "scam_type"], [...st.entries()].map(([p, m]) => [p, [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(", ")])));
  say();
  const misses = all.filter((r) => !atLeast(r.level, "likely_scam")).sort((a, b) => a.p - b.p);
  say(`Worst misses (below Likely, lowest is_scam first; ${misses.length} total):`);
  say();
  const text = new Map(archive.map((r) => [r.id, transcriptOf(r.turns).replace(/\n/g, " ")]));
  say(
    md(
      ["id", "set", "pattern", "level", "is_scam", "flags ≥0.7", "texts", "excerpt"],
      misses.slice(0, 15).map((r) => [
        r.id,
        r.set,
        r.pattern,
        LABEL[r.level],
        f2(r.p),
        CALL_FLAGS.filter((f) => r.probs[f] >= FLAG_ALERT).join(", ") || "-",
        r.texts.join(", ") || "-",
        `"${text.get(r.id)!.slice(0, 110).replace(/\|/g, "/")}…"`,
      ]),
    ),
  );
  say();
}

// ======== 2. BETTER30, growing transcript

interface ConvResult {
  id: string;
  truth: Truth;
  steps: number;
  firstScamStep: number | null;
  firstSuspStep: number | null;
  firstAlertStep: number | null;
  firstLikelyStep: number | null;
  firstUnsureStep: number | null;
  finalLevel: RiskLevel;
  maxP: number;
  maxAsk: string; // highest concrete-ask probability over the call, e.g. "money_or_code 0.62"
  alerts: { step: number; texts: string[] }[];
  familyStep: number | null;
  perStep: { step: number; label: string; level: RiskLevel; stepLevel: RiskLevel; p: number; flags: string[]; texts: string[] }[];
  opener: string;
}

function runConvs(pol: Policy, answers = answersMain): ConvResult[] {
  const res: ConvResult[] = [];
  for (const c of b30.convs) {
    const ts = prefixT.get(c.id)!;
    if (ts.some((t) => !answers.has(t))) continue;
    const s = newSim();
    const perStep: ConvResult["perStep"] = [];
    c.steps.forEach((st, i) => {
      const o = simulate(s, answers.get(ts[i])!, pol);
      perStep.push({ step: st.step, label: st.label, level: o.level, stepLevel: o.stepLevel, p: o.p, flags: CALL_FLAGS.filter((f) => o.probs[f] >= (pol.flagAlert ?? FLAG_ALERT)), texts: o.texts });
    });
    const first = (pred: (x: (typeof perStep)[number]) => boolean) => perStep.find(pred)?.step ?? null;
    res.push({
      id: c.id,
      truth: c.truth,
      steps: c.steps.length,
      firstScamStep: c.firstScamStep,
      firstSuspStep: c.firstSuspStep,
      firstAlertStep: first((x) => x.texts.length > 0),
      firstLikelyStep: first((x) => atLeast(x.level, "likely_scam")),
      firstUnsureStep: first((x) => atLeast(x.level, "unsure")),
      finalLevel: perStep[perStep.length - 1].level,
      maxP: Math.max(...perStep.map((x) => x.p)),
      maxAsk: (() => {
        let best = ["-", -1] as [string, number];
        for (const t of ts)
          for (const f of pol.extraAsk ? [...CONCRETE_ASKS, pol.extraAsk] : CONCRETE_ASKS) {
            const v = noul({ model, answers: answers.get(t)!, ms: 0 }, f);
            if (v > best[1]) best = [f, v];
          }
        return `${best[0]} ${f2(best[1])}`;
      })(),
      alerts: perStep.filter((x) => x.texts.length).map((x) => ({ step: x.step, texts: x.texts })),
      familyStep: first((x) => x.texts.includes("family_danger")),
      perStep,
      opener: c.opener,
    });
  }
  return res;
}

const conv = runConvs(NEW);
const convOld = runConvs(OLD);
say("## 2. BETTER30 conversations, scored as the call grows");
say();
say(
  `${b30.convs.length} conversations after dropping ${b30.dupRows} repeated step rows (${b30.dupDiffer} of them differed from the first copy). ` +
    `Ground truth: scam ${conv.filter((c) => c.truth === "scam").length}, legit ${conv.filter((c) => c.truth === "legit").length}, ` +
    `ambiguous ${conv.filter((c) => c.truth === "ambiguous").length}. Labels outside the known set: ${JSON.stringify(b30.junkLabels)}.`,
);
say();

function convHeadline(cs: ConvResult[]) {
  return md(
    ["truth", "convs", "final Safe", "final Unsure", "final Likely", "final High", "any text alert"],
    (["scam", "legit", "ambiguous"] as Truth[]).map((t) => {
      const xs = cs.filter((c) => c.truth === t);
      const n = (l: RiskLevel) => xs.filter((c) => c.finalLevel === l).length;
      return [t, xs.length, n("safe"), n("unsure"), n("likely_scam"), n("high_risk"), `${xs.filter((c) => c.alerts.length).length} (${pct(xs.filter((c) => c.alerts.length).length, xs.length)})`];
    }),
  );
}
for (const [name, cs] of [["old rule (level ≥ likely_scam)", convOld], ["new gate (also needs a concrete ask ≥ 0.7)", conv]] as const) {
  say(`### ${name}`);
  say();
  say("Final verdict (session level = highest level reached) vs ground truth:");
  say();
  say(convHeadline(cs));
  say();
  const scams = cs.filter((c) => c.truth === "scam");
  const caught = scams.filter((c) => c.firstAlertStep !== null);
  const delays = caught.map((c) => c.firstAlertStep! - c.firstScamStep!);
  const dist = new Map<number, number>();
  for (const d of delays) dist.set(d, (dist.get(d) ?? 0) + 1);
  say(`Time to first text alert, scam conversations (${caught.length} of ${scams.length} alerted). Delay = first alert step − first scam-labeled step:`);
  say();
  say(md(["delay (steps)", "convs"], [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => [d < 0 ? `${d} (before label)` : d, n])));
  say();
  say(`Delay: ${quantiles(delays)}. First alert step (absolute): ${quantiles(caught.map((c) => c.firstAlertStep!))}. ` +
    `Alert at or before the scam call's midpoint: ${caught.filter((c) => c.firstAlertStep! <= Math.ceil(c.steps / 2)).length} of ${scams.length}.`);
  say();
  const lk = scams.filter((c) => c.firstLikelyStep !== null).map((c) => c.firstLikelyStep! - c.firstScamStep!);
  say(`Level reaches Likely+: ${lk.length} of ${scams.length}; delay ${quantiles(lk)}.`);
  say();
  const fa = cs.filter((c) => c.truth === "legit" && c.alerts.length);
  say(`False alarms on legit conversations: ${fa.length} of ${cs.filter((c) => c.truth === "legit").length}.`);
  for (const c of fa) {
    say();
    say(`- conv ${c.id}: ${c.perStep.map((x) => `s${x.step} ${LABEL[x.stepLevel]} ${f2(x.p)}${x.flags.length ? ` [${x.flags.join(",")}]` : ""}${x.texts.length ? ` → TEXT ${x.texts.join("+")}` : ""}`).join(" · ")}`);
  }
  say();
  const amb = cs.filter((c) => c.truth === "ambiguous");
  say(`Ambiguous conversations alerted: ${amb.filter((c) => c.alerts.length).length} of ${amb.length} (${amb.filter((c) => c.alerts.length).map((c) => c.id).join(", ") || "none"}; reported separately, not counted as false alarms).`);
  say();
}

const oldById = new Map(convOld.map((c) => [c.id, c]));
const detailRow = (c: ConvResult) => [
  c.id,
  c.truth,
  c.steps,
  c.firstScamStep ?? "-",
  oldById.get(c.id)?.firstAlertStep ?? "-",
  c.firstAlertStep ?? "-",
  LABEL[c.finalLevel],
  f2(c.maxP),
  oldById.get(c.id)!.alerts.map((a) => `s${a.step}: ${a.texts.join("+")}`).join("; ") || "-",
  c.alerts.map((a) => `s${a.step}: ${a.texts.join("+")}`).join("; ") || "-",
  c.maxAsk,
  `"${c.opener.replace(/\|/g, "/")}"`,
];
const detailHead = ["conv", "truth", "steps", "1st scam step", "1st alert (old)", "1st alert (new)", "final", "max is_scam", "texts (old rule)", "texts (new gate)", "max concrete ask", "caller opener"];
say("### Per conversation (both rules)");
say();
say(md(detailHead, conv.map(detailRow)));
say();

{
  const fam = conv.filter((c) => c.familyStep !== null);
  say(`family_danger started Flow 3 in ${fam.length} conversations: ${fam.map((c) => `${c.id} (${c.truth}, step ${c.familyStep})`).join(", ") || "none"}.`);
  const archFam = arch.filter((r) => r.texts.includes("family_danger"));
  const byPat = new Map<string, number>();
  for (const r of archFam) byPat.set(r.pattern, (byPat.get(r.pattern) ?? 0) + 1);
  say(`Archive rows where family_danger fired: ${archFam.length} of ${arch.length} (${[...byPat.entries()].map(([k, n]) => `${k} ${n}`).join(", ")}).`);
  say();
  // Flag that fires most on legit steps (the flags-before-level case)
  const legitSteps = conv.filter((c) => c.truth === "legit").flatMap((c) => c.perStep);
  say(`Flags ≥ 0.7 on legit conversations (any step): ${CALL_FLAGS.map((f) => `${f} ${conv.filter((c) => c.truth === "legit" && c.perStep.some((x) => x.flags.includes(f))).length}`).join(", ")} (of ${conv.filter((c) => c.truth === "legit").length} convs, ${legitSteps.length} steps).`);
  say();
}

// ======== 3. What-ifs (from cache, no extra Jev calls)

function summary(name: string, pol: Policy, answers = answersMain) {
  const cs = runConvs(pol, answers);
  const scams = cs.filter((c) => c.truth === "scam");
  const legit = cs.filter((c) => c.truth === "legit");
  const amb = cs.filter((c) => c.truth === "ambiguous");
  const delays = scams.filter((c) => c.firstAlertStep !== null).map((c) => c.firstAlertStep! - c.firstScamStep!).sort((a, b) => a - b);
  const archAlert = archive.filter((r) => answers.has(archiveT.get(r.id)!)).filter((r) => simulate(newSim(), answers.get(archiveT.get(r.id)!)!, pol).texts.length);
  const archLikely = archive.filter((r) => answers.has(archiveT.get(r.id)!)).filter((r) => atLeast(simulate(newSim(), answers.get(archiveT.get(r.id)!)!, pol).level, "likely_scam"));
  return [
    name,
    `${scams.filter((c) => c.alerts.length).length}/${scams.length}`,
    median(delays),
    `${legit.filter((c) => c.alerts.length).length}/${legit.length}`,
    `${amb.filter((c) => c.alerts.length).length}/${amb.length}`,
    `${archAlert.length}/${arch.length}`,
    `${archLikely.length}/${arch.length}`,
  ];
}
say("## 3. What-ifs (same cached answers, no new Jev calls; not applied)");
say();
const T = thresholds;
say(
  md(
    ["policy", "scam convs alerted", "median delay", "legit convs alerted", "ambiguous alerted", "archive any text", "archive Likely+"],
    [
      summary("old rule (level ≥ likely)", OLD),
      summary("old rule, no likely gate on flag texts (SPEC wording)", { flagGate: false }),
      summary("old rule, likely 0.50", { t: { ...T, likely: 0.5 } }),
      summary("old rule, likely 0.80", { t: { ...T, likely: 0.8, high: Math.max(T.high, 0.8) } }),
      summary("**new gate (production now)**", NEW),
      summary("new gate, asks at 0.6", { ...NEW, flagAlert: 0.6 }),
      summary("new gate, asks at 0.5", { ...NEW, flagAlert: 0.5 }),
      summary("new gate, likely 0.50", { ...NEW, t: { ...T, likely: 0.5 } }),
      summary("new gate, family_danger needs level ≥ unsure", { ...NEW, familyMinLevel: "unsure" }),
      summary("new gate OR level high_risk", { ...NEW, gateBypassLevel: "high_risk" }),
      summary("new gate OR Likely+ on 2 scorings in a row", { ...NEW, gateBypassStreak: 2 }),
      summary("new gate OR Likely+ on 3 scorings in a row", { ...NEW, gateBypassStreak: 3 }),
      summary("new gate OR (high_risk AND 2 in a row)", { ...NEW, gateBypassLevel: "high_risk", gateBypassStreak: 2, bothBypass: true }),
    ],
  ),
);
say();

// ======== 4. family_danger wording what-if (extra Jev calls on voice-clone rows + BETTER30 only)

const FAMILY_VARIANT =
  "Someone on the call says that they, or a member of the listener's family, have been hurt, arrested, " +
  "in an accident, kidnapped or are in serious trouble.";
{
  const variantQ: Record<string, JevQuestion> = {
    ...CALL_QUESTIONS,
    family_danger: { type: "noul", instructions: FAMILY_VARIANT },
  };
  const voice = archive.filter((r) => r.platform === "voice");
  const FAMILY_THRESHOLD = FLAG_ALERT;
  const vt = [...voice.map((r) => archiveT.get(r.id)!), ...[...prefixT.values()].flat()];
  const va = await answersFor(vt, mode === "run", variantQ);
  const fd = (a: Answers | undefined) => (a?.family_danger?.type === "noul" ? a.family_danger.noul : NaN);
  const rate = (ts: string[], src: Map<string, Answers>) => ts.filter((t) => fd(src.get(t)) >= FAMILY_THRESHOLD).length;
  const voiceTs = voice.map((r) => archiveT.get(r.id)!);
  say("## 4. family_danger wording what-if (not applied)");
  say();
  say(`Variant: "${FAMILY_VARIANT}" (every other question unchanged, same single request).`);
  say();
  const convFires = (src: Map<string, Answers>, truth: Truth) =>
    b30.convs.filter((c) => c.truth === truth && prefixT.get(c.id)!.some((t) => fd(src.get(t)) >= FAMILY_THRESHOLD));
  const ids = (cs: Conversation[]) => cs.map((c) => c.id).join(", ") || "none";
  say(
    md(
      ["set", "production wording", "variant wording"],
      [
        [`voice-clone transcripts, family_danger ≥ 0.7 (of ${voiceTs.length})`, rate(voiceTs, answers), rate(voiceTs, va)],
        ...(["scam", "legit", "ambiguous"] as Truth[]).map((t) => [
          `BETTER30 ${t} convs where it fires at any step`,
          `${convFires(answers, t).length} (${ids(convFires(answers, t))})`,
          `${convFires(va, t).length} (${ids(convFires(va, t))})`,
        ]),
      ],
    ),
  );
  say();
  const shared = [...new Set(vt)].filter((t) => answers.has(t) && va.has(t));
  const drift = shared.map((t) => Math.abs(noul({ model, answers: answers.get(t)!, ms: 0 }, "is_scam") - noul({ model, answers: va.get(t)!, ms: 0 }, "is_scam")));
  say(`Check that the other answers don't move: mean |Δ is_scam| ${(drift.reduce((a, b) => a + b, 0) / (drift.length || 1)).toFixed(3)}, max ${Math.max(0, ...drift).toFixed(3)} over ${shared.length} transcripts.`);
  say();
}

// ======== 5. Concrete-ask gate with one more ask (extra Jev calls on every transcript)

const INFO_ASK =
  "Someone asks the listener to give or confirm an account number, card number, Social Security number, " +
  "ID number, password, or other personal or financial details.";
{
  const infoQ: Record<string, JevQuestion> = { ...CALL_QUESTIONS, asks_personal_info: { type: "noul", instructions: INFO_ASK } };
  const xa = await answersFor(allT, mode === "run", infoQ);
  const X: Policy = { ...NEW, extraAsk: "asks_personal_info" };
  say("## 5. What-if: the concrete-ask gate also accepts a new `asks_personal_info` question (not applied)");
  say();
  say(`Question: "${INFO_ASK}" Added to the same single request; it gets no text line of its own (the level line is sent).`);
  say();
  say(
    md(
      ["policy", "scam convs alerted", "median delay", "legit convs alerted", "ambiguous alerted", "archive any text", "archive Likely+"],
      [
        summary("old rule", OLD, xa),
        summary("new gate (production now)", NEW, xa),
        summary("new gate + asks_personal_info ≥ 0.7", X, xa),
        summary("new gate + asks_personal_info, all asks at 0.6", { ...X, flagAlert: 0.6 }, xa),
      ],
    ),
  );
  say();
  const cs = runConvs(X, xa);
  const legitInfo = cs.filter((c) => c.truth === "legit" && c.perStep.some((x) => noul({ model, answers: xa.get(prefixT.get(c.id)![c.perStep.indexOf(x)])!, ms: 0 }, "asks_personal_info") >= FLAG_ALERT));
  say(`Legit conversations where asks_personal_info ≥ 0.7 at some step (blocked from texting only by the level gate): ${legitInfo.length} (${legitInfo.map((c) => c.id).join(", ") || "none"}).`);
  const stillMissed = cs.filter((c) => c.truth === "scam" && !c.alerts.length);
  say();
  say(`Scam conversations still silent: ${stillMissed.length} (${stillMissed.map((c) => `${c.id} [${LABEL[c.finalLevel]}, max ask ${c.maxAsk}]`).join(", ") || "none"}).`);
  say();
  const shared = [...new Set(allT)].filter((t) => answers.has(t) && xa.has(t));
  const drift = shared.map((t) => Math.abs(noul({ model, answers: answers.get(t)!, ms: 0 }, "is_scam") - noul({ model, answers: xa.get(t)!, ms: 0 }, "is_scam")));
  say(`Adding the question moves is_scam by mean ${(drift.reduce((a, b) => a + b, 0) / (drift.length || 1)).toFixed(3)}, max ${Math.max(0, ...drift).toFixed(3)} over ${shared.length} transcripts.`);
  say();
}

console.log(out.join("\n"));
fs.writeFileSync(
  RESULTS,
  JSON.stringify({ model, qhash: QHASH, thresholds, archive: arch, conversations: conv.map(({ opener, ...c }) => c) }, null, 1),
);
console.error(`[done] Jev calls this run: ${jevCalls} (${jevFailed} failed). Results: ${path.relative(process.cwd(), RESULTS)}`);
