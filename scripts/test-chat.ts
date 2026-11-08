// Chat runner: drives one iMessage conversation through the real router in ONE process (so the
// 30-minute chat memory in src/messages/history.ts carries across turns) with DRY_RUN on, then prints
// the transcript with per-turn latency. Uses live Jev + Gemini and the DB in DATABASE_URL.
//   npm run test:chat                      (the default conversation below)
//   npm run test:chat -- "hi" "why?" ...   (your own turns, in order)
//   npm run test:chat -- --new ...         (as a brand-new user: the welcome text comes first)
// Uses the fake handle +15555550191 and deletes its rows afterwards.
export {};
process.env.DRY_RUN = "1";
process.env.PHOTON_SOCKET = "off";

const { handleInbound } = await import("../src/messages/inbound.js");
const { dryRunOutbox } = await import("../src/photon/client.js");
const { query, pool } = await import("../src/db.js");
const { getOrCreateUser, saveConversation } = await import("../src/users.js");

const HANDLE = "+15555550191";
const SPACE = "tsp-chat-0191";
const AGENT = "tsp-agent";

const DEFAULT_TURNS = [
  "hello",
  "whats up",
  "what can you do?",
  "NTTA: You have an unpaid toll balance of $4.35. Pay by 11/10 to avoid a $50 late fee: https://ntta-pay.top/pay",
  "why?",
  "are you sure?",
  "thanks!",
  "how do I know if a call is really my bank?",
];

let args = process.argv.slice(2);
const asNew = args[0] === "--new";
if (asNew) args = args.slice(1);
const turns = args.length ? args : DEFAULT_TURNS;

let n = 0;
const fake = (text: string) => ({
  id: `chat-${Date.now()}-${n++}`,
  spaceId: SPACE,
  spaceKind: "direct",
  senderHandle: HANDLE,
  agentUserId: AGENT,
  text,
  attachmentIds: [] as string[],
  receivedAt: new Date().toISOString(),
});

const { user } = await getOrCreateUser(HANDLE);
if (asNew) await query("DELETE FROM users WHERE id = $1", [user.id]);
else await saveConversation(user.id, SPACE, AGENT);

const transcript: string[] = [];
try {
  for (const t of turns) {
    const before = dryRunOutbox.length;
    const t0 = Date.now();
    await handleInbound(fake(t) as any);
    const ms = Date.now() - t0;
    const out = dryRunOutbox.slice(before).filter((m) => m.spaceId === SPACE);
    transcript.push(`User:    ${t}`);
    for (const m of out) transcript.push(`Bouncer: ${m.sensitive ? "(sensitive)" : m.text.replace(/\n/g, "\n         ")}`);
    if (!out.length) transcript.push("Bouncer: (no reply)");
    transcript.push(`         [${ms} ms]`, "");
  }
  console.log("\n=== transcript ===\n" + transcript.join("\n"));
} finally {
  const ids = (await query<{ id: string }>("SELECT id FROM users WHERE imessage_handle = $1", [HANDLE])).rows.map((r) => r.id);
  if (ids.length) {
    await query("DELETE FROM events WHERE user_id = ANY($1)", [ids]);
    await query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  }
  await pool.end();
}
