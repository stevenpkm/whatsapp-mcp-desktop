// Sending, off by default. The person turns it on on the settings page after a
// ban-risk warning. Messages never go out in a burst: one at a time, a random
// 20 to 60 second gap, a few seconds of "typing..." first, and hourly and daily
// caps. Only to chats that already exist (resolveChat finds nothing else).
// The log and the history file hold times only, never message text.

import crypto from "crypto";
import { appendFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { HOME } from "./paths.js";
import { getSession } from "./whatsapp.js";

const SENT_FILE = join(HOME, "sent-times.json");
const FAKE_FILE = join(HOME, "fake-sent.jsonl");
// Tests only: write to a file instead of WhatsApp, and wait less.
const FAKE = process.env.WHATSAPP_MCP_FAKE_SEND === "1";
const GAP_MIN_MS = Number(process.env.WHATSAPP_MCP_SEND_GAP_MS ?? 20_000);
const GAP_MAX_MS = process.env.WHATSAPP_MCP_SEND_GAP_MS ? GAP_MIN_MS : 60_000;
const WAIT_FOR_LINK_MS = 30 * 60_000;

export const LIMITS = { perHour: 20, perDay: 100, maxChars: 2000, gapMinSec: 20, gapMaxSec: 60 };

export type OutStatus = "queued" | "sending" | "sent" | "failed" | "cancelled";
export interface OutItem {
  id: string;
  numberId: string;
  chatJid: string;
  label: string;
  text: string;
  status: OutStatus;
  // A number with no chat here yet: check it is on WhatsApp before sending.
  newNumber?: boolean;
  queuedAt: number;
  doneAt?: number;
  error?: string;
}

const outbox: OutItem[] = [];
let sentTimes: number[] | null = null;
let lastSentAt = 0;
let working = false;
let isOn: () => boolean = () => false;

export function initSender(enabled: () => boolean): void {
  isOn = enabled;
}

function times(): number[] {
  if (!sentTimes) {
    try {
      sentTimes = (JSON.parse(readFileSync(SENT_FILE, "utf8")) as number[]).filter((n) => typeof n === "number");
    } catch {
      sentTimes = [];
    }
  }
  const dayAgo = Date.now() - 86_400_000;
  sentTimes = sentTimes.filter((t) => t > dayAgo);
  return sentTimes;
}

export function counts(): { lastHour: number; lastDay: number; queued: number } {
  const t = times();
  const hourAgo = Date.now() - 3_600_000;
  return { lastHour: t.filter((x) => x > hourAgo).length, lastDay: t.length, queued: outbox.filter((o) => o.status === "queued" || o.status === "sending").length };
}

// Puts a message in the line. Throws with a plain reason when it cannot.
export function enqueue(numberId: string, chatJid: string, label: string, text: string, newNumber = false): { item: OutItem; ahead: number; etaSec: number } {
  if (!isOn()) throw new Error("Sending is off. The person can turn it on on the settings page (open_settings_page), at their own risk.");
  const body = text.trim();
  if (!body) throw new Error("The message is empty.");
  if (body.length > LIMITS.maxChars) throw new Error(`The message is too long (${body.length} characters, limit ${LIMITS.maxChars}).`);
  const c = counts();
  if (c.lastHour + c.queued >= LIMITS.perHour) throw new Error(`Hourly limit reached (${LIMITS.perHour} messages an hour, to keep the number safe). Try again later.`);
  if (c.lastDay + c.queued >= LIMITS.perDay) throw new Error(`Daily limit reached (${LIMITS.perDay} messages a day, to keep the number safe). Try again tomorrow.`);
  const item: OutItem = { id: crypto.randomBytes(4).toString("hex"), numberId, chatJid, label, text: body, status: "queued", queuedAt: Date.now(), ...(newNumber ? { newNumber } : {}) };
  outbox.push(item);
  if (outbox.length > 100) outbox.splice(0, outbox.length - 100);
  const ahead = c.queued;
  const etaSec = Math.max(0, Math.round((lastSentAt + GAP_MIN_MS - Date.now()) / 1000)) + ahead * Math.round((GAP_MIN_MS + GAP_MAX_MS) / 2000);
  console.log(`[send] queued 1 (${ahead} ahead)`);
  void work();
  return { item, ahead, etaSec };
}

// Turning sending off stops everything that has not gone out yet.
export function cancelAll(): number {
  let n = 0;
  for (const o of outbox) {
    if (o.status === "queued") {
      o.status = "cancelled";
      o.doneAt = Date.now();
      n += 1;
    }
  }
  if (n) console.log(`[send] cancelled ${n}`);
  return n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deliver(o: OutItem): Promise<void> {
  if (FAKE) {
    await sleep(200);
    appendFileSync(FAKE_FILE, JSON.stringify({ to: o.chatJid, text: o.text, at: Date.now() }) + "\n");
    return;
  }
  const until = Date.now() + WAIT_FOR_LINK_MS;
  let session = getSession(o.numberId);
  while (session?.status !== "connected" || !session.sock) {
    if (Date.now() > until) throw new Error("WhatsApp was not connected for 30 minutes");
    if (!isOn() || o.status !== "sending") throw new Error("stopped");
    await sleep(10_000);
    session = getSession(o.numberId);
  }
  const sock = session.sock;
  if (o.newNumber) {
    const [hit] = (await sock.onWhatsApp(o.chatJid.split("@")[0])) || [];
    if (!hit?.exists) throw new Error("this number is not on WhatsApp");
    o.chatJid = hit.jid;
  }
  // A few seconds of "typing...", longer for longer messages, like a person.
  try {
    await sock.sendPresenceUpdate("composing", o.chatJid);
    await sleep(Math.min(8_000, 1_500 + o.text.length * 40));
    await sock.sendPresenceUpdate("paused", o.chatJid);
  } catch {
    /* presence is only a courtesy */
  }
  await sock.sendMessage(o.chatJid, { text: o.text });
}

async function work(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (;;) {
      const o = outbox.find((x) => x.status === "queued");
      if (!o) return;
      const gap = GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS);
      const wait = lastSentAt + gap - Date.now();
      if (wait > 0) await sleep(wait);
      if (o.status !== "queued") continue;
      if (!isOn()) {
        cancelAll();
        return;
      }
      o.status = "sending";
      try {
        await deliver(o);
        o.status = "sent";
        lastSentAt = Date.now();
        times().push(lastSentAt);
        writeFileSync(SENT_FILE, JSON.stringify(times()));
        console.log("[send] sent 1");
      } catch (e: any) {
        o.status = o.status === "sending" && e?.message === "stopped" ? "cancelled" : "failed";
        o.error = e?.message || String(e);
        lastSentAt = Date.now();
        console.error(`[send] ${o.status}: ${o.error}`);
      }
      o.doneAt = Date.now();
    }
  } finally {
    working = false;
  }
}
