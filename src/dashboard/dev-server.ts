// Local test server for Flow 7 only: mounts dashboardApp the same way src/index.ts does, without the
// Photon socket or voice routes. Run: tsx --env-file=.env src/dashboard/dev-server.ts (PORT defaults to 3007).
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { pool } from "../db.js";
import { ensureSchema } from "../schema.js";
import { dashboardApp } from "./app.js";

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
app.route("/", dashboardApp);

const port = Number(process.env.DEV_PORT) || 3007;
await ensureSchema(pool);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (i) => console.log(`flow 7 dev server on http://127.0.0.1:${i.port}/dashboard`));
