# Bouncer on the 2024–2026 scams archive (Flow 6 extension)

Run on Nov 8, 2026 with **Jev `jev-1.14.0`**, the live question set (`MESSAGE_QUESTIONS`, hash `9d5617a066ee`), and the live level logic (`riskLevel()` / `flagsFrom()` in `src/detection/risk.ts`) with the thresholds already in `config/thresholds.json` (unsure 0.35, likely 0.62, high 0.805, flag 0.6, callback 0.7). Nothing in `src/` or `config/` was changed. Every number below comes from `npm run eval:archive -- report`, which rebuilds them from cached Jev answers.

## Bottom line

1. **Every scam was caught, and every one was rated High risk:** 400 of 400 in the train sample and 952 of 952 on test. The lowest `is_scam` on any scam was 0.89. This data is synthetic and its scams are blatant (AUC 1.000), so it says little about hard scams. Mendeley and the scout set remain the evidence for recall.
2. **The real finding is false alarms on legitimate messages.** At Likely or above, the false-alarm rate was **6.8% on the train sample and 18.5% on test**, against a 2% target. Another 25–31% of legit messages land in "Not sure".
3. **The Mendeley thresholds hold for scams but not for legit business messages.** Raising `likely` alone would need about 0.75 to reach 2% here, and on Mendeley that costs about 4% of smishing.
4. **The pending HANDOFF item-6 rule fixes almost all of it.** The rule says Likely or above needs a red flag other than impersonation, unless severe. With it, false alarms drop to **1 of 400 on the train sample and 1 of 324 on test**, with **zero scams lost** on either set. The trade-off is that more legit messages land in "Not sure" (32% and 49%).
5. **`impersonation` fired on 100% of legit messages** (724 of 724). It now measures "mentions a company", not "pretends to be one". This repeats the scout finding at scale.

## Method

- **Data.** `data/scams_archive_en.csv` has 21,364 English synthetic rows from one generator ("Compositional Template Pipeline v1"), with fixed `split` values. Rows on the platforms "Phone Call" and "Voice Call (Transcript)" are **excluded**, because calls are evaluated separately. That leaves 19,660 rows: 16,739 train, 1,645 val and 1,276 test.
- **Labels.** Positive = `Scam`, negative = `Benign`. The benign rows come from 6 kinds: delivery update, marketing promo, bank statement, job posting, support reply and social notification.
- **Jev state.** `{ body }`. For emails, the body is prefixed with `Subject: <subject>\n`, and only email rows have a subject. There is no sender and `known_contact` is false.
- **Jev calls.** One `POST /v1/systemone` per row asks the 8 `MESSAGE_QUESTIONS`. Calls ran 8 at a time (`p-limit`) with `askJev` retries. In total there were **2,076 calls** (800 sample + 1,276 test) and **0 failures**. The sample took about 18 s and test about 26 s.
- **Cache.** Answers are stored in `data/archive_jev_cache.json` (git-ignored), keyed by `scam_id|model` plus the question hash. If the question wording changes, those rows are asked again.
- **Train sample: 800 rows, seed 42.**
  - It has 400 Scam and 400 Benign rows.
  - Within each label, rows are split evenly across `scam_pattern`: 22 scam patterns get 18–19 rows each, and 6 benign kinds get 66–67 each.
  - Within each pattern, rows are drawn round-robin across platforms, preferring templates not already used in that pattern. The sample covers 603 distinct templates.
  - Precision is reweighted to the real train mix (weights: scam 29.44, benign 12.41). Catch rates and false-alarm rates need no weights.
- **Test split.** All 1,276 non-call test rows (952 Scam, 324 Benign), scored **once** with the current thresholds and never used for tuning.
  - **Test shares no templates with train** (0 of 1,276).
  - Its mix is shifted. It has only 14 of the 22 scam patterns: there are no `account_suspension`, `prize_advance_fee`, `family_emergency`, `tech_support_popup`, `romance_emergency_money` and others.
  - Its benign rows lean toward job postings (29% vs 17% in the sample) and promos.
  - So test is a harder generalization check than the sample, not a replica of it.
