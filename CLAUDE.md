# Bouncer: project context

Bouncer is a scam-prevention agent for T-Mobile customers, built for HackUTD 2026 (T-Mobile scam track + Photon 2.0 messaging-agent track). iOS first.

Users text Bouncer on iMessage (chat + screenshots) and call it, or merge it into a suspicious call, on a voice number. Bouncer stays silent on calls, scores the conversation, and texts warnings. It only speaks after "Hey Bouncer."

**The full spec is `docs/SPEC.md`. Read the relevant flow there before writing code.**

## Scope (tonight)

- **Built:** Flow 1 (screenshot scanner), Flow 2 (live listen + "Hey Bouncer"), Flow 3 (coaching, verification call, circle alert, and setup by text with JOIN codes), Flow 4 recovery checklist (`src/recovery`), Flow 5 REPORT/templates/spikes (`src/patterns`), Flow 6 evals (Mendeley, archive, calls), Flow 7 dashboard + carrier feed (`src/dashboard`, `src/carrier`). The user asked for Flows 4, 5 and 7 on Nov 8.

## Stack

- Node 22+ / TypeScript, ESM, run with `tsx` (no build step). `@photon-ai/api` requires Node 22
- Hono + `@hono/node-server`, single server deployed on Railway
- PostgreSQL on Railway via `pg` (no ORM)
- Photon 2.0: iMessage line (text + images) via Socket.IO events + `sendMessage`; voice number connected to ElevenLabs over SIP
- TypeSafe Jev: every scam decision (text only, calibrated probabilities)
- DeepSeek V4.1 Flash via OpenRouter (`OPENROUTER_API_KEY`): reads screenshots, writes reply wording, chat and spoken replies (`src/detection/openrouter.ts`, routed through `src/detection/gemini.ts`). Gemini is the fallback when no OpenRouter key is set (`LLM_PROVIDER=gemini` forces it) and still does Flow 5 embeddings. The Gemini key is free tier (20 req/day on flash), which is why we switched.
- ElevenLabs Agents: calls, with our server as the custom LLM (`POST /v1/chat/completions`)

## Commands

```bash
npm install
npm run dev            # local server on :3000, reads .env
npm start              # production (Railway)
npm run migrate        # create tables (safe to rerun)
npm run typecheck      # tsc --noEmit
npm run test:message   # Flow 1 runner (fake envelopes, DRY_RUN)
npm run test:call      # Flow 2 runner (simulated call turns)
npm run seed:family    # Flow 3 demo circle + safe word
npm run eval           # Flow 6 tuning / holdout scoring
npm run eval:archive   # message eval on data/scams_archive_en.csv
npm run eval:calls     # call eval (archive call scripts + BETTER30)
npm run test:postcall | test:recovery | test:setup | test:patterns
npm run replay -- --one toll --to +1...   # Flow 7 simulated carrier event
```

Local DB access without a public URL: `railway connect Postgres --tunnel-only --port 54329` (local `.env` already points at `127.0.0.1:54329`). The tunnel runs through the app container, so **reopen it after every Railway redeploy**.

Verified API shapes and live measurements: `docs/API_NOTES.md`.

## Repo layout

```
src/index.ts           server entry, routes
src/photon/            Socket.IO client, sendMessage helpers
src/detection/         Gemini extraction, Jev questions, risk levels, reply writing
src/voice/             custom-LLM endpoint, init + post-call webhooks, call sessions
src/family/            safe word encryption, coaching, verification calls, circle alerts
scripts/migrate.ts     table definitions
scripts/               eval, seed, test-message runners
data/                  datasets (git-ignored)
docs/SPEC.md           full technical spec
```

Create folders as needed; keep this shape.

## Database

Definitions are in `src/schema.ts` (Flow 1–3 tables, plus Flow 5 `report_templates, report_counts, pattern_spikes` and Flow 7 `carrier_events, dashboard_state`). The server runs it on every startup, and `npm run migrate` runs it by hand. Change the schema only by editing that file with `IF NOT EXISTS` / `ALTER ... IF NOT EXISTS`, never by hand.

## Environment variables

All in `.env` locally and Railway Variables in production. Never commit `.env`.

`PHOTON_PROJECT_API_KEY, PHOTON_PROJECT_ID, PHOTON_IMESSAGE_HANDLE, PHOTON_VOICE_NUMBER, TYPESAFE_API_KEY, JEV_MODEL, GEMINI_API_KEY, GEMINI_MODEL, ELEVENLABS_API_KEY, ELEVENLABS_LISTEN_AGENT_ID, ELEVENLABS_VERIFY_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID, ELEVENLABS_WEBHOOK_SECRET, BOUNCER_LLM_SECRET, BOUNCER_INIT_TOKEN, SAFE_WORD_KEY, DATABASE_URL, PUBLIC_BASE_URL`

Optional: `OPENROUTER_API_KEY` (strongly recommended; without it everything falls back to free-tier Gemini), `OPENROUTER_MODEL` / `OPENROUTER_FAST_MODEL` (default `deepseek/deepseek-v4.1-flash`), `LLM_PROVIDER`, `DASHBOARD_PASSWORD` (Flow 7 routes return 503 without it), `DEMO_VICTIM_PHONE`, `GEMINI_EMBED_MODEL`, `PATTERN_SPIKE_THRESHOLD` (default 3), `GEMINI_FAST_MODEL` (default `gemini-3.5-flash-lite`, for replies and voice), `PHOTON_SOCKET` (`on` on Railway, `off` in local `.env`, see rule 5), `DRY_RUN=1` (print iMessages instead of sending), `PORT` (pinned to 3000 on Railway to match the domain).

