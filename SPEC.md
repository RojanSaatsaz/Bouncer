# Bouncer — Technical Spec & Build Plan

Nov 8, 2026

## Summary

Bouncer is one Node server behind two Photon numbers: an iMessage line for chat and screenshots, and a voice-capable number that Photon sends to an ElevenLabs agent over SIP. That agent's "LLM" is your server, so every call turn is decided in code: run Jev, text an alert, and stay silent, unless someone says "Hey Bouncer." This spec keeps every decision in the team plan (no Twilio, no Brev, silent until "Hey Bouncer," encrypted safe words, simulated carrier) and writes each flow out action by action.

Checking the Photon 2.0 and ElevenLabs docs turned up five things the plan has to handle:

1. **The shared iMessage line can't start conversations or take calls.** Photon's Beta guide says a shared line "cannot send an unsolicited first message," and voice needs a separate eligible number ([iMessage guide](https://photon.codes/docs/beta/get-started/imessage.md), [voice guide](https://photon.codes/docs/beta/get-started/voice.md)). So Bouncer can't text a Trusted Circle invite to Mom first. Members join by texting a join code to Bouncer (Flow 3, step 2). Put both numbers on one "Bouncer" contact card.
2. **Caller ID through Photon is undocumented.** ElevenLabs reads caller ID from an `X-Caller-ID` SIP header ([SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking)); Photon's guide doesn't say it sends one. Without it, Bouncer can't tell whose call it joined. Flow 2 reads the caller's number from ElevenLabs' `system__caller_id` variable in the agent's system prompt, with a text-first fallback.
3. **ElevenLabs keeps call transcripts by default.** The plan promises no transcripts. Turn off audio saving and set the shortest retention in the agent's privacy settings, and say only what you've actually configured on the privacy slide.
4. **"Most scammers hang up when an AI is listening" has no source.** Keep the spoken warning, drop the statistic unless you find one.
5. **The circle alert can't claim "No money was sent."** Bouncer only knows what Grandma confirms. Flow 3 asks her before saying it.

## Accounts and API keys

You need four paid-service credentials (Photon, ElevenLabs, TypeSafe, Gemini), a Postgres URL, and three secrets you generate yourselves. Everything in the server's `.env`; nothing in the repo, the dashboard bundle or a client.

| Service | Credential | Env var | Where to get it | Used for |
| --- | --- | --- | --- | --- |
| Photon 2.0 | Project API key (`pho_sk_...`) | `PHOTON_PROJECT_API_KEY` | [Beta dashboard](https://app.beta.photon.codes) → your project → API keys. Scopes: `project:read`, `project:write` (plus `platforms:write` only if you assign lines by API) | Socket.IO event stream and `sendMessage` ([credentials](https://photon.codes/docs/beta/api-client/credentials.md)) |
| Photon 2.0 | Project ID | `PHOTON_PROJECT_ID` | Same page | Every Photon call is under `/v1/projects/{projectId}` |
| Photon 2.0 | iMessage line number | `PHOTON_IMESSAGE_HANDLE` | Project → iMessage → "Assign a number from the shared pool" | Chat and screenshots |
| Photon 2.0 | Voice-capable number | `PHOTON_VOICE_NUMBER` | Project → Voice → Lines (must be an eligible SMS or dedicated number; shared lines can't take calls) | Live listen, "Hey Bouncer" calls, verification calls |
| Photon 2.0 | Outbound SIP password | not in `.env` | Voice profile in the Photon dashboard | Typed into ElevenLabs' outbound trunk settings so the verification call can go out through Photon |
| ElevenLabs | API key | `ELEVENLABS_API_KEY` | Developers → API Keys. Permissions: ElevenAgents = Write, every other endpoint and admin permission = No Access | Outbound verification call API |
| ElevenLabs | Agent IDs | `ELEVENLABS_LISTEN_AGENT_ID`, `ELEVENLABS_VERIFY_AGENT_ID` | Each agent's page | Listen agent answers the voice number; Verify agent places the call to the real relative |
| ElevenLabs | Phone number ID (`phnum_...`) | `ELEVENLABS_PHONE_NUMBER_ID` | Deploy → Phone Numbers, after importing the Photon voice number | `agent_phone_number_id` in the outbound call |
| ElevenLabs | Post-call webhook secret | `ELEVENLABS_WEBHOOK_SECRET` | Agents → Settings → Webhooks (HMAC) | Verifying `elevenlabs-signature` on call-ended events |
| TypeSafe | API key | `TYPESAFE_API_KEY` | TypeSafe console | Every Jev call ([quickstart](https://docs.typesafe.ai/introduction/quickstart.md)) |
| TypeSafe | Pinned model | `JEV_MODEL` | The exact `model` string your first response returns (for example `jev-1.14.x`) | Keeps thresholds stable; never `jev-latest` after tuning |
| Google | Gemini API key | `GEMINI_API_KEY` | Google AI Studio → Get API key | Screenshot reading, replies, templates, embeddings |
| Google | Model names | `GEMINI_MODEL`, `GEMINI_EMBED_MODEL` | Current Flash-tier model and embedding model listed in AI Studio | Lets you swap models without code changes |
| Postgres | Connection string | `DATABASE_URL` | Railway, Neon or Supabase | All tables |
| You | Custom-LLM secret | `BOUNCER_LLM_SECRET` | `openssl rand -hex 32`; paste the same value as the custom LLM's API key secret in both ElevenLabs agents | Server rejects any `/v1/chat/completions` call without `Authorization: Bearer <secret>` |
| You | Safe-word key | `SAFE_WORD_KEY` | `openssl rand -base64 32` | AES-256-GCM encryption of safe words |
| You | Dashboard password | `DASHBOARD_PASSWORD` | Any long string | HTTP basic auth on the T-Mobile dashboard |

Optional backup only, if the ElevenLabs agent can't stay silent: `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`, or `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. The Mendeley dataset needs no key.

```bash
# .env for local development (Flow 1 + database)
PHOTON_PROJECT_API_KEY=pho_sk_...
PHOTON_PROJECT_ID=...
TYPESAFE_API_KEY=...
JEV_MODEL=jev-latest   # pin the exact version after Flow 6 tuning
GEMINI_API_KEY=...
GEMINI_MODEL=...
DATABASE_URL=postgres://localhost:5432/bouncer
```

Add the rest from the table when a flow needs them: `PHOTON_VOICE_NUMBER`, `PHOTON_IMESSAGE_HANDLE`, the ElevenLabs key and IDs, `ELEVENLABS_WEBHOOK_SECRET`, `PUBLIC_BASE_URL` and `BOUNCER_LLM_SECRET` for Flow 2 (ElevenLabs also needs a public URL, so set them in the Railway service's Variables tab); `SAFE_WORD_KEY` for Flow 3; `GEMINI_EMBED_MODEL` for Flow 5; `DASHBOARD_PASSWORD` once the dashboard is deployed to Railway.

## Getting every key for the demo, step by step

About an hour end to end, in this order: Photon, TypeSafe, Gemini and Postgres work locally right away; ElevenLabs comes after you have a public URL, because its agents call your server. Each step ends with a test so you know the key works before moving on.

### Step 1 · Photon (about 15 minutes)

1. Open [app.beta.photon.codes](https://app.beta.photon.codes), sign in, and create an organization and a project named "Bouncer" ([project setup](https://photon.codes/docs/beta/get-started/project.md)).
2. Open **Settings**, copy the **Project ID** (starts with `pho_prj_`) into `PHOTON_PROJECT_ID`.
3. In the project sidebar open **API keys** → **New API key**. Name it "Bouncer server", set an expiry past the hackathon, and tick `project:read`, `project:write` and `platforms:read`. Select **Create key** and copy it into `PHOTON_PROJECT_API_KEY` immediately: it is shown only once.
4. Open **iMessage**. Under "Add the number you or your user will send from," add the iMessage number of the Grandma demo phone (repeat for the teammate and Mom phones if it lets you add more). Select **Add**, then **Assign a number from the shared pool**, and copy the assigned number into `PHOTON_IMESSAGE_HANDLE` ([iMessage guide](https://photon.codes/docs/beta/get-started/imessage.md)).
5. **Test:** text "hi" from the Grandma phone to that number and confirm it appears in the project's messages.
6. Open **Voice** → **Lines**. You need an eligible SMS or dedicated number; shared lines can't take calls ([voice guide](https://photon.codes/docs/beta/get-started/voice.md)). Add one if none is listed and copy it into `PHOTON_VOICE_NUMBER`. If there's no default profile, choose **Set up default** → **SIP** → **Create profile**.
7. In that Voice profile, note the outbound SIP host and the **outbound SIP password**; you'll type them into ElevenLabs in Step 7. If you can't find them, ask Photon at support@photon.codes or on their Discord.

### Step 2 · TypeSafe (about 3 minutes)

1. Open [console.typesafe.ai/keys](https://console.typesafe.ai/keys), sign in, create a key, and copy it into `TYPESAFE_API_KEY`.
2. **Test:**

```bash
curl -sS https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"state":"Your toll is unpaid. Pay now at ntta-pay.xyz or face a fine.","model":"jev-latest","questions":{"is_scam":{"type":"noul","instructions":"This message is a scam."}}}'
```

3. The response's `answers.is_scam.noul` should be close to 1. Note the `model` value it returns (for example `jev-1.14.x`); keep `JEV_MODEL=jev-latest` until Flow 6, then pin that string.

### Step 3 · Gemini (about 3 minutes)

1. Open [aistudio.google.com](https://aistudio.google.com), sign in, select **Get API key** → **Create API key**, pick or create a Google Cloud project, and copy the key into `GEMINI_API_KEY`.
2. **Test and pick models:**

```bash
curl -sS https://generativelanguage.googleapis.com/v1beta/models \
  -H "x-goog-api-key: $GEMINI_API_KEY"
```

3. From the list, copy the current Flash model's name into `GEMINI_MODEL` and the embedding model's name into `GEMINI_EMBED_MODEL` (drop the `models/` prefix if your SDK adds it).

### Step 4 · Postgres (about 5 minutes)

1. Locally, with Docker running:

```bash
docker run -d --name bouncer-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=bouncer -e POSTGRES_DB=bouncer \
  pgvector/pgvector:pg16
```

2. Set `DATABASE_URL=postgres://postgres:bouncer@localhost:5432/bouncer`. The pgvector image is there for Flow 5's embeddings.
3. **Test:** `psql "$DATABASE_URL" -c "create extension if not exists vector;"`
4. For the hosted demo, add a Postgres database in Railway (use a pgvector-enabled template if you build Flow 5) and copy its `DATABASE_URL` from the service's **Variables** tab.

### Step 5 · Secrets you generate (1 minute)

```bash
echo "BOUNCER_LLM_SECRET=$(openssl rand -hex 32)" >> .env
echo "SAFE_WORD_KEY=$(openssl rand -base64 32)" >> .env
echo "DASHBOARD_PASSWORD=$(openssl rand -hex 16)" >> .env
```

### Step 6 · Railway deployment (already set up)

1. The server runs on Railway, which gives ElevenLabs a public URL that doesn't change between deploys. In the server service, **Settings** → **Networking** → **Generate Domain**, and put `https://<service>.up.railway.app` in `PUBLIC_BASE_URL`. Use that domain in every ElevenLabs URL below.
2. Put every variable from the keys table in the service's **Variables** tab; Railway injects them as environment variables, and the local `.env` is only for running on your laptop. If Postgres runs in the same Railway project, set `DATABASE_URL` to the reference `${{Postgres.DATABASE_URL}}`. The server must listen on the `PORT` variable Railway provides. Each push to the connected branch redeploys.
3. **Test:** `curl $PUBLIC_BASE_URL/health` returns 200 from your running server.

### Step 7 · ElevenLabs (about 25 minutes)

1. **API key.** Developers → API Keys → create a key named "Bouncer server." Permissions: **ElevenAgents = Write**, everything else **No Access**. Copy it into `ELEVENLABS_API_KEY`.
2. **Bouncer Listen agent.** Agents → create a blank agent named "Bouncer Listen." First message: leave blank. LLM: **Custom LLM**, Server URL `<PUBLIC_BASE_URL>/v1`, Model ID `bouncer-listen`, API key: create a new secret whose value is your `BOUNCER_LLM_SECRET`. Tools: add the **Skip Turn** system tool; leave End call and transfers off. System prompt: `conv={{system__conversation_id}} caller={{system__caller_id}}`. Turn off any silence reminder, set the longest max call duration, turn audio saving off and retention to the shortest. Publish, then copy the agent ID (starts with `agent_`) into `ELEVENLABS_LISTEN_AGENT_ID`.
3. **Bouncer Verify agent.** Same Custom LLM URL and secret, Model ID `bouncer-verify`, first message "Hi {{relative_name}}, this is Bouncer calling for {{protected_name}}. Are you safe right now?", system prompt `verify={{verify_id}} conv={{system__conversation_id}}`, tools: **End call** on. Publish and copy its ID into `ELEVENLABS_VERIFY_AGENT_ID`.
4. **Import the Photon number.** Deploy → Phone Numbers → Import number → From SIP Trunk. Label "Bouncer voice", number = `PHOTON_VOICE_NUMBER` with the leading `+`. Inbound: media encryption **Allowed**. Outbound: address = Photon's outbound SIP host (no `sip:` prefix), transport **TLS**, username and password = Photon's outbound SIP credentials from Step 1.7. Save, then set the **Agent** to Bouncer Listen. Copy the phone number ID (starts with `phnum_`) into `ELEVENLABS_PHONE_NUMBER_ID` ([SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking)).
5. **Post-call webhook.** Agents → Settings → post-call webhook → create one with URL `<PUBLIC_BASE_URL>/elevenlabs/post-call` and HMAC auth. Copy the secret into `ELEVENLABS_WEBHOOK_SECRET` ([post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks)).

### Step 8 · Point Photon's voice number at ElevenLabs (about 5 minutes)

1. Photon → Voice → your profile → **Inbound calls** → **Enable inbound**. Destination `sips:sip.rtc.elevenlabs.io:5061`, Transport **TLS**, SIP credentials empty, Media encryption **Auto**. Click out of the field to save, then confirm the address and TLS still show.
2. **Test:** with the Railway deployment live, call `PHOTON_VOICE_NUMBER` from a phone that isn't enrolled. You should hear nothing, your server log should show a `POST /v1/chat/completions` for each sentence you say, and the call should appear in Photon → Voice → Recent calls and in the agent's conversations in ElevenLabs.
3. **Test the outbound path:** run the Flow 3 step 7 `curl` to a teammate's phone; it should ring from `PHOTON_VOICE_NUMBER` and play the Verify agent's greeting.

When all eight steps pass, every variable in the keys table above has a value and the demo can run end to end.

## Architecture

One Node 22 server on Railway receives Photon's iMessage events, answers ElevenLabs' custom-LLM requests, takes the simulated carrier feed, and serves the dashboard.

```mermaid
flowchart TD
  A["iMessage line<br/>Photon 2.0 shared line<br/>texts and screenshots"] --> G["Gemini vision<br/>screenshot to text"]
  V["Voice number<br/>Photon 2.0, SIP<br/>calls and merged calls"] --> E["ElevenLabs agent<br/>transcribes each turn<br/>its LLM is the server"]
  C["Simulated carrier<br/>replay script<br/>Mendeley messages"] --> J
  G --> J["Jev decision<br/>calibrated probability per question<br/>Safe / Unsure / Likely scam / High risk"]
  E --> J
  J --> S["Bouncer server (your code)<br/>skip_turn or spoken reply, alerts, Gemini text"]
  S --- P[("PostgreSQL<br/>no content kept")]
  S --> U["Grandma's iPhone<br/>iMessage alerts<br/>spoken reply after Hey Bouncer"]
  S --> T["Trusted Circle<br/>verification call to Jake<br/>type and outcome to Mom"]
  S --> D["T-Mobile dashboard<br/>live feed, accuracy<br/>trends by ZIP, demo buttons"]
```

Jev makes every scam decision; Gemini reads images before it and writes the words after it.

| Server route | Called by | Purpose |
| --- | --- | --- |
| Socket.IO client to Photon | Server, outbound | Inbound iMessage events (Flows 1, 3, 4, 5) |
| `POST /v1/chat/completions` | ElevenLabs, every call turn | Silent or spoken reply (Flow 2, Flow 3 verification) |
| `POST /elevenlabs/post-call` | ElevenLabs, call end | Clear session, log, summary text |
| `POST /carrier/events` | Replay script, demo buttons | Simulated network messages (Flow 7) |
| `GET /dashboard` + Socket.IO `/dash` | Judges' laptop | T-Mobile view |

## Flow 1: Screenshot scanner (iMessage)

A screenshot or pasted message comes in on the iMessage line, Gemini turns it into structured text, Jev scores it, and Bouncer replies with a verdict, confidence, up to three red flags and one safe next step. Target: under 6 seconds.

1. **Stay connected to Photon.** On server start, create a Socket.IO client for `https://api.photon.codes` with options `path: "/v1/projects/" + PHOTON_PROJECT_ID + "/events/ws"`, `addTrailingSlash: false`, `transports: ["websocket"]`, `extraHeaders: { Authorization: "Bearer " + PHOTON_PROJECT_API_KEY }`, `autoConnect: false`. Register listeners, then call `socket.connect()` ([connect](https://photon.codes/docs/beta/websocket/connect)). After every connect, send `subscribe` with the last `seq` stored in table `photon_cursor` ([frames](https://photon.codes/docs/beta/websocket/frames)). If the socket isn't working by hour 1, poll `photon.projects.listMessages` every 2 s with `direction: "received"`, `order: "asc"`, `createdSince` = last processed time.
2. **Receive.** Each `delivery` event is `[envelope, { seq, replyExpected }]`. Log the first few envelopes in full: the Beta docs don't publish the image attachment field, so read its name off a real event. From the message take `id`, `sentBy.handle`, `receivedBy.id`, `space.id`, `content`. Skip any `id` already in `processed_messages`; after handling, insert the id and save `seq` to `photon_cursor`.
3. **Find the user.** Look up `users` by `imessage_handle = sentBy.handle`. Unknown sender: create the row, reply "Hi, I'm Bouncer from T-Mobile. Send me any text, DM or screenshot you're unsure about and I'll check it. Reply YES to turn on call protection and alerts." and stop. YES sets `opted_in = true`.
4. **Route.** Image attached: go to step 5. Text only: one Jev Choice question `intent` with criteria `check_message` (a pasted or forwarded message to judge), `family_emergency` (someone says a relative is in trouble), `already_paid` (they clicked, paid or shared info), `report` (wants to report a scam), `setup` (circle or safe word), `question` (general question). `family_emergency` starts Flow 3 step 5, `already_paid` starts Flow 4 step 1, `report` starts Flow 5 step 1, `setup` starts Flow 3 step 1, `question` gets a Gemini answer with the step 9 system prompt. `check_message` skips to step 6 with the text as `body`.
5. **Read the screenshot.** Send "Looking at it now..." Then call Gemini (`GEMINI_MODEL`) with the image inline and a JSON response schema: `source_app`, `sender`, `sender_type` (phone, shortcode, email, handle, unknown), `body`, `urls[]`, `phone_numbers[]`, `qr_code_present`, `claimed_brand`. Prompt: "Transcribe every visible word exactly, then fill the fields. Do not judge whether it is a scam." Drop the image buffer as soon as the call returns; never write it to disk.
6. **Check per-number memory.** If `sender` is a phone number and `contact_memory` has a row for this user and that number with `safe_count ≥ 3`, set `known_contact = true`.
7. **Ask Jev.** `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer TYPESAFE_API_KEY`, `model: JEV_MODEL`, state = `{ body, sender, sender_type, urls, claimed_brand, known_contact, active_patterns }`. `active_patterns` is the list of templates currently spiking in the user's ZIP3 (Flow 5 step 6), empty until one spikes. Questions:
   - `impersonation` (Noul): "The message pretends to be from a company, a government agency, or someone the reader knows."
   - `money_or_code` (Noul): "The message asks for money, gift cards, cryptocurrency, payment details, or a verification code."
   - `urgency_secrecy` (Noul): "The message pressures the reader to act fast or to keep it secret."
   - `link_mismatch` (Noul): "A link or phone number does not belong to the brand or person the message claims to be."
   - `asks_code` (Noul): "The message asks the reader to share a one-time code, password or PIN."
   - `is_scam` (Noul): "This message is a scam."
   - `matches_pattern` (Noul): "The message matches one of the templates in active_patterns." Ask only when `active_patterns` is non-empty.
   - `scam_type` (Choice): `toll_or_delivery`, `bank_or_card`, `crypto`, `government`, `tech_support`, `family_emergency`, `job_or_prize`, `marketplace`, `romance_or_investment`, `other`.
8. **Set the risk level in code.** `p = is_scam`. `severe = asks_code ≥ 0.8 || (money_or_code ≥ 0.6 && urgency_secrecy ≥ 0.6 && impersonation ≥ 0.6)`. If `known_contact && !severe`, `p = p − 0.15`. Then: **High risk** if `severe` or `p ≥ 0.85`; **Likely scam** if `p ≥ 0.60`; **Unsure** if `p ≥ 0.35`; else **Safe**. If `matches_pattern ≥ 0.8`, the level is at least Likely scam. Final thresholds come from Flow 6 step 4. Shown confidence: `round(p × 100)` for scam levels, `round((1 − p) × 100)` for Safe.
9. **Write the reply.** Gemini call with the level, confidence, `scam_type`, every flag ≥ 0.6, and `claimed_brand`. System prompt: "You are Bouncer, T-Mobile's scam helper. Plain words, sixth-grade reading level. Line 1: the verdict and confidence. Line 2: up to three red flags. Line 3: one safe next step. Never call anything 100% safe. For Unsure, say how to check through the company's official app or number." Example High risk line 1: "⚠️ High risk scam (91% sure). Don't tap the link."
10. **Send.** Call `photon.projects.sendMessage` with `path: { id: PHOTON_PROJECT_ID }`, header `idempotency-key: "bouncer:" + msg.id + ":1"`, and body `{ spaceId: space.id, senderId: receivedBy.id, parentMessageId: msg.id, content: { type: "text", format: "plain", text } }` ([iMessage guide](https://photon.codes/docs/beta/get-started/imessage.md)). One message per line, idempotency key suffix `:1`, `:2`, `:3`. Save `space.id` on the user row as `space_id`; Flows 2, 3 and 5 send alerts into it.
11. **Log without content.** Insert into `events`: `user_id`, `source = 'imessage'`, `risk_level`, `p_scam`, `scam_type`, `flags` (names only), `latency_ms`. No body, sender or image. Push the row to the dashboard socket. Keep `body` in memory only, keyed by user, for 10 minutes so a REPORT reply can use it (Flow 5 step 2), then drop it.
12. **Update memory.** Safe verdict with a phone `sender`: `safe_count += 1` in `contact_memory`. Likely scam or High risk: set `safe_count = 0` for that number.
13. **Invite a report.** For Likely scam or High risk, end with "Reply REPORT to warn people near you." A REPORT reply starts Flow 5 step 1.

## Flow 2: Live listen and "Hey Bouncer" on one number

Every call to Bouncer's voice number lands on one ElevenLabs agent whose LLM is your server. The server answers each turn with ElevenLabs' `skip_turn` tool, so the agent says nothing, while Jev runs on the transcript in the background and alerts go out by iMessage. Only "Hey Bouncer" switches the server to spoken replies. Silence is enforced by code, not by a model choosing to be quiet.

### One-time setup

1. **Photon voice profile** ([voice guide](https://photon.codes/docs/beta/get-started/voice.md)). Project → Voice → Lines, pick the voice-capable number. No default profile: Set up default → SIP → Create profile. Open Inbound calls → Enable inbound, then set Destination `sips:sip.rtc.elevenlabs.io:5061`, Transport TLS, SIP credentials empty (unless you turn on inbound auth in ElevenLabs), Media encryption Auto.
2. **ElevenLabs agent "Bouncer Listen."**
   - First message: blank.
   - LLM: Custom LLM. Server URL `${PUBLIC_BASE_URL}/v1` (ElevenLabs appends `/chat/completions`), Model ID `bouncer-listen`, API key = a new secret holding `BOUNCER_LLM_SECRET` ([custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm.md)).
   - System prompt, used only as a carrier for IDs: `conv={{system__conversation_id}} caller={{system__caller_id}}`. ElevenLabs fills both itself; `system__caller_id` comes from the call's `X-Caller-ID` SIP header.
   - Tools: enable the `skip_turn` system tool ([skip turn](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/skip-turn.md)). Leave `end_call`, transfers and every other tool off.
   - Conversation: turn off any silence follow-up or "are you still there" prompt; set the maximum call length as high as your plan allows.
   - Voice: a calm stock voice.
   - Privacy: audio saving off, shortest retention.
   - Post-call webhook: `${PUBLIC_BASE_URL}/elevenlabs/post-call`, HMAC.
3. **Import the Photon number into ElevenLabs.** Deploy → Phone Numbers → Import number → From SIP Trunk. Label "Bouncer voice," number in E.164 with the leading `+`, inbound media encryption Allowed. Outbound (needed for Flow 3): Address = Photon's outbound SIP host from your Voice profile, Transport TLS, digest username and password = Photon's outbound SIP credentials. Assign Bouncer Listen as the agent. Copy the `phnum_...` ID into `ELEVENLABS_PHONE_NUMBER_ID`.
4. **Contact card.** Onboarding sends users a vCard named "Bouncer" holding both the iMessage handle and the voice number, so they text, call or merge one contact.

### Per call

1. **Call starts.** The user calls Bouncer's voice number, or taps Add Call → Bouncer → Merge Calls during a suspicious call. Photon passes it to ElevenLabs over SIP.
2. **Receive each turn.** ElevenLabs POSTs `/v1/chat/completions` with `stream: true`, a `messages` array (system prompt first, then turns) and `tools` containing `skip_turn`. Reject without `Authorization: Bearer BOUNCER_LLM_SECRET`. Parse `conv` and `caller` from the system message. Get or create the in-memory session `{ mode: "listening", turns: [], alerted: Set, level: "Safe", userId: null }` keyed by `conv`. Append the last `user` message.
3. **Identify the user (first turn of each call).** If `session.userId` is null, normalise `caller` to E.164 (`libphonenumber-js`, default region US) and look up `users.voice_phone`. No caller number or no match: use the user whose `listen_pending` flag was set in the last 2 minutes (they text "listen" to Bouncer before merging). Otherwise set `userId = "unknown"`; the call is still transcribed but sends no alerts. Log `caller` on every test call: if it's always empty, Photon isn't passing caller ID and the text-first fallback is the only way to identify the user.
4. **Check for the wake phrase.** `/\b(hey|hi|ok(ay)?)[,.!]?\s+(bouncer|bouncers|bounce her)\b/i` on the latest turn (speech-to-text sometimes splits it into "bounce her"). Match: go to step 7. No match in listening mode: step 5.
5. **Stay silent immediately.** Respond within milliseconds with the SSE below; do not wait for Jev.

```
data: {"id":"s1","object":"chat.completion.chunk","model":"bouncer-listen","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_skip","type":"function","function":{"name":"skip_turn","arguments":"{}"}}]},"finish_reason":null}]}

data: {"id":"s1","object":"chat.completion.chunk","model":"bouncer-listen","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]

```

6. **Score in the background, alert by text.** If no Jev call is running for this session, call Jev with state `{ transcript: turns.join("\n") }` (the whole call fits in Jev 1.14's 256K context). Questions:
   - `impersonation` (Noul): "Someone on the call claims to be from a company, a government agency, the police, or a relative."
   - `money_or_code` (Noul): "Someone asks for money, gift cards, cryptocurrency, a transfer to a 'safe' account, or a verification code."
   - `urgency_secrecy` (Noul): "Someone pressures the listener to act now, stay on the line, or keep this secret."
   - `asks_code` (Noul): "Someone asks the listener to read out a one-time code, password or PIN."
   - `remote_access` (Noul): "Someone asks the listener to install an app or give access to their phone or computer."
   - `family_danger` (Noul): "Someone says a family member is hurt, arrested, kidnapped or in trouble."
   - `is_scam` (Noul): "This call is a scam."
   - `scam_type` (Choice): same options as Flow 1 step 7.

   Level rules are Flow 1 step 8's, without `known_contact` (a merged call never reveals the other number). Send one iMessage per newly crossed flag ≥ 0.7 or level increase, into the user's stored `space_id`, leading with the action:
   - `asks_code`: "⚠️ High risk: hang up. Never read a code to someone who called you."
   - `money_or_code`: "⚠️ Likely scam: hang up. Real companies never ask for gift cards or crypto."
   - `impersonation` with a brand: "⚠️ Likely scam: hang up. Real {brand} never calls you." (Gemini fills `{brand}` from the transcript)
   - `remote_access`: "⚠️ High risk: don't install anything. Hang up."
   - `family_danger ≥ 0.7`: start Flow 3 step 5.

   Users who never texted Bouncer have no `space_id`; Photon's shared line can't text them first, so live listen requires onboarding over iMessage.
7. **"Hey Bouncer" heard.** Set `mode = "talking"`. Call Gemini with the last 20 turns, the current level and flags, and this system prompt: "You are Bouncer on a phone call that a scammer may be listening to. Two sentences max. Never say a safe word, account details, addresses or other personal information; say 'I've sent that to your phone' and the server texts it. Never promise to take an action; say 'Reply YES to my text to confirm.' If the level is Likely scam or High risk, say 'This matches a known scam pattern.'" Stream Gemini's tokens back as `chat.completion.chunk` content deltas, then `data: [DONE]`. If Gemini takes over 700 ms to start, send a first chunk `"One moment... "`.
8. **Keep or leave talking mode.** On the next turn: "thanks bouncer" (same regex with `thanks?|thank you`) → say "Okay, I'll keep listening quietly." and set `mode = "listening"`. Otherwise ask Jev one Noul, `addressed_to_bouncer`: "The latest turn speaks to the assistant called Bouncer, not to another person on the call," with the last 3 turns as state. ≥ 0.6: answer as in step 7. Below: `skip_turn` and set `mode = "listening"`.
9. **Text-only actions.** Anything Bouncer would do (call Jake, alert the circle, send a reminder) is sent as an iMessage ending "Reply YES to confirm." Nothing happens on a spoken request alone, because the scammer can say "Hey Bouncer" too.
10. **Call ends.** On the post-call webhook, verify the `elevenlabs-signature` header with `elevenlabs.webhooks.constructEvent(rawBody, signature, ELEVENLABS_WEBHOOK_SECRET)` ([post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks)). Delete the session from memory. Insert an `events` row with `source = 'call'`, top level, flag names, alert count, duration, no transcript. Text the user: "Call summary: Bouncer spotted {n} red flags: {list}. Was it a scam? Reply YES or NO." Store the reply in `feedback`.

**Spike test before building anything else in this flow (about 1 hour):** merge a real call into the number and confirm (a) the agent never speaks over 3 minutes, including long silences; (b) `caller=` in the system message holds the caller's real number; (c) how many seconds pass between someone finishing a sentence and that turn reaching `/v1/chat/completions`; (d) two mixed voices still transcribe cleanly. If (a) fails, the backup is Twilio or LiveKit answering silently.

## Flow 3: Family safety

One rule: if the caller says the safe word correctly, it's really them; anything else, treat it as a scam. Bouncer coaches Grandma by text, calls the real relative's saved number itself, checks the word without ever saying it, and gives the circle only the scam type and outcome.

### Setup

1. **Start.** The organizer texts "set up family" (Flow 1 step 4 routes `setup` here). Bouncer asks one question per message: the protected person's name and number, then each member's name, relationship, number, and role: `guardian` (gets alerts) or `relative` (can be verification-called). The protected person must text Bouncer themselves at least once, because the shared line can't message them first.
2. **Join by code.** Create `circles` with a 6-character `join_code`. Reply: "Send each family member this: 'Text JOIN {code} to Bouncer' with the attached contact card." When someone texts `JOIN {code}`, match their handle to a listed member and reply: "{Organizer} added you to {Protected}'s Bouncer circle. You'll get the scam type and outcome if someone targets them, never their messages. Relatives may get one verification call from Bouncer. Reply YES to join." YES sets `circle_members.joined = true` and stores their `space_id`. Nobody is alerted or called until they've said YES.
3. **Store the safe word.** Bouncer texts the organizer: "Pick a word or short phrase you'd never say by accident and tell your family in person. Then text it to me here." Normalise it (lowercase, strip punctuation, collapse spaces), encrypt with AES-256-GCM (`SAFE_WORD_KEY`, random 12-byte IV) and store `ciphertext`, `iv`, `auth_tag` in `safe_words`. Reply: "Saved and encrypted. I'll never say it on a call. You can delete your message now." The key lives only in the server env, never in the database.

### During an emergency

4. **Trigger.** Grandma texts something like "Jake is calling me crying, says he's in jail" (Flow 1 step 4 `family_emergency`), or live listen sees `family_danger ≥ 0.7` (Flow 2 step 6).
5. **Find who is claimed.** Jev Choice `claimed_relative` on the text or call transcript, one criterion per joined relative (`jake`: "Grandson Jake") plus `none`. With `none` or confidence < 0.5, skip step 7 and coach only.
6. **Coach privately.** iMessage to Grandma: "Ask him for the family safe word. Don't say it yourself, and don't send money yet. I'm checking on Jake." If she replies asking what the word is, and the sender is the protected person in their own thread, decrypt and send "Your family word is: {word}. Delete this after the call." Text only; never in voice.
7. **Call the real relative.** Text-triggered: call now. Triggered by live listen: first text "Reply YES and I'll call Jake's own number to check he's safe," and wait for YES. Then `POST https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call` with header `xi-api-key: ELEVENLABS_API_KEY` and body `{ "agent_id": ELEVENLABS_VERIFY_AGENT_ID, "agent_phone_number_id": ELEVENLABS_PHONE_NUMBER_ID, "to_number": "<Jake's saved number>", "conversation_initiation_client_data": { "dynamic_variables": { "verify_id": "<id>", "relative_name": "Jake", "protected_name": "your grandma" } } }` ([outbound call](https://elevenlabs.io/docs/eleven-agents/api-reference/sip-trunk/outbound-call)). Insert `verifications { id, circle_id, relative_id, status: "calling", conversation_id }`.
8. **Run the verification call.** Agent "Bouncer Verify": Custom LLM at the same server URL with Model ID `bouncer-verify`; first message "Hi {{relative_name}}, this is Bouncer calling for {{protected_name}}. Are you safe right now?"; system prompt `verify={{verify_id}} conv={{system__conversation_id}}`; tools: `end_call` on. The server drives it:
   - Turn 1: store Jev Noul `says_unsafe` ("The speaker says they are not safe or need help"), then reply "Thanks. Please say your family safe word."
   - Each later turn: normalise the transcript and compare with the decrypted word, allowing one letter of difference per word for transcription errors. Match: reply "Thank you, that's right. I'll let {{protected_name}} know. Goodbye." and call `end_call`; status `verified_safe`, or `verified_needs_help` if `says_unsafe ≥ 0.6`.
   - Two turns without a match: "Thanks, I'll pass that on. Goodbye." and `end_call`; status `failed`. Never say, spell or hint the word.
   - No answer, voicemail, or no result in 90 seconds: status `unreachable` (from the `call_initiation_failure` webhook or the timer).
9. **Tell Grandma** by iMessage:
   - `verified_safe`: "Jake just answered his own phone and said the family word. He's safe. The call you're on is a scam: hang up."
   - `verified_needs_help`: "Jake answered and gave the family word, but says he needs help. Call him back on his own number, or 911 in an emergency."
   - `failed`: "Someone answered Jake's number but couldn't give the family word. Don't send money. Hang up and try Jake yourself."
   - `unreachable`: "I couldn't reach Jake. That doesn't mean he's in trouble. Don't send money; ask the caller for the family word."
   - If Grandma texts that the caller gave the word: "Then it's very likely really him. Call him back on his saved number to be sure."
10. **Ask about losses.** "Did you send money or share any codes? Reply NO or YES." YES starts Flow 4 step 1.
11. **Alert the circle.** Each joined guardian gets type and outcome only: "Grandma received a likely family-emergency scam. Jake is safe." Add "No money was sent." only if Grandma replied NO. Never message content.
12. **Log.** `events` row with `source = 'family'`, the outcome and which check decided it; no content.

## Flow 4: "I already clicked or paid" recovery (secondary)

Bouncer works out what was lost, then sends a short checklist one step at a time by text. By voice it gives one sentence and texts the rest.

1. **Trigger.** Flow 1 step 4 `already_paid`, a YES in Flow 3 step 10, or "Hey Bouncer, I already paid" on a call (Flow 2 step 7 replies "I've sent the steps to your phone").
2. **Classify the loss.** Jev Choice `loss_type` on the user's message: `clicked_only`, `entered_password`, `shared_code`, `paid_card`, `paid_gift_card`, `paid_crypto`, `paid_bank_or_p2p`, `installed_app`, `shared_ssn`. If confidence < 0.6, ask: "What happened? Reply 1 clicked a link, 2 typed a password, 3 shared a code, 4 paid by card, 5 gift card, 6 crypto, 7 bank transfer or Zelle, 8 installed an app, 9 gave my SSN."
3. **Send the checklist.** First message is the most time-critical step. Each later step is sent after the user replies DONE or NEXT:
   - `paid_card`: freeze the card in your bank app, then call the number on the back of the card and dispute the charge.
   - `paid_bank_or_p2p`: call your bank now and ask them to recall the payment; transfers are hardest to reverse later.
   - `paid_gift_card`: call the gift card company with the card number and receipt; keep both.
   - `paid_crypto`: contact the exchange's support from its app, then file at ic3.gov.
   - `entered_password` / `shared_code`: change that password, plus anywhere you reused it, and sign out other devices.
   - `installed_app`: turn off Wi-Fi and data, uninstall the app, then change banking passwords from another device.
   - `shared_ssn`: go to IdentityTheft.gov and freeze your credit with the three bureaus.
   - `clicked_only`: don't enter anything; close the page.
   - Last step for everyone: forward the scam text to 7726 (SPAM) and report at ReportFraud.ftc.gov.
4. **Bank call script.** For card and bank losses, Gemini writes a 4-line script with blanks: "I'm calling to report fraud on my account. On {date} I sent {amount} to {recipient} after a scam. Please stop or recall the payment and freeze the account." Bouncer never asks for or stores account numbers.
5. **Log.** `events` row with `source = 'recovery'` and `loss_type`; no amounts or details.

## Flow 5: Pattern recognition across users (secondary)

Reports become anonymised templates counted by ZIP area; when one spikes, nearby users get one local alert and Flow 1 starts checking new messages against it.

1. **Trigger.** A REPORT reply after a Flow 1 verdict, or a text routed as `report` in Flow 1 step 4.
2. **Get the text without storing it.** Flow 1 keeps the last analysed `body` per user in memory for 10 minutes only, for exactly this. A REPORT with nothing in memory: "Forward or screenshot the scam message and I'll add it."
3. **Make a template.** Gemini, JSON output: "Rewrite this message as a template. Replace names, phone numbers, amounts, dates, links and codes with {NAME}, {PHONE}, {AMOUNT}, {DATE}, {LINK}, {CODE}. Keep the brand name. Return template, brand, scam_type, link_domain." Reduce `link_domain` to its registered domain with `tldts`. Drop the original text.
4. **Embed.** `GEMINI_EMBED_MODEL` on the template; store in a pgvector column.
5. **Match or create.** Among `report_templates` with the same `scam_type` updated in the last 7 days, match on cosine similarity ≥ 0.88 or the same `link_domain`. Match: bump `last_seen`. None: insert a new template. Then add 1 to `report_counts (template_id, zip3, day)`, where `zip3` is the first three digits of the reporter's ZIP. No user id is stored.
6. **Detect a spike.** A template with ≥ 5 reports in one ZIP3 within 48 hours becomes `status = 'spiking'` (set the threshold to 3 for the demo).
7. **Send the local alert.** Gemini writes one line, for example: "Heads up: fake toll texts are spiking in North Texas. Real toll agencies don't text you a payment link." Send it once per template to opted-in users in that ZIP3 who have a `space_id`, at most one local alert per user per day.
8. **Feed detection.** Spiking templates are passed into Flow 1 step 7 as `active_patterns`, so the next matching message is caught even if it's worded to look friendly.
9. **Show it.** The dashboard's trends panel and report counter read `report_counts` (Flow 7 step 6).

## Flow 6: Accuracy test on the Mendeley dataset

Tune thresholds on 80% of the dataset, score once on the untouched 20%, and show three numbers on the dashboard: scams caught, flags that were right, and real messages wrongly flagged. About an hour, mostly waiting on API calls.

1. **Get the data.** Download the Mendeley SMS Phishing Dataset CSV (5,971 messages labelled ham, spam or smishing) into `data/`, which is git-ignored. Print the header row first and map its label and text columns; don't assume their names.
2. **Decide labels.** Positive = `smishing`. Negative = `ham`. `spam` is unwanted but not necessarily fraud: report its flag rate separately and leave it out of precision and false-alarm numbers.
3. **Split once.** Stratified 80/20 split with seed 42. Write the holdout row indexes to `data/holdout.json` and never send holdout rows to the tuning script.
4. **Tune.** Run Flow 1 step 7's questions (state = `{ body }`, no sender, `known_contact = false`) on a stratified 600-message sample of the 80%. Pick the Likely scam threshold where ham false alarms are ≤ 2%, the High risk threshold where precision is ≥ 97%, and the Unsure floor where ≥ 95% of smishing lands in Unsure or above. Save them to `config/thresholds.json` together with the `JEV_MODEL` string that produced them.
5. **Score the holdout.** All \~1,194 holdout rows, 8 requests at a time (`p-limit`), retrying 429 and 5xx with exponential backoff. Store `eval_results (row, label, p_scam, level, flags)`.
6. **Compute.** Scams caught = smishing at Likely or above ÷ all smishing. Flags right = smishing ÷ everything at Likely or above (ham + smishing). Real messages flagged = ham at Likely or above ÷ all ham. Also the share of each label in Unsure. Gemini adds a `scam_type` to each smishing row for the dashboard breakdown, since the dataset has none.
7. **Stress set.** Jev's failure-mode notes warn about literal reading and adversarial input. Hand-write 30 normal messages (bank alerts, 2FA codes, delivery updates, a pharmacy reminder) and 10 scams written to sound friendly. Score them separately and show them as their own row.
8. **Call scripts.** Write 6 scam call scripts (fake Coinbase, bank fraud department, IRS, tech support, toll, grandson in jail) and 3 normal calls. Feed each one turn at a time through Flow 2 step 6 and record which turn triggers the first alert; that's your "alert by turn N" number for the slide.

## Flow 7: Simulated carrier feed and T-Mobile dashboard

A replay script pretends to be T-Mobile's network by pushing dataset messages through Jev; the dashboard shows what the carrier would see; and when a flagged message is addressed to an enrolled demo user, Bouncer texts their real phone.

1. **Event format.** `{ event_id, type: "sms", to, from, body, zip, ts, true_label }`. `true_label` is used only for scoring and never shown to the classifier.
2. **Replay script** (`scripts/replay.ts`). Read dataset rows. Fill `to` with fictional numbers from the 555-0100 to 555-0199 range, `from` with random 10-digit numbers (5-digit short codes for spam), `zip` from a North Texas list (75201, 75074, 75061, 76010, 76102, 76201), and `ts` = now. POST each to `/carrier/events` with basic auth (`DASHBOARD_PASSWORD`).
3. **Classify.** `/carrier/events` runs Flow 1 step 7's Jev questions with state `{ body, sender: from }` and Flow 1 step 8's levels. Store a `carrier_events` row with level, `p_scam`, `scam_type` and the body (dataset text, not a real user's), then push it to the dashboard socket.
4. **Reach a real phone.** If `to` matches a user's `voice_phone`, the level is Likely scam or High risk, and the user has a `space_id`, Bouncer texts them through Photon: "⚠️ A text to your phone from {last 4 of from} looks like a {scam_type} scam ({confidence}% sure). Don't tap its link."
5. **Bulk mode.** `replay.ts --bulk --rate 20` sends the training split at 20 messages per second to fill the live feed and trends, and never triggers step 4.
6. **Dashboard.** Vite + React + Recharts, served by the same server at `/dashboard` behind basic auth, live updates on a Socket.IO namespace `/dash`. Panels:
   - **Live feed:** time, ZIP, level badge, Jev confidence, `scam_type`, masked sender; message body only for simulated carrier rows. Rows from real users (iMessage, calls, family) show type and outcome only.
   - **Accuracy:** Flow 6's three numbers on the holdout, the per-level breakdown, the stress-set row, the thresholds and the pinned `JEV_MODEL`.
   - **Trends:** flagged messages per hour by ZIP3, the report counter from `report_counts`, and the list of spiking templates (Flow 5).
   - **Demo controls:** "Send toll scam to Grandma's line" (injects one fixed toll-scam event with `to` = Grandma's number, which fires step 4), "Start bulk replay," "Stop," and "Reset demo" (clears sessions, `carrier_events` and demo events).
7. **Scam call.** Leave out a "Start scam call" button: an ElevenLabs outbound call would show Bouncer's own number as caller ID, which breaks the merge. A teammate calls the victim phone from their own phone instead.

## Privacy and consent, as implemented

Each promise in the team plan maps to a specific setting or line of code; if a row's "how" isn't built, drop that promise from the slide.

| Promise | How it's enforced |
| --- | --- |
| No message content kept | `events` has no body, sender or image columns; Flow 1 keeps `body` in memory 10 minutes for REPORT, then drops it |
| Screenshots deleted right after processing | Image buffer never written to disk; released after the Gemini call (Flow 1 step 5) |
| No audio or transcripts kept | Call turns live only in the in-memory session, deleted on the post-call webhook. ElevenLabs agent: audio saving off, shortest retention. Optional: server deletes each ElevenLabs conversation after the call (ElevenAgents Write key) |
| Safe words encrypted, never spoken | AES-256-GCM with a key only in the server env; Flow 2 step 7 prompt forbids it; Flow 3 step 8 compares without speaking it |
| Circle sees type and outcome only | Alert templates in Flow 3 step 11 take only `scam_type` and the outcome |
| Reports anonymised | `report_templates` stores placeholders; `report_counts` stores ZIP3 and day, no user id |
| Opt-in before anything | `opted_in` set only by a YES text; circle members join only by `JOIN {code}` + YES; relatives are called only after joining |

**Consent law remains the open risk.** Texas is one-party consent, so the demo is fine. Roughly a dozen states require every party's consent, and California's statute covers eavesdropping, not just recording ([Cal. Penal Code § 632](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=632)), so deleting transcripts at hang-up doesn't settle it. Put the proposed announce mode on the privacy slide: in those states, Bouncer speaks one line, "This call is being screened for scams," when it joins. Say plainly that you'd get a legal answer before shipping.

## Demo script

Four scenes in about four minutes: Grandma's iPhone mirrored to the projector, the dashboard on the laptop, and two teammate phones playing the scammer, Jake and Mom.

**Before going on stage:** Phone A (Grandma) has texted Bouncer, replied YES, and has the Bouncer contact card. Phone B (teammate: scammer, then Jake) and Phone C (Mom) have joined Grandma's circle with `JOIN {code}` + YES. The safe word is set. Press "Reset demo" on the dashboard.

| Time | Scene | On Grandma's phone | On the dashboard |
| --- | --- | --- | --- |
| 0:00 | Hook | One sourced stat from your FTC source | Title |
| 0:20 | Live listen | Phone B calls as "Coinbase security": "Your account was hacked, move your funds to this safe wallet." Grandma taps Add Call → Bouncer → Merge. Within seconds: "⚠️ Likely scam: hang up. Real Coinbase never calls you." Optional: Grandma says "Hey Bouncer, is this real?" and Bouncer says "This matches a known scam pattern. I've sent details to your phone." | New `call` row with level and confidence |
| 1:30 | Scam text + screenshot | Phone B sends a fake toll text while a teammate presses "Send toll scam to Grandma's line"; Bouncer's warning lands seconds later. Grandma then screenshots an Instagram DM scam and gets a verdict, red flags and one safe step | Carrier row with Jev confidence, then an `imessage` row |
| 2:15 | Family safety | Grandma texts "Jake is calling me crying, says he's in jail." Bouncer: "Ask him for the family safe word." Phone B rings: Bouncer's verification call; the teammate says the word. Grandma gets "Jake just answered his own phone and said the family word. He's safe." Phone C gets the circle alert | `family` row with outcome `verified_safe` |
| 3:30 | T-Mobile view | — | Live feed, accuracy panel with holdout numbers, trends by ZIP |
| 4:00 | Close | Privacy slide with the announce-mode proposal | Accuracy panel stays up |

**Keep it from failing on stage:**

- Record a backup video of every scene the night before.
- Test calling in the judging room; turn on Wi-Fi Calling on all three phones.
- Only text and call the team's own phones.
- Rehearse three times and write down how many seconds each alert takes.

## Build order and checklist

This follows the team plan's order, run as four parallel tracks, and assumes submission around noon Sunday (18 hours from 6 pm Saturday). The live-listen spike decides by 2:30 am whether you need the Twilio or LiveKit backup. Tracks: **V** Voice (Flow 2, verification call), **M** Messaging (Flows 1, 3, 4, 5), **D** Data (Flow 6, replay), **W** Web dashboard.

### 12:45 to 1:30 am · Setup

- [ ] All: `.env` filled from the keys section; ElevenLabs key set to ElevenAgents Write only
- [ ] M: Node 22 server with Postgres schema (`users`, `circles`, `circle_members`, `safe_words`, `contact_memory`, `events`, `feedback`, `verifications`, `report_templates`, `report_counts`, `carrier_events`, `eval_results`, `photon_cursor`, `processed_messages`), deployed to Railway with a public HTTPS URL
- [ ] M: Photon iMessage line assigned; Socket.IO connection logging raw envelopes
- [ ] V: Photon voice profile pointed at ElevenLabs; number imported; Bouncer Listen agent created with the custom LLM URL
- [ ] D: dataset downloaded, header checked, 80/20 split saved

### 1:30 to 3:00 am · First working pieces

- [ ] M: Flow 1 end to end: screenshot in, verdict out
- [ ] V: spike test (Flow 2): silent for 3 minutes, `caller=` filled in the system message, turn delay measured, merged audio transcribes
- [ ] V: 2:30 am decision: keep ElevenLabs-only, or add the silent-answer backup
- [ ] D: tuning run on the 600-message sample; thresholds saved
- [ ] W: dashboard shell with basic auth and the `/dash` socket

### 3:00 to 5:30 am · Core flows

- [ ] V: Flow 2 steps 4 to 10: background Jev, iMessage alerts, "Hey Bouncer" replies, post-call summary
- [ ] M: Flow 3 setup (join codes, encrypted safe word) and emergency texts
- [ ] V: Bouncer Verify agent and outbound call through Photon (Flow 3 steps 7 and 8)
- [ ] D: holdout scored; metrics and stress set computed
- [ ] W: live feed and accuracy panels

### 5:30 to 8:00 am · Carrier side and secondary features

- [ ] D: replay script, bulk mode, "Send toll scam to Grandma's line"
- [ ] W: trends panel and demo controls
- [ ] M: Flow 4 recovery checklist
- [ ] M: Flow 5 templates, spike rule and local alert
- [ ] D: call scripts run through Flow 2 step 6; "alert by turn N" recorded

### 8:00 to 10:30 am · Harden

- [ ] All: three full rehearsals with alert times written down
- [ ] All: backup video of every scene
- [ ] All: slides: problem, demo, pipeline, accuracy numbers, privacy and announce mode, scoring table for both tracks
- [ ] All: code freeze at 10:30 am

### 10:30 am to noon · Buffer and submit

- [ ] Submit for both the T-Mobile and Photon tracks
- [ ] Rotate or delete any keys that were shared in chat or screenshots

## Sources

- Photon 2.0 Beta: [overview](https://photon.codes/docs/beta/photon.md), [get started](https://photon.codes/docs/beta/index.md), [iMessage guide](https://photon.codes/docs/beta/get-started/imessage.md), [voice guide (ElevenLabs over SIP)](https://photon.codes/docs/beta/get-started/voice.md), [credentials](https://photon.codes/docs/beta/api-client/credentials.md), [API reference](https://photon.codes/docs/beta/api-reference.md), [WebSocket connect](https://photon.codes/docs/beta/websocket/connect), [WebSocket frames](https://photon.codes/docs/beta/websocket/frames)
- ElevenLabs: [custom LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm.md), [skip turn tool](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/skip-turn.md), [SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking), [outbound call via SIP trunk](https://elevenlabs.io/docs/eleven-agents/api-reference/sip-trunk/outbound-call), [post-call webhooks](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks)
- TypeSafe Jev: [introduction](https://docs.typesafe.ai/introduction), [quickstart](https://docs.typesafe.ai/introduction/quickstart.md), [patterns](https://docs.typesafe.ai/patterns.md)
- [California Penal Code § 632](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=PEN&sectionNum=632)
- The team's plan (Nov 7, 2026, written under the earlier name Scout), including its dataset, Jev 1.14 context-size and failure-mode references
