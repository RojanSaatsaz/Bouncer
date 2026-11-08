// Seeds the demo family circle (Flow 3 trimmed: no JOIN-code flow).
//
//   SAFE_WORD='purple elephant' npm run seed:family -- \
//     --protected "name=Grandma,handle=+12145550100" \
//     --member "name=Jake,relationship=grandson,phone=+12145550101,role=relative" \
//     --member "name=Mom,relationship=daughter,phone=+12145550102,role=guardian"
//
//   npm run seed:family -- --file circle.json      (JSON: { protected: {name, handle}, members: [...] })
//
// The safe word comes ONLY from the SAFE_WORD env var, stdin (echo … | npm run seed:family -- …),
// or a hidden prompt. Never from argv or the JSON file, and it is never printed.
// Idempotent: rerunning replaces that person's circle and safe word.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import { seedCircle, type SeedInput, type SeedMember } from "../src/family/seed.js";

const USAGE = `Usage:
  SAFE_WORD='…' npm run seed:family -- --protected "name=Grandma,handle=+1214…" \\
    --member "name=Jake,relationship=grandson,phone=+1214…,role=relative" \\
    --member "name=Mom,relationship=daughter,phone=+1214…,role=guardian"
  npm run seed:family -- --file circle.json
Member keys: name, relationship, phone, handle (defaults to phone), role (guardian | relative).`;

function kv(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) throw new Error(`Expected key=value in "${part.trim()}"`);
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  if ("safe_word" in out || "word" in out || "safeword" in out) throw new Error("Don't pass the safe word as an argument; use SAFE_WORD or stdin.");
  return out;
}

function readInput(): SeedInput {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      protected: { type: "string" },
      member: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (values.file) {
    const json = JSON.parse(readFileSync(values.file, "utf8"));
    if (JSON.stringify(json).match(/"(safe_?word|word)"\s*:/i)) {
      throw new Error("Remove the safe word from the JSON file; pass it with SAFE_WORD or stdin instead.");
    }
    return json as SeedInput;
  }
  if (!values.protected || !values.member?.length) throw new Error(USAGE);
  const p = kv(values.protected);
  return {
    protected: { name: p.name, handle: p.handle ?? p.phone },
    members: values.member.map((m) => {
      const f = kv(m);
      return { name: f.name, relationship: f.relationship, phone: f.phone, handle: f.handle, role: f.role as SeedMember["role"] };
    }),
  };
}

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (ch === "\u0003") process.exit(130); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readSafeWord(): Promise<string> {
  const fromEnv = process.env.SAFE_WORD;
  delete process.env.SAFE_WORD;
  if (fromEnv?.trim()) return fromEnv.trim();
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.split(/\r?\n/)[0].trim();
  }
  const a = await promptHidden("Family safe word (hidden): ");
  const b = await promptHidden("Type it again: ");
  if (a.trim() !== b.trim()) throw new Error("The two entries didn't match. Nothing was saved.");
  return a.trim();
}

try {
  const input = readInput();
  const word = await readSafeWord();
  if (!word) throw new Error("No safe word given. Set SAFE_WORD, pipe it on stdin, or type it at the prompt.");
  const s = await seedCircle(input, word);

  console.log(`\nCircle ${s.circleId} ready (safe word saved, encrypted; not shown).`);
  for (const p of s.people) {
    console.log(
      `  ${p.role.padEnd(9)} ${p.name.padEnd(12)} …${p.phoneLast4 ?? "????"}  member=${p.memberId?.slice(0, 8) ?? "-"}  user=${p.userId?.slice(0, 8) ?? "-"}  thread=${p.hasThread ? "yes" : "NO"}`,
    );
  }
  for (const w of s.warnings) console.warn(`WARNING: ${w.replace("Bouncer", `Bouncer (${config.photon.imessageHandle})`)}`);
  console.log("\nRerun this command any time; it replaces the circle and the word.");
} catch (err: any) {
  console.error(err?.message ?? err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
