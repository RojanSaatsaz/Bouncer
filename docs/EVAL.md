# Bouncer accuracy test (Flow 6)

Run on Nov 8, 2026, about 4 AM, with **Jev `jev-1.14.0`** and the exact question set and level logic used by live detection (`src/detection/questions.ts`, `src/detection/risk.ts`). Every number below comes from `npm run eval -- report`, which rebuilds them from cached Jev answers without calling Jev again.

## Slide one-liners

1. **Bouncer caught 104 of 106 scam texts (98%) in 1,160 messages it never saw during tuning.**
2. **Only 19 of 967 normal texts (2%) were flagged as scams. When Bouncer says "scam", it's right 85% of the time (104 of 123).**
3. **On 30 current U.S. texts (tolls, Zelle, Coinbase, fake jobs), Bouncer flagged 16 of 17 scams and called none of them "Looks safe".**

## Headline numbers (holdout, scored once)

| | Result | Count |
|---|---|---|
| **Scams caught** (smishing at Likely or above ÷ all smishing) | **98.1%** | caught 104 of 106 |
| **Flags right** (smishing ÷ everything at Likely or above, ham + smishing) | **84.6%** | 104 of 123 |
| **Real messages flagged** (ham at Likely or above ÷ all ham) | **2.0%** | 19 of 967 |

Other holdout numbers:
- At least Unsure: 105 of 106 smishing (99.1%). Only 1 scam was called "Looks safe".
- High risk precision: 99 smishing and 10 ham, so **90.8%**. That **misses the 97% target**, while the tuning sample showed 97.7% with 1 ham. See "What went wrong".
- AUC of `is_scam`, smishing vs ham: 0.998.

### Per-level breakdown (holdout, 1,160 rows)

| label | Safe | Unsure | Likely scam | High risk | total |
|---|---|---|---|---|---|
| ham | 910 (94.1%) | 38 (3.9%) | 9 (0.9%) | 10 (1.0%) | 967 |
| smishing | 1 (0.9%) | 1 (0.9%) | 5 (4.7%) | 99 (93.4%) | 106 |
| spam | 7 (8.0%) | 12 (13.8%) | 29 (33.3%) | 39 (44.8%) | 87 |

**Share in Unsure:** ham 3.9% (38/967), smishing 0.9% (1/106), spam 13.8% (12/87).

**Spam (reported separately, not counted as a scam or a false alarm):** 68 of 87 spam texts (78.2%) were rated Likely or above. Jev treats aggressive marketing ("you've won, call 0906…") much like fraud. On the dashboard that's a "spam" row, not a false alarm.

### Scam types (smishing rows, holdout)

This comes from Jev's `scam_type` Choice answer, already part of the one request per message, instead of a separate Gemini call. That keeps "Jev decides, Gemini words": no extra model and no extra cost.

| scam_type | smishing rows | share | caught |
|---|---|---|---|
| job_or_prize | 65 | 61.3% | 65 (100%) |
| other | 16 | 15.1% | 15 (93.8%) |
| bank_or_card | 15 | 14.2% | 14 (93.3%) |
| romance_or_investment | 7 | 6.6% | 7 (100%) |
| tech_support | 2 | 1.9% | 2 (100%) |
| government | 1 | 0.9% | 1 (100%) |

The dataset is mostly UK and Indian SMS from around 2012, so it's dominated by prize and "call this number" texts. There are no toll or delivery scams. The scout set below covers those.

## Method

1. **Data.** `data/mendeley_clean.csv` holds 5,797 deduplicated Mendeley messages. The spec's 5,971 and ~1,194 holdout are counts from before deduplication. The fixed `split` column is seed 42. Before anything runs, `scripts/eval-data.ts` checks the split against `data/holdout.json`; they matched with all 1,160 ids. CSV parsing is our own RFC 4180 parser, cross-checked against Python's `csv` (same rows, same text hash).
2. **Labels.** Positive = `smishing`, negative = `ham`. `spam` is reported on its own row and never enters precision or false-alarm numbers.
3. **Jev.** One `POST /v1/systemone` per message asks exactly the 8 `MESSAGE_QUESTIONS` (`impersonation, money_or_code, urgency_secrecy, link_mismatch, asks_code, callback, is_scam, scam_type`). For Mendeley, state = `{ body }` only (no sender, `known_contact` false). For scout, state = `{ body, sender }`. Requests run 8 at a time with `p-limit`, and `askJev` retries 429 and 5xx. We made 1,790 calls in total (600 + 1,160 + 30) with 0 failures, about 50 rows per second (the 1,160-row holdout took 24 s).
4. **Levels.** Each answer goes through `riskLevel()` and `flagsFrom()` from `src/detection/risk.ts`, unchanged, with the thresholds in `config/thresholds.json`.
5. **Cache.** Answers are saved in `data/eval_cache_<dataset>.json` (git-ignored; public dataset rows), keyed by row id + model, with a hash of the question wording. If the wording changes, the cache entry no longer counts and the row is asked again.
6. **Results.** Rows go to `eval_results` as run ids `2026-11-08-tune-1` (600 train rows), `2026-11-08-holdout-1` (1,160) and `2026-11-08-scout-1` (30, dataset `test30`, row_index = file order). Each row stores label, p_scam, level, flags, scam_type and jev_model. No message text is stored.