Read them in one place (`src/config.ts`) and fail fast with a clear message if a required one is missing.

## Hard rules

1. **Privacy.** Never store or log message content, screenshots, senders, audio or call transcripts. `events` holds type, level, flags and outcome only. Images stay in memory and are dropped after the Gemini call. Call turns live in memory and are deleted on the post-call webhook.
2. **Safe words** are AES-256-GCM encrypted with `SAFE_WORD_KEY`, never logged, never spoken by Bouncer, and compared in code.
3. **Jev decides, Gemini words.** Gemini never decides whether something is a scam.
4. **No action from voice alone.** Calling a relative or alerting the circle needs a "YES" by text, because a scammer on a merged call can say "Hey Bouncer" too.
5. **One server instance at a time.** If local and Railway are both connected to Photon, every message gets two replies. Railway holds the socket (`PHOTON_SOCKET=on`); local `.env` has `PHOTON_SOCKET=off`. To test iMessage locally, pause Railway first and flip the flag.
6. **Don't guess API shapes.** Check the Photon, ElevenLabs, TypeSafe or Gemini docs (links below) or log a real payload first.
7. **Secrets** only from env. No keys in code, logs or client bundles.

## Key decisions (see SPEC.md for details)

- **Photon shared iMessage line cannot send the first message.** Bouncer only replies inside existing conversations. Save each user's `space_id` and send alerts into it.
- **iMessage on the Photon beta supports text and images only.**
- **Calls:** ElevenLabs agent "Bouncer Listen" has a blank first message and the `skip_turn` tool. Our custom-LLM endpoint answers every turn with `skip_turn` immediately, runs Jev in the background, and texts alerts. Wake phrase regex: `/\b(hey|hi|ok(ay)?)[,.!]?\s+(bouncer|bouncers|bounce her)\b/i`. After "Hey Bouncer" the conversation stays open (direct questions and greetings are answered; Jev `addressed_to_bouncer` is a tie-breaker) until "thanks/bye Bouncer", 2 not-addressed turns, or ~28 s idle; then silent again. Bouncer's own earlier replies are in the prompt so it doesn't repeat itself.
- **Case memory** (`src/messages/case.ts`): after a scam call (or a Likely+ text/screenshot) the user has one active "case" for 30 min, in memory only: level, scam type, flag names, brand, payment method and up to 3 amounts, pulled from the transcript by code before it is deleted. Recovery uses it ("Sounds like you paid with Klarna after that call. Is that right?"), short replies during a case are routed with it and never scanned as new messages, and chat sees it. Chat memory compacts itself past 8 turns into a ≤ 280-char summary (one background fast-model call).
- **Spoken replies** (call may include a scammer): max 2 sentences; never say a safe word, account details or personal info ("I've sent that to your phone"); "This matches a known scam pattern" is OK.
- **Jev:** send all questions in ONE request (`POST https://api.typesafe.ai/v1/systemone`). Question types: `noul` (yes/no), `choice`, `score`. Pin `JEV_MODEL` after tuning.
- **Message questions:** impersonation, money_or_code, urgency_secrecy, link_mismatch, asks_code, is_scam, scam_type (choice), plus our addition **callback**: "The message tells the reader to contact a phone number or link given in the message, instead of the company's official app, website or the number on their card." Treat callback >= 0.7 like link_mismatch.
- **Risk levels:** safe, unsure, likely_scam, high_risk. Logic in SPEC Flow 1 step 8; thresholds in `config/thresholds.json` after tuning.
- **Replies:** plain words, sixth-grade reading level. Line 1 verdict + confidence, line 2 up to three red flags, line 3 one safe next step. Never say "100% safe."

## Test data

- `data/mendeley_clean.csv`: 5,797 deduplicated messages (ham / spam / smishing) with a fixed `split` column (train / holdout, seed 42). Tune on train only; score holdout once.
- `data/scout_test_messages.csv`: 30 hand-written current US messages (S1-S18 scams, L1-L12 legit). Key pairs: S4 vs L2, S6 vs L1/L9, S10 vs L11, S1 vs L7.
- Spam is not fraud: report it separately, never count it as a scam or a false alarm.

## Docs

- Photon: https://photon.codes/docs/spectrum-ts/introduction, https://photon.codes/docs/beta/api-reference
- Photon voice + ElevenLabs: https://photon.codes/docs/beta/cookbooks/voice/elevenlabs
- ElevenLabs custom LLM: https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm
- ElevenLabs skip turn: https://elevenlabs.io/docs/agents-platform/customization/tools/skip-turn
- TypeSafe Jev: https://docs.typesafe.ai
- Gemini API: https://ai.google.dev

## Working style

- Small, working steps. After each change, say how to test it (a curl, a text to send, or a script to run).
- Keep it simple: no frameworks or abstractions we don't need tonight.
- If something in SPEC.md conflicts with this file, this file wins; flag the conflict.
