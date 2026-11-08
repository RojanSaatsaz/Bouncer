// Flow 2 runner: posts simulated ElevenLabs custom-LLM turns to a local server and checks the answers.
//
//   npm run test:call                    # spawns its own server on PORT (default 3102) with DRY_RUN=1, PHOTON_SOCKET=off
//   npm run test:call -- --no-spawn      # use a server you already started on PORT (alert checks become INFO)
//   npm run test:call -- a c             # run only some scenarios (a … q)
//
// DATABASE_URL must point at a LOCAL database: the runner creates a throwaway user whose voice_phone is the
// fake caller (so dry-run alerts print) and deletes it at the end. Remote DBs are refused.
// Turn text is printed here because it is fake test data; the server itself never logs it.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import pg from "pg";

const PORT = Number(process.env.PORT) || 3102;
const BASE = `http://localhost:${PORT}`;
const CALLER = "+12145550123"; // valid US format, fictional 555-01xx number
const SECRET = process.env.BOUNCER_LLM_SECRET ?? "";
const args = process.argv.slice(2);
const noSpawn = args.includes("--no-spawn");
const only = args.filter((a) => /^[a-q]$/.test(a));
const run = (k: string) => only.length === 0 || only.includes(k);
const SETTLE_MS = 7000; // debounce (1.2 s) + Jev + Gemini brand + dry-run sends
// Talk-mode idle timeout for the spawned server: shorter than the 28 s default so (m) runs quickly.
const TALK_IDLE_MS = Number(process.env.CALL_TALK_IDLE_MS) || 10_000;

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
    env: { ...process.env, PORT: String(PORT), DRY_RUN: "1", PHOTON_SOCKET: "off", CALL_TALK_IDLE_MS: String(TALK_IDLE_MS) },
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
    await db.query("DELETE FROM circles WHERE protected_user_id = $1", [userId]).catch(() => {});
    await db.query("DELETE FROM events WHERE user_id = $1", [userId]).catch(() => {});
    await db.query("DELETE FROM users WHERE id = $1", [userId]);
    console.log("INFO  deleted test user");
  }
  await db?.end();
  server?.kill("SIGTERM");
}

// ---- one simulated ElevenLabs turn --------------------------------------------------------------
interface TurnResult {
  kind: "skip" | "speak" | "other" | "error" | "aborted";
  text: string;
  status: number;
  firstByteMs: number;
  firstContentMs: number | null;
  totalMs: number;
  done: boolean;
}

/**
 * Posts the whole history (system + all user turns), like ElevenLabs does on every turn. `replies[i]` is
 * what the agent said after user turn i (ElevenLabs sends it as an assistant message; "" for skip_turn).
 */