- **Val** was not used.

## Headline numbers

| metric | Train sample (800) | Test (1,276, scored once) |
|---|---|---|
| Scams caught (Likely+) | **400 / 400 (100%)** | **952 / 952 (100%)** |
| Scams at Unsure+ | 400 / 400 (100%) | 952 / 952 (100%) |
| Scams at High risk | 400 / 400 (100%) | 952 / 952 (100%) |
| Scams rated "Looks safe" | 0 | 0 |
| **Benign flagged (Likely+), false alarms** | **27 / 400 (6.8%)** | **60 / 324 (18.5%)** |
| Benign at High risk | 1 / 400 (0.3%) | 4 / 324 (1.2%) |
| Benign at Unsure ("Not sure") | 102 / 400 (25.5%) | 99 / 324 (30.6%) |
| Flags right (precision at Likely+) | 97.2% (reweighted to train mix) | 94.1% (natural test mix) |
| AUC of `is_scam`, scam vs benign | 1.0000 | 1.0000 |

Levels:

| set | label | Safe | Unsure | Likely | High |
|---|---|---|---|---|---|
| sample | scam | 0 | 0 | 0 | 400 |
| sample | benign | 271 (67.8%) | 102 (25.5%) | 26 (6.5%) | 1 (0.3%) |
| test | scam | 0 | 0 | 0 | 952 |
| test | benign | 165 (50.9%) | 99 (30.6%) | 56 (17.3%) | 4 (1.2%) |

**Compared with Mendeley (docs/EVAL.md):** recall is the same or better (98.1% on the Mendeley holdout, 100% here). Ham false alarms were 2.0% on the Mendeley holdout, but 6.8–18.5% on these modern business messages. The `likely` threshold of 0.62 was tuned on personal SMS ("ham"), which Jev finds easy to clear. Legit corporate messages (recruiters, promos, delivery notices) sit much closer to the line.

## Why legit messages get flagged

**By benign kind** (Likely+ = false alarm):

| benign kind | sample: rows / Likely+ / Unsure+ | test: rows / Likely+ / Unsure+ | median is_scam (sample / test) |
|---|---|---|---|
| legit_job_posting | 67 / **21 (31%)** / 48 (72%) | 93 / **44 (47%)** / 79 (85%) | 0.53 / 0.60 |
| legit_marketing_promo | 67 / 3 (4.5%) / 12 | 107 / **11 (10%)** / 22 (4 at High) | 0.24 / 0.23 |
| legit_delivery_update | 67 / 1 (1.5%) / 32 (48%) | 48 / 5 (10%) / 29 (60%) | 0.32 / 0.42 |
| legit_bank_statement | 67 / 2 (3.0%) / 32 (48%) | 55 / 0 / 29 (53%) | 0.34 / 0.36 |
| legit_social_notification | 66 / 0 / 5 | 18 / 0 / 0 | 0.15 / 0.21 |
| legit_support_reply | 66 / 0 / 0 | 3 / 0 / 0 | 0.12 / 0.20 |

What drives the false alarms (checked from the cache, no new Jev calls):

- **Job postings.** Every false alarm is a "**Remote** Customer Support role" posting: 21 of 45 in the sample and 44 of 69 on test. The non-remote postings had 0 of 22 and 0 of 24. Many of these have nonsense salaries such as "₦2500/year + benefits": ₦/year postings were flagged 11/11 in the sample and 13/14 on test. That is a generator artifact, but "remote support job, apply now" is also the classic fake-job lure. Jev's suspicion is understandable, and the template is unrealistic.
- **Promos (test).** All 11 false alarms have a subject that **contradicts the body**: "Your 10% Off Code Inside", while the body says 30–50% off. That gives 11 of 34 mismatched rows flagged vs 0 of 73 consistent ones. This is another generator artifact, and a real inconsistency Jev reasonably reacts to. The 4 benign High-risk rows are all of this kind (`is_scam` 0.81–0.88).
- **Platform.** All false alarms are on Email, LinkedIn and Job Board, which is where the job and promo templates live. **SMS benign: 0 of 67 (sample) and 0 of 39 (test) at Likely+**, which is the channel Bouncer actually receives.
- **No false alarm had a real red flag.** On every benign row, the only flag at ≥ 0.6 is `impersonation` (all 724 benign rows) or occasionally `urgency_secrecy` (20 sample, 23 test). `money_or_code`, `link_mismatch`, `asks_code` and `callback` fired on **0** benign rows. The flagged messages are the ones `is_scam` leans on alone.

