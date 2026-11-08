// Flow 7: simulated carrier feed (POST /carrier/events) and the T-Mobile dashboard (/dashboard/*).
// Mounted by src/index.ts with `app.route("/", dashboardApp)`. Everything here sits behind basic auth
// (any user name, DASHBOARD_PASSWORD); with no password set the routes answer 503.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { one } from "../db.js";
import { thresholds } from "../detection/risk.js";
import { ingestEvent, parseEvent } from "../carrier/ingest.js";
import { tollEvent } from "../carrier/dataset.js";
import { startReplay, stopReplay, replayStatus } from "../carrier/replayer.js";
import { toE164 } from "../users.js";
import { snapshot, subscribe, resetDemo } from "./feed.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.join(HERE, "page.html");
const ACCURACY_PATH = path.resolve(process.cwd(), "config/accuracy.json");

const sha = (s: string) => createHash("sha256").update(s).digest();

/** Basic auth: any user name, password = DASHBOARD_PASSWORD. Compared in constant time. */
const requireAuth: MiddlewareHandler = async (c, next) => {
  const want = config.dashboardPassword;
  if (!want) return c.text("Dashboard disabled: set DASHBOARD_PASSWORD.", 503);
  const m = /^Basic\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
  const decoded = m ? Buffer.from(m[1], "base64").toString("utf8") : "";
  const pass = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : "";
  if (!m || !timingSafeEqual(sha(pass), sha(want))) {
    return c.text("Unauthorized", 401, { "WWW-Authenticate": 'Basic realm="Bouncer dashboard", charset="UTF-8"' });
  }
  await next();
};

/** Demo buttons send this header; a cross-site form can't, so basic auth alone can't be ridden (CSRF). */
const requireXhr: MiddlewareHandler = async (c, next) => {
  if (c.req.header("x-bouncer-dashboard") !== "1") return c.json({ error: "missing X-Bouncer-Dashboard header" }, 403);
  await next();
};

export const dashboardApp = new Hono();

// Specific paths only: a "*" middleware here would also guard the parent app's routes after app.route().
dashboardApp.use("/dashboard", requireAuth);
dashboardApp.use("/dashboard/*", requireAuth);
dashboardApp.use("/carrier/*", requireAuth);
dashboardApp.use("/dashboard/demo/*", requireXhr);

// ---- Flow 7 steps 1–5: one simulated network SMS ----
dashboardApp.post("/carrier/events", async (c) => {
  const ev = parseEvent(await c.req.json().catch(() => null));
  if (typeof ev === "string") return c.json({ error: ev }, 400);
  try {
    return c.json(await ingestEvent(ev));
  } catch (err: any) {
    console.error(`[carrier] ${ev.event_id.slice(0, 40)} failed: ${err?.message}`);
    return c.json({ error: "classification failed", detail: String(err?.message ?? err).slice(0, 200) }, 502);
  }
});

// ---- dashboard page + data ----
const page = () => fs.readFileSync(PAGE_PATH, "utf8"); // read per request: edits show without a restart
const servePage = (c: any) => c.html(page(), 200, { "Cache-Control": "no-store" });
dashboardApp.get("/dashboard", servePage);
dashboardApp.get("/dashboard/", servePage);

dashboardApp.get("/dashboard/accuracy", (c) => {
  let accuracy: unknown = null;
  try {
    accuracy = JSON.parse(fs.readFileSync(ACCURACY_PATH, "utf8"));
  } catch {
    accuracy = null;
  }
  return c.json({
    accuracy,
    thresholds: { unsure: thresholds.unsure, likely: thresholds.likely, high: thresholds.high, jev_model: thresholds.jev_model },
    jevModelLive: config.typesafe.model,
  });
});

dashboardApp.get("/dashboard/feed", async (c) => c.json(await snapshot()));

// Server-Sent Events: "init" (snapshot), then "rows" and "stats" from the shared poller.
dashboardApp.get("/dashboard/stream", (c) => {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      let open = true;
      const write = (s: string) => {
        if (!open) return;
        try {
          ctrl.enqueue(enc.encode(s));
        } catch {
          cleanup();
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      write("retry: 3000\n\n");
      snapshot().then(
        (s) => send("init", s),
        (err) => send("error", { message: String(err?.message ?? err).slice(0, 200) }),
      );
      const unsubscribe = subscribe(send);
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      cleanup = () => {
        if (!open) return;
        open = false;
        unsubscribe();
        clearInterval(ping);
        try {
          ctrl.close();
        } catch {}
      };
      c.req.raw.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  // Fresh headers object per response (see the Content-Length note in src/voice/sse.ts).
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// ---- demo controls ----

/** Grandma's line: DEMO_VICTIM_PHONE, else the protected user of the first circle. */
async function demoVictimPhone(): Promise<string | null> {
  if (config.demoVictimPhone) return toE164(config.demoVictimPhone);
  const r = await one<{ voice_phone: string | null }>(
    `SELECT u.voice_phone FROM circles c JOIN users u ON u.id = c.protected_user_id
      WHERE u.voice_phone IS NOT NULL ORDER BY c.created_at LIMIT 1`,
  );
  return r?.voice_phone ?? null;
}

dashboardApp.post("/dashboard/demo/toll", async (c) => {
  const to = await demoVictimPhone();
  if (!to) return c.json({ error: "No demo victim: run `npm run seed:family` or set DEMO_VICTIM_PHONE." }, 409);
  try {
    const v = await ingestEvent(tollEvent(to));
    return c.json({ ...v, to: "…" + to.slice(-4) });
  } catch (err: any) {
    return c.json({ error: "classification failed", detail: String(err?.message ?? err).slice(0, 200) }, 502);
  }
});

dashboardApp.post("/dashboard/demo/replay/start", (c) => c.json(startReplay()));
dashboardApp.post("/dashboard/demo/replay/stop", (c) => c.json(stopReplay()));
dashboardApp.get("/dashboard/demo/replay", (c) => c.json(replayStatus()));

dashboardApp.post("/dashboard/demo/reset", async (c) => {
  stopReplay();
  return c.json(await resetDemo());
});
