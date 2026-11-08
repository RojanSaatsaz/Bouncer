// Flow 6 metrics: scoring cached Jev answers with the live level logic, threshold picking, and tables.
// Uses src/detection/risk.ts exactly as live detection does, so the eval measures the same thing.
import type { JevAnswer } from "../src/detection/jev.js";
import { MESSAGE_FLAGS } from "../src/detection/questions.js";
import { atLeast, flagsFrom, LEVEL_ORDER, riskLevel, type RiskLevel, type Thresholds } from "../src/detection/risk.js";

export interface Scored {
  id: number | string;
  label: string;
  probs: Record<string, number>; // every noul answer
  scamType: string | null;
  scamTypeConf: number;
  p: number;
  severe: boolean;
  level: RiskLevel;
  confidence: number;
  flags: string[];
}

export function nouls(answers: Record<string, JevAnswer>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, a] of Object.entries(answers)) if (a.type === "noul") out[k] = a.noul;
  return out;
}

const riskInput = (probs: Record<string, number>) => ({
  is_scam: probs.is_scam ?? 0,
  asks_code: probs.asks_code,
  money_or_code: probs.money_or_code,
  urgency_secrecy: probs.urgency_secrecy,
  impersonation: probs.impersonation,
  knownContact: false, // eval rows have no contact history
  messageFlags: Object.fromEntries(MESSAGE_FLAGS.map((f) => [f, probs[f] ?? 0])),
});

export function score(id: number | string, label: string, answers: Record<string, JevAnswer>, t: Thresholds): Scored {
  const probs = nouls(answers);
  const r = riskLevel(riskInput(probs), t);
  const st = answers.scam_type;
  return {
    id,
    label,
    probs,
    scamType: st?.type === "choice" ? st.choice : null,
    scamTypeConf: st?.type === "choice" ? st.confidence : 0,
    p: r.p,
    severe: r.severe,
    level: r.level,
    confidence: r.confidence,
    flags: flagsFrom(probs, MESSAGE_FLAGS, t),
  };
}

const levelWith = (probs: Record<string, number>, t: Thresholds) => riskLevel(riskInput(probs), t).level;
const likelyPlus = (l: RiskLevel) => atLeast(l, "likely_scam");
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export type Weights = Record<string, number>;

// ---------------------------------------------------------------- threshold picking (Flow 6 step 4)

export interface Targets {
  hamFalseAlarm: number; // Likely or above, share of ham
  highPrecision: number; // High risk, smishing share (prevalence-weighted)
  unsureRecall: number; // Unsure or above, share of smishing
}
export const TARGETS: Targets = { hamFalseAlarm: 0.02, highPrecision: 0.97, unsureRecall: 0.95 };

interface Point {
  t: number;
  hamFa: number; // ham at Likely+ (count) with likely = t
  recallLikely: number; // smishing at Likely+ (count) with likely = t
  hamHigh: number; // ham at High with high = t
  smHigh: number; // smishing at High with high = t
  precHighW: number; // weighted precision of High with high = t (NaN if empty)
  recallUnsure: number; // smishing at Unsure+ (count) with unsure = t
}

/** Midpoints between consecutive distinct p values, plus the ends: every threshold that changes a level. */
function candidates(rows: { probs: Record<string, number> }[]): number[] {
  const ps = [...new Set(rows.map((r) => r.probs.is_scam ?? 0))].sort((a, b) => a - b);
  const mids = ps.slice(1).map((v, i) => r3((ps[i] + v) / 2));
  return [...new Set([0, ...mids, r3(Math.max(1, ps[ps.length - 1] ?? 0) + 0.001)])].sort((a, b) => a - b);
}

export function sweep(rows: { label: string; probs: Record<string, number> }[], base: Thresholds, w: Weights, ts: number[]): Point[] {
  const ham = rows.filter((r) => r.label === "ham");
  const sm = rows.filter((r) => r.label === "smishing");
  return ts.map((t) => {
    // With likely = high = t, both "Likely or above" and "High risk" are exactly: severe || p >= t.
    const asTop = { ...base, unsure: 0, likely: t, high: t };
    const asUnsure = { ...base, unsure: t, likely: t, high: t };
    const hamFa = ham.filter((r) => likelyPlus(levelWith(r.probs, asTop))).length;
    const recallLikely = sm.filter((r) => likelyPlus(levelWith(r.probs, asTop))).length;
    const hamHigh = ham.filter((r) => levelWith(r.probs, asTop) === "high_risk").length;
    const smHigh = sm.filter((r) => levelWith(r.probs, asTop) === "high_risk").length;
    const tpW = smHigh * (w.smishing ?? 1);
    const fpW = hamHigh * (w.ham ?? 1);
    const recallUnsure = sm.filter((r) => atLeast(levelWith(r.probs, asUnsure), "unsure")).length;
    return { t, hamFa, recallLikely, hamHigh, smHigh, precHighW: tpW + fpW ? tpW / (tpW + fpW) : NaN, recallUnsure };
  });
}

