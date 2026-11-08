// Self sign-up link, so people (e.g. hackathon judges) can try Bouncer without anyone touching the Photon
// dashboard. GET /join shows a form; POST /join assigns their number to Bouncer's shared iMessage line through
// Photon's assignment API (POST /v1/projects/{id}/platforms/imessage/assignments, SDK
// photon.projects.platforms.imessage.assignments.create; the key needs platforms:write) and then shows the
// number to text, a tap-to-call link and a contact card. Their first text starts the normal welcome.
//
// Privacy: phone numbers and names are never logged (rule 1): logs say only what happened. Nothing is written to
// our database here; the user row is created by their first text, as for everyone else.
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { ApiError } from "@photon-ai/api";
import { config } from "../config.js";
import { photon } from "../photon/client.js";
import { toE164 } from "../users.js";

export interface AssignResult {
  /** Bouncer's iMessage number this person should text (E.164). */
  number: string;
  /** They were already signed up. */
  existed: boolean;
}
export type Assigner = (handle: string, firstName: string | null) => Promise<AssignResult>;

const projectId = config.photon.projectId;
const assignments = () => photon.projects.platforms.imessage.assignments;

/** Default: Photon's shared-line assignment. An existing assignment is looked up instead of failing. */
const photonAssign: Assigner = async (handle, firstName) => {
  try {
    const r = await assignments().create({
      path: { id: projectId },
      // Same number → same key, so a double tap or a retry never creates two assignments.
      headers: { idempotencyKey: `join-${createHash("sha256").update(handle).digest("hex").slice(0, 32)}` },
      body: { handle, ...(firstName ? { firstName } : {}) },
    });
    return { number: r.assignedPhoneNumber, existed: false };
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && (err.body as any)?.code === "ASSIGNMENT_EXISTS") {
      return { number: (await existingNumber(handle)) ?? config.photon.imessageHandle, existed: true };
    }
    throw err;
  }
};

async function existingNumber(handle: string): Promise<string | null> {
  let pageToken: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page: any = await assignments().list({ path: { id: projectId }, query: { pageSize: 100, ...(pageToken ? { pageToken } : {}) } });
    const hit = (page.assignments ?? []).find((a: any) => a.handle === handle);
    if (hit) return hit.assignedPhoneNumber;
    pageToken = page.nextPageToken;
    if (!pageToken) return null;
  }
  return null;
}

let assign: Assigner = photonAssign;
/** Tests swap in a fake so no real assignment is created. */
export const setAssigner = (fn: Assigner | null) => {
  assign = fn ?? photonAssign;
};

// ---- abuse limits (memory only) ---------------------------------------------------------------

const perIp = new Map<string, number[]>();
const IP_MAX = 6;
const IP_WINDOW_MS = 10 * 60_000;
let day = "";
let todayCount = 0;

function allowIp(ip: string): boolean {
  const now = Date.now();
  const recent = (perIp.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  if (recent.length >= IP_MAX) return false;
  recent.push(now);
  perIp.set(ip, recent);
  return true;
}
function allowToday(): boolean {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) {
    day = d;
    todayCount = 0;
  }
  return todayCount < config.join.dailyMax;
}
export const resetSignupLimits = () => {
  perIp.clear();
  todayCount = 0;
};

// ---- pages ------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
/** "+16289988619" → "(628) 998-8619". */
const pretty = (e164: string) => {
  const d = e164.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
};

