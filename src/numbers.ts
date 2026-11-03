// Linked numbers: the list in the database plus one WhatsApp session each.
// Each number keeps its WhatsApp login in auth/<id> on the volume.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { createNumber, deleteNumber, getNumber, listNumbers, setNumberMe, stats, type NumberRow } from "./store.js";
import { addSession, dropSession, getSession, type Status } from "./whatsapp.js";

let authRoot = "";
let run = true;
export let maxNumbers = 5;

export function initNumbers(opts: { authRoot: string; run: boolean; max: number }): void {
  authRoot = opts.authRoot;
  run = opts.run;
  maxNumbers = opts.max;
  mkdirSync(authRoot, { recursive: true });
  moveSingleNumberLogin();
  // A fresh vault starts with one number, so `npm run qr` works as before.
  if (!listNumbers().length) createNumber(null);
  for (const n of listNumbers()) addSession(n.id, join(authRoot, n.id), run);
}

// Version 1 kept the one WhatsApp login straight in auth/. It belongs to n1.
function moveSingleNumberLogin(): void {
  if (!existsSync(join(authRoot, "creds.json"))) return;
  const dest = join(authRoot, "n1");
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(authRoot)) {
    const p = join(authRoot, f);
    if (statSync(p).isFile()) renameSync(p, join(dest, f));
  }
  console.log("[vault] WhatsApp login moved to auth/n1 (no new scan needed)");
}

export interface NumberView {
  id: string;
  label: string | null;
  phone: string | null; // digits only, once linked
  status: Status;
  hasQr: boolean;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  messages: number;
  chats: number;
  oldest: number | null;
  newest: number | null;
}

const phoneOf = (jid: string | null) => (jid ? jid.split(":")[0].split("@")[0] : null);

export function viewNumber(n: NumberRow): NumberView {
  const s = getSession(n.id);
  return {
    id: n.id,
    label: n.label,
    phone: phoneOf(s?.meJid || n.me_jid),
    status: s?.status || "disconnected",
    hasQr: !!s?.qr,
    lastConnectedAt: s?.lastConnectedAt ?? null,
    lastDisconnectedAt: s?.lastDisconnectedAt ?? null,
    ...stats(n.id),
  };
}

export function allNumbers(): NumberView[] {
  return listNumbers().map(viewNumber);
}

// What to call a number in text: its label, else its phone, else its id.
export function numberName(n: NumberRow | NumberView | undefined, id: string): string {
  if (!n) return id;
  const phone = "phone" in n ? n.phone : phoneOf(n.me_jid);
  return n.label || (phone ? `+${phone}` : id);
}

// "number=n2 (Sales)", or just "number=n1" while it has no label or phone.
export function numberTag(n: NumberRow | NumberView | undefined, id: string): string {
  const name = numberName(n, id);
  return name === id ? `number=${id}` : `number=${id} (${name})`;
}

export function addNumber(label: string | null): NumberRow {
  if (listNumbers().length >= maxNumbers) throw new Error(`this vault already has ${maxNumbers} numbers (MAX_NUMBERS)`);
  const n = createNumber(label);
  addSession(n.id, join(authRoot, n.id), run);
  return n;
}

// Unlink and wipe the WhatsApp login, then show a new QR. Messages stay.
export async function resetNumber(id: string): Promise<void> {
  if (!getNumber(id)) throw new Error("no number with that id");
  await dropSession(id);
  await rm(join(authRoot, id), { recursive: true, force: true });
  setNumberMe(id, null);
  addSession(id, join(authRoot, id), run);
}

// Unlink, wipe the login, and delete everything this number received.
export async function removeNumber(id: string): Promise<number> {
  if (!getNumber(id)) throw new Error("no number with that id");
  await dropSession(id);
  await rm(join(authRoot, id), { recursive: true, force: true });
  return deleteNumber(id);
}