### Sample (tuning on train only)

The sample has 600 train rows, drawn per label with seed 42: **420 ham, 150 smishing, 30 spam**.

**Why oversample smishing.** A proportional sample of 600 would have only about 55 smishing rows. The Unsure rule ("95% of smishing") would then rest on about 3 rows, and the High rule (97% precision) on 1 or 2. With 150 smishing rows, 5% is 7 or 8 rows. 420 ham still puts the 2% false-alarm budget at 8 rows. Spam doesn't drive any threshold, so it gets only 30 rows for a preview.

**Correction.** Oversampling changes the label mix, so precision is **reweighted** back to the real train mix. Each row counts as (train rows of its label) ÷ (sampled rows of its label): ham 9.21, smishing 2.81. The false-alarm rate (within ham) and recall (within smishing) don't depend on the mix, so they need no weights. The holdout keeps the natural mix and is never reweighted.

### Threshold rules

Candidates are the midpoints between neighbouring `is_scam` values in the sample, so a threshold never sits on a message's exact score. The severe rule (`asks_code ≥ 0.8`, or all three of `money_or_code`, `urgency_secrecy`, `impersonation` ≥ 0.6) stays on throughout.

| key | value | how it was set |
|---|---|---|
| `likely` | **0.62** | Among thresholds with ham at Likely+ ≤ 2%, catch the most smishing, then take the one with the fewest false alarms. 150/150 caught, 4/420 ham (1.0%). The lowest in-budget threshold, 0.575, catches the same 150 but flags 8 ham, so the tie-break matters. |
| `high` | **0.805** | The lowest threshold ≥ likely from which weighted High-risk precision stays ≥ 97% all the way up. On the sample: 97.7%, 141 smishing and 1 ham. |
| `unsure` | **0.35** | The spec floor, lowered only if needed to put ≥ 95% of smishing at Unsure or above. Here that target is slack: every floor up to 0.62 meets it, because the lowest smishing score in the sample is 0.63. Raising the floor to 0.62 would close the Unsure band entirely, and the band is what turns a borderline real scam (scout S17, 0.47) into "Not sure" instead of "Looks safe". We kept the spec value instead of closing it. |
| `asks_code_severe` | 0.8 (spec) | Checked. 0 ham on the sample; 1 ham on the holdout ("What's ur pin?" between friends, rated High). Fine. |
| `combo_severe` | 0.6 (spec) | Checked. 0 ham on the sample and holdout. On the scout set it's fragile; see recommendations. |
| `flag` | 0.6 (spec) | Checked. At 0.6, every Likely+ smishing text on the sample has at least one red flag to show, with an average of 2.9. At 0.7, one loses all its flags. The cost: 5.3% of Safe ham (sample) and 7.4% (holdout) still have a flag ≥ 0.6, mostly `impersonation`. See recommendations. |
| `callback_flag` | 0.7 (spec) | It works: 95% of smishing vs 0.2% of ham. |
| `known_contact_discount` | 0.15 (spec) | Not testable: the datasets have no contact history. |
| `jev_model` | `jev-1.14.0` | The model string Jev returned on every one of the 1,790 answers. |

Tuning sweep (sample, severe rule on; precision weighted):

| t | ham at Likely+ | smishing at Likely+ | High precision (high = t) |
|---|---|---|---|
| 0.35 | 27 (6.4%) | 150 (100%) | 62.9% |
| 0.5 | 10 (2.4%) | 150 (100%) | 82.1% |
| 0.6 | 5 (1.2%) | 150 (100%) | 90.2% |
| 0.65 | 3 (0.7%) | 149 (99.3%) | 93.8% |
| 0.75 | 2 (0.5%) | 144 (96.0%) | 95.7% |
| 0.8 | 2 (0.5%) | 141 (94.0%) | 95.6% |
| 0.85 | 1 (0.2%) | 137 (91.3%) | 97.7% |
| 0.9 | 0 | 128 (85.3%) | 100% |