const STYLE = `
  :root { color-scheme: light; --page:#f9f9f7; --surface:#fcfcfb; --surface-2:#f3f2ee; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
    --border:rgba(11,11,11,.10); --brand:#e20074; --brand-wash:rgba(226,0,116,.08); --bad:#d03b3b; --good:#006300; }
  @media (prefers-color-scheme: dark) { :root { color-scheme: dark; --page:#0d0d0d; --surface:#1a1a19; --surface-2:#232321; --ink:#f0efec;
    --ink-2:#c3c2b7; --muted:#898781; --border:rgba(255,255,255,.10); --brand:#ff3d9e; --brand-wash:rgba(255,61,158,.12); --good:#0ca30c; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--page); color:var(--ink); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
  main { max-width: 480px; margin: 0 auto; padding: 28px 16px 48px; }
  .mark { width:44px; height:44px; border-radius:12px; background:var(--brand); color:#fff; font-weight:800; display:grid; place-items:center; font-size:20px; }
  h1 { font-size: 26px; margin: 14px 0 4px; letter-spacing: -0.4px; }
  .sub { color: var(--ink-2); margin: 0 0 20px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:18px; margin-bottom:14px; }
  label { display:block; font-size:14px; font-weight:600; margin: 12px 0 6px; }
  label:first-child { margin-top: 0; }
  input[type=tel], input[type=text] { width:100%; font:inherit; padding:12px 13px; border-radius:11px; border:1px solid var(--border); background:var(--page); color:var(--ink); }
  .check { display:flex; gap:10px; align-items:flex-start; margin-top:14px; font-size:14px; color:var(--ink-2); font-weight:400; }
  .check input { margin-top: 3px; width:18px; height:18px; flex:none; }
  button, .btn { display:block; width:100%; text-align:center; text-decoration:none; font:inherit; font-weight:650; padding:13px; border-radius:12px; border:0;
    background:var(--brand); color:#fff; cursor:pointer; margin-top:16px; }
  .btn.ghost { background:var(--surface-2); color:var(--ink); border:1px solid var(--border); }
  .err { background:rgba(208,59,59,.10); color:var(--ink); border-radius:11px; padding:10px 12px; margin-bottom:12px; font-size:14px; }
  .big { font-size: 30px; font-weight: 700; letter-spacing: -0.5px; margin: 2px 0; font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); font-size: 13.5px; }
  ol, ul { padding-left: 20px; margin: 6px 0 0; color: var(--ink-2); }
  li { margin-bottom: 6px; }
  li b { color: var(--ink); }
  .ok { color: var(--good); font-weight: 650; }
  .demo { font-size: 12px; color: var(--muted); text-align: center; margin-top: 22px; }
`;

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main><div class="mark" aria-hidden="true">B</div>${body}
<p class="demo">Bouncer · HackUTD 2026 demo</p></main></body></html>`;

function formPage(opts: { error?: string; phone?: string; name?: string; code?: string }) {
  const needCode = !!config.join.code;
  return page(
    "Try Bouncer",
    `<h1>Try Bouncer</h1>
<p class="sub">A scam checker you can text and call. Send it a sketchy text or screenshot, or let it listen in on a suspicious call.</p>
${opts.error ? `<div class="err" role="alert">${esc(opts.error)}</div>` : ""}
<form class="card" method="post" action="/join">
  <label for="phone">Your iPhone number</label>
  <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(214) 555-0123" required value="${esc(opts.phone ?? "")}">
  <label for="name">First name <span class="muted">(optional)</span></label>
  <input id="name" name="name" type="text" autocomplete="given-name" maxlength="40" value="${esc(opts.name ?? "")}">
  ${needCode ? `<label for="code">Event code</label><input id="code" name="code" type="text" autocapitalize="characters" required value="${esc(opts.code ?? "")}">` : ""}
  <label class="check"><input type="checkbox" name="agree" value="1" required>
    <span>I'm trying a hackathon demo. Bouncer reads what I send it to check for scams and doesn't save my messages. I won't send real passwords or account numbers.</span></label>
  <button type="submit">Get Bouncer</button>
</form>
<p class="muted">Use the number your iPhone uses for iMessage (Settings → Messages → Send &amp; Receive).</p>`,
  );
}

function donePage(name: string | null, textNumber: string, existed: boolean) {
  const voice = config.photon.voiceNumber;
  return page(
    "You're in",
    `<h1>${existed ? "You're already set up" : "You're in"}${name ? `, ${esc(name)}` : ""}!</h1>
<p class="sub">Send Bouncer a text to start. It can't text you first.</p>
<div class="card">
  <div class="muted">1. Text Bouncer</div>
  <div class="big">${pretty(textNumber)}</div>
  <a class="btn" href="sms:${textNumber}&amp;body=hi">Text "hi" to Bouncer</a>
  <a class="btn ghost" href="/join/bouncer.vcf?n=${encodeURIComponent(textNumber)}">Save Bouncer to contacts</a>
  <p class="muted" style="margin:12px 0 0">Reply YES to its first message to turn on call protection.</p>
</div>
<div class="card">
  <div class="muted">2. Call or merge it into a call</div>
  <div class="big">${pretty(voice)}</div>
  <a class="btn ghost" href="tel:${voice}">Call Bouncer</a>
  <p class="muted" style="margin:12px 0 0">It stays quiet and texts you warnings. Say "Hey Bouncer" to ask it something.</p>
</div>
<div class="card">
  <div class="muted">Things to try</div>
  <ul>
    <li><b>Paste a sketchy text</b>, like "USPS: your package is on hold, update your address at usps-redeliver.info".</li>
    <li><b>Send a screenshot</b> of a scam text, DM or email.</li>
    <li><b>Call it with a friend</b> playing a scammer ("this is your bank, read me the code"), then text "I already paid".</li>
    <li><b>Text "set up family"</b> to make a family circle with a safe word.</li>
  </ul>
