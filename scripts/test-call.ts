// Flow 2 runner: posts simulated ElevenLabs custom-LLM turns to a local server and checks the answers.
//
//   npm run test:call                    # spawns its own server on PORT (default 3102) with DRY_RUN=1, PHOTON_SOCKET=off
//   npm run test:call -- --no-spawn      # use a server you already started on PORT (alert checks become INFO)
//   npm run test:call -- a c             # run only some scenarios (a b c d e f)
//
// DATABASE_URL must point at a LOCAL database: the runner creates a throwaway user whose voice_phone is the
// fake caller (so dry-run alerts print) and deletes it at the end. Remote DBs are refused.
// Turn text is printed here because it is fake test data; the server itself never logs it.
import { spawn, type ChildProcess } from "node:child_process";
import pg from "pg";

const PORT = Number(process.env.PORT) || 3102;
const BASE = `http://localhost:${PORT}`;
const CALLER = "+12145550123"; // valid US format, fictional 555-01xx number
const SECRET = process.env.BOUNCER_LLM_SECRET ?? "";
const args = process.argv.slice(2);
const noSpawn = args.includes("--no-spawn");
const only = args.filter((a) => /^[a-f]$/.test(a));
const run = (k: string) => only.length === 0 || only.includes(k);
const SETTLE_MS = 7000; // debounce (1.2 s) + Jev + Gemini brand + dry-run sends