## Per platform

| platform | sample scams caught | sample benign Likely+ | test scams caught | test benign Likely+ |
|---|---|---|---|---|
| Email | 122/122 | 15/189 (7.9%) | 411/411 | 36/207 (17.4%) |
| SMS | 43/43 | 0/67 | 151/151 | 0/39 |
| LinkedIn | 4/4 | **10/23 (43.5%)** | 17/17 | **9/23 (39.1%)** |
| Job Board | 14/14 | 2/22 (9.1%) | 54/54 | **15/36 (41.7%)** |
| Facebook | 40/40 | 0/22 | 13/13 | 0/7 |
| Instagram | 26/26 | 0/22 | 42/42 | 0/7 |
| X (Twitter) | 19/19 | 0/22 | – | 0/4 |
| Live Chat | 9/9 | 0/33 | – | 0/1 |
| WhatsApp | 28/28 | – | 58/58 | – |
| Telegram | 24/24 | – | 92/92 | – |
| Pop-up/Website, Website, Website/Listing | 40/40 | – | 59/59 | – |
| Dating App, Marketplace, TikTok, QR | 31/31 | – | 55/55 | – |

## Per scam pattern

Every pattern was 100% at High risk on both sets, so the table shows how confident Jev was and which flags explain the verdict. "Flags" lists those that fire on at least half the rows (sample).

| scam_pattern | sample n | test n | median is_scam (sample) | Jev scam_type (top) | flags on ≥ 50% of rows |
|---|---|---|---|---|---|
| account_suspension_phishing | 19 | – | 0.98 | tech_support | impersonation, urgency, link_mismatch, asks_code, callback |
| ai_personalized_phish | 19 | 78 | 0.95 | bank_or_card / other | impersonation, money_or_code, urgency, link_mismatch, callback |
| bank_fraud_alert | 19 | 94 | 0.98 | bank_or_card | all six |
| bec_wire_transfer | 19 | 118 | 0.95 | other / bank_or_card | impersonation, money_or_code, urgency |
| charity_disaster_relief | 18 | 29 | 0.97 | other | impersonation, money_or_code, urgency, link_mismatch, callback |
| crypto_guaranteed_returns | 18 | 44 | 0.98 | romance_or_investment | money_or_code, urgency, link_mismatch |
| crypto_wallet_seed_phishing | 18 | 57 | 0.98 | crypto | impersonation, money_or_code, urgency, link_mismatch, callback |
| delivery_fee_smishing | 18 | 54 | 0.97 | toll_or_delivery | impersonation, money_or_code, urgency, link_mismatch, callback |
| fake_customer_support_callback | 18 | – | 0.97 | marketplace | impersonation, urgency |
| fake_job_overpayment_check | 18 | 87 | 0.98 | job_or_prize | impersonation, money_or_code, urgency, link_mismatch |
| fake_job_upfront_fee | 18 | 54 | 0.98 | job_or_prize | impersonation, money_or_code, urgency, link_mismatch, callback |
| family_emergency | 18 | – | 0.96 | family_emergency | impersonation, money_or_code, urgency, link_mismatch |
| identity_theft_govt_threat | 18 | 54 | 0.98 | government | impersonation, urgency, link_mismatch, callback |
| online_shopping_fake_store | 18 | – | 0.96 | marketplace | impersonation, money_or_code, urgency, link_mismatch, callback |
| pig_butchering | 18 | 115 | 0.98 | romance_or_investment | impersonation, money_or_code, urgency, link_mismatch, callback |
| prize_advance_fee | 18 | – | 0.99 | job_or_prize | impersonation, money_or_code, urgency, link_mismatch |
| qr_parking_payment | 18 | 26 | 0.97 | toll_or_delivery | impersonation, money_or_code, urgency, link_mismatch, callback |
| rental_wire_deposit | 18 | 62 | 0.97 | marketplace | money_or_code, urgency, link_mismatch |
| romance_emergency_money | 18 | – | 0.97 | romance_or_investment | impersonation, money_or_code, urgency, link_mismatch |
| social_media_giveaway_fee | 18 | – | 0.99 | job_or_prize | money_or_code, urgency, link_mismatch, callback |
| tech_support_popup | 18 | – | 0.98 | tech_support | impersonation, urgency, link_mismatch, callback |
| telegram_investment_admin | 18 | 80 | 0.98 | romance_or_investment | money_or_code, urgency, link_mismatch |

