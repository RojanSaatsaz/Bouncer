// Flow 7 step 5, in process: the dashboard's "Start bulk replay" button. Pushes dataset rows through
// ingestEvent() at ~5 messages/second with bulk = true (never texts anyone). Stops by itself after
// MAX_MESSAGES so a forgotten replay can't run up Jev usage.
import { ingestEvent, bulkQueueDepth } from "./ingest.js";
import { replayMix, toEvent } from "./dataset.js";

const RATE_PER_S = 5;
const MAX_MESSAGES = 600; // two minutes at 5/s
const MAX_BACKLOG = 8; // don't queue up if Jev slows down

interface ReplayState {
  running: boolean;
  sent: number;
  failed: number;
  total: number;
  startedAt: string | null;
  error: string | null;
}

const state: ReplayState = { running: false, sent: 0, failed: 0, total: 0, startedAt: null, error: null };
let timer: NodeJS.Timeout | null = null;

export const replayStatus = (): ReplayState => ({ ...state });

export function startReplay(limit = MAX_MESSAGES): ReplayState {
  if (state.running) return replayStatus();
  const rows = replayMix(Math.min(limit, MAX_MESSAGES));
  if (!rows.length) {
    state.error = "no replay data: add data/*.csv or src/carrier/sample.json";
    return replayStatus();
  }
  Object.assign(state, { running: true, sent: 0, failed: 0, total: rows.length, startedAt: new Date().toISOString(), error: null });
  let i = 0;
  timer = setInterval(() => {
    if (i >= rows.length) return stopReplay();
    if (bulkQueueDepth() >= MAX_BACKLOG) return; // Jev is behind: skip this tick
    const ev = toEvent(rows[i++], true);
    ingestEvent(ev).then(
      () => state.sent++,
      (err) => {
        state.failed++;
        state.error = String(err?.message ?? err).slice(0, 200);
      },
    );
  }, 1000 / RATE_PER_S);
  return replayStatus();
}

export function stopReplay(): ReplayState {
  if (timer) clearInterval(timer);
  timer = null;
  state.running = false;
  return replayStatus();
}
