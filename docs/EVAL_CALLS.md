# Bouncer live-listen accuracy on phone calls (Flow 2 step 6)

Run on Nov 8, 2026 with **Jev `jev-1.14.0`**, the production call question set (`CALL_QUESTIONS` in `src/voice/questions.ts`), the production level logic (`riskLevel()` in `src/detection/risk.ts`, `config/thresholds.json`), and the alert logic of `src/voice/score.ts`. Every number comes from `npm run eval:calls -- report`, which rebuilds the numbers from cached Jev answers.

Two alert rules are reported side by side:

- **Old rule:** text alerts once the call's level is Likely scam or higher.
- **New gate** (commit `9636c0e`, in production now): the old rule, **plus** at least one of `asks_code`, `remote_access` or `money_or_code` must have reached 0.7 at some point in the call. `family_danger` still starts Flow 3 on its own.

## Slide one-liners

1. **Bouncer scored all 430 scam call scripts as Likely scam or higher (100%), with no misses.**
2. **On 37 multi-turn scam calls, the old rule texted an alert on 36. The first alert came on the caller's first scam line in 28 of them.**
3. **No normal call got a text: 0 of 22, under both rules.**

Before a slide uses these numbers, read the caveats: the archive is template-generated, and the 22 normal calls are easy.

## Headline numbers

| | Old rule | New gate (production) |
|---|---|---|
| Archive scam scripts at Likely+ (430) | **430 (100%)** | 430 (100%) |
| Archive scam scripts that get a text alert | **430 (100%)** | **326 (75.8%)** |
| BETTER30 scam calls that get a text alert (37) | **36 (97.3%)** | **16 (43.2%)** |
| BETTER30 legit calls that get a text alert (22) | **0** | **0** |
| BETTER30 ambiguous calls that get a text alert (6, reported separately) | 5 | 0 |
| Median delay, first scam line → first text (alerted scam calls) | **0 steps** | **3 steps** |
| Scam calls alerted by the call's midpoint | 36 of 37 | 12 of 37 |

**What the new gate costs:** on this data, it silences 20 of the 36 scam calls that the old rule caught, and every government-threat script in the archive (101 of 101). It removes **no** false alarm here, because the old rule already had none. The dataset can't show the false alarm the gate was built for (two teammates chatting); see "Caveats".

## Method

1. **Same request as production.** One `POST /v1/systemone` per scoring, with state `{ transcript: turns.join("\n") }` and the 8 `CALL_QUESTIONS`. There is no `known_contact`, which matches calls. The production `callerTranscript()` only drops speech aimed at Bouncer ("Hey Bouncer…"), and these datasets have none, so the transcripts are identical.
2. **Alert logic.** `score.ts` keeps `scoreOnce()` and `alert()` private, and its module imports the DB, Photon and Flow 3 code. So `scripts/eval-calls.ts` has a pure function, `simulate()`, that **mirrors them line by line**:
   - The level only goes up during a call.
   - Flags ≥ 0.7 build up across the call.
   - `family_danger` starts Flow 3 on its own, with no level gate. Flow 3 always texts, either coaching or the YES prompt.
   - Flag lines go out in the order asks_code, remote_access, money_or_code, impersonation, each at most once.
   - A level line goes out when the level rises and no flag line was sent in that round.
   - The new gate is optional, so both rules can be run.

   The simulation assumes a known user and that every send succeeds. One thing isn't reproduced: the Gemini brand lookup. It only changes wording, except that an impersonation line with no brand is skipped when family_danger is set. "No brand" is approximated as `scam_type = family_emergency`. This never changes whether a call gets *some* text.
3. **Concurrency and cache.** Requests run 6 at a time with `p-limit`. Answers are cached in `data/calls_jev_cache.json` (git-ignored), keyed by sha256(model, question-set hash, transcript), so no transcript text is stored. Per-row results (ids, probabilities, levels, alert keys) are written to `data/calls_eval_results.json`.
4. **Jev calls:**
   - 1,013 for the main run (430 archive scripts and 583 growing BETTER30 transcripts).
   - 633 for the family_danger rewording.
   - 1,013 for the `asks_personal_info` what-if.
   - Total: **2,659**, with 0 failures. Each set of about 1,000 took about 26 s.

### Data and cleaning

