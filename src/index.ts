import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.text("Bouncer is running"));
app.get("/health", (c) => c.json({ ok: true, time: new Date().toISOString() }));

// Railway sets PORT for you. Bind to 0.0.0.0 so it's reachable from outside the container.
const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`Bouncer listening on port ${info.port}`);
});