The `scam_type` choice maps sensibly onto the patterns. The weak spots are BEC wire fraud (`other` / `bank_or_card`, since there is no "boss or vendor asks for a wire" option), `account_suspension_phishing` (mostly `tech_support`), and `fake_customer_support_callback` (`marketplace`).

## Red flags vs the dataset's own columns

The flags use the live bars (0.6, `callback` 0.7). The mappings are approximate, because the dataset's columns are narrower than Jev's questions.

| Jev flag | dataset column | recall when column true (sample / test) | fires when column false, scams (sample / test) | fires on benign |
|---|---|---|---|---|
| asks_code | requests_otp | **100% / 100%** (19, 94 rows) | 3.1% / 0.5% | 0% |
| asks_code | requests_otp or requests_password | 54% / 65% | 0.3% / 0% | 0% |
| money_or_code | requests_payment or requests_otp | 88% / 92% | 74% / 95%* | 0% |
| callback | contains_link or contains_phone_number | 75% / 76% | 4.9% / 4.1% | 0% |
| link_mismatch | contains_link or contains_phone_number | 95% / 92% | 54% / 64% | 0% |
| impersonation | scam_tactics has "impersonation" | 91% / 96% | 54% / 37% | **100%** |
| urgency_secrecy | manipulation_techniques has "urgency" | 95% / 96% | 88% / 84% | 5.0% / 7.1% |

\* Every one of those `money_or_code` "extra" hits is a row that has `requests_bank_details` or `requests_password` set (fake checks, card numbers, seed phrases, logins). That matches the question's own wording ("payment details, or a verification code"), so it isn't an error.

Takeaways:

- `asks_code` is excellent for OTPs. It misses most password-only requests ("log in here to verify"), but `link_mismatch` and `callback` cover those.
- `callback` is very precise (98%). Its 25% miss on link/number rows is mostly links that `link_mismatch` already flags.
- `impersonation` has no discriminating power on legit business messages.

**Remote access** (sample only, 36 rows: `tech_support_popup`, `fake_customer_support_callback`): all were caught at High. There is **no remote-access question**, so the reply shows impersonation (97%) and urgency (94%) instead of "asks you to install an app". `FLAG_LABELS.remote_access` exists, but nothing sets it.

**Severe rule:** it never fired on a benign row (0 / 724), and no scam needed it, because `is_scam` was already ≥ 0.89.

## What-if: "Likely or above needs a red flag other than impersonation, unless severe"

This is the rule from HANDOFF item 6. It was computed from the cache without changing `risk.ts`. "Red flag" means `flagsFrom()` over `money_or_code, urgency_secrecy, link_mismatch, asks_code, callback` at the live bars. Messages that fail it are capped at Unsure.