**`data/scams_archive_en.csv`, call rows only.** "Phone Call" has 1,429 rows and "Voice Call (Transcript)" has 275. Every row is labeled Scam.
- **Train sample:** 50 rows per (platform, scam_pattern) stratum, seed 42, giving 300 rows. There are 6 strata: tech_support_coldcall, bank_fraud_alert, identity_theft_govt_threat, charity_disaster_relief and fake_customer_support_callback for Phone Call, and deepfake_voice_clone, which is the only Voice Call pattern. Equal allocation gives each pattern a usable rate. A reweighted total is also reported; it's 100% either way.
- **Val + test:** all 130 call rows, scored once. They are all "Phone Call": bank_fraud_alert 49, identity_theft_govt_threat 51, charity_disaster_relief 30.
- **Turns:**
  - Phone Call rows are one monologue script, split into one sentence per turn.
  - Voice Call rows are split on `[Transcript]`. **Meta markers are removed**, for example `[Voice call transcript, caller ID spoofed as uncle]`, `[Transcript flagged by carrier as likely synthetic voice]` and `[Call ended]`. Speech-to-text never produces them, and they give the answer away.
- **Caveat:** these are template-generated scripts (`generation_template_id`). Many read like SMS ("Reply with the OTP…"). The is_scam minimum across all 430 rows was 0.86, so the set measures recall on obvious scripts only. There are no legit calls in it.

**`data/better30_en.csv`: 65 multi-turn calls, 650 rows.**
- **Duplicates:** 30 step rows repeat earlier steps of the same conversation further down the file (conversations 18, 19, 22, 23, 24 and 25). The first copy is kept; all the duplicates were identical.
- **Two speakers in one cell:** 139 TEXT cells hold two speakers joined by `[Step: n]`, and conversation 5 uses stage markers such as `[Attack Formulation]`. Each piece becomes its own turn.
- **Placeholders:** `[Your Name]` → "Alex", `[Fake Charity Name]` → "Hope Relief Fund", `[Region]` → "the coast".
- **Scoring:** the transcript is scored after each dataset step (1..k) with all turns so far. This is what live listen does after each stable turn. A step is about one speaker turn.

**Ground truth per conversation:**
- **scam:** any step labeled `scam`, `scam_response`, `potential_scam` or `highly_suspicious`. That's 37 conversations.
- **legit:** every step labeled `neutral` or `legitimate`. That's 22.
- **ambiguous:** everything else, meaning `suspicious` or `slightly_suspicious` steps with no scam step. That's 6 (1, 3, 4, 5, 24, 26). They are reported separately and never count as detections or false alarms.
- **Junk labels:** 10 cells hold feature text such as "citing urgency" or "polite_ending". All of them are in conversations that already have scam steps, so they don't affect the ground truth.
- **First scam step** = the first step with one of the scam labels. In 35 of 37 scam calls that's step 2, the caller's first line. Step 1 is always the callee's greeting.

## 1. Archive call scripts (all scams)

| platform/pattern | rows | Likely+ | Unsure+ | text (old) | text (new gate) | mean is_scam |
|---|---|---|---|---|---|---|
| phone/bank_fraud_alert | 50 + 49 | 100% | 100% | 100% | 100% | 0.96 |
| phone/charity_disaster_relief | 50 + 30 | 100% | 100% | 100% | 100% | 0.95 |
| phone/fake_customer_support_callback | 50 | 100% | 100% | 100% | **94%** | 0.95 |
| phone/identity_theft_govt_threat | 50 + 51 | 100% | 100% | 100% | **0%** | 0.96 |
| phone/tech_support_coldcall | 50 | 100% | 100% | 100% | 100% | 0.95 |
| voice/deepfake_voice_clone | 50 | 100% | 100% | 100% | 100% | 0.97 |
| **all (train sample 300 + val/test 130)** | 430 | **100%** | 100% | **100%** | **75.8%** | 0.96 |

All 430 rows land at High risk. **Worst misses: none.** No row was below Likely.

**Silenced by the new gate:** 104 of 430 rows (101 identity_theft_govt_threat and 3 fake_customer_support_callback). They are High risk with is_scam 0.94 to 0.98, but no concrete ask reaches 0.7:
- **SCA-014996** (govt): "Revenue Compliance Office: our records show an outstanding balance associated with your ID. We need to verify your identity…" Here money_or_code is 0.52.
- **SCA-014669** (govt): "official notice from National Benefits Agency… discrepancy in your filing…" Here money_or_code is 0.36.
- **SCA-015113** (callback): "To process your refund, I'll just need to verify your payment method… confirm your card number". Here money_or_code is 0.69, just under the bar.

These scams ask for **identity or card details**, and none of the three concrete-ask questions covers that.

Texts that would fire (archive, one scoring of the whole script):