On the same sample, the spec defaults (0.35 / 0.6 / 0.85) give 150/150 caught, 5 ham flagged and 137 at High. The tuned values give 150/150 caught, 4 ham flagged and 141 at High.

## Scout set (30 hand-written U.S. messages)

- **Scams at Likely or above: 16 of 17. At Unsure or above: 17 of 17.**
- **Legit at Likely or above (false alarms): 1 of 11** (L11). Rated Safe: 6 of 11. Rated Not sure: 4 of 11.
- S9 ("Hi, is this Kevin? golf Saturday", expected scam_or_unsure): Looks safe (0.16). A lone wrong-number opener carries no signal yet.
- L8 (Domino's promo, spam): Not sure (0.61).

| id | expected | level | conf. | flags | scam_type |
|---|---|---|---|---|---|
| S1 | scam | High risk | 94% | impersonation, money_or_code, urgency_secrecy, link_mismatch, callback | toll_or_delivery |
| S2 | scam | High risk | 97% | impersonation, money_or_code, urgency_secrecy, link_mismatch, callback | government |
| S3 | scam | High risk | 98% | impersonation, urgency_secrecy, link_mismatch, callback | toll_or_delivery |
| S4 | scam | High risk | 94% | impersonation, urgency_secrecy, link_mismatch, callback | bank_or_card |
| S5 | scam | High risk | 98% | impersonation, money_or_code, link_mismatch, callback | bank_or_card |
| S6 | scam | High risk | 98% | money_or_code, link_mismatch, asks_code | marketplace |
| S7 | scam | Likely scam | 79% | impersonation, urgency_secrecy, link_mismatch, callback | family_emergency |
| S8 | scam | High risk | 96% | impersonation, money_or_code, urgency_secrecy, link_mismatch | family_emergency |
| S9 | scam_or_unsure | Looks safe | 84% | impersonation | other |
| S10 | scam | High risk | 94% | impersonation, link_mismatch, callback | crypto |
| S11 | scam | High risk | 94% | impersonation, link_mismatch, callback | job_or_prize |
| S12 | scam | High risk | 98% | money_or_code, link_mismatch | job_or_prize |
| S13 | scam | High risk | 98% | impersonation, urgency_secrecy, link_mismatch, callback | job_or_prize |
| S14 | scam | High risk | 97% | impersonation, urgency_secrecy, link_mismatch, callback | tech_support |
| S15 | scam | High risk | 98% | impersonation, money_or_code, link_mismatch, callback | government |
| S16 | scam | High risk | 97% | impersonation, money_or_code, link_mismatch | romance_or_investment |
| S17 | scam | **Not sure (miss)** | 47% | money_or_code | marketplace |
| S18 | scam | High risk (severe combo; is_scam 0.74) | 74% | impersonation, money_or_code, urgency_secrecy, link_mismatch, callback | other |
| L1 | legit | **Not sure** | 56% | impersonation, urgency_secrecy | bank_or_card |
| L2 | legit | **Not sure** | 48% | impersonation | bank_or_card |
| L3 | legit | Looks safe | 70% | impersonation | toll_or_delivery |
| L4 | legit | Looks safe | 83% | impersonation | other |
| L5 | legit | Looks safe | 93% | impersonation, money_or_code | other |
| L6 | legit | Looks safe | 98% | impersonation | other |
| L7 | legit | **Not sure** | 43% | impersonation | toll_or_delivery |
| L8 | spam | Not sure | 61% | impersonation, urgency_secrecy | other |
| L9 | legit | **Not sure** | 49% | impersonation, money_or_code | tech_support |
| L10 | legit | Looks safe | 87% | impersonation | job_or_prize |
| L11 | legit | **High risk (false alarm)** | 87% | impersonation | crypto |
| L12 | legit | Looks safe | 73% | impersonation | other |

**Key pairs** (scam vs the real message it copies):

| pair | scam | legit | result |
|---|---|---|---|
| S4 vs L2 (Chase fraud alert) | High risk (0.94) | Not sure (0.48) | partly separated |
| S6 vs L1 (code request vs Chase OTP) | High risk (0.98) | Not sure (0.56) | partly separated |
| S6 vs L9 (code request vs Google OTP) | High risk (0.98) | Not sure (0.49) | partly separated |
| S10 vs L11 (Coinbase withdrawal) | High risk (0.94) | **High risk (0.87)** | **not separated** |
| S1 vs L7 (NTTA toll) | High risk (0.94) | Not sure (0.43) | partly separated |

Every scam in a pair is High risk. The real messages land in "Not sure" (4 of 5), which tells the user to check in the official app: annoying, but safe. L11 is the one real failure: a genuine Coinbase alert called High risk.

## What went wrong, and evidence for changes (not applied; outside Flow 6)

1. **High-risk precision didn't hold up on the holdout (97.7% on the sample, 90.8% on the holdout).** 10 ham texts scored High:
   - 4 chain letters ("Send ur birthdate and I'll tell u ur partner's name")
   - 4 out-of-context fragments that sound like a scam ("just send your account details and the money will be sent")
   - 1 contact-spam text
   - "What's ur pin?" (severe rule)

   The sample had only 1 such text, so one row decided the High threshold. Across all 19 ham false alarms, 8 are chain letters ("Send this to 10 friends…") and **13 of the 19 have no red flag at all**: Jev's `is_scam` reads "This message is a scam" literally on manipulative but harmless texts.
2. **Level logic suggestion, for the `risk.ts` owner.** Require at least one red flag other than `impersonation` (or `severe`) for Likely or above, and cap the rest at Unsure. Measured from the cache, with no new Jev calls:
   - **Train sample:** ham flagged 4 → 1, smishing caught 150 → 147, ham at High 1 → 0.
   - **Holdout (post hoc, so treat it as a hint, not a result):** ham flagged 19 → 6 (2.0% → 0.6%), caught 104 → 102, ham at High 10 → 4.
   - **Scout:** fixes L11 (Coinbase legit → Unsure); scams unchanged, still 16 of 17.
   - If adopted, re-run `tune` and score a fresh holdout run id.
3. **`impersonation` fires on 11 of 11 legit scout messages** (Chase, Google, NTTA, Coinbase…). Jev reads "pretends to be from a company" as "is from a company". Two costs:
   - A Safe reply can say "pretends to be a company" about a real Chase text.
   - It weakens the combo-severe rule. L1 (real Chase OTP) already has impersonation 0.97 and urgency 0.87, so only `money_or_code` = 0.40 keeps it out of High risk.
   Suggested fixes:
   - Reword to "The message claims to be from a company, agency or person, **and** something in it (sender, link or number) does not match that company, agency or person". Then re-tune.
   - Or drop `impersonation` from the combo rule.
   - **Flow 1 reply writing:** don't list red flags on a "Looks safe" verdict.
4. **`callback` is the best single signal for the hard U.S. pairs.** S10 vs L11: callback 0.95 vs 0.04 (`is_scam` 0.94 vs 0.87). S4 vs L2: 0.95 vs 0.03 ("call the number on the back of your card" was read correctly). Yet `riskLevel()` ignores it. It's worth using in the level, e.g. as one of the "other red flags" in suggestion 2.
5. **Missed scams.** Holdout: a bank-card "payment overdue, call 1300…" reminder (0.57, Not sure) and a holiday ad (0.31, Safe; arguably spam). Scout: S17, the Zelle overpayment refund (0.47, Not sure), which is the case the Unsure band exists for.

## Recommendation: pin the model

Set **`JEV_MODEL=jev-1.14.0`** in `.env` and in Railway Variables. The eval was run with that exact string (Jev accepts it and returned it on every answer). Today `.env` has `jev-latest`, which can move under us and silently change the calibration. `npm run eval` refuses to run against an alias.

## Reproduce

```bash
# needs the Postgres tunnel (CLAUDE.md) for the eval_results writes; report needs only the cache
JEV_MODEL=jev-1.14.0 npm run eval -- tune      # 600 train rows -> config/thresholds.json + run 2026-11-08-tune-1
JEV_MODEL=jev-1.14.0 npm run eval -- holdout   # 1,160 holdout rows, once -> 2026-11-08-holdout-1
JEV_MODEL=jev-1.14.0 npm run eval -- scout     # 30 rows -> 2026-11-08-scout-1
npm run eval -- report                         # every number in this file, from the cache, no Jev calls
```

Add `--run=2` to write new run ids. Once `.env` is pinned, the `JEV_MODEL=` prefix isn't needed. Reruns reuse `data/eval_cache_*.json` and never re-ask Jev for a cached row. Copy those files along with the repo if you want `report` to work on another machine.
