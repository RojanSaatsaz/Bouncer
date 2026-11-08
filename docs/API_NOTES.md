# Verified API notes (Nov 8, 2026, ~3 AM)

Each fact below was checked against the live API or the SDK's generated types, not guessed (CLAUDE.md rule 6). Add to this file whenever you confirm something new.

## TypeSafe Jev — `POST https://api.typesafe.ai/v1/systemone`

- Live model behind `jev-latest`: **`jev-1.14.0`** (pin this in `JEV_MODEL` after tuning). About 270–450 ms per call with 3–8 questions.
- `state` may be a string **or a JSON object** (both tested).
- `noul` → `{ "type": "noul", "noul": 0.97 }`
- `choice` (criteria = object label → description) → `{ "choice": "toll_or_delivery", "confidence": 1.0, "probabilities": { … } }`
- `score` **requires `criteria: string[]`** (422 without it) → `{ "score": 1.58, "confidence": 0.37, "legend": {"0": …}, "probabilities": {"0": …} }`
- Client: `src/detection/jev.ts` (retries 429/5xx with backoff).

## Gemini — REST v1beta

- `gemini-2.5-flash` is **retired for new users (404)**. `gemini-3.8-flash` and `3.7-flash` returned **503 "high demand"** on every try tonight.
- `GEMINI_MODEL=gemini-3.5-flash` (served as `gemini-3.6-flash`): works, but took 1.5–17 s and sometimes 503s. It thinks by default; `thinkingConfig: { thinkingBudget: 0 }` turns that off.
- `GEMINI_FAST_MODEL=gemini-3.5-flash-lite`: about 0.6–0.9 s for JSON output, and about 0.5 s to the first streamed chunk. No thinking.
- JSON output: `generationConfig.responseMimeType = "application/json"` + `responseSchema` (OpenAPI subset). Works on both models.
- Streaming: `:streamGenerateContent?alt=sse` gives `data: {candidates:[{content:{parts:[{text}]}}]}` lines.
- Client: `src/detection/gemini.ts`. Each call has a timeout and falls back to the other tier on 503, 429 or timeout.

## Photon 2.0 (`@photon-ai/api` 0.6.0, Node ≥ 22)

- REST methods on `photon.projects`: `sendMessage`, `listMessages`, `getAttachment`, `downloadAttachment`, `setSpaceTyping` (all take `path: { id: projectId, … }`).
- `sendMessage`: `headers: { "idempotency-key" }`, `body: { spaceId, senderId, parentMessageId?, content: { type: "text", format: "plain", text } }`. The reply says "accepted for async dispatch", which doesn't prove delivery.
- Received iMessage: `{ id, status: "received", platform: "imessage", sentBy: { kind: "human", handle, id }, receivedBy: { kind: "agent", id }, space: { id, kind: "direct" }, content, timestamps.receivedAt }`.
- `content` is one of: `text { text, format }`, **`attachment { attachmentId }`** (images), `group { parts: [text | attachment …] }`, `message.read`, `space.typing.update`.
- Image bytes: `GET /v1/projects/{id}/attachments/{attachmentId}/content` (a Blob; returns `ATTACHMENT_NOT_READY` + `Retry-After: 5` if it isn't ready after 10 s). `getAttachment` returns `contentType` and `sizeBytes`.
- Socket.IO: `https://api.photon.codes`, `path: /v1/projects/{id}/events/ws`, websocket only, bearer header. `subscribe { startSeq, apiVersion: "2026-07-01" }` → ack `{ ok, connectionId, limits: { maxFrameBytes: 1572864, maxReplyBodyBytes: 1048576 } }`. `startSeq: 0` = live only. To resume, pass the **last processed** seq (not seq + 1). Seqs can have gaps. Save the cursor only after the handler succeeds.
- `delivery` = `[envelope, { seq, replyExpected }]`. **Confirmed from a live text (03:46):** envelope = `{ id: "pho_evt_…", apiVersion: "2026-07-01", type: "message.received", source, timestamp, data: { object: <Message>, projectId } }`, with `replyExpected: false`. The message has `status: "received"`, `sentBy { kind: "human", handle, id }`, `receivedBy { kind: "agent", id, details: { type: "shared" } }`, `space { id, kind: "direct", participantIds }`, `content`, and `timestamps.receivedAt`. Not yet seen live: an image delivery (the SDK types say `content.type = "attachment"` with an `attachmentId`, or a `group` of parts).
- The project key gets 403 on `listWebhookEventTypes`.

## ElevenLabs

- Agents (`GET/PATCH /v1/convai/agents/{id}`). PATCH is a deep merge, but `prompt.custom_llm` must be sent together with `prompt.llm`.
  - **Bouncer Listen:** blank first message; prompt `conv={{system__conversation_id}} caller={{system__caller_id}}`; custom LLM `${PUBLIC_BASE_URL}/v1`, model_id `bouncer-listen`; tool `skip_turn` (`wait_timeout_secs: -1`); turn_timeout 7 s, soft timeout off, silence end-call off; max 1800 s; `record_voice: false`, `retention_days: 1`.
  - **Bouncer Verify:** first message `Hi {{relative_name}}, this is Bouncer calling for {{protected_name}}. Are you safe right now?`; prompt `verify={{verify_id}} conv={{system__conversation_id}}`; model_id `bouncer-verify`; tool `end_call`; same privacy settings.
- Phone number `phnum_…` = `+16179939248`, SIP trunk `sip.photon.codes` TLS, inbound and outbound, **assigned to Bouncer Listen** (it was unassigned before tonight).
- Workspace post-call webhook: `${PUBLIC_BASE_URL}/elevenlabs/post-call`, HMAC. Events `transcript` + `call_initiation_failure`, **`exclude_transcript: true`**, no audio.
- No conversation-initiation webhook is configured yet (`BOUNCER_INIT_TOKEN` is reserved for it).

## Railway

- Service `HackUTD-26` deploys from GitHub `RojanSaatsaz/HackUTD-26` (a push to main triggers a deploy). The domain targets port 3000, so the `PORT=3000` variable is pinned to match.
- Postgres has no public proxy. Locally, run `railway connect Postgres --tunnel-only --port 54329`; `.env` points at `127.0.0.1:54329`. **The tunnel dies whenever the app service redeploys** (it goes through the app container), so rerun it after each deploy.
