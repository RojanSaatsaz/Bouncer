# Handoff (Nov 8, 2026, ~10:05 AM)

Read `CLAUDE.md`, then `docs/API_NOTES.md` (API shapes verified live tonight), then this file. `docs/SPEC.md` has each flow.

## Where things are

| Piece | Branch / worktree | State |
|---|---|---|
| Foundation (config, db, Photon, Jev, Gemini, risk, pending, SSE, stubs) | `foundation` · `../HackUTD-26-wt/foundation` | On main and **deployed**. Commit `c464fc1` (the pending-slot fix below) is **not merged yet**. |
| Docker deploy (`Dockerfile`, `railway.json`) | `deploy-docker` | On main and deployed. Railpack kept failing on GitHub downloads. |
| Flow 6 eval | `flow6-eval` | **Done, merged to local main**, not pushed. Results in `docs/EVAL.md`. |
| Flow 3 family | `flow3-family` | **Done, merged to local main**, not pushed. 69/69 tests pass (`npx tsx --env-file=.env scripts/test-family.ts`). |
| Flow 1 scanner + router | `flow1-scanner` · `../HackUTD-26-wt/flow1-scanner` | **WIP snapshot `d5bb8e1`, untested.** The agent was stopped right before its final test run (text, two screenshot fixtures, scout). |
| Flow 2 voice | `flow2-voice` · `../HackUTD-26-wt/flow2-voice` | **WIP snapshot `6ce8c69`, untested.** The agent was stopped while debugging talk-mode streaming: the SSE response stalls when `speakResponse` wraps the real Gemini stream (it worked with a fake generator). |

Railway runs `2a84b13`: foundation stubs only. iMessages are received and saved but get no reply, and every call turn is answered with `skip_turn`. Local main is ahead, at `docs/HANDOFF.md` plus the Flow 6 and Flow 3 merges.

## Do next, in order

1. **Flow 1:** `cd ../HackUTD-26-wt/flow1-scanner`, `npx tsc --noEmit`, then `DRY_RUN=1 npm run test:message -- scout` (and the `text` / `image scripts/fixtures/…` modes). Fix, commit, then `git merge --no-ff flow1-scanner` from main. Its router must call `resolvePending` first, then `handleFamilyText`, and on `family_emergency` call `startFamilyEmergency({source:"text"})` **without sending its own reply** (Flow 3 sends the coach text).
2. **Flow 2:** fix the streaming stall in `src/voice/talk.ts` / `speakResponse` (`src/voice/sse.ts`). Then handle **speculative turns**: the live call sent duplicate requests with the same user-turn count, and the last turn's text can be revised. Always skip_turn at once; only act on a turn once it's stable. Wire the post-call webhook: if Verify agent, call `onVerifyCallEnded(conv, {failed})`; `family_danger ≥ 0.7` calls `startFamilyEmergency({source:"call"})`. Run `npm run test:call` (local server `PORT=3102 DRY_RUN=1`), then merge.
3. Merge `foundation` (`c464fc1`) into main.
4. Typecheck main **in a worktree** (see gotchas), then **push main**. The user must approve each push, because auto mode blocks production deploys. Set the Railway variable `JEV_MODEL=jev-1.14.0` (the local `.env` is already pinned; Railway still says `jev-latest`, and the eval refuses `jev-latest`).
5. After the deploy, reopen the DB tunnel (it dies on every redeploy).
6. **User decision:** Flow 6 suggests "Likely or above needs a red flag other than impersonation, unless severe". On train data it cuts false alarms 4→1 and loses 3 of 150 scams, and it fixes L11. The agent had already looked at the holdout before proposing it, so after this change the holdout numbers aren't a clean one-time score. It also found `impersonation` fires on every legit scout message. Don't change `risk.ts` without the user's OK.
7. **Seed the demo circle** (the user runs this with the real numbers; Grandma and Mom must have texted Bouncer once first):
   `SAFE_WORD='<word>' npm run seed:family -- --protected "name=Grandma,handle=<PHONE>" --member "name=Jake,relationship=grandson,phone=<PHONE>,role=relative" --member "name=Mom,relationship=daughter,phone=<PHONE>,role=guardian"`
8. **Real-device tests:** a screenshot and a scam text to +1 628-998-8619; a call to +1 617-993-9248 with "Hey Bouncer, is this real?"; the family scene. The outbound verification call (ElevenLabs → Photon SIP) has **never been placed for real**, and the `conversation_id` response field and `end_call {reason}` args are unverified.

## Verified tonight

- **Spike test** (two real calls, conv `conv_2101m…` and `conv_7901m…`): caller ID **is present** in `caller=` (E.164, 12 characters). Turns arrive about every 2 s. Duplicate (speculative) requests happen. The post-call webhook reaches `/elevenlabs/post-call`. **Still to confirm with the user:** that Bouncer stayed silent by ear, the turn delay, and merged two-voice audio.
- Photon `message.received` puts the message at `envelope.data.object`. A screenshot is `content {type:"attachment", attachmentId}`, and a 326 KB PNG downloads in 1.2–3.5 s. Photon also emits `call.started` / `call.ringing` on the socket (ignored).
- Flow 6 holdout: scams caught 104/106 (98.1%), flags right 104/123 (84.6%), real messages flagged 19/967 (2.0%). **High-risk precision is 90.8%, under the 97% target.** Thresholds: likely 0.62, high 0.805.
- ElevenLabs was fixed via the API: the phone number is assigned to Listen, recording is off, retention is 1 day, the webhook excludes transcripts and adds `call_initiation_failure`, the model IDs are set, and the Verify greeting quotes are removed. The init webhook is **not configured** (optional).

## Gotchas

- **DB tunnel:** `railway connect Postgres --tunnel-only --port 54329` (run in background). `.env` points at it. It dies on every Railway redeploy, and sometimes on its own; check with a `select 1`.
- **`tsc`/`cp` hang in the main checkout's `node_modules`** (reads there are very slow, cause unknown). Typecheck in a worktree whose `node_modules` is a symlink to `../foundation/node_modules`, e.g. `cd ../HackUTD-26-wt/deploy-docker && git checkout --detach main && npx tsc --noEmit`. **Don't delete the `foundation` worktree.**
- Rule 5: Railway holds the Photon socket (`PHOTON_SOCKET=on`); local `.env` is `off`. Test locally with `DRY_RUN=1` and fake `InboundMessage`s.
- Gemini: `gemini-3.5-flash` (quality) is slow (1.5–17 s) and often 503s; `gemini-3.5-flash-lite` (fast) is about 0.6 s. `src/detection/gemini.ts` falls back between them.
- Each user has one pending YES/NO slot. `c464fc1` stops `call_feedback` from overwriting another pending action.
- The user's earlier Wi-Fi blocked `*.railway.app` (DNS failures); a different connection fixed it.
- **The Gemini API key was printed in this session's tool output. The user should rotate it** (AI Studio, then `.env` and Railway).