| alert | old rule | new gate |
|---|---|---|
| impersonation | 302 (70%) | 198 (46%) |
| money_or_code | 290 (67%) | 290 (67%) |
| remote_access | 86 (20%) | 86 (20%) |
| asks_code | 75 (17%) | 75 (17%) |
| family_danger (Flow 3) | 11 (3%) | 11 (3%) |

Flag ≥ 0.7 rates by platform:

| flag | phone scripts (380) | voice-clone transcripts (50) |
|---|---|---|
| asks_code | 13.9% | 44.0% |
| remote_access | 22.6% | 0% |
| money_or_code | 63.2% | 100% |
| impersonation | 77.9% | 14.0% |
| urgency_secrecy | 94.2% | 100% |
| family_danger | 0% | **22.0%** |

`scam_type` is right for the clear patterns:
- bank_fraud_alert: bank_or_card 99/99
- identity_theft_govt_threat: government 99/101
- tech_support_coldcall: tech_support 50/50
- deepfake_voice_clone: family_emergency 38/50, government 12/50
- charity_disaster_relief: other 80/80. There is no charity option in `SCAM_TYPES`.

## 2. BETTER30: time to alert as the call grows

### Final verdict vs ground truth

The session level is the highest level reached during the call, and it's the same under both rules.

| truth | convs | final Safe | final Unsure | final Likely | final High | text (old) | text (new gate) |
|---|---|---|---|---|---|---|---|
| scam | 37 | 0 | 1 | 2 | 34 | **36 (97.3%)** | **16 (43.2%)** |
| legit | 22 | 19 | 3 | 0 | 0 | **0** | **0** |
| ambiguous | 6 | 0 | 1 | 1 | 4 | 5 | 0 |

### Time to first text

Delay = (step of the first text alert) − (first scam-labeled step). One step is one speaker turn, about 5 to 15 s of speech. On top of that come production latencies: a 1.2 s debounce plus a Jev call of about 0.3 to 0.5 s (`docs/API_NOTES.md`).

| delay (steps) | old rule | new gate |
|---|---|---|
| −3 (before the label) | 2 | 0 |
| 0 (on the first scam line) | **28** | 5 |
| 1 | 0 | 1 |
| 2 | 2 | 2 |
| 4 | 4 | 5 |
| 6 | 0 | 2 |
| 12 | 0 | 1 |
| never | 1 | **21** |

- **Old rule:** median 0, p90 4, max 4. The first alert comes at absolute step 2 (median), 6 at p90.
- **New gate:** median 3, p90 6, max 12. The first alert comes at absolute step 5 (median), 8 at p90.
- The −3 cases are conversations 2 and 25. Their labels only turn to `highly_suspicious` at step 5, but the caller opens with "National Tax Bureau legal department" or "Congratulations, you've been selected".
- **Late under the old rule** (delay 4): the charity calls 59, 60 and 64 and the software-licence call 48. A charity's opening pitch looks like a real one until the caller refuses verification and pushes urgency, so this is reasonable.
- **Missed under both rules:** conversation 68, a HelpNow Foundation charity call. It stayed Unsure the whole call (is_scam ≤ 0.55, max money_or_code 0.47), because the caller never asks for money outright.

**Silenced by the new gate** (caught under the old rule): 2, 25, 27, 30, 34, 37, 41, 43, 47, 48, 49, 51, 52, 53, 59, 60, 61, 62, 66 and 67.
- Many of them are fake tax agencies, police, bank fraud teams, ISP and "security" callers, and investment pitches. The callee in BETTER30 is a skeptical assistant who refuses early, so the scammer often never states a concrete ask before the call ends.
- A real victim would hear the ask. But in that case the alert under the new gate comes when money is already being discussed, not when the pretext starts.
- The **new gate also delays** the calls it still catches: 29, 33, 35, 39, 45, 50, 56, 57, 63 and 65 alert 1 to 12 steps later than under the old rule. For example, call 56 (fake IT department) alerts at step 14 instead of step 2.

### False alarms

- **Legit calls: 0 of 22 under both rules.** No legit call ever reached Likely. The highest were friend or acquaintance calls 21, 22 and 23, at Unsure with is_scam 0.47 to 0.55 ("Hey, it's Alex, trying to reach Alex"). Unsure doesn't text.
- **`impersonation` ≥ 0.7 fires on 11 of 22 legit calls** (7, 8, 9, 10, 15, 16, 17, 18, 19, 38, 40), for example Dr. Harris's office, a community center, SuperFix Home Services and Aunt Clara. Only the level gate keeps these from texting. Without it, as the SPEC's step 6 text reads ("one iMessage per newly crossed flag"), **11 of 22 legit calls would get "Likely scam: hang up. Real {brand} never calls you."**
- **Ambiguous calls** (old rule 5 of 6: 3, 4, 5, 24, 26). These are charity, bank and job callers that the dataset labels `suspicious` and that push urgency or ask for account details. Texting the user here is arguably right.

