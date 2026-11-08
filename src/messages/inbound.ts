// OWNER: Flow 1 (messaging). Every inbound iMessage lands here (src/photon/socket.ts).
// Foundation stub: remembers the conversation so other flows can text the user, logs nothing else.
import type { InboundMessage } from "../photon/socket.js";
import { getOrCreateUser, saveConversation } from "../users.js";

export async function handleInbound(msg: InboundMessage): Promise<void> {
  const { user, created } = await getOrCreateUser(msg.senderHandle);
  await saveConversation(user.id, msg.spaceId, msg.agentUserId);
  console.log(
    `[inbound] stub: user ${user.id.slice(0, 8)} ${created ? "(new)" : ""} text=${msg.text ? "yes" : "no"} images=${msg.attachmentIds.length}`,
  );
}
