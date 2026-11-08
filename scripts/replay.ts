// Flow 7 step 2: pretend to be T-Mobile's network and push SMS events to POST /carrier/events.
//
//   npm run replay -- --one toll --to +12145550123      one fixed toll-scam text (alerts that user if enrolled)
//   npm run replay -- --bulk --rate 5 --limit 200       dataset traffic, bulk: true (never alerts anyone)
//        [--source mendeley|archive|both]               train splits only (default both)
//   npm run replay -- --write-sample [--limit 400]      writes src/carrier/sample.json for the server's
//                                                       in-process replay (data/*.csv isn't deployed)
//   add --prod to post to PUBLIC_BASE_URL, or --base <url>; default http://localhost:3000
import fs from "node:fs";
import pLimit from "p-limit";
import { config } from "../src/config.js";
import { loadDatasetRows, replayMix, toEvent, tollEvent, SAMPLE_PATH } from "../src/carrier/dataset.js";
import type { CarrierEvent } from "../src/carrier/ingest.js";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

const MAX_RATE = 5; // keep Jev usage modest

async function main() {
  if (has("--write-sample")) return writeSample(Number(val("--limit") ?? 400));

  const base = (val("--base") ?? (has("--prod") ? config.publicBaseUrl : "http://localhost:3000")).replace(/\/+$/, "");
  if (!config.dashboardPassword) throw new Error("DASHBOARD_PASSWORD is not set (needed for basic auth).");
  const auth = "Basic " + Buffer.from(`replay:${config.dashboardPassword}`).toString("base64");

  const post = async (ev: CarrierEvent) => {
    const res = await fetch(`${base}/carrier/events`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(20_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? "?"}${body.detail ? ` (${body.detail})` : ""}`);
    return body;
  };

  if (val("--one")) {
    if (val("--one") !== "toll") throw new Error('only "--one toll" is defined');
    const to = val("--to");
    if (!to) throw new Error("--one toll needs --to <E.164 phone>");
    const v = await post(tollEvent(to));
    console.log(`toll → …${to.slice(-4)}: ${v.label} (${v.confidence}%), ${v.scam_type}, flags [${v.flags.join(", ")}], ` +
      `${v.latency_ms} ms, alert: ${v.alert}`);
    return;
  }

  if (has("--bulk")) {
    let rate = Number(val("--rate") ?? MAX_RATE);
    if (!(rate > 0)) rate = MAX_RATE;
    if (rate > MAX_RATE) {
      console.warn(`--rate ${rate} capped at ${MAX_RATE}/s to keep Jev usage modest`);
      rate = MAX_RATE;
    }
    const limit = Number(val("--limit") ?? 100);
    const source = (val("--source") ?? "both") as "mendeley" | "archive" | "both";
    const rows = replayMix(limit, source);
    if (!rows.length) throw new Error("no rows: data/*.csv and src/carrier/sample.json are both missing");
    console.log(`replaying ${rows.length} texts (${source}) to ${base} at ${rate}/s, bulk mode`);

    const inflight = pLimit(4);
    const tally: Record<string, number> = {};
    let ok = 0, failed = 0;
    const t0 = Date.now();
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < rows.length; i++) {
      const ev = toEvent(rows[i], true);
      jobs.push(
        inflight(() => post(ev)).then(
          (v) => {
            ok++;
            const k = `${ev.true_label}→${v.level}`;
            tally[k] = (tally[k] ?? 0) + 1;
          },
          (err) => {
            failed++;
            console.error(`  ${ev.event_id}: ${err.message}`);
          },
        ),
      );
      await new Promise((r) => setTimeout(r, 1000 / rate));
    }
    await Promise.all(jobs);
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${ok} ok, ${failed} failed`);
    for (const [k, n] of Object.entries(tally).sort()) console.log(`  ${k.padEnd(28)} ${n}`);
    return;
  }

  console.log("usage: --one toll --to <E.164> | --bulk [--rate N] [--limit M] [--source mendeley|archive|both] | --write-sample  [--prod | --base URL]");
}

function writeSample(n: number) {
  if (!loadDatasetRows().length) throw new Error("data/mendeley_clean.csv and data/scams_archive_en.csv not found");
  const rows = replayMix(n, "both", 42);
  fs.writeFileSync(SAMPLE_PATH, JSON.stringify(rows, null, 1) + "\n");
  const by = rows.reduce<Record<string, number>>((a, r) => ((a[`${r.source}/${r.label}`] = (a[`${r.source}/${r.label}`] ?? 0) + 1), a), {});
  console.log(`wrote ${rows.length} rows to ${SAMPLE_PATH}`, by);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
