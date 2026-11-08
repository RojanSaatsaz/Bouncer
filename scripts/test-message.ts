// Flow 1 runner: feeds fake inbound iMessages through the real router with DRY_RUN on
// (texts are printed, never sent). Uses live Jev + Gemini and the DB in DATABASE_URL.
//   npm run test:message -- text "USPS: your package is on hold, update at usps-help.top"
//   npm run test:message -- image scripts/fixtures/scam-usps.png
//   npm run test:message -- caption scripts/fixtures/scam-usps.png "is this a scam? what is this link?"
//   npm run test:message -- scout           (all 30 scout messages, summary table)
//   npm run test:message -- first "<text>"   (as a brand-new user: welcome, then a verdict if it's a message)
// Uses the fake handle +15555550190 and deletes its rows afterwards.
export {};
process.env.DRY_RUN = "1";
process.env.PHOTON_SOCKET = "off";

const fs = await import("node:fs");
const { handleInbound } = await import("../src/messages/inbound.js");
const { query, pool } = await import("../src/db.js");
const { getOrCreateUser, saveConversation } = await import("../src/users.js");

const HANDLE = "+15555550190";
const SPACE = "tsp-msg-0190";
const AGENT = "tsp-agent";

// Capture dry-run sends so scout mode can print the verdict line per message.
const sent: string[] = [];
const origLog = console.log.bind(console);
console.log = (...a: unknown[]) => {
  const s = a.map(String).join(" ");
  if (s.startsWith("[photon:dry-run]")) sent.push(s.slice(s.indexOf("…  ") + 3));
  origLog(...a);
};

let n = 0;
const fake = (text: string | null, attachmentIds: string[] = []) => ({
  id: `test-${Date.now()}-${n++}`,
  spaceId: SPACE,
  spaceKind: "direct",
  senderHandle: HANDLE,
  agentUserId: AGENT,
  text,
  attachmentIds,
  receivedAt: new Date().toISOString(),
});

// Existing user with a saved thread, so the welcome text doesn't get in the way.
const { user } = await getOrCreateUser(HANDLE);
await saveConversation(user.id, SPACE, AGENT);

async function run(text: string | null, attachmentIds: string[] = []) {
  const t0 = Date.now();
  sent.length = 0;
  await handleInbound(fake(text, attachmentIds));
  return { ms: Date.now() - t0, lines: [...sent] };
}

const [mode, ...rest] = process.argv.slice(2);
try {
  if (mode === "text") {
    const r = await run(rest.join(" "));
    origLog(`\n(${r.ms} ms)`);
  } else if (mode === "first") {
    await query("DELETE FROM users WHERE id = $1", [user.id]);
    const r = await run(rest.join(" "));
    origLog(`\n(${r.ms} ms)`);
  } else if (mode === "image") {
    const r = await run(null, rest.map((p) => `file:${p}`));
    origLog(`\n(${r.ms} ms)`);
  } else if (mode === "caption") {
    // iOS sends "screenshot + typed words" as two messages, picture first: one verdict, then a chat answer.
    const [file, ...words] = rest;
    const a = await run(null, [`file:${file}`]);
    const b = await run(words.join(" "));
    const verdicts = [...a.lines, ...b.lines].filter((l) => /^(✅|🤔|⚠️)/u.test(l));
    origLog(`\n(${a.ms} + ${b.ms} ms) verdict lines: ${verdicts.length} ${verdicts.length === 1 ? "OK" : "FAIL (want exactly 1)"}`);
  } else if (mode === "scout") {
    const csv = fs.readFileSync("data/scout_test_messages.csv", "utf8").trim().split("\n").slice(1);
    const rows = csv.map((line) => {
      const m = line.match(/^([^,]+),([^,]+),([^,]+),([^,]*),"?(.*?)"?$/)!;
      return { id: m[1], expected: m[2], text: m[5].replace(/""/g, '"') };
    });
    const out: string[] = [];
    for (const r of rows) {
      const res = await run(r.text);
      out.push(`${r.id.padEnd(4)} ${r.expected.padEnd(15)} ${String(res.ms).padStart(5)} ms  ${res.lines[0] ?? "(no reply)"}`);
    }
    origLog("\n=== scout summary ===\n" + out.join("\n"));
  } else {
    origLog('usage: test:message -- text "<message>" | first "<message>" | image <file.png> [...] | scout');
  }
} finally {
  const ids = [user.id, ...(await query<{ id: string }>("SELECT id FROM users WHERE imessage_handle = $1", [HANDLE])).rows.map((r) => r.id)];
  await query("DELETE FROM events WHERE user_id = ANY($1)", [ids]);
  await query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  await pool.end();
}
