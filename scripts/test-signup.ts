// Sign-up link test: runs /join in-process with a FAKE assigner (no Photon assignment is ever created).
//   npm run test:signup
export {};
process.env.DRY_RUN = "1";
process.env.PHOTON_SOCKET = "off";
process.env.JOIN_CODE = "HACKUTD";
process.env.JOIN_DAILY_MAX = "50";

const { signupApp, setAssigner, resetSignupLimits } = await import("../src/signup/index.js");
const { ApiError } = await import("@photon-ai/api");

let failures = 0;
const check = (name: string, cond: unknown, detail?: string) => {
  process.stdout.write(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  (${detail})` : ""}\n`); // not console: logs are captured below
  if (!cond) failures++;
};

// Capture logs to prove no phone number is ever logged.
const logs: string[] = [];
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
    if (!String(a[0]).startsWith("[join]")) orig(...a);
  };
}

const calls: Array<{ handle: string; firstName: string | null }> = [];
let next: (() => Promise<{ number: string; existed: boolean }>) | null = null;
setAssigner(async (handle, firstName) => {
  calls.push({ handle, firstName });
  return next ? next() : { number: "+16289988619", existed: false };
});

const post = (fields: Record<string, string>, ip = "10.0.0.1") =>
  signupApp.request("/join", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body: new URLSearchParams(fields).toString(),
  });
const good = { phone: "(214) 555-0123", name: "Ana", code: "hackutd", agree: "1" };

let r = await signupApp.request("/join?code=HACKUTD");
let html = await r.text();
check("GET /join → form", r.status === 200 && /<form/.test(html) && /Your iPhone number/.test(html));
check("event code field, prefilled from the link", /name="code"[^>]*value="HACKUTD"/.test(html));

r = await post({ ...good, agree: "" });
check("no checkbox → 400 + message", r.status === 400 && /check the box/.test(await r.text()));
r = await post({ ...good, code: "WRONG" });
check("wrong event code → 403", r.status === 403 && /event code isn(&#39;|')t right/.test(await r.text()));
r = await post({ ...good, phone: "12345" });
check("bad phone → 400", r.status === 400 && /US phone number/.test(await r.text()));
check("nothing assigned yet", calls.length === 0);

r = await post(good);
html = await r.text();
check("valid → 200 'You're in, Ana'", r.status === 200 && /You're in, Ana!/.test(html), html.slice(0, 200));
check("assigned the E.164 number + first name", calls[0]?.handle === "+12145550123" && calls[0]?.firstName === "Ana", JSON.stringify(calls[0]));
check("shows the number to text", html.includes("(628) 998-8619"));
check("tap-to-text link", html.includes('href="sms:+16289988619&amp;body=hi"'));
check("tap-to-call link to the voice line", /href="tel:\+1\d{10}"/.test(html));
check("contact card link", html.includes("/join/bouncer.vcf?n=%2B16289988619"));

next = async () => ({ number: "+16289988619", existed: true });
r = await post({ ...good, name: "" }, "10.0.0.2");
check("already signed up → friendly page", r.status === 200 && /already set up/.test(await r.text()));

const apiErr = (status: number, code: string) =>
  new ApiError(`HTTP ${status}`, { status, headers: new Headers(), body: { code } });
next = async () => { throw apiErr(409, "SHARED_LINE_CAP_EXCEEDED"); };
r = await post(good, "10.0.0.3");
check("shared-line cap → 'full' message", r.status === 502 && /Sign-ups are full/.test(await r.text()));
next = async () => { throw apiErr(403, "INSUFFICIENT_SCOPE"); };
r = await post(good, "10.0.0.4");
check("missing permission → 'isn't switched on yet'", r.status === 502 && /isn(&#39;|')t switched on yet/.test(await r.text()));
check("log says the key needs platforms:write", logs.some((l) => /platforms:write/.test(l)));

next = null;
resetSignupLimits();
let last = 0;
for (let i = 0; i < 7; i++) last = (await post(good, "10.9.9.9")).status;
check("7th try from one address in 10 min → 429", last === 429, String(last));

r = await post({ ...good, code: '"><script>alert(1)</script>' }, "10.0.0.5");
check("form values are escaped", !(await r.text()).includes("<script>alert(1)</script>"));

r = await signupApp.request("/join/bouncer.vcf?n=%2B16289988619");
const vcf = await r.text();
check("contact card: vCard with both numbers", /text\/vcard/.test(r.headers.get("content-type") ?? "") && /TEL;TYPE=CELL,pref:\+16289988619/.test(vcf) && /TEL;TYPE=VOICE:\+1\d{10}/.test(vcf), vcf);
r = await signupApp.request("/join/qr");
const qr = await r.text();
check("QR page encodes the join link with the code", /\/join\?code=HACKUTD/.test(qr) && /qrcode\.min\.js/.test(qr));

check("no phone number or name in any log line", !logs.some((l) => /2145550123|555-0123|Ana/.test(l)), logs.join(" | "));

process.stdout.write(`\n${failures ? `${failures} FAILED` : "All checks passed"}\n`);
process.exit(failures ? 1 : 0);