/** The spec's Unsure floor (Flow 1 step 8). Tuning may lower it to reach the recall target, never raise it. */
export const SPEC_UNSURE = 0.35;

export interface Picks {
  unsure: number;
  likely: number;
  high: number;
  why: string[];
}

export function pickThresholds(rows: { label: string; probs: Record<string, number> }[], base: Thresholds, w: Weights, tg = TARGETS): Picks {
  const nHam = rows.filter((r) => r.label === "ham").length;
  const nSm = rows.filter((r) => r.label === "smishing").length;
  const pts = sweep(rows, base, w, [...new Set([...candidates(rows), SPEC_UNSURE])].sort((a, b) => a - b));
  const why: string[] = [];

  // Likely: among thresholds within the ham false-alarm budget, catch the most smishing; among those,
  // take the highest (fewest false alarms). Candidates are midpoints, so it sits halfway between scores.
  const ok = pts.filter((x) => x.hamFa / nHam <= tg.hamFalseAlarm);
  if (!ok.length) throw new Error("No Likely threshold meets the ham false-alarm target: the severe rule alone is over it.");
  const best = Math.max(...ok.map((x) => x.recallLikely));
  const lk = ok.filter((x) => x.recallLikely === best).at(-1)!;
  why.push(
    `likely ${lk.t}: most smishing caught (${lk.recallLikely}/${nSm}) with ham at Likely+ <= ${tg.hamFalseAlarm * 100}%, then fewest false alarms ` +
      `(${lk.hamFa}/${nHam} = ${pct(lk.hamFa, nHam)}; the lowest in-budget threshold ${ok[0].t} catches the same ${ok[0].recallLikely} with ${ok[0].hamFa} ham)`,
  );

  // High: the lowest threshold >= likely from which weighted precision stays >= target all the way up.
  const up = pts.filter((x) => x.t >= lk.t);
  let hi = up[up.length - 1];
  for (let i = up.length - 1; i >= 0; i--) {
    if (Number.isNaN(up[i].precHighW) || up[i].precHighW >= tg.highPrecision) hi = up[i];
    else break;
  }
  if (!Number.isNaN(hi.precHighW) && hi.precHighW < tg.highPrecision)
    why.push(`WARNING: High precision target not reachable; even with only the severe rule it is ${pct(hi.precHighW, 1)}`);
  why.push(`high ${hi.t}: lowest threshold (>= likely) where High-risk precision stays >= ${tg.highPrecision * 100}% (weighted ${pct(hi.precHighW, 1)}; ${hi.smHigh} smishing, ${hi.hamHigh} ham at High)`);

  // Unsure: the spec floor, lowered if needed so >= target of smishing lands at Unsure or above. When the
  // target is slack (every floor up to Likely meets it) we keep the spec value instead of closing the band.
  const meets = pts.filter((x) => x.t <= Math.min(lk.t, SPEC_UNSURE) && x.recallUnsure / nSm >= tg.unsureRecall);
  const un = meets.at(-1) ?? pts[0];
  const highestOk = pts.filter((x) => x.t <= lk.t && x.recallUnsure / nSm >= tg.unsureRecall).at(-1);
  why.push(
    `unsure ${un.t}: highest floor <= min(likely, spec ${SPEC_UNSURE}) with smishing at Unsure+ >= ${tg.unsureRecall * 100}% ` +
      `(${un.recallUnsure}/${nSm} = ${pct(un.recallUnsure, nSm)}; the target alone would allow up to ${highestOk?.t ?? "none"})`,
  );

  return { unsure: un.t, likely: lk.t, high: hi.t, why };
}

// ---------------------------------------------------------------- tables