### family_danger

- **On non-family calls: never.** It fired 0 times on legit or ambiguous BETTER30 calls (including the legit Aunt Clara call), and 0 times on the 380 non-family archive scripts.
- **On family-emergency scams:** it fired at step 2 on all 4 BETTER30 calls (31, 54, 55 and 58: "Officer Davis… your grandson", "Emergency Medical Response Team…", "Oh thank goodness… your grandson / cousin").
- **But only 11 of 50 voice-clone transcripts (22%)** reached 0.7. Those transcripts are spoken *by the "relative"* in the first person ("It's me, I know this sounds crazy but I'm in trouble…", "I got into an accident and the officer needs payment…"). The question asks whether "**a family member** is hurt, arrested…". Scores were 0.55 to 0.85 when the speaker says "It's me" and 0.19 to 0.32 when there is no hint of a relative. These calls still get a money_or_code text, but **Flow 3 (safe-word coaching) doesn't start**, and the grandparent voice-clone call is exactly what it's for.

## 3. What-ifs (cached answers, no new Jev calls)

| policy | scam convs texted | median delay | legit texted | ambiguous texted | archive texted |
|---|---|---|---|---|---|
| old rule | 36/37 | 0 | 0/22 | 5/6 | 430/430 |
| old rule, no level gate on flag texts (SPEC wording) | 37/37 | 0 | **11/22** | 5/6 | 430/430 |
| old rule, likely 0.50 | 37/37 | 0 | 1/22 | 5/6 | 430/430 |
| old rule, likely 0.80 | 34/37 | 0 | 0/22 | 5/6 | 430/430 |
| **new gate (production now)** | **16/37** | 3 | 0/22 | 0/6 | 326/430 |
| new gate, asks at 0.6 | 19/37 | 2 | 0/22 | 1/6 | 336/430 |
| new gate, asks at 0.5 | 21/37 | 2 | 0/22 | 2/6 | 354/430 |
| new gate OR level high_risk | 34/37 | 0 | 0/22 | 4/6 | 430/430 |
| **new gate OR Likely+ on 2 scorings in a row** | **36/37** | 1 | 0/22 | 5/6 | 326/430\* |
| new gate OR Likely+ on 3 scorings in a row | 35/37 | 2 | 0/22 | 5/6 | 326/430\* |
| new gate OR (high_risk AND 2 in a row) | 34/37 | 1 | 0/22 | 4/6 | 326/430\* |

\* The archive is scored once per script, so a "2 in a row" rule can never pass there. In a live call, the same script would arrive turn by turn.

Two family_danger gates ("needs level ≥ unsure" or "≥ likely") change nothing on this data. Every family_danger trigger already sat at Likely+.

## 4. What-if: family_danger wording (633 extra Jev calls)

The variant is "Someone on the call says that **they, or** a member of the listener's family, have been hurt, arrested, **in an accident**, kidnapped or are in serious trouble." All other questions stay the same, in the same single request.

| | production wording | variant |
|---|---|---|
| voice-clone transcripts ≥ 0.7 (of 50) | 11 | **22** |
| BETTER30 scam calls where it fires | 4 (31, 54, 55, 58) | 5 (adds 43, QuickInsure "claim… accident") |
| BETTER30 legit / ambiguous calls where it fires | 0 / 0 | 0 / 0 |

Other answers barely move (mean |Δ is_scam| 0.008, max 0.07).

## 5. What-if: an `asks_personal_info` question that counts for the gate (1,013 extra Jev calls)

The question is "Someone asks the listener to give or confirm an account number, card number, Social Security number, ID number, password, or other personal or financial details." It is added to the same request and counts as a concrete ask. It has no text line of its own, so the level line is sent instead.

| policy (answers from the 9-question request) | scam convs texted | median delay | legit texted | ambiguous texted | archive texted |
|---|---|---|---|---|---|
| old rule | 36/37 | 0 | 0/22 | 5/6 | 430/430 |
| new gate | 18/37 | 4 | 0/22 | 0/6 | 325/430 |
| new gate + asks_personal_info ≥ 0.7 | 22/37 | 2 | 0/22 | 1/6 | **430/430** |
| same, all asks at 0.6 | 24/37 | 2 | 0/22 | 2/6 | 430/430 |