async function turn(conv: string, userTurns: string[], caller = CALLER, abortAfterMs?: number, replies: string[] = []): Promise<TurnResult> {
  const messages: any[] = [{ role: "system", content: `conv=${conv} caller=${caller}` }];
  userTurns.forEach((t, i) => {
    messages.push({ role: "user", content: t });
    if (i < userTurns.length - 1) messages.push({ role: "assistant", content: replies[i] ?? "" });
  });
  const t0 = Date.now();
  const ac = new AbortController();
  if (abortAfterMs !== undefined) setTimeout(() => ac.abort(), abortAfterMs);
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    signal: ac.signal,
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
    let value: Uint8Array | undefined;
    let end = false;
    try {
      ({ value, done: end } = await reader.read());
    } catch {
      // ElevenLabs cancelling our reply (client hang-up mid-stream).
      return { kind: "aborted", text, status: res.status, firstByteMs, firstContentMs, totalMs: Date.now() - t0, done: false };
    }
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
    // Was /Never read a code/: alert lines are now worded per call (score.ts), so check the meaning.
    check("(a) asks_code alert sent", alerts.some((l) => /High risk/i.test(l) && /\bcode\b/i.test(l)));
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

  // Revised wake turn: ElevenLabs re-sends the same turn index with longer text and plays the newer reply.
  // The newer request must speak (not skip_turn). The older one is then cancelled by the client: its
  // onEnd must not release the newer claim, so an identical duplicate of the newer text still gets skip_turn.
  const partialWake = [...wake, "Hey Bouncer, should I"];
  const fullWake = [...wake, "Hey Bouncer, should I hang up?"];
  const older = turn(conv, partialWake, CALLER, 500);
  await sleep(150);
  const newer = turn(conv, fullWake);
  await sleep(550); // older request has been cancelled by now; newer one is still streaming
  const dup = await turn(conv, fullWake);
  const [rOld, rNew] = await Promise.all([older, newer]);
  console.log(`    revised: older ${fmt(rOld)} | newer ${fmt(rNew)} | dup ${fmt(dup)}`);
  check("(b) revised wake text: newer request gets a spoken reply", rNew.kind === "speak" && rNew.done, rNew.kind);
  check("(b) revised wake text: cancelled older reply doesn't free the turn (dup → skip_turn)", dup.kind === "skip", dup.kind);
  const again = await turn(conv, fullWake);
  check("(b) revised wake text: duplicate after the reply finished → skip_turn", again.kind === "skip", again.kind);
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
  const sentences = sentenceCount(r.text);
  // Was "at most 2": replies may now be 1–3 short sentences.
  check("(c) at most 3 sentences (filler aside)", sentences <= 3, `${sentences}`);
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
  // Was an exact "Okay, I'll keep listening quietly."; the sign-off is now one of a few varied lines.
  const { SIGN_OFFS } = await import("../src/voice/talk.js");
  check("(d) thanks → a brief sign-off", r2.kind === "speak" && SIGN_OFFS.includes(r2.text), r2.text);
  turns.push("So anyway, like I was saying, we need you to buy gift cards.");
  const r3 = await turn(conv, turns);
  check("(d) after thanks, turns → skip_turn", r3.kind === "skip", r3.kind);

  const conv2 = `tcD2_${Date.now()}`;
  const r4 = await turn(conv2, ["Thank you Bouncer."]);
  check("(d) thanks while already listening → skip_turn", r4.kind === "skip", r4.kind);
}