</div>`,
  );
}

function vcard(textNumber: string): string {
  const voice = config.photon.voiceNumber;
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Bouncer",
    "N:;Bouncer;;;",
    "ORG:Bouncer scam help",
    `TEL;TYPE=CELL,pref:${textNumber}`,
    `TEL;TYPE=VOICE:${voice}`,
    `NOTE:Text ${pretty(textNumber)} with anything suspicious. Call or merge ${pretty(voice)} into a call that feels off.`,
    "END:VCARD",
    "",
  ].join("\r\n");
}

function qrPage(url: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scan to try Bouncer</title><style>${STYLE} .qr{background:#fff;padding:18px;border-radius:18px;display:inline-block} .qr img,.qr canvas{display:block;width:min(70vw,420px)!important;height:auto!important}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head>
<body><main style="text-align:center; max-width:640px"><h1 style="font-size:34px">Scan to try Bouncer</h1>
<p class="sub">Text and call a scam checker from your own phone.</p><div class="qr" id="qr"></div>
<p class="muted" style="margin-top:14px; word-break:break-all">${esc(url)}</p></main>
<script>new QRCode(document.getElementById("qr"), { text: ${JSON.stringify(url)}, width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });</script></body></html>`;
}

/** Turns a Photon failure into words for the person and a short log reason (no personal data). */
function explain(err: unknown): { userMsg: string; reason: string } {
  if (err instanceof ApiError) {
    const code = String((err.body as any)?.code ?? "");
    if (code === "SHARED_LINE_CAP_EXCEEDED" || code === "SHARED_LINE_POOL_EXHAUSTED" || err.status === 503)
      return { userMsg: "Sign-ups are full right now. Find the Bouncer team and we'll get you set up.", reason: `${err.status} ${code}` };
    if (err.status === 401 || err.status === 403)
      return { userMsg: "Sign-up isn't switched on yet. Find the Bouncer team and we'll add you by hand.", reason: `${err.status} ${code} (the Photon key needs platforms:write)` };
    if (err.status === 422 || err.status === 400)
      return { userMsg: "That number didn't work. Use the number your iPhone uses for iMessage.", reason: `${err.status} ${code}` };
    return { userMsg: "Something went wrong. Please try again in a minute.", reason: `${err.status} ${code}` };
  }
  return { userMsg: "Something went wrong. Please try again in a minute.", reason: (err as Error)?.message?.slice(0, 120) ?? "unknown" };
}

// ---- routes -----------------------------------------------------------------------------------

export const signupApp = new Hono();

signupApp.get("/join", (c) => c.html(formPage({ code: c.req.query("code") ?? "" })));

signupApp.post("/join", async (c) => {
  const form = await c.req.parseBody();
  const field = (k: string) => (typeof form[k] === "string" ? (form[k] as string).trim() : "");
  const phoneRaw = field("phone").slice(0, 40);
  const name = field("name").replace(/[^\p{L}\p{N} .'-]/gu, "").slice(0, 40) || null;
  const code = field("code").slice(0, 40);
  const again = (error: string, status: 400 | 403 | 429 | 502 = 400) =>
    c.html(formPage({ error, phone: phoneRaw, name: name ?? "", code }), status);

  if (config.join.code && code.toUpperCase() !== config.join.code.toUpperCase()) return again("That event code isn't right.", 403);
  if (!field("agree")) return again("Please check the box to continue.");
  const handle = toE164(phoneRaw);
  if (!handle) return again("That doesn't look like a US phone number.");
  const ip = (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  if (!allowIp(ip)) return again("Too many tries. Wait a few minutes and try again.", 429);
  if (!allowToday()) {
    console.warn("[join] daily sign-up cap reached");
    return again("Sign-ups are full for today. Find the Bouncer team and we'll get you set up.", 429);
  }

  const t0 = Date.now();
  try {
    const r = await assign(handle, name);
    if (!r.existed) todayCount++;
    console.log(`[join] ${r.existed ? "already assigned" : "assigned"} in ${Date.now() - t0} ms (${todayCount}/${config.join.dailyMax} today)`);
    return c.html(donePage(name, r.number, r.existed));
  } catch (err) {
    const { userMsg, reason } = explain(err);
    console.error(`[join] failed: ${reason}`);
    return again(userMsg, 502);
  }
});

signupApp.get("/join/bouncer.vcf", (c) => {
  const n = toE164(c.req.query("n")) ?? config.photon.imessageHandle;
  return c.body(vcard(n), 200, { "Content-Type": "text/vcard; charset=utf-8", "Content-Disposition": 'attachment; filename="Bouncer.vcf"' });
});

signupApp.get("/join/qr", (c) => {
  const url = `${config.publicBaseUrl}/join${config.join.code ? `?code=${encodeURIComponent(config.join.code)}` : ""}`;
  return c.html(qrPage(url));
});