- It brings back all 104 silenced archive scripts, but only 4 BETTER30 calls. 15 scam calls stay silent because the caller never asks for anything concrete.
- It reaches 0.7 on 4 legit calls (15 doctor's office, 18 home services, 22, 42 subscription renewal). Those calls ask for or confirm details, which real businesses do. Only the level gate keeps them quiet.
- **Noise note:** just adding a question moved the new gate's own result from 16 to 18 of 37. Asks near 0.7 flip with small calibration shifts (mean |Δ is_scam| 0.006). Treat differences of 1 or 2 conversations as noise.

## Caveats

- **The false alarm the new gate was built for isn't in this data.** The 22 legit BETTER30 calls are polite service inquiries, and none of them got above Unsure. There are no hard negatives: no real bank fraud-department call, no real IRS call, no friends joking about money or chatting about scams. The gate's benefit can't be measured here, only its cost. **A small hard-negative call set is the most important missing piece.** It should include casual chats between friends or teammates, real bank and pharmacy callbacks, and a family call about a real accident.
- **The archive scripts are synthetic and saturated.** All 430 land at High. That shows the questions recognise the classic patterns, not that Bouncer separates hard cases.
- **BETTER30's "victim" is a skeptical AI assistant.** It pushes back from step 3 onward, so scammers rarely get as far as the ask. Real victims cooperate, which makes the gate's cost here an upper bound. Still, the *timing* cost (alerting only once the ask happens) holds for any victim.
- **Text only.** Real ASR errors, crosstalk and missing speaker labels on merged calls aren't simulated.
- **Brand lookup approximated** (see Method). It changes wording, not whether a text goes out.

## Recommendations (evidence above; not applied)

1. **Alert gating (owner: `score.ts`).** The concrete-ask gate as shipped costs 20 of 36 caught scam calls and all government-threat scripts, and on this data it removes no false alarm. Options that keep a guard against one-off spikes:
   - **Preferred:** "concrete ask **OR** the level is Likely+ on **2 scorings in a row**". That's 36/37 caught, median delay 1 step, 0/22 legit. A single spiky scoring from chatter can't text, while a scam call keeps scoring high turn after turn. Check it against the teammates-chat transcript that triggered the live false alarm before adopting it.
   - Or "concrete ask **OR** the level is high_risk". That's 34/37, delay 0, 0/22 legit. But if the live false alarm reached High, this doesn't stop it.
   - Or keep the gate and add `asks_personal_info` to `CONCRETE_ASKS`, for the identity and govt pattern: 22/37 calls and 430/430 archive.
2. **Keep the level gate on flag texts.** Never text a flag line below Likely: `impersonation` alone fires on 11 of 22 legit calls. The SPEC's step 6 text ("one iMessage per newly crossed flag ≥ 0.7") should be updated to match the code.
3. **Reword `family_danger`** to cover first-person callers: "Someone on the call says that they, or a member of the listener's family, have been hurt, arrested, in an accident, kidnapped or are in serious trouble." That doubles voice-clone triggers (11 → 22 of 50), with no new trigger on legit calls. Even so, more than half of voice-clone calls don't start Flow 3. Also consider starting Flow 3 when `scam_type = family_emergency` and the level is Likely+ (38 of 50 voice-clone rows have that scam_type).
4. **Impersonation line wording.** The impersonation line is the first text in most scam calls under the old rule, and it says "Real {brand} never calls you." That's wrong for charities, insurers, software vendors and law firms, which do call. Suggested: "Real {brand} won't pressure you on a call. Hang up and call them on a number you trust."
5. **Charity scams are the weakest pattern.** They are the latest alerts (4 steps) and the one miss (conversation 68), and `scam_type` has no charity option, so they come out as "other". Consider adding `charity` to `SCAM_TYPES` (this changes message calibration too; re-run `npm run eval`).
6. **Thresholds.** Leave `likely` at 0.62 for calls. 0.50 catches conversation 68 but adds a legit false alarm (1/22), and 0.80 loses 2 scam calls.
7. Before changing any of the above, **re-run `npm run eval:calls`** together with a hard-negative call set. Treat 1 or 2 conversation differences as noise.

## Reproduce

```bash
npm run eval:calls             # asks Jev only for transcripts not in data/calls_jev_cache.json, then prints the report
npm run eval:calls -- report   # cache only, no Jev calls
```

The cache key includes the question-set hash. If `CALL_QUESTIONS` wording changes, the affected answers are asked again. The script refuses an alias `JEV_MODEL` (e.g. `jev-latest`).