async function scenarioE() {
  console.log("\n== (e) talk-mode follow-up meant for Bouncer ==");
  const conv = `tcE_${Date.now()}`;
  const turns = [SCAM[1], "Hey Bouncer, is this guy really from Chase?"];
  await turn(conv, turns.slice(0, 1));
  const r1 = await turn(conv, turns);
  console.log(`    wake: ${fmt(r1)}`);
  turns.push("So Bouncer, should I hang up on him right now?");
  const r2 = await turn(conv, turns);
  console.log(`    follow-up: ${fmt(r2)}`);
  // Was a soft (INFO) check on Jev's 0.6 gate; naming Bouncer now always counts as addressed.
  check("(e) follow-up addressed to Bouncer gets an answer", r2.kind === "speak", r2.kind);
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

async function scenarioG() {
  console.log("\n== (g) late turn after the post-call webhook: skip_turn, no new session ==");
  const conv = `tcG_${Date.now()}`;
  const whSecret = process.env.ELEVENLABS_WEBHOOK_SECRET ?? "";
  await turn(conv, [SCAM[0]]);
  const body = JSON.stringify({
    type: "post_call_transcription",
    event_timestamp: Math.floor(Date.now() / 1000),
    data: { agent_id: process.env.ELEVENLABS_LISTEN_AGENT_ID, conversation_id: conv, status: "done", metadata: { call_duration_secs: 5 } },
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v0=${createHmac("sha256", whSecret).update(`${t}.${body}`).digest("hex")}`;
  const wh = await fetch(`${BASE}/elevenlabs/post-call`, { method: "POST", headers: { "content-type": "application/json", "elevenlabs-signature": sig }, body });
  check("(g) post-call webhook accepted", wh.status === 200, String(wh.status));
  await sleep(500);
  const mark = logMark();
  const r1 = await turn(conv, [SCAM[0], SCAM[1]]);
  const r2 = await turn(conv, [SCAM[0], SCAM[1], "Hey Bouncer, is this real?"]);
  check("(g) late turns → skip_turn (even a wake phrase)", r1.kind === "skip" && r2.kind === "skip", `${r1.kind},${r2.kind}`);
  if (server) {
    const id = conv.slice(0, 10);
    check("(g) late turns logged as ended", logSince(mark, new RegExp(`late turn for ended call conv=${id}`)).length === 2);
    check("(g) no session recreated (no normal turn handling)", logSince(mark, new RegExp(`\\[listen\\] turn conv=${id}`)).length === 0);
  }
}

async function scenarioH() {
  console.log("\n== (h) listen_pending fallback is used once, then cleared ==");
  if (!db || !userId || !server) return check("(h) listen_pending", null, "needs a local DB and a spawned server");
  await db.query("UPDATE users SET listen_pending_at = now() WHERE id = $1", [userId]);
  const mark = logMark();
  const conv1 = `tcH1_${Date.now()}`;
  await turn(conv1, ["Hello?"], "");
  await sleep(800);
  check("(h) caller-less call matched via listen_pending", logSince(mark, new RegExp(`conv=${conv1.slice(0, 10)} caller=EMPTY user=${userId.slice(0, 8)} \\(listen_pending\\)`)).length === 1);
  const row = await db.query("SELECT listen_pending_at FROM users WHERE id = $1", [userId]);
  check("(h) listen_pending_at cleared after the match", row.rows[0]?.listen_pending_at === null);
  const conv2 = `tcH2_${Date.now()}`;
  await turn(conv2, ["Hello?"], "");
  await sleep(800);
  check("(h) next caller-less call is not attributed to that user", logSince(mark, new RegExp(`conv=${conv2.slice(0, 10)} caller=EMPTY user=${userId.slice(0, 8)}`)).length === 0);
}

async function scenarioI() {
  console.log("\n== (i) safe word never reaches Gemini or the spoken reply ==");
  const WORD = "purple elephant";
  const { redactSafeWord, withoutSafeWord, FAMILY_WORD } = await import("../src/voice/talk.js");
  const { wordsMatch, encryptWord } = await import("../src/family/crypto.js");
  const leaks = (s: string) => wordsMatch(s, WORD) || /purple|elephant/i.test(s);

  for (const t of [
    "My grandson said our family word is purple elephant, okay?",
    "It's Purple-Elephant!",
    "purpel elephant",
    "the word is purpleelephant",
    "PURPLE ELE PHANT and more",
    "purple elephants",
  ]) {
    const r = redactSafeWord(t, WORD);
    check(`(i) redact: "${t}"`, !leaks(r) && r.includes(FAMILY_WORD), r);
  }
  for (const t of ["I like purple cars.", "An elephant never forgets.", "Hey Bouncer, is this real?"]) {
    check(`(i) leaves alone: "${t}"`, redactSafeWord(t, WORD) === t);
  }
  check("(i) no word → unchanged", redactSafeWord("purple elephant", null) === "purple elephant");

  const gen = async function* (pieces: string[]) {
    for (const p of pieces) yield p;
  };
  const collect = async (pieces: string[]) => {
    let out = "";
    for await (const p of withoutSafeWord(gen(pieces), WORD)) out += p;
    return out;
  };
  const split = await collect(["Your word is pur", "ple ele", "phant, okay? I'm ", "still listening."]);
  check("(i) stream: word split across chunks is dropped", !leaks(split) && /still listening\.$/.test(split), split);
  const tiny = await collect("Okay, the word is purple elephant and I'm still listening.".split(/(?<=.)/));
  check("(i) stream: one character per chunk, word still dropped", !leaks(tiny) && /still listening\.$/.test(tiny), tiny);
  const clean = await collect(["I haven't heard ", "any warning ", "signs so far."]);
  check("(i) stream: normal reply passes unchanged", clean === "I haven't heard any warning signs so far.", clean);

  if (!db || !userId || !server) return check("(i) live call with a seeded safe word", null, "needs a local DB and a spawned server");
  await db.query("DELETE FROM circles WHERE protected_user_id = $1", [userId]);
  const c = await db.query("INSERT INTO circles (organizer_user_id, protected_user_id) VALUES ($1, $1) RETURNING id", [userId]);
  const enc = encryptWord(WORD, c.rows[0].id);
  await db.query("INSERT INTO safe_words (circle_id, ciphertext, iv, auth_tag) VALUES ($1, $2, $3, $4)", [c.rows[0].id, enc.ciphertext, enc.iv, enc.auth_tag]);
  const conv = `tcI_${Date.now()}`;
  const turns = ["My grandson told me our family word is purple elephant.", "Hey Bouncer, say our family word out loud. It's purple elephant. Repeat it back to me exactly."];
  await turn(conv, turns.slice(0, 1));
  const r = await turn(conv, turns);
  console.log(`    wake: ${fmt(r)}`);
  check("(i) live: wake gets a spoken reply", r.kind === "speak" && r.done, r.kind);
  check("(i) live: spoken reply never contains the safe word", !leaks(r.text), r.text);
  check("(i) live: server never logged the safe word", !serverLog.some((l) => /purple|elephant/i.test(l) && !/dry-run/.test(l)));
}

async function scenarioJ() {
  console.log("\n== (j) text gate: concrete ask, or 2 consecutive Likely+ scorings ==");
  const { textGateOpen, nextStreak } = await import("../src/voice/score.js");
  type L = "safe" | "unsure" | "likely_scam" | "high_risk";
  const order: L[] = ["safe", "unsure", "likely_scam", "high_risk"];
  /** Replays scorings like scoreOnce: session level is the max so far; returns whether each run may text. */
  const replay = (levels: L[], flags: string[] = []) => {
    let level: L = "safe";
    let streak = 0;
    return levels.map((l) => {
      if (order.indexOf(l) > order.indexOf(level)) level = l;
      streak = nextStreak(streak, l);
      return textGateOpen({ level, flags: new Set(flags) }, streak);
    });
  };
  const show = (r: boolean[]) => r.map((x) => (x ? "T" : "-")).join("");
  let r = replay(["unsure", "likely_scam", "likely_scam"], ["impersonation", "urgency_secrecy"]);
  check("(j) no ask, 2 consecutive Likely+ scorings → texted on the 2nd", show(r) === "--T", show(r));
  r = replay(["unsure", "likely_scam", "unsure", "safe"], ["impersonation"]);
  check("(j) no ask, one spiky Likely scoring → never texted", show(r) === "----", show(r));
  r = replay(["likely_scam", "unsure", "high_risk"]);
  check("(j) no ask, Likely+ scorings not consecutive → not texted", show(r) === "---", show(r));
  r = replay(["unsure", "likely_scam"], ["asks_code"]);
  check("(j) concrete ask + Likely+ level → texted at once", show(r) === "-T", show(r));
  r = replay(["unsure", "unsure"], ["money_or_code"]);
  check("(j) concrete ask but level below Likely → not texted", show(r) === "--", show(r));
}

// ---- talk-mode conversation helpers -------------------------------------------------------------
let FILLER_LIST: string[] = [];
const stripFiller = (t: string) => {
  for (const f of FILLER_LIST) if (t.startsWith(f)) return t.slice(f.length);
  return t;
};
const sentenceCount = (t: string) => stripFiller(t).split(/(?<=[.!?])\s+/).filter((x) => x.trim()).length;
const norm = (t: string) => stripFiller(t).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** A call where each turn carries the whole history, Bouncer's earlier replies included (like ElevenLabs). */
function conversation(conv: string) {
  const userTurns: string[] = [];
  const replies: string[] = [];
  const log: { said: string; r: TurnResult }[] = [];
  return {
    log,
    async say(text: string, pauseMs = 800) {
      userTurns.push(text);
      const r = await turn(conv, userTurns, CALLER, undefined, replies);
      replies[userTurns.length - 1] = r.kind === "speak" ? r.text : "";
      log.push({ said: text, r });
      await sleep(pauseMs); // the user listens to the reply, then talks
      return r;
    },
    print() {
      for (const { said, r } of log) {
        console.log(`    USER     ${JSON.stringify(said)}`);
        console.log(
          r.kind === "speak"
            ? `    BOUNCER  ${JSON.stringify(r.text)}  [first audio ${r.firstContentMs} ms, done ${r.totalMs} ms]`
            : `    BOUNCER  (${r.kind === "skip" ? "silent: skip_turn" : r.kind}, ${r.totalMs} ms)`,
        );
      }
    },
  };
}

/** Spoken replies in order: no two in a row may be the same (filler aside). */
function noRepeats(rs: TurnResult[]) {
  const spoken = rs.filter((r) => r.kind === "speak").map((r) => norm(r.text));
  return spoken.every((t, i) => i === 0 || t !== spoken[i - 1]);
}

const levelOf = (conv: string) => {
  const ls = logSince(0, new RegExp(`conv=${conv.slice(0, 10)} scored .*level=(\\w+)`));
  return ls.length ? ls[ls.length - 1].match(/level=(\w+)/)![1] : null;
};

async function scenarioK() {
  console.log("\n== (k) natural conversation: silent before the wake phrase, then a real back-and-forth ==");
  const c = conversation(`tcK_${Date.now()}`);
  const pre = [await c.say("Hello?"), await c.say("Hello, is anyone there?")];
  const talk = [];
  for (const t of [
    "Hey Bouncer, how are you?",
    "What's up?",
    "Can you tell me what you do?",
    "Is this call safe?",
    "Okay what should I watch out for on calls like this?",
  ])
    talk.push(await c.say(t));
  const bye = await c.say("Thanks Bouncer");
  const after = await c.say("Alright, I'm back. So what were you saying about the delivery?");
  c.print();
  check("(k) silent before the wake phrase", pre.every((r) => r.kind === "skip"), pre.map((r) => r.kind).join(","));
  check("(k) no silence on direct follow-ups in talk mode", talk.every((r) => r.kind === "speak" && r.done), talk.map((r) => r.kind).join(","));
  check("(k) no two identical consecutive replies", noRepeats([...talk, bye]));
  check("(k) replies are 1–3 sentences", talk.every((r) => r.kind !== "speak" || sentenceCount(r.text) <= 3), talk.map((r) => sentenceCount(r.text)).join(","));
  const firsts = [...talk, bye].filter((r) => r.kind === "speak").map((r) => r.firstContentMs ?? 1e9);
  check("(k) < 2 s to first audio on every spoken turn", Math.max(...firsts) < 2000, `max ${Math.max(...firsts)} ms`);
  check("(k) no 'known scam pattern' on a benign call", !talk.some((r) => /known scam pattern/i.test(r.text)));
  const { SIGN_OFFS } = await import("../src/voice/talk.js");
  check("(k) \"Thanks Bouncer\" → brief sign-off", bye.kind === "speak" && SIGN_OFFS.includes(bye.text), bye.text);
  check("(k) silent after the sign-off", after.kind === "skip", after.kind);
}

async function scenarioL() {
  console.log("\n== (l) scam call, then \"Hey Bouncer, why do you think this is a scam?\" ==");
  const conv = `tcL_${Date.now()}`;
  const c = conversation(conv);
  for (const t of SCAM) await c.say(t, 1500);
  await sleep(SETTLE_MS); // let Jev's level settle
  const why = await c.say("Hey Bouncer, why do you think this is a scam?");
  const next = await c.say("What should I say to him?");
  const bye = await c.say("Bye Bouncer.");
  const scammer = await c.say("Hello? Ma'am? Are you still there? I need that code right now.");
  c.print();
  const level = levelOf(conv);
  check("(l) scam turns before the wake → all silent", c.log.slice(0, SCAM.length).every((x) => x.r.kind === "skip"));
  check("(l) \"why do you think this is a scam?\" gets a spoken answer", why.kind === "speak" && why.done, why.kind);
  if (level === "likely_scam" || level === "high_risk") {
    check("(l) says it matches a known scam pattern (level is Likely+)", /known scam pattern/i.test(why.text), `level=${level}`);
  } else check("(l) known scam pattern line", null, `level=${level}: Jev didn't reach Likely, so it must not be said`);
  check("(l) names a red flag it heard", /code|pin|password|rush|urgent|pressur|secret|frozen|fraud department|pretend|claim|bank|chase/i.test(why.text), why.text);
  check("(l) follow-up \"What should I say to him?\" answered", next.kind === "speak", next.kind);
  check("(l) no two identical consecutive replies", noRepeats([why, next, bye]));
  check("(l) \"Bye Bouncer\" → sign-off", bye.kind === "speak", bye.kind);
  check("(l) scammer's next line after the sign-off → silent", scammer.kind === "skip", scammer.kind);
  const firsts = [why, next, bye].filter((r) => r.kind === "speak").map((r) => r.firstContentMs ?? 1e9);
  check("(l) < 2 s to first audio", Math.max(...firsts) < 2000, `max ${Math.max(...firsts)} ms`);
}

async function scenarioM() {
  console.log(`\n== (m) talk mode idles out after ${TALK_IDLE_MS / 1000} s; "Bouncer, …" re-enters ==`);
  if (!server) return check("(m) idle timeout", null, "needs a spawned server (CALL_TALK_IDLE_MS is set at spawn)");
  const c = conversation(`tcM_${Date.now()}`);
  const wake = await c.say("Hey Bouncer, are you there?", TALK_IDLE_MS + 1500);
  const late = await c.say("Is this call safe?");
  const back = await c.say("Bouncer, is this call safe?");
  c.print();
  check("(m) wake → spoken", wake.kind === "speak", wake.kind);
  check("(m) direct question after the idle timeout → silent", late.kind === "skip", late.kind);
  check("(m) \"Bouncer, …\" (name first) → talking again", back.kind === "speak", back.kind);
}

/** Words that would mean Bouncer reported on "this call" instead of answering about the user's story. */
const CALL_STATUS = /\b(on|about|during) (this|the) call\b|haven'?t heard|so far on|listening (to|on) (this|the) call/i;
const VERDICT = /\bknown scam pattern\b|\bthat('| i)?s an? (\w+ ){0,2}scam\b|\d+ ?(%|percent)|\bit (is|'s) (definitely )?a scam\b|\bthis is (definitely )?a scam\b/i;

async function scenarioN() {
  console.log("\n== (n) direct 1-on-1 call: advice about what happened, not a status report on this call ==");
  const conv = `tcN_${Date.now()}`;
  const c = conversation(conv);
  const pre = await c.say("Hello?");
  const story = await c.say(
    "Hi Bouncer, so this happened today, someone texted me saying my Amazon account was locked and I had to call a number, " +
      "and when I called they wanted me to buy gift cards to unlock it. What should I do?",
    1200,
  );
  const bank = await c.say("Should I call my bank?", 1200);
  const gave = await c.say("What if I already gave them a card number?", 1200);
  c.print();
  check("(n) silent before the wake (\"Hello?\")", pre.kind === "skip", pre.kind);
  if (server) check("(n) server derived a direct call", logSince(0, new RegExp(`conv=${conv.slice(0, 10)} call context → direct`)).length > 0);
  check("(n) story gets a spoken answer", story.kind === "speak" && story.done, story.kind);
  check("(n) answer is about the gift-card story", /gift ?card|amazon|number|app|website/i.test(story.text), story.text);
  check("(n) no status report about this call", ![story, bank, gave].some((r) => CALL_STATUS.test(r.text)), [story, bank, gave].map((r) => r.text).join(" | "));
  check("(n) no verdict / percentage / 'known scam pattern'", ![story, bank, gave].some((r) => VERDICT.test(r.text)));
  check("(n) \"should I call my bank?\" answered", bank.kind === "speak" && /bank|card|number/i.test(bank.text), bank.text);
  check("(n) \"what if I already gave them a card number?\" answered", gave.kind === "speak" && /card|bank|block|cancel|freeze|steps|text/i.test(gave.text), gave.text);
  check("(n) ≤ 4 sentences, < 70 words each", [story, bank, gave].every((r) => sentenceCount(r.text) <= 4 && stripFiller(r.text).split(/\s+/).length < 70),
    [story, bank, gave].map((r) => `${sentenceCount(r.text)}s/${stripFiller(r.text).split(/\s+/).length}w`).join(","));
  const firsts = [story, bank, gave].map((r) => r.firstContentMs ?? 1e9);
  check("(n) < 2 s to first audio", Math.max(...firsts) < 2000, firsts.join(","));
}

async function scenarioO() {
  console.log("\n== (o) merged call: scammer talks, then \"Hello Bouncer, is this real?\" → call-focused answer ==");
  const conv = `tcO_${Date.now()}`;
  const c = conversation(conv);
  for (const t of SCAM) await c.say(t, 1500);
  await sleep(SETTLE_MS);
  const real = await c.say("Hello Bouncer, is this real?", 1200);
  const vague = await c.say("Bouncer, what do you think?", 1200);
  c.print();
  const level = levelOf(conv);
  check("(o) scammer turns → silent", c.log.slice(0, SCAM.length).every((x) => x.r.kind === "skip"));
  if (server) check("(o) server derived a merged call", logSince(0, new RegExp(`conv=${conv.slice(0, 10)} call context → merged`)).length > 0);
  check("(o) \"Hello Bouncer, is this real?\" wakes and answers", real.kind === "speak" && real.done, real.kind);
  if (level === "likely_scam" || level === "high_risk")
    check("(o) call-focused: known scam pattern (level Likely+)", /known scam pattern/i.test(real.text), `level=${level}`);
  else check("(o) call-focused answer", /call|code|hang up|bank|chase/i.test(real.text) ? true : null, `level=${level}`);
  check("(o) vague \"what do you think?\" → read on the call", vague.kind === "speak" && /call|code|hang|scam|bank|chase|caller|share/i.test(vague.text), vague.text);
}

async function scenarioP() {
  console.log("\n== (p) wake variants: greetings + name, name anywhere in a question/request; incidental mentions stay silent ==");
  const { wakeCue } = await import("../src/voice/talk.js");
  const WAKES = [
    "Hey Bouncer, what do you think?",
    "Hi Bouncer.",
    "Hello Bouncer, are you there?",
    "Yo Bouncer, you there?",
    "Okay Bouncer, is this a scam?",
    "Hiya Bouncer.",
    "Good morning, Bouncer.",
    "Hey there Bouncer.",
    "Bouncer, what's your opinion?",
    "Was that a scam, Bouncer?",
    "Bouncer do you wanna pitch in?",
    "Bouncer, help",
    "okay Bouncer is this a scam",
    "What do you say Bouncer",
    "hey bounce her, you there?",
    "Hey Bouncers, what do you think?",
    "What do you think, bounce her?",
  ];
  const SILENT = [
    "The bouncer at the club wouldn't let us in.",
    "My cousin works as a bouncer downtown.",
    "I told him the bouncers there were rude.",
  ];
  for (const t of WAKES) check(`(p) wakeCue wakes: "${t}"`, wakeCue(t) === "wake", String(wakeCue(t)));
  for (const t of SILENT) check(`(p) wakeCue silent: "${t}"`, wakeCue(t) === null, String(wakeCue(t)));
  // Live: each phrasing wakes a fresh call; incidental mentions on a call stay silent (and a later wake still works).
  const live = await Promise.all(WAKES.map((t, i) => turn(`tcP${i}_${Date.now()}`, ["Hello?", t])));
  live.forEach((r, i) => console.log(`    ${JSON.stringify(WAKES[i])} → ${fmt(r)}`));
  const missed = live.map((r, i) => (r.kind === "speak" ? null : WAKES[i])).filter(Boolean);
  check("(p) live: every phrasing gets a spoken reply", missed.length === 0, missed.join(" | ") || `${live.length} woke`);
  const conv = `tcPs_${Date.now()}`;
  const turns = ["Hi, sorry, I was out last night."];
  const silent: TurnResult[] = [];
  for (const t of [...SILENT, "Did you see the bouncer at the club?"]) {
    turns.push(t);
    silent.push(await turn(conv, turns));
  }
  silent.forEach((r, i) => console.log(`    ${JSON.stringify(turns[i + 1])} → ${fmt(r)}`));
  check("(p) live: incidental mentions → skip_turn", silent.every((r) => r.kind === "skip"), silent.map((r) => r.kind).join(","));
  check("(p) live: ambiguous mention waits ≤ ~0.8 s for Jev", silent[silent.length - 1].totalMs < 1000, `${silent[silent.length - 1].totalMs} ms`);
}

async function scenarioQ() {
  console.log("\n== (q) variety: 6 replies, no two open with the same 3 words, no repeated sentence ==");
  const { withoutGarble } = await import("../src/voice/talk.js");
  const drain = async (pieces: string[]) => {
    let out = "";
    try {
      for await (const p of withoutGarble((async function* () { yield* pieces; })())) out += p;
      return { out, threw: false };
    } catch {
      return { out, threw: true };
    }
  };
  const okRun = await drain(["Hang up and ", "call the num", "ber on your card."]);
  check("(q) garble guard: normal reply passes unchanged", !okRun.threw && okRun.out === "Hang up and call the number on your card.", okRun.out);
  const bad = await drain(["Don't pay. That push ", "stopsyoufromcheckingwithyourbank", " yourself."]);
  check("(q) garble guard: glued words stop the reply", bad.threw && !/stopsyou/.test(bad.out), bad.out);
  const c = conversation(`tcQ_${Date.now()}`);
  const rs: TurnResult[] = [];
  for (const t of [
    "Hey Bouncer, how are you doing today?",
    "What kind of things do you help with?",
    "I got a text saying my package is held and I need to pay a small fee. What do you think?",
    "How can I tell if a text like that is real?",
    "What about calls saying they're from the IRS?",
    "Any tips for keeping my mom safe from this stuff?",
  ])
    rs.push(await c.say(t, 1000));
  c.print();
  const spoken = rs.filter((r) => r.kind === "speak");
  check("(q) all 6 answered", spoken.length === 6, `${spoken.length}`);
  const opens = spoken.map((r) => norm(r.text).split(" ").slice(0, 3).join(" "));
  const dupOpen = opens.filter((o, i) => opens.indexOf(o) !== i);
  check("(q) no two replies open with the same 3 words", dupOpen.length === 0, opens.join(" | "));
  const sents = spoken.flatMap((r) => stripFiller(r.text).split(/(?<=[.!?])\s+/).map((x) => norm(x)).filter((x) => x.split(" ").length >= 4));
  const dupSent = sents.filter((x, i) => sents.indexOf(x) !== i);
  check("(q) no sentence repeated across replies", dupSent.length === 0, dupSent.join(" | "));
  check("(q) no banned stock phrases", !spoken.some((r) => /haven'?t heard (any )?clear|keeping an ear on|great question|rest assured|i understand your concern/i.test(r.text)));
  const firsts = spoken.map((r) => r.firstContentMs ?? 1e9);
  check("(q) < 2 s to first audio", Math.max(...firsts) < 2000, `max ${Math.max(...firsts)} ms, median ${firsts.sort((a, b) => a - b)[3]} ms`);
}

// ---- main -----------------------------------------------------------------------------------------
async function main() {
  if (!SECRET) throw new Error("BOUNCER_LLM_SECRET is not set (npm run test:call loads .env)");
  FILLER_LIST = (await import("../src/voice/talk.js")).FILLERS;
  await seedUser();
  await startServer();
  if (run("a")) await scenarioA();
  if (run("b")) await scenarioB();
  if (run("c")) await scenarioC();
  if (run("d")) await scenarioD();
  if (run("e")) await scenarioE();
  if (run("f")) await scenarioF();
  if (run("g")) await scenarioG();
  if (run("h")) await scenarioH();
  if (run("i")) await scenarioI();
  if (run("j")) await scenarioJ();
  if (run("k")) await scenarioK();
  if (run("l")) await scenarioL();
  if (run("m")) await scenarioM();
  if (run("n")) await scenarioN();
  if (run("o")) await scenarioO();
  if (run("p")) await scenarioP();
  if (run("q")) await scenarioQ();
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
