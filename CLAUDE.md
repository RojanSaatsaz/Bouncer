# Bouncer: project context

Bouncer is a scam-prevention agent for T-Mobile customers, built for HackUTD 2026 (T-Mobile scam track + Photon 2.0 messaging-agent track). iOS first.

Users text Bouncer on iMessage (chat + screenshots) and call it, or merge it into a suspicious call, on a voice number. Bouncer stays silent on calls, scores the conversation, and texts warnings. It only speaks after "Hey Bouncer."

**The full spec is `docs/SPEC.md`. Read the relevant flow there before writing code.**

## Scope (tonight)

- **In:** Flow 1 (screenshot scanner), Flow 2 (live listen + "Hey Bouncer"), Flow 3 trimmed (safe-word coaching, verification call, circle alert; circle and safe word are seeded by script, no JOIN-code flow), Flow 6 trimmed (holdout accuracy numbers).
- **Out:** Flow 4 recovery (one checklist text at most), Flow 5 pattern recognition, Flow 7 carrier feed and dashboard. Don't build these unless asked.

## Stack

- Node 20.6+ / TypeScript, ESM, run with `tsx` (no build step)
- Hono + `@hono/node-server`, single server deployed on Railway
- PostgreSQL on Railway via `pg` (no ORM)
- Photon 2.0: iMessage line (text + images) via Socket.IO events + `sendMessage`; voice number connected to ElevenLabs over SIP
- TypeSafe Jev: every scam decision (text only, calibrated probabilities)
- Gemini API: reads screenshots, writes reply wording
- ElevenLabs Agents: calls, with our server as the custom LLM (`POST /v1/chat/completions`)

## Commands

```bash
npm install
npm run dev            # local server on :3000, reads .env
npm start              # production (Railway)
npm run migrate        # create tables (safe to rerun)
```

Local DB access without a public URL: `railway connect Postgres --tunnel-only`, then point `DATABASE_URL` in `.env` at the printed `127.0.0.1:<port>` URL.

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

Tables already exist on Railway: `users, circles, circle_members, safe_words, contact_memory, events, feedback, verifications, processed_messages, photon_cursor, eval_results`. Definitions are in `scripts/migrate.ts`. Change the schema only by editing that file with `IF NOT EXISTS` / `ALTER ... IF NOT EXISTS`, never by hand.

## Environment variables

All in `.env` locally and Railway Variables in production. Never commit `.env`.

`PHOTON_PROJECT_API_KEY, PHOTON_PROJECT_ID, PHOTON_IMESSAGE_HANDLE, PHOTON_VOICE_NUMBER, TYPESAFE_API_KEY, JEV_MODEL, GEMINI_API_KEY, GEMINI_MODEL, ELEVENLABS_API_KEY, ELEVENLABS_LISTEN_AGENT_ID, ELEVENLABS_VERIFY_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID, ELEVENLABS_WEBHOOK_SECRET, BOUNCER_LLM_SECRET, BOUNCER_INIT_TOKEN, SAFE_WORD_KEY, DATABASE_URL, PUBLIC_BASE_URL`

Read them in one place (`src/config.ts`) and fail fast with a clear message if a required one is missing.

## Hard rules

1. **Privacy.** Never store or log message content, screenshots, senders, audio or call transcripts. `events` holds type, level, flags and outcome only. Images stay in memory and are dropped after the Gemini call. Call turns live in memory and are deleted on the post-call webhook.
2. **Safe words** are AES-256-GCM encrypted with `SAFE_WORD_KEY`, never logged, never spoken by Bouncer, and compared in code.
3. **Jev decides, Gemini words.** Gemini never decides whether something is a scam.
4. **No action from voice alone.** Calling a relative or alerting the circle needs a "YES" by text, because a scammer on a merged call can say "Hey Bouncer" too.
5. **One server instance at a time.** If local and Railway are both connected to Photon, every message gets two replies. Pause Railway while testing locally.
6. **Don't guess API shapes.** Check the Photon, ElevenLabs, TypeSafe or Gemini docs (links below) or log a real payload first.
7. **Secrets** only from env. No keys in code, logs or client bundles.

## Key decisions (see SPEC.md for details)

- **Photon shared iMessage line cannot send the first message.** Bouncer only replies inside existing conversations. Save each user's `space_id` and send alerts into it.
- **iMessage on the Photon beta supports text and images only.**
- **Calls:** ElevenLabs agent "Bouncer Listen" has a blank first message and the `skip_turn` tool. Our custom-LLM endpoint answers every turn with `skip_turn` immediately, runs Jev in the background, and texts alerts. Wake phrase regex: `/\b(hey|hi|ok(ay)?)[,.!]?\s+(bouncer|bouncers|bounce her)\b/i`. After answering, go back to silent. "Thanks Bouncer" also ends talk mode.
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
