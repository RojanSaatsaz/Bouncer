// Photon 2.0 REST helpers: send text, download an image attachment, typing indicator.
// Shapes verified against @photon-ai/api 0.6.0 types (see docs/API_NOTES.md).
import { Photon, ApiError } from "@photon-ai/api";
import { config } from "../config.js";

export const photon = new Photon({
  headers: { Authorization: `Bearer ${config.photon.apiKey}` },
});

const projectId = config.photon.projectId;

export interface SendTextArgs {
  spaceId: string;
  /** The agent's own Photon user id on this line (incoming `receivedBy.id`). */
  senderId: string;
  text: string;
  /** Same key on retry = no duplicate message. Convention: "bouncer:<msgId>:<n>". */
  idempotencyKey: string;
  parentMessageId?: string;
}

/** Sends one plain-text iMessage. Photon accepts it for async dispatch (not proof of delivery). */
export async function sendText(args: SendTextArgs): Promise<void> {
  if (config.photon.dryRun) {
    console.log(`[photon:dry-run] → space ${args.spaceId.slice(0, 12)}…  ${args.text}`);
    return;
  }
  try {
    await photon.projects.sendMessage({
      path: { id: projectId },
      headers: { "idempotency-key": args.idempotencyKey },
      body: {
        spaceId: args.spaceId,
        senderId: args.senderId,
        ...(args.parentMessageId ? { parentMessageId: args.parentMessageId } : {}),
        content: { type: "text", format: "plain", text: args.text },
      },
    });
  } catch (err) {
    throw describe(err, "sendMessage");
  }
}

/** Sends several lines as separate messages, in order. Keys get :1, :2, :3 suffixes. */
export async function sendLines(
  base: Omit<SendTextArgs, "text" | "idempotencyKey"> & { keyPrefix: string },
  lines: string[],
): Promise<void> {
  const { keyPrefix, ...rest } = base;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.trim()) continue;
    await sendText({ ...rest, text: lines[i], idempotencyKey: `${keyPrefix}:${i + 1}` });
  }
}

/** Downloads attachment bytes into memory. Never write them to disk (CLAUDE.md rule 1). */
export async function downloadAttachment(attachmentId: string): Promise<{ data: Buffer; contentType: string }> {
  try {
    const meta = await photon.projects.getAttachment({ path: { id: projectId, attachmentId } });
    const blob = await photon.projects.downloadAttachment({ path: { id: projectId, attachmentId } });
    return { data: Buffer.from(await blob.arrayBuffer()), contentType: meta.contentType || blob.type || "image/jpeg" };
  } catch (err) {
    throw describe(err, "downloadAttachment");
  }
}

/** Shows or hides the "…" typing bubble. Failures are ignored: it's cosmetic. */
export async function setTyping(spaceId: string, senderId: string, typing: boolean): Promise<void> {
  if (config.photon.dryRun) return;
  try {
    await photon.projects.setSpaceTyping({ path: { id: projectId, spaceId }, body: { senderId, typing } });
  } catch (err) {
    console.warn("[photon] setTyping failed:", describe(err, "setSpaceTyping").message);
  }
}

function describe(err: unknown, op: string): Error {
  if (err instanceof ApiError) {
    const code = (err.body as any)?.code ?? "";
    return new Error(`Photon ${op} failed: HTTP ${err.status} ${code} (request ${err.requestId ?? "?"})`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
