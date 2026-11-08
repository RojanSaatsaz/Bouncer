// Photon Socket.IO event stream (SPEC Flow 1 steps 1–2). One server instance only (rule 5).
// Verified: connect + subscribe ack { ok, apiVersion: "2026-07-01", limits }, delivery = [envelope, { seq, replyExpected }].
// Verified from a live event (2026-11-08): envelope = { id: "pho_evt_…", apiVersion, type: "message.received",
// source, timestamp, data: { object: <Message>, projectId } }, replyExpected: false.
import { io, type Socket } from "socket.io-client";
import { config } from "../config.js";
import { query, one } from "../db.js";

export interface InboundMessage {
  id: string;
  spaceId: string;
  spaceKind: string;
  /** Sender's iMessage handle: phone (E.164) or Apple ID email. */
  senderHandle: string;
  /** Our agent's user id on the line (`receivedBy.id`) — the `senderId` for replies. */
  agentUserId: string;
  /** All text parts joined, or null. In memory only; never log or store it. */
  text: string | null;
  attachmentIds: string[];
  receivedAt: string;
}

type Handler = (msg: InboundMessage) => Promise<void>;

const API_VERSION = "2026-07-01";
let socket: Socket | null = null;
let shapeLogs = 0;

/** Structure only — keys, types, enum-ish values. Never message text (rule 1). */
function shape(v: any, k = ""): any {
  if (Array.isArray(v)) return v.length ? [shape(v[0], k)] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, shape(vv, kk)]));
  if (typeof v === "string") return /^(type|kind|platform|status|format|contentType)$/.test(k) ? v : `<str ${v.length}>`;
  return typeof v;
}

/** The Photon message inside a `message.received` envelope (`data.object`); null for any other event type. */
export function findMessage(env: any): any | null {
  if (env?.type !== "message.received") return null;
  const m = env?.data?.object;
  return m && typeof m === "object" && m.content && m.sentBy && m.space ? m : null;
}

export function normalize(m: any): InboundMessage | null {
  if (!m || m.status !== "received" || m.platform !== "imessage") return null;
  if (m.sentBy?.kind && m.sentBy.kind !== "human") return null;
  const parts: any[] = m.content?.type === "group" ? m.content.parts ?? [] : [m.content];
  const texts = parts.filter((p) => p?.type === "text" && p.text?.trim()).map((p) => p.text.trim());
  const attachmentIds = parts.filter((p) => p?.type === "attachment" && p.attachmentId).map((p) => p.attachmentId);
  if (!texts.length && !attachmentIds.length) return null; // read receipts, typing updates
  return {
    id: m.id,
    spaceId: m.space?.id,
    spaceKind: m.space?.kind ?? "direct",
    senderHandle: m.sentBy?.handle,
    agentUserId: m.receivedBy?.id ?? m.addressedTo?.id,
    text: texts.length ? texts.join("\n") : null,
    attachmentIds,
    receivedAt: m.timestamps?.receivedAt ?? m.createdAt,
  };
}

/** Returns false if this message id was already handled (replay after reconnect). */
async function claim(id: string): Promise<boolean> {
  const row = await one("INSERT INTO processed_messages (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id", [id]);
  return !!row;
}

async function savedCursor(): Promise<number> {
  const row = await one<{ seq: string | null }>("SELECT seq FROM photon_cursor WHERE id = 1");
  return row?.seq ? Number(row.seq) : 0;
}

async function saveCursor(seq: number) {
  await query(
    `INSERT INTO photon_cursor (id, seq, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET seq = GREATEST(photon_cursor.seq, EXCLUDED.seq), updated_at = now()`,
    [seq],
  );
}

// Messages from the same conversation are handled one at a time, in order; different users run in parallel.
const chains = new Map<string, Promise<void>>();
function enqueue(key: string, job: () => Promise<void>) {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(job, job).finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  chains.set(key, next);
}

export function startPhotonSocket(handler: Handler) {
  if (!config.photon.socket) {
    console.log("[photon] socket disabled (PHOTON_SOCKET=off). Another instance owns the iMessage line.");
    return;
  }
  socket = io("https://api.photon.codes", {
    path: `/v1/projects/${config.photon.projectId}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { Authorization: `Bearer ${config.photon.apiKey}` },
    autoConnect: false,
  });

  socket.on("connect", async () => {
    const startSeq = await savedCursor().catch(() => 0);
    socket!.timeout(10_000).emit("subscribe", { startSeq, apiVersion: API_VERSION }, (err: Error | null, res: any) => {
      if (err) {
        console.error("[photon] subscribe timed out; reconnecting");
        socket!.disconnect().connect();
        return;
      }
      if (!res?.ok) return console.error("[photon] subscribe rejected:", res?.error?.code);
      console.log(`[photon] subscribed from seq ${startSeq} (api ${res.apiVersion})`);
    });
  });
  socket.on("connect_error", (e) => console.error("[photon] connect_error:", e.message));
  socket.on("disconnect", (reason) => console.warn("[photon] disconnected:", reason));
  socket.on("delivery_error", (e: any) => console.error("[photon] delivery_error:", e?.code, e?.message, e?.fatal ? "(fatal)" : ""));

  socket.on("delivery", async (env: any, meta: { seq: number; replyExpected: boolean }) => {
    if (meta?.replyExpected) socket!.emit("reply", { eventId: env.id, status: 200 });
    const msgObj = findMessage(env);
    if (shapeLogs < 3) {
      shapeLogs++;
      console.log(`[photon] delivery type=${env?.type} seq=${meta?.seq} shape=${JSON.stringify(shape(env))}`);
    }
    const msg = normalize(msgObj);
    try {
      if (msg && (await claim(msg.id))) {
        enqueue(msg.spaceId, async () => {
          try {
            await handler(msg);
          } catch (err: any) {
            console.error(`[photon] handler failed for ${msg.id}:`, err?.message);
          }
        });
      }
      if (typeof meta?.seq === "number") await saveCursor(meta.seq);
    } catch (err: any) {
      console.error("[photon] delivery bookkeeping failed:", err?.message);
    }
  });

  socket.connect();
}

export function stopPhotonSocket() {
  socket?.close();
  socket = null;
}
