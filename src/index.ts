import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { pool } from "./db.js";
import { ensureSchema } from "./schema.js";
import { startPhotonSocket, stopPhotonSocket } from "./photon/socket.js";
import { handleInbound } from "./messages/inbound.js";
import { handleChatCompletions } from "./voice/llm.js";
import { handlePostCall, handleInit } from "./voice/webhooks.js";

const app = new Hono();

const bearerOk = (header: string | undefined, secret: string) => {
  const got = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
};

app.get("/", (c) => c.text("Bouncer is running"));
app.get("/health", async (c) => {
  const db = await pool.query("SELECT 1").then(() => true, () => false);
  return c.json({ ok: true, db, photonSocket: config.photon.socket, time: new Date().toISOString() });
});

// ElevenLabs custom LLM (both agents). ElevenLabs appends /chat/completions to the configured /v1 URL.
app.post("/v1/chat/completions", async (c) => {
  if (!bearerOk(c.req.header("authorization"), config.llmSecret)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  if (!body?.messages) return c.json({ error: "bad request" }, 400);
  return handleChatCompletions(c, body);
});

app.post("/elevenlabs/post-call", (c) => handlePostCall(c));
app.post("/elevenlabs/init", (c) => handleInit(c));

// Railway sets PORT (pinned to 3000 in Variables to match the domain's target port). Bind 0.0.0.0.
serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`Bouncer listening on port ${info.port}`);
});

// Safety net: a stray rejected promise in background work (Jev/Gemini/DB) must not take the server down mid-demo.
process.on("unhandledRejection", (err: any) => console.error("[process] unhandled rejection:", err?.message ?? err));

void ensureSchema(pool);
startPhotonSocket(handleInbound);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopPhotonSocket();
    pool.end().finally(() => process.exit(0));
  });
}
