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
- `delivery` = `[envelope, { seq, replyExpected }]`. **Confirmed from a live text (03:46):** envelope = `{ id: "pho_evt_…", apiVersion: "2026-07-01", type: "message.received", source, timestamp, data: { object: <Message>, projectId } }`, with `replyExpected: false`. The message has `status: "received"`, `sentBy { kind: "human", handle, id }`, `receivedBy { kind: "agent", id, details: { type: "shared" } }`, `space { id, kind: "direct", participantIds }`, `content`, and `timestamps.receivedAt`. **Image confirmed live (03:47):** a screenshot arrives as its own message with `content: { type: "attachment", attachmentId: "pho_att_…" }`. Downloading a 326 KB `image/png` took 1.2–3.5 s (metadata and bytes fetched in parallel), so budget for it in Flow 1's 6 s target.
- The project key gets 403 on `listWebhookEventTypes`.

## ElevenLabs

- Agents (`GET/PATCH /v1/convai/agents/{id}`). PATCH is a deep merge, but `prompt.custom_llm` must be sent together with `prompt.llm`.
  - **Bouncer Listen:** blank first message; prompt `conv={{system__conversation_id}} caller={{system__caller_id}}`; custom LLM `${PUBLIC_BASE_URL}/v1`, model_id `bouncer-listen`; tool `skip_turn` (`wait_timeout_secs: -1`); turn_timeout 7 s, soft timeout off, silence end-call off; max 1800 s; `record_voice: false`, `retention_days: 1`.
  - **Bouncer Verify:** first message `Hi {{relative_name}}, this is Bouncer calling for {{protected_name}}. Are you safe right now?`; prompt `verify={{verify_id}} conv={{system__conversation_id}}`; model_id `bouncer-verify`; tool `end_call`; same privacy settings.
- Phone number `phnum_…` = `+16179939248`, SIP trunk `sip.photon.codes` TLS, inbound and outbound, **assigned to Bouncer Listen** (it was unassigned before tonight).
- Workspace post-call webhook: `${PUBLIC_BASE_URL}/elevenlabs/post-call`, HMAC. Events `transcript` + `call_initiation_failure`, **`exclude_transcript: true`**, no audio.
- No conversation-initiation webhook is configured yet (`BOUNCER_INIT_TOKEN` is reserved for it).
- **SIP outbound call** `POST /v1/convai/sip-trunk/outbound-call` (checked against docs + SDK; not yet placed for real). Body `{ agent_id, agent_phone_number_id, to_number, conversation_initiation_client_data?: { dynamic_variables }, telephony_call_config? }`. 200 response `{ success: boolean, message: string, conversation_id: string|null, sip_call_id: string|null }`, so the id field is **`conversation_id`** and it can be null. Sources: https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call; `@elevenlabs/elevenlabs-js` 2.77.0 `SipTrunkOutboundCallResponse` (serialization `Raw`) and `BodyHandleAnOutboundCallViaSipTrunkV1ConvaiSipTrunkOutboundCallPost`.
- **System tools from a custom LLM.** ElevenLabs puts the enabled system tools in the `tools` array of each `/v1/chat/completions` request as OpenAI function definitions. The LLM calls one the OpenAI way: `tool_calls: [{ index, id, type: "function", function: { name, arguments: "<JSON string>" } }]`. We end the stream with `finish_reason: "tool_calls"`, then `data: [DONE]`. The docs only say "OpenAI format" and give no chunk-level layout. Source: https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm.
  - `end_call` args: `{ reason: string (required), message?: string }`, where `message` is a farewell spoken before hanging up. We stream our own goodbye as content and then send `{ reason }`. We leave out `message` so the goodbye isn't spoken twice. Sources: custom-llm page (`"required": ["reason"]`), https://elevenlabs.io/docs/agents-platform/customization/tools/system-tools/end-call, SDK `EndCallToolResultModel { status, reason, message }`.
  - `skip_turn` args: `{ reason?: string }` with `"required": []`, so our `"{}"` is valid. `wait_timeout_secs` belongs to the agent config (`params`) and is not a call argument. Sources: custom-llm page, https://elevenlabs.io/docs/agents-platform/customization/tools/skip-turn, SDK `SkipTurnToolConfig { waitTimeoutSecs }` and `SkipTurnToolResponseModel { status, reason }`.
  - Live agent config from GET on Nov 8: Verify has system tool `end_call` with `params: { system_tool_type: "end_call" }`. Listen has `skip_turn` with `params: { system_tool_type: "skip_turn", wait_timeout_secs: -1, omit_from_transcript: false }`. The GET doesn't show the parameter schema the LLM sees; that comes from the docs above.

## Railway

- Service `HackUTD-26` deploys from GitHub `RojanSaatsaz/HackUTD-26` (a push to main triggers a deploy). The domain targets port 3000, so the `PORT=3000` variable is pinned to match.
- Postgres has no public proxy. Locally, run `railway connect Postgres --tunnel-only --port 54329`; `.env` points at `127.0.0.1:54329`. **The tunnel dies whenever the app service redeploys** (it goes through the app container), so rerun it after each deploy.

## OpenRouter web search (verified Nov 8, 2026, ~8 AM)

- Add `plugins: [{ id: "web", engine: "parallel", mode: "fast", max_results: 5, include_domains: [...] }]` to a normal chat-completions request. Results come back in `choices[0].message.annotations[].url_citation` as `{ url, title, content }`, where `content` is about 1.3–1.5 KB of page text.
- A government-only search uses **`include_domains: [".gov"]`**. Both `"*.gov"` and `"gov"` return **HTTP 500** with the Parallel engine. Exa accepts `"*.gov"` but takes about 2.4 s instead of about 1 s.
- Cost is about $0.001 per lookup in total (search plus DeepSeek tokens), and it takes about 0.9–1.4 s.
- Results differ from run to run, so `scripts/verify-contacts.ts` tries each lookup 3 times and keeps a number that was verified on an earlier run.