const results: { ok: boolean | null; name: string; detail: string }[] = [];
const check = (name: string, ok: boolean | null, detail = "") => {
  results.push({ ok, name, detail });
  console.log(`${ok === null ? "INFO" : ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- server (spawned unless --no-spawn) ----------------------------------------------------------
const serverLog: string[] = [];
let server: ChildProcess | null = null;

async function healthy() {
  try {
    return (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function startServer() {
  if (noSpawn) {
    if (!(await healthy())) throw new Error(`No server at ${BASE}. Start one or drop --no-spawn.`);
    return;
  }
  if (await healthy()) throw new Error(`Something is already listening on ${BASE}. Stop it or pass --no-spawn.`);
  server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DRY_RUN: "1", PHOTON_SOCKET: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const onData = (d: Buffer) =>
    d
      .toString()
      .split("\n")
      .filter(Boolean)
      .forEach((l) => {
        serverLog.push(l);
        console.log(`    │ ${l}`);
      });
  server.stdout!.on("data", onData);
  server.stderr!.on("data", onData);
  for (let i = 0; i < 60; i++) {
    if (await healthy()) return;
    await sleep(500);
  }
  throw new Error("server did not start in 30 s");
}

const logMark = () => serverLog.length;
const logSince = (mark: number, re: RegExp) => serverLog.slice(mark).filter((l) => re.test(l));
const alertsSince = (mark: number) => logSince(mark, /\[photon:dry-run\]/);

// ---- test user -----------------------------------------------------------------------------------
let db: pg.Client | null = null;
let userId: string | null = null;

async function seedUser() {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (!["127.0.0.1", "localhost"].includes(host) || url.includes(":54329")) {
    console.log("INFO  not seeding a test user: DATABASE_URL is not a throwaway local DB (54329 is the Railway tunnel)");
    return;
  }
  db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query("DELETE FROM users WHERE voice_phone = $1 OR imessage_handle = 'test-call@bouncer.invalid'", [CALLER]);
  const r = await db.query(
    `INSERT INTO users (imessage_handle, voice_phone, name, space_id, photon_sender_id, opted_in)
     VALUES ('test-call@bouncer.invalid', $1, 'Test Caller', 'test-call-space', 'test-call-sender', true) RETURNING id`,
    [CALLER],
  );
  userId = r.rows[0].id;
  console.log(`INFO  seeded test user ${userId!.slice(0, 8)} with voice_phone ${CALLER}`);
}

async function cleanup() {
  if (db && userId) {
    await db.query("DELETE FROM events WHERE user_id = $1", [userId]).catch(() => {});
    await db.query("DELETE FROM users WHERE id = $1", [userId]);
    console.log("INFO  deleted test user");
  }
  await db?.end();
  server?.kill("SIGTERM");
}

// ---- one simulated ElevenLabs turn --------------------------------------------------------------
interface TurnResult {
  kind: "skip" | "speak" | "other" | "error";
  text: string;
  status: number;
  firstByteMs: number;
  firstContentMs: number | null;
  totalMs: number;
  done: boolean;
}

/** Posts the whole history (system + all user turns), like ElevenLabs does on every turn. */
async function turn(conv: string, userTurns: string[], caller = CALLER): Promise<TurnResult> {
  const messages: any[] = [{ role: "system", content: `conv=${conv} caller=${caller}` }];
  userTurns.forEach((t, i) => {
    messages.push({ role: "user", content: t });
    if (i < userTurns.length - 1) messages.push({ role: "assistant", content: "" });
  });
  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "bouncer-listen",
      stream: true,
      messages,
      tools: [{ type: "function", function: { name: "skip_turn", description: "Skip this turn", parameters: { type: "object", properties: {} } } }],
    }),
  });
  const firstByteMs = Date.now() - t0;
  let raw = "";
  let text = "";
  let firstContentMs: number | null = null;
  let tool = false;
  let done = false;
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n\n")) >= 0) {
      const evt = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 2);
      raw += evt + "\n";
      if (!evt.startsWith("data:")) continue;
      const data = evt.slice(5).trim();
      if (data === "[DONE]") {
        done = true;
        continue;
      }
      const delta = JSON.parse(data).choices?.[0]?.delta ?? {};
      if (delta.tool_calls?.some((c: any) => c.function?.name === "skip_turn")) tool = true;
      if (delta.content) {
        firstContentMs ??= Date.now() - t0;
        text += delta.content;
      }
    }
  }
  const totalMs = Date.now() - t0;
  const kind = res.status !== 200 ? "error" : tool && !text ? "skip" : text ? "speak" : "other";
  return { kind, text, status: res.status, firstByteMs, firstContentMs, totalMs, done };
}

const fmt = (r: TurnResult) =>
  `${r.kind} ${r.totalMs}ms${r.firstContentMs !== null ? `, first words ${r.firstContentMs}ms` : ""}${r.text ? `: "${r.text}"` : ""}`;

// ---- scenarios ----------------------------------------------------------------------------------
const SCAM = [
  "Hello?",
  "Hi, this is Mark from the Chase fraud department. We detected suspicious charges on your account.",
  "To stop them I need to verify your identity. We just texted you a six digit code. Please read it to me now.",
  "This is urgent. If you hang up your account will be frozen today. Don't tell anyone at the branch about this call.",
];

async function scenarioA() {
  console.log("\n== (a) silent scam call: every turn skip_turn, alerts by text ==");
  const conv = `tcA_${Date.now()}`;
  const mark = logMark();
  const out: TurnResult[] = [];
  for (let i = 1; i <= SCAM.length; i++) {
    out.push(await turn(conv, SCAM.slice(0, i)));
    await sleep(1500); // real turns arrive ~2 s apart
  }
  out.forEach((r, i) => console.log(`    turn ${i}: ${fmt(r)}`));
  check("(a) every turn answered with skip_turn", out.every((r) => r.kind === "skip" && r.done), out.map((r) => r.kind).join(","));
  const slowest = Math.max(...out.map((r) => r.totalMs));
  check("(a) skip_turn is immediate (< 300 ms)", slowest < 300, `slowest ${slowest} ms`);
  await sleep(SETTLE_MS);
  if (server && userId) {
    const alerts = alertsSince(mark);
    alerts.forEach((l) => console.log(`    alert: ${l.replace(/.*\]\s*/, "")}`));
    check("(a) at least one alert texted", alerts.length > 0, `${alerts.length} alert(s)`);
    check("(a) asks_code alert sent", alerts.some((l) => /Never read a code/.test(l)));
    const dupes = alerts.length - new Set(alerts).size;
    check("(a) no duplicate alert lines", dupes === 0, `${dupes} duplicate(s)`);
    check("(a) server never logged turn text", !serverLog.some((l) => /[Cc]hase fraud|six digit code/.test(l) && !/dry-run/.test(l)));
  } else check("(a) alerts", null, "check the server log for [photon:dry-run] lines");
}

async function scenarioB() {
  console.log("\n== (b) duplicate and revised speculative turns ==");
  const conv = `tcB_${Date.now()}`;
  const mark = logMark();
  const base = SCAM.slice(0, 2);
  const out: TurnResult[] = [];
  out.push(await turn(conv, base.slice(0, 1)));
  out.push(await turn(conv, base));
  // Turn 2 arrives three times: two identical speculative requests at once, then a revised text.
  const partial = "To stop them I need to verify your identity.";
  out.push(...(await Promise.all([turn(conv, [...base, partial]), turn(conv, [...base, partial])])));
  await sleep(300);
  out.push(await turn(conv, [...base, SCAM[2]]));
  check("(b) every duplicate/revised turn skip_turn", out.every((r) => r.kind === "skip"), out.map((r) => r.kind).join(","));
  await sleep(SETTLE_MS);
  if (server) {
    const scored = logSince(mark, new RegExp(`conv=${conv.slice(0, 10)} scored`));
    scored.forEach((l) => console.log(`    ${l}`));
    check("(b) Jev scored once after the burst settled (debounce)", scored.length === 1, `${scored.length} scoring run(s)`);
    check("(b) transcript holds 3 turns, not 5 (replace, not append)", scored.some((l) => /turns=3\b/.test(l)));
  } else check("(b) scoring count", null, "check the server log: one 'scored turns=3' line for this conv");

  // Same wake-phrase turn twice at once: speak once, skip the duplicate.
  const wake = [...base, SCAM[2], "Hey Bouncer, is this real?"];
  const pair = await Promise.all([turn(conv, wake), turn(conv, wake)]);
  pair.forEach((r, i) => console.log(`    wake dup ${i}: ${fmt(r)}`));
  const kinds = pair.map((r) => r.kind).sort().join(",");
  check("(b) duplicate wake request: one spoken reply, one skip_turn", kinds === "skip,speak", kinds);
}

async function scenarioC() {
  console.log("\n== (c) \"Hey Bouncer, is this real?\" then an unrelated turn ==");
  const conv = `tcC_${Date.now()}`;
  const turns = SCAM.slice(0, 3);
  for (let i = 1; i <= turns.length; i++) await turn(conv, turns.slice(0, i));
  await sleep(SETTLE_MS); // let the level reach likely/high so the reply can say so
  turns.push("Hey Bouncer, is this real?");
  const r = await turn(conv, turns);
  console.log(`    wake: ${fmt(r)}`);
  check("(c) wake phrase gets a spoken reply", r.kind === "speak" && r.done, r.kind);
  check("(c) spoken reply streamed through to [DONE] in < 6 s", r.done && r.totalMs < 6000, `${r.totalMs} ms`);
  check("(c) first words in < 1.5 s (filler or Gemini)", (r.firstContentMs ?? 1e9) < 1500, `${r.firstContentMs} ms`);
  const sentences = r.text.replace(/^One moment\.\.\.\s*/, "").split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;
  check("(c) at most 2 sentences (filler aside)", sentences <= 2, `${sentences}`);
  check("(c) mentions the known scam pattern", /known scam pattern/i.test(r.text));

  turns.push("Okay sir, hold on, let me go find my card.");
  const r2 = await turn(conv, turns);
  console.log(`    next: ${fmt(r2)}`);
  check("(c) next unrelated turn → skip_turn", r2.kind === "skip", r2.kind);

  turns.push("Yes, I'm still here. What do you need again?");
  const r3 = await turn(conv, turns);
  check("(c) back to listening: later turns → skip_turn", r3.kind === "skip", r3.kind);
}

async function scenarioD() {
  console.log("\n== (d) \"thanks Bouncer\" ends talk mode ==");
  const conv = `tcD_${Date.now()}`;
  const turns = ["Hi, who is this?", "Hey Bouncer, are you there?"];
  await turn(conv, turns.slice(0, 1));
  const r1 = await turn(conv, turns);
  console.log(`    wake: ${fmt(r1)}`);
  check("(d) wake → spoken reply", r1.kind === "speak", r1.kind);
  turns.push("Thanks Bouncer.");
  const r2 = await turn(conv, turns);
  console.log(`    thanks: ${fmt(r2)}`);
  check("(d) thanks → \"Okay, I'll keep listening quietly.\"", r2.text === "Okay, I'll keep listening quietly.", r2.text);
  turns.push("So anyway, like I was saying, we need you to buy gift cards.");
  const r3 = await turn(conv, turns);
  check("(d) after thanks, turns → skip_turn", r3.kind === "skip", r3.kind);

  const conv2 = `tcD2_${Date.now()}`;
  const r4 = await turn(conv2, ["Thank you Bouncer."]);
  check("(d) thanks while already listening → skip_turn", r4.kind === "skip", r4.kind);
}

async function scenarioE() {
  console.log("\n== (e) talk-mode follow-up meant for Bouncer (Jev addressed_to_bouncer; soft check) ==");
  const conv = `tcE_${Date.now()}`;
  const turns = [SCAM[1], "Hey Bouncer, is this guy really from Chase?"];
  await turn(conv, turns.slice(0, 1));
  const r1 = await turn(conv, turns);
  console.log(`    wake: ${fmt(r1)}`);
  turns.push("So Bouncer, should I hang up on him right now?");
  const r2 = await turn(conv, turns);
  console.log(`    follow-up: ${fmt(r2)}`);
  check("(e) follow-up addressed to Bouncer gets an answer", r2.kind === "speak" ? true : null, r2.kind);
  const bad = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", body: "{}", headers: { Authorization: "Bearer nope" } });
  check("(e) wrong bearer → 401", bad.status === 401, String(bad.status));
}

async function scenarioF() {
  console.log("\n== (f) family_danger on a call → Flow 3 started once (YES-gated there) ==");
  const conv = `tcF_${Date.now()}`;
  const mark = logMark();
  const turns = [
    "Grandma? It's me. I'm in trouble.",
    "I got arrested after a car accident and I'm in jail. I need you to send bail money right now.",
    "Please don't tell Mom or Dad. The lawyer will call you about the gift cards.",
  ];
  for (let i = 1; i <= turns.length; i++) {
    const r = await turn(conv, turns.slice(0, i));
    if (r.kind !== "skip") check(`(f) turn ${i - 1} skip_turn`, false, r.kind);
    await sleep(1500);
  }
  await sleep(SETTLE_MS);
  if (server && userId) {
    const fam = logSince(mark, /\[family\]|\[photon:dry-run\]/);
    fam.forEach((l) => console.log(`    ${l}`));
    const scored = logSince(mark, new RegExp(`conv=${conv.slice(0, 10)} scored.*family_danger`));
    check("(f) family_danger crossed 0.7", scored.length > 0);
    check("(f) Flow 3 / alerts produced texts", fam.length > 0, `${fam.length} line(s)`);
  } else check("(f) family flow", null, "check the server log for [family] lines");
}

// ---- main -----------------------------------------------------------------------------------------
async function main() {
  if (!SECRET) throw new Error("BOUNCER_LLM_SECRET is not set (npm run test:call loads .env)");
  await seedUser();
  await startServer();
  if (run("a")) await scenarioA();
  if (run("b")) await scenarioB();
  if (run("c")) await scenarioC();
  if (run("d")) await scenarioD();
  if (run("e")) await scenarioE();
  if (run("f")) await scenarioF();
  const failed = results.filter((r) => r.ok === false);
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${failed.length} failed, ${results.filter((r) => r.ok === null).length} info`);
  failed.forEach((f) => console.log(`FAIL  ${f.name}  ${f.detail}`));
  process.exitCode = failed.length ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("test-call crashed:", err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => cleanup().catch(() => {}));