| metric | sample: current | sample: with rule | test: current | test: with rule |
|---|---|---|---|---|
| Scams caught (Likely+) | 400/400 | **400/400** | 952/952 | **952/952** |
| Scams at High | 400 | 400 | 952 | 952 |
| Benign false alarms (Likely+) | 27 (6.8%) | **1 (0.3%)** | 60 (18.5%) | **1 (0.3%)** |
| Benign at High | 1 | 0 | 4 | 0 |
| Benign at Unsure | 102 (25.5%) | 128 (32.0%) | 99 (30.6%) | 158 (48.8%) |
| Precision at Likely+ | 97.2% (weighted) | 99.9% | 94.1% | 99.9% |

- **Removed false alarms:** sample 26 (job posting 21, bank 2, promo 2, delivery 1); test 59 (job posting 44, promo 10, delivery 5). The 1 left in each set has `urgency_secrecy`.
- **Margin:** every scam had at least one non-impersonation flag. 12 sample scams and 7 test scams had **exactly one**. In the sample that's mostly `fake_customer_support_callback` (urgency only, 7) and fake-job / romance rows (money only). Those are the rows a future question change could tip.
- **Cost seen elsewhere:** on Mendeley the same rule lost 3 of 150 train smishing (docs/EVAL.md). Here it loses none.

Likely-threshold sweep on the **train sample** (high = max(likely, 0.805)):

| likely | scams Likely+ | benign Likely+ | scams Likely+ (rule) | benign Likely+ (rule) |
|---|---|---|---|---|
| 0.35 | 400 | 129 (32.3%) | 400 | 4 (1.0%) |
| 0.5 | 400 | 56 (14.0%) | 400 | 2 (0.5%) |
| 0.6 | 400 | 29 (7.3%) | 400 | 1 (0.3%) |
| **0.62 (current)** | 400 | **27 (6.8%)** | 400 | **1 (0.3%)** |
| 0.7 | 400 | 9 (2.3%) | 400 | 0 |
| 0.75 | 400 | 3 (0.8%) | 400 | 0 |
| 0.8 | 400 | 1 (0.3%) | 400 | 0 |

On this data, the threshold alone would have to rise to about 0.75 to meet the 2% budget. On the Mendeley sample, 0.75 drops smishing recall from 100% to 96%, so that trade is worse than the rule.

## Worst cases

- **Missed scams:** none on either set. The lowest scam `is_scam` was 0.91 (sample) and 0.89 (test).
- **Worst false alarms (test):** the 4 High-risk ones are all promo emails whose subject says "10% off" while the body says 30–50% (`SCA-020926` 0.88, `SCA-020908` 0.83, `SCA-020302` 0.82, `SCA-020154` 0.81). The rest are mostly "Remote Customer Support role" postings (`SCA-021701` 0.79, `SCA-022046` 0.76, …) and "delivery completed, left at your front door" emails (`SCA-018901` 0.75, `SCA-019166` 0.74).
- **Worst false alarms (sample):** `SCA-020768` (promo email, High, 0.81), then `SCA-021686`, `SCA-021488`, `SCA-021455` and `SCA-021931` (remote-job postings, 0.74–0.76), and `SCA-018987` (delivery email, 0.69).

`npm run eval:archive -- report` lists each one with a 90-character excerpt.

## Caveats

- The data is **synthetic and template-based** (2,598 templates). Its scams are much easier than Mendeley or the scout set. A 100% catch rate here is not evidence of 100% in the wild.
- The benign side has generator artifacts: absurd salaries, and subjects that contradict the body. These inflate false alarms on job posts and promos. Treat 6.8% and 18.5% as an upper-bound stress test for corporate messages. The useful signal is **what** gets flagged and **why**, which matches the scout findings (`impersonation` on every legit message, L11).
- The test split differs from train in template and pattern mix. The gap between 6.8% (sample) and 18.5% (test) is mostly that mix: more remote-job postings and subject-mismatch promos on test.
- The Mendeley and scout caches are not on this machine, so variant B below has **not** been checked on those harder sets.

## Recommendations (not applied; the user decides)

