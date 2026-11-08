// Wake / sign-off phrases for Flow 2 (no imports, so score.ts and talk.ts can both use them without a cycle).
//
// Bouncer stays silent until someone ADDRESSES it by name. No set phrases to remember (elderly users):
//   - a greeting + the name anywhere: "Hey/Hi/Hello/Yo/Okay/Hiya/Good morning Bouncer";
//   - the name at the start ("Bouncer, help", "Bouncer?") or at the end after a comma ("…, Bouncer?");
//   - the name anywhere in a question or request ("was that a scam Bouncer", "what do you say Bouncer",
//     "Bouncer do you wanna pitch in?", "okay Bouncer is this a scam").
// An incidental mention ("the bouncer at the club wouldn't let us in") stays silent: a name right after
// "the/a/my/…" never wakes on its own. Anything in between is "maybe" and Jev breaks the tie (talk.ts).
// Speech-to-text variants: "Bouncers", "Bouncer's", "bounce her" ("bounce her" only next to a greeting or at
// the start/end, since it's a real phrase mid-sentence). "Bowser" is left out on purpose: a common name.

const NAME = String.raw`(?:bouncer|bouncers|bouncer's|bounce her)`;
const GREETING = String.raw`(?:hey|hi|hello|hallo|hullo|hiya|heya|yo|howdy|ok(?:ay)?|good (?:morning|afternoon|evening))`;
const SEP = String.raw`[,.!…\s]*\s`;

/** A greeting followed by the name, anywhere in the turn ("…read me the code. Hello Bouncer, is this real?"). */
export const WAKE = new RegExp(String.raw`\b${GREETING}(?:${SEP}there)?${SEP}${NAME}\b(?!['’])`, "i");

/** "Thanks Bouncer" / "Thank you, Bouncer". */
export const THANKS = new RegExp(String.raw`\b(?:thanks?|thank you|thank u|thx|cheers)${SEP}${NAME}\b`, "i");

/** Wake greeting or thanks, for stripping speech aimed at Bouncer out of what Jev scores (score.ts). */
export const WAKE_ANY = new RegExp(`${WAKE.source}|${THANKS.source}`, "i");

/** Small words people put before a name or a question ("okay so Bouncer…"). */
const LEAD = String.raw`(?:(?:so|and|but|ok(?:ay)?|um+|uh+|hmm+|well|alright|all right|wait|oh|yo|hey|now|listen)[,.!]?\s+)*`;

/** The name first in the turn, then punctuation or the end: "Bouncer, …", "Bouncer?", "Okay Bouncer." */
export const NAME_FIRST = new RegExp(String.raw`^\W*${LEAD}${NAME}(?:\s*[,?!.:…]|\s*$)`, "i");

/** "…, Bouncer?" / "…, Bouncer." — the name last, after a comma. */
const NAME_LAST_COMMA = new RegExp(String.raw`,\s*${NAME}\s*[?.!…]*\s*$`, "i");

/** A question or request in the turn (aimed at whoever is named). */
const WH = String.raw`(?:what|what's|whats|why|how|who|where|when|which|any)`;
const AUX = String.raw`(?:is|are|was|were|do|does|did|can|could|would|will|should|shall|may|might|have|has|am)`;
const PRONOUN = String.raw`(?:this|that|it|he|she|they|there|i|we|you|someone|somebody|anyone)`;
const QUESTION_START = new RegExp(
  // "Bouncer, is …" / "Bouncer what …" / "Bouncer is this …" ("Bouncer is my dog's name" is not a question).
  String.raw`^\W*${LEAD}(?:${NAME}[,.!:]?\s+(?=${WH}\b|${AUX}\s+${PRONOUN}\b)|${NAME}[,.!:]\s+)?(?:${WH}|${AUX})\b`,
  "i",
);
const REQUEST =
  /\b(?:tell me|help|pitch in|chime in|weigh in|jump in|step in|what do you (?:think|say|reckon|make of)|what(?:'s| is) your (?:opinion|take|view|read)|your (?:opinion|thoughts|take)|any (?:advice|ideas|thoughts|tips)|advise|explain|do you (?:wanna|want to)|talk to me|listen to (?:this|that)|check (?:this|that))\b/i;
export const isQuestionOrRequest = (t: string) => /\?/.test(t) || QUESTION_START.test(t) || REQUEST.test(t);

/** "the bouncer", "a bouncer", "my bouncer": a mention of a person/thing, not Bouncer being addressed. */
const DETERMINER = /\b(?:the|a|an|that|those|these|my|his|her|our|your|their|some|one|no|every|as)\s+$/i;
const NAME_G = new RegExp(String.raw`\b${NAME}\b(?!['’]\w)`, "gi");

/**
 * Is the turn addressed to Bouncer?
 *   "wake"  — greeting + name, name first/last, or the name (not after "the/a/my…") in a question/request.
 *   "maybe" — the name appears but the form is ambiguous: ask Jev (talk.ts, ≤ 700 ms).
 *   null    — no name, or only an incidental mention in a statement.
 */
export function wakeCue(t: string): "wake" | "maybe" | null {
  if (!t) return null;
  if (WAKE.test(t)) return "wake";
  const mentions = [...t.matchAll(NAME_G)].map((m) => ({
    word: m[0].toLowerCase(),
    det: DETERMINER.test(t.slice(0, m.index)),
  }));
  if (!mentions.length) return null;
  const question = isQuestionOrRequest(t);
  const bare = mentions.filter((m) => !m.det);
  if (!bare.length) return question ? "maybe" : null; // "did you see the bouncer at the club?" → Jev
  if (NAME_FIRST.test(t) || NAME_LAST_COMMA.test(t)) return "wake";
  // "bounce her" mid-sentence is usually the real phrase; only a real "Bouncer" wakes on question form.
  if (question && bare.some((m) => m.word !== "bounce her")) return "wake";
  return "maybe";
}