export function md(head: string[], body: (string | number)[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

export function sweepTable(rows: { label: string; probs: Record<string, number> }[], base: Thresholds, w: Weights): string {
  const nHam = rows.filter((r) => r.label === "ham").length;
  const nSm = rows.filter((r) => r.label === "smishing").length;
  const grid = Array.from({ length: 19 }, (_, i) => r3(0.05 * (i + 1)));
  return md(
    ["t", "ham at Likely+ (likely=t)", "smishing at Likely+", "High precision, weighted (high=t)", "smishing at Unsure+ (unsure=t)"],
    sweep(rows, base, w, grid).map((x) => [
      x.t,
      `${x.hamFa} (${pct(x.hamFa, nHam)})`,
      `${x.recallLikely} (${pct(x.recallLikely, nSm)})`,
      Number.isNaN(x.precHighW) ? "n/a" : `${pct(x.precHighW, 1)} (${x.smHigh} sm / ${x.hamHigh} ham)`,
      `${x.recallUnsure} (${pct(x.recallUnsure, nSm)})`,
    ]),
  );
}

const count = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;

export interface Headline {
  n: Record<string, number>;
  caught: number; // smishing at Likely+
  hamFlagged: number; // ham at Likely+
  spamFlagged: number;
  flagsRight: number; // caught / (caught + hamFlagged), unweighted
  flagsRightW: number; // prevalence-weighted (tune sample only)
  highSm: number;
  highHam: number;
  unsure: Record<string, number>;
  auc: number;
}

export function headline(rows: Scored[], w: Weights = {}): Headline {
  const by = (l: string) => rows.filter((r) => r.label === l);
  const [ham, sm, spam] = [by("ham"), by("smishing"), by("spam")];
  const caught = count(sm, (r) => likelyPlus(r.level));
  const hamFlagged = count(ham, (r) => likelyPlus(r.level));
  const ws = w.smishing ?? 1;
  const wh = w.ham ?? 1;
  return {
    n: { ham: ham.length, smishing: sm.length, spam: spam.length },
    caught,
    hamFlagged,
    spamFlagged: count(spam, (r) => likelyPlus(r.level)),
    flagsRight: caught / (caught + hamFlagged),
    flagsRightW: (ws * caught) / (ws * caught + wh * hamFlagged),
    highSm: count(sm, (r) => r.level === "high_risk"),
    highHam: count(ham, (r) => r.level === "high_risk"),
    unsure: Object.fromEntries(["ham", "smishing", "spam"].map((l) => [l, count(by(l), (r) => r.level === "unsure")])),
    auc: auc(sm.map((r) => r.p), ham.map((r) => r.p)),
  };
}

/** Mann-Whitney AUC: chance a random smishing row has a higher is_scam than a random ham row (ties count half). */
export function auc(pos: number[], neg: number[]): number {
  const all = [...pos.map((v) => ({ v, pos: true })), ...neg.map((v) => ({ v, pos: false }))].sort((a, b) => a.v - b.v);
  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j].v === all[i].v) j++;
    const avg = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (all[k].pos) rankSum += avg;
    i = j;
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

export function headlineText(h: Headline, opts: { weighted?: boolean } = {}): string {
  const { ham, smishing, spam } = h.n;
  const lines = [
    `- Scams caught (smishing at Likely or above): **${h.caught} of ${smishing}** = ${pct(h.caught, smishing)}`,
    `- Flags right (smishing share of everything at Likely or above, ham + smishing): **${h.caught} of ${h.caught + h.hamFlagged}** = ${pct(h.caught, h.caught + h.hamFlagged)}` +
      (opts.weighted ? ` (reweighted to the real train mix: ${pct(h.flagsRightW, 1)})` : ""),
    `- Real messages flagged (ham at Likely or above): **${h.hamFlagged} of ${ham}** = ${pct(h.hamFlagged, ham)}`,
    `- High risk: ${h.highSm} smishing, ${h.highHam} ham`,
    `- In Unsure: ham ${h.unsure.ham}/${ham} (${pct(h.unsure.ham, ham)}), smishing ${h.unsure.smishing}/${smishing} (${pct(h.unsure.smishing, smishing)}), spam ${h.unsure.spam}/${spam} (${pct(h.unsure.spam, spam)})`,
    `- Spam (reported separately, not fraud): ${h.spamFlagged} of ${spam} at Likely or above = ${pct(h.spamFlagged, spam)}`,
    `- AUC of is_scam, smishing vs ham: ${h.auc.toFixed(4)}`,
  ];
  return lines.join("\n");
}

export function levelTable(rows: Scored[], labels = ["ham", "smishing", "spam"]): string {
  return md(
    ["label", ...LEVEL_ORDER, "total"],
    labels.map((l) => {
      const xs = rows.filter((r) => r.label === l);
      return [l, ...LEVEL_ORDER.map((lv) => `${count(xs, (r) => r.level === lv)} (${pct(count(xs, (r) => r.level === lv), xs.length)})`), xs.length];
    }),
  );
}

export function scamTypeTable(rows: Scored[]): string {
  const sm = rows.filter((r) => r.label === "smishing");
  const types = [...new Set(sm.map((r) => r.scamType ?? "none"))];
  const body = types
    .map((t) => {
      const xs = sm.filter((r) => (r.scamType ?? "none") === t);
      return { t, n: xs.length, caught: count(xs, (r) => likelyPlus(r.level)) };
    })
    .sort((a, b) => b.n - a.n)
    .map((x) => [x.t, x.n, pct(x.n, sm.length), `${x.caught} (${pct(x.caught, x.n)})`]);
  return md(["Jev scam_type", "smishing rows", "share", "caught (Likely+)"], body);
}

/** Does the severe rule (asks_code, or the 3-way combo) push ham to High on its own? */
export function severeTable(rows: Scored[], t: Thresholds): string {
  const lines: (string | number)[][] = [];
  for (const l of ["ham", "smishing", "spam"]) {
    const xs = rows.filter((r) => r.label === l);
    const ac = count(xs, (r) => (r.probs.asks_code ?? 0) >= t.asks_code_severe);
    const combo = count(
      xs,
      (r) => (r.probs.money_or_code ?? 0) >= t.combo_severe && (r.probs.urgency_secrecy ?? 0) >= t.combo_severe && (r.probs.impersonation ?? 0) >= t.combo_severe,
    );
    const only = count(xs, (r) => r.severe && r.p < t.likely); // raised to High only because of severe
    lines.push([l, xs.length, `${ac} (${pct(ac, xs.length)})`, `${combo} (${pct(combo, xs.length)})`, `${only} (${pct(only, xs.length)})`]);
  }
  return md(["label", "rows", `asks_code >= ${t.asks_code_severe}`, `combo >= ${t.combo_severe}`, "severe with is_scam < likely (severe alone made it High)"], lines);
}

/** How often each red flag fires on ham vs smishing, at a few thresholds. */
export function flagTable(rows: Scored[]): string {
  const ham = rows.filter((r) => r.label === "ham");
  const sm = rows.filter((r) => r.label === "smishing");
  const ts = [0.5, 0.6, 0.7, 0.8, 0.9];
  return md(
    ["flag", ...ts.map((t) => `>= ${t} ham / smishing`)],
    MESSAGE_FLAGS.map((f) => [
      f,
      ...ts.map((t) => `${pct(count(ham, (r) => (r.probs[f] ?? 0) >= t), ham.length)} / ${pct(count(sm, (r) => (r.probs[f] ?? 0) >= t), sm.length)}`),
    ]),
  );
}

/** What replies would show at different `flag` values (callback keeps its own bar unless it is lower). */
export function flagSummary(rows: Scored[], t: Thresholds): string {
  const ham = rows.filter((r) => r.label === "ham");
  const sm = rows.filter((r) => r.label === "smishing");
  const safeHam = ham.filter((r) => r.level === "safe");
  const smLikely = sm.filter((r) => likelyPlus(r.level));
  const body = [0.5, 0.6, 0.7, 0.8].map((f) => {
    const tf = { ...t, flag: f, callback_flag: Math.max(f, t.callback_flag) };
    const fl = (r: Scored) => flagsFrom(r.probs, MESSAGE_FLAGS, tf);
    const shown = smLikely.map((r) => fl(r).length);
    return [
      `${f}${f === t.flag ? " (current)" : ""}`,
      `${count(safeHam, (r) => fl(r).length > 0)} of ${safeHam.length} (${pct(count(safeHam, (r) => fl(r).length > 0), safeHam.length)})`,
      `${count(shown, (n) => n === 0)} of ${smLikely.length}`,
      shown.length ? (shown.reduce((a, b) => a + b, 0) / shown.length).toFixed(2) : "-",
    ];
  });
  return md(["flag threshold", "ham rated Safe showing >= 1 red flag", "smishing at Likely+ with no red flag", "avg red flags on smishing at Likely+"], body);
}

export const fmtP = (x: number | undefined) => (x === undefined ? "-" : x.toFixed(2));
export { pct, likelyPlus };