1. **Adopt the HANDOFF item-6 rule in `riskLevel()`**: Likely or above needs a red flag other than `impersonation`, unless severe.
   - Evidence: false alarms 6.8% → 0.3% (sample) and 18.5% → 0.3% (test), with 0 scams lost here. On Mendeley train: ham 4 → 1, smishing 150 → 147.
   - It needs the flag probabilities passed into `riskLevel()`, or a post-step in `scoreAnswers()`.
   - Afterwards, re-run `npm run eval -- tune` (Mendeley), the scout set, and `npm run eval:archive -- report` (the archive cache is free).
2. **Don't raise `likely` / `high` instead.** About 0.75 would be needed here, at a recall cost on Mendeley. Keep 0.62 / 0.805 for now. Re-tune only after the rule (and any wording change) is in.
3. **Shrink the "Not sure" band for flagless messages (variant B; needs checking).** With the rule, 32–49% of legit messages here would say "Not sure", which is too noisy. Candidate: if no non-impersonation flag fires and the message isn't severe, return Safe when `is_scam` < `likely` and Unsure otherwise.
   - On this archive (rule plus variant B), benign comes out as Safe 370, Unsure 29, Likely 1 of 400 (sample), and Safe 261, Unsure 62, Likely 1 of 324 (test). Today it is Safe 271 and 165. All scams stay High.
   - **Must be checked on the Mendeley train sample and scout first** (S17, the Zelle overpayment at 0.47, has `money_or_code`, so it would stay Unsure). It costs about 630 Jev calls on this machine, because those caches are missing.
4. **Reword `impersonation`.** It fires on 100% of 724 legit messages. Suggested wording (same as docs/EVAL.md): "The message claims to be from a company, agency or person, **and** something in it (sender, link, number or request) does not match how that company, agency or person really contacts people." Also drop it from the combo-severe rule, or require `link_mismatch` / `callback` alongside it. Re-tune after any wording change, since the cache is keyed by question hash.
5. **Add a `remote_access` question** (noul): "The message asks the reader to install an app, allow screen sharing or remote control, or call a support number to fix a device." `FLAG_LABELS.remote_access` already exists. Today the 36 remote-access scams are caught only through impersonation and urgency, so the reply can't name the real danger. Adding a question changes the request, so re-run the evals.
6. **Add a `scam_type` option for business email compromise**, e.g. `boss_or_vendor_payment`: "A boss, coworker or vendor asks for an urgent wire, gift cards or changed bank details". BEC is 118 of 952 test scams and lands in `other` or `bank_or_card`.
7. **Reply writing (Flow 1):** don't list `impersonation` as a red flag on Safe or Unsure verdicts. On legit messages it is always on and always wrong.
8. **Data hygiene for future use of this archive:** for any tuning on it, drop or tag the benign artifacts (promo subject/body mismatch, salaries under about 1,000 per year) so they don't push thresholds up. Use `val` for tuning and keep `test` (already scored once here) untouched.

## Reproduce

```bash
npm run eval:archive -- sample   # 800-row stratified train sample (asks Jev for uncached rows)
npm run eval:archive -- test     # 1,276 non-call test rows (already scored once; reruns hit the cache)
npm run eval:archive -- report   # everything above, from data/archive_jev_cache.json, no Jev calls
```

`JEV_MODEL` must be a pinned version equal to `jev_model` in `config/thresholds.json` (`jev-1.14.0`). No database is used.

## Applied (2026-11-08)

The user approved the "needs a red flag other than impersonation, unless severe" rule. It now lives in `riskLevel()` (`src/detection/risk.ts`, via `messageFlags`, messages only; calls are unaffected) and in `scripts/eval-metrics.ts`, so every eval measures the shipped logic. Re-scored from cache: archive test false alarms (Likely+) **60/324 → 1/324 (0.3%)**, scams caught still **952/952**. Capped messages reply "🤔 Not sure: no clear red flags, but be careful." and `impersonation` is only listed as a red flag on Likely+ verdicts. Mendeley holdout numbers in docs/EVAL.md predate the rule (train-sample what-if: false alarms 4 → 1, 3 of 150 smishing moved to Unsure).
