// Safe word encryption and comparison (CLAUDE.md rule 2, SPEC Flow 3 step 3 + 8).
// AES-256-GCM with SAFE_WORD_KEY (base64, 32 bytes), random 12-byte IV, circle id as associated data
// so a stored word can't be copied onto another circle. The plain word is never logged, stored or spoken.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

export interface EncryptedWord {
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
}

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const k = Buffer.from(config.safeWordKey, "base64");
  if (k.length !== 32) {
    throw new Error("SAFE_WORD_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).");
  }
  return (cachedKey = k);
}

/** Lowercase, strip punctuation, collapse spaces. "Purple-Elephant!" → "purple elephant". */
export function normalizeWord(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/['’`]/g, "") // "grandma's" → "grandmas"
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function encryptWord(plain: string, circleId: string): EncryptedWord {
  const word = normalizeWord(plain);
  if (!word) throw new Error("The safe word is empty after normalising.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(circleId));
  const ciphertext = Buffer.concat([cipher.update(word, "utf8"), cipher.final()]);
  return { ciphertext, iv, auth_tag: cipher.getAuthTag() };
}

/** Throws if the key, circle id or data don't match (GCM auth). Keep the result in a local variable only. */
export function decryptWord(enc: EncryptedWord, circleId: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key(), enc.iv);
  decipher.setAAD(Buffer.from(circleId));
  decipher.setAuthTag(enc.auth_tag);
  return Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Edit distance (insert, delete, substitute, or swap two neighbouring letters = 1 each), with an early
 * exit once it exceeds `max`. "elephent" and "elpehant" are 1 away from "elephant"; "elefant" is 2.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

// One letter of slack per word for speech-to-text errors; very short words must match exactly.
const slack = (w: string) => (w.length >= 3 ? 1 : 0);

/**
 * True if the spoken text contains the safe word: same number of words in a row, each within one
 * letter (edit distance ≤ 1). Also accepts the word run together or split ("blue berry" / "blueberry").
 * Long rambles are rejected so a caller can't list many guesses in one turn.
 */
export function wordsMatch(spoken: string, secret: string): boolean {
  const said = normalizeWord(spoken).split(" ").filter(Boolean);
  const want = normalizeWord(secret).split(" ").filter(Boolean);
  const n = want.length;
  if (!n || !said.length || said.length > n + 8) return false;

  for (let i = 0; i + n <= said.length; i++) {
    if (want.every((w, k) => editDistance(said[i + k], w, slack(w)) <= slack(w))) return true;
  }

  // Split or run-together forms: compare letters only, one letter of slack in total.
  const joined = want.join("");
  const budget = slack(joined);
  for (let size = Math.max(1, n - 1); size <= n + 1; size++) {
    if (size === n) continue; // handled word-by-word above
    for (let i = 0; i + size <= said.length; i++) {
      const cand = said.slice(i, i + size).join("");
      if (editDistance(cand, joined, budget) <= budget) return true;
    }
  }
  return false;
}
