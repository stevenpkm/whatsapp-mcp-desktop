// Catching up missed messages after being offline, against a stand-in for
// WhatsApp that hands out one batch of 100 per request. npm run test:backlog
// (add --heavy for 20,000 messages, about 7 minutes).
import { EventEmitter } from "events";
import { Session, trackBacklog } from "../src/whatsapp.ts";

interface Case {
  name: string;
  batches: number; // batches WhatsApp holds for us
  markerBeforeOpen?: boolean; // "all delivered" arrives before the watcher starts
  noMarker?: boolean; // WhatsApp never says "all delivered"
  live?: boolean; // busy live traffic all the time (not offline)
}

async function run(c: Case) {
  const ws = new EventEmitter();
  let buffering = c.batches > 0, held = 0, stored = 0, sent = 0, asks = 0, maxHeld = 0;
  const ev: any = { isBuffering: () => buffering, flush: () => { if (!buffering) return false; stored += held; held = 0; buffering = false; return true; }, on() {} };
  const marker = () => { if (!c.noMarker) ws.emit("CB:ib,,offline", {}); };
  const sendBatch = () => {
    if (sent >= c.batches) return marker();
    sent++;
    let i = 0;
    const t = setInterval(() => { buffering = true; held += 20; maxHeld = Math.max(maxHeld, held); ws.emit("CB:message", { attrs: { offline: "1" } }); if (++i === 5) clearInterval(t); }, 40);
  };
  const sock: any = { ws, ev, sendNode: async (n: any) => { if (n.content?.[0]?.tag === "offline_batch") { asks++; sendBatch(); } } };
  const backlog = trackBacklog(sock);
  if (c.markerBeforeOpen) marker();
  else if (c.batches) sendBatch(); // the library's own first request
  const liveTimer = c.live ? setInterval(() => { ws.emit("CB:message", { attrs: {} }); ws.emit("CB:receipt", { attrs: {} }); }, 100) : null;
  const s: any = new Session("t", "unused");
  s.epoch = 1;
  s.watchHeldEvents(sock, 1, backlog);
  const t0 = Date.now();
  while (s.holdTimer && Date.now() - t0 < 30 * 60_000) await new Promise((r) => setTimeout(r, 200));
  if (liveTimer) clearInterval(liveTimer);
  const total = c.batches * 100;
  const ok = stored === total && held === 0 && !s.holdTimer;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}: ${stored}/${total} stored, asked ${asks}x, most held ${maxHeld}, ${Math.round((Date.now() - t0) / 1000)}s`);
  return ok;
}

const cases: Case[] = [
  { name: "no missed messages, signal came before connect", batches: 0, markerBeforeOpen: true },
  { name: "no missed messages, no signal at all", batches: 0, noMarker: true },
  { name: "small backlog (300)", batches: 3 },
  { name: "backlog, WhatsApp never says done", batches: 5, noMarker: true },
  { name: "busy live groups while catching up (2,000)", batches: 20, live: true },
  ...(process.argv.includes("--heavy") ? [{ name: "heavy account with busy live groups (20,000)", batches: 200, live: true }] : []),
];
let all = true;
for (const c of cases) all = (await run(c)) && all;
process.exit(all ? 0 : 1);
