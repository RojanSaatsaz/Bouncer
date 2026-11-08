// Risk level, set in code from Jev's probabilities (SPEC Flow 1 step 8). Used by messages and calls.
// Thresholds live in config/thresholds.json (written by `npm run eval`, Flow 6).
import fs from "node:fs";
import path from "node:path";

export type RiskLevel = "safe" | "unsure" | "likely_scam" | "high_risk";
export const LEVEL_ORDER: RiskLevel[] = ["safe", "unsure", "likely_scam", "high_risk"];
export const LEVEL_LABEL: Record<RiskLevel, string> = {
  safe: "Looks safe",
  unsure: "Not sure",
  likely_scam: "Likely scam",
  high_risk: "High risk scam",
};

export interface Thresholds {
  jev_model: string | null;
  unsure: number;
  likely: number;
  high: number;
  asks_code_severe: number;
  combo_severe: number;
  known_contact_discount: number;
  flag: number;
  callback_flag: number;
}

const DEFAULTS: Thresholds = {
  jev_model: null,
  unsure: 0.35,
  likely: 0.6,
  high: 0.85,
  asks_code_severe: 0.8,
  combo_severe: 0.6,
  known_contact_discount: 0.15,
  flag: 0.6,
  callback_flag: 0.7,
};

export const THRESHOLDS_PATH = path.resolve(process.cwd(), "config/thresholds.json");

function load(): Thresholds {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(THRESHOLDS_PATH, "utf8")) };
  } catch {
    return DEFAULTS;
  }
}

export let thresholds: Thresholds = load();
export const reloadThresholds = () => (thresholds = load());

export interface RiskInput {
  is_scam: number;
  asks_code?: number;
  money_or_code?: number;
  urgency_secrecy?: number;
  impersonation?: number;
  knownContact?: boolean;
  /**
   * Messages only: every message red-flag probability (MESSAGE_FLAGS). When given, Likely or above needs
   * a red flag other than impersonation unless severe; otherwise the level is capped at Unsure.
   * Approved 2026-11-08 (docs/EVAL_ARCHIVE.md): archive test false alarms 60 → 1 with no scam lost;
   * Mendeley train 4 → 1, 3 of 150 smishing moved to Unsure. Calls don't pass it.
   */
  messageFlags?: Record<string, number>;
}

export interface Risk {
  level: RiskLevel;
  /** Adjusted probability that it's a scam. */
  p: number;
  severe: boolean;
  /** Level was capped at Unsure by the needs-a-red-flag rule (scam score alone was Likely+). */
  capped: boolean;
  /** Number to show the user: p% for scam levels and Unsure, (1-p)% for Safe. */
  confidence: number;
}

export function riskLevel(x: RiskInput, t: Thresholds = thresholds): Risk {
  const severe =
    (x.asks_code ?? 0) >= t.asks_code_severe ||
    ((x.money_or_code ?? 0) >= t.combo_severe &&
      (x.urgency_secrecy ?? 0) >= t.combo_severe &&
      (x.impersonation ?? 0) >= t.combo_severe);
  let p = x.is_scam;
  if (x.knownContact && !severe) p = Math.max(0, p - t.known_contact_discount);
  let level: RiskLevel =
    severe || p >= t.high ? "high_risk" : p >= t.likely ? "likely_scam" : p >= t.unsure ? "unsure" : "safe";
  let capped = false;
  if (x.messageFlags && !severe && atLeast(level, "likely_scam")) {
    const others = Object.keys(x.messageFlags).filter((f) => f !== "impersonation");
    if (!flagsFrom(x.messageFlags, others, t).length) {
      level = "unsure";
      capped = true;
    }
  }
  const confidence = Math.round((level === "safe" ? 1 - p : p) * 100);
  return { level, p, severe, capped, confidence };
}

/** Red-flag names at or above threshold. `callback` uses its own (higher) bar. */
export function flagsFrom(probs: Record<string, number>, names: string[], t: Thresholds = thresholds): string[] {
  return names.filter((n) => (probs[n] ?? 0) >= (n === "callback" ? t.callback_flag : t.flag));
}

export const atLeast = (level: RiskLevel, min: RiskLevel) => LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(min);
