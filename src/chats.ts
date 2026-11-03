// Shared by the MCP tools and the JSON API: times, numbers and chats by name,
// search, and the JSON shape of one message.

import { unsealText } from "./crypto.js";
import { KIND_LABEL, mediaKey } from "./media.js";
import { allNumbers, numberName, numberTag, type NumberView } from "./numbers.js";
import { knownChats, mediaInfo, namesFor, parseBody, scanRows, type Row } from "./store.js";
import { mediaDetails } from "./whatsapp.js";

// Times are shown and read in TIMEZONE (an IANA name like Asia/Singapore,
// default UTC). A local phone number like 012... gets DEFAULT_COUNTRY_CODE in
// front of it when that is set. The settings page can change the country code.
export const TZ = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
let COUNTRY_CODE = (process.env.DEFAULT_COUNTRY_CODE ?? "").replace(/\D/g, "");
export function setCountryCode(code: string) {
  COUNTRY_CODE = code.replace(/\D/g, "");
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(ms: number, tz: string): Record<string, string> {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
}

export function fmt(ms: number | null): string {
  if (!ms) return "-";
  const p = partsIn(ms, TZ);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// A wall-clock time in `tz` -> ms since epoch. Read it as UTC first, then
// subtract the zone's offset at that moment; the second pass settles a
// daylight-saving edge.
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(t, tz);
    const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
    t = wall - offset;
  }
  return t;
}

// "2026-09-27", "2026-09-27 14:00", any ISO string, relative "3d" / "12h", or
// ms since epoch (what the JSON API sends). Dates without a zone are read in
// TIMEZONE. `end` makes a bare date mean end of day.
export function parseWhen(s: string | undefined, end: boolean, tz = TZ): number | null {
  if (!s) return null;
  const v = s.trim();
  if (/^\d{10,}$/.test(v)) return Number(v);
  const rel = /^(\d+)\s*([dh])$/i.exec(v);
  if (rel) return Date.now() - Number(rel[1]) * (rel[2].toLowerCase() === "d" ? 86_400_000 : 3_600_000);
  const wall = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (wall) {
    const [, y, mo, d, h, mi, sec] = wall;
    if (h === undefined) return end ? zonedToUtc(+y, +mo, +d, 23, 59, 59, 999, tz) : zonedToUtc(+y, +mo, +d, 0, 0, 0, 0, tz);
    return zonedToUtc(+y, +mo, +d, +h, +mi, +(sec || 0), 0, tz);
  }
  const n = Date.parse(v);
  if (Number.isNaN(n)) throw new Error(`cannot read the date "${s}" (use 2026-09-27, 2026-09-27 14:00, 3d or 12h)`);
  return n;
}

export function range(since: string | undefined, until: string | undefined): { lo: number; hi: number } {
  return { lo: parseWhen(since, false) ?? 0, hi: parseWhen(until, true) ?? Date.now() + 86_400_000 };
}

export const digits = (jid: string) => jid.split("@")[0].split(":")[0];
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const isGroup = (jid: string) => jid.endsWith("@g.us");

export function chatLabel(jid: string, names: Map<string, string>): string {
  const n = names.get(jid);
  if (isGroup(jid)) return n || "unnamed group";
  return n ? `${n} (+${digits(jid)})` : `+${digits(jid)}`;
}

export function senderLabel(r: Row, names: Map<string, string>): string {
  if (r.from_me) return "me";
  const fromRow = unsealText(r.sender_name_enc);
  const fromBook = r.sender_jid ? names.get(r.sender_jid) : undefined;
  return fromBook || fromRow || (r.sender_jid ? `+${digits(r.sender_jid)}` : "unknown");
}

export function namesForRows(rows: Row[], extra: string[] = []): Map<string, string> {
  const jids = [...extra];
  for (const r of rows) {
    jids.push(r.chat_jid);
    if (r.sender_jid) jids.push(r.sender_jid);
  }
  return namesFor(jids);
}

// ---------------------------------------------------------------------------
// numbers and chats by what a person types
// ---------------------------------------------------------------------------

// A number by id (n1), label (Sales) or phone. Empty = all numbers.
export function resolveNumber(input: string | undefined): string | null {
  const v = (input || "").trim();
  if (!v) return null;
  const all = allNumbers();
  const byId = all.find((n) => n.id === v.toLowerCase());
  if (byId) return byId.id;
  const d = v.replace(/[\s+\-()]/g, "");
  if (/^\d{6,}$/.test(d)) {
    const full = d.startsWith("0") && COUNTRY_CODE ? COUNTRY_CODE + d.slice(1) : d;
    const hit = all.find((n) => n.phone === full);
    if (hit) return hit.id;
  }
  const byLabel = all.filter((n) => (n.label || "").toLowerCase() === v.toLowerCase());
  if (byLabel.length === 1) return byLabel[0].id;
  throw new Error(`no linked number matches "${input}". Numbers: ${all.map((n) => `${n.id} (${numberName(n, n.id)})`).join(", ")}`);
}

export interface ChatRef {
  number_id: string;
  chat_jid: string;
}

// A chat by address, phone number or part of its name, within one number or
// across all of them.
export function resolveChat(input: string, numberId: string | null): ChatRef {
  const v = input.trim();
  const all = knownChats(numberId);
  const numbers = new Map(allNumbers().map((n) => [n.id, n]));
  const label = (c: ChatRef, names: Map<string, string>) =>
    `${chatLabel(c.chat_jid, names)}  chat_id=${c.chat_jid}${numbers.size > 1 ? `  ${numberTag(numbers.get(c.number_id), c.number_id)}` : ""}`;
  const one = (hits: ChatRef[], what: string): ChatRef | null => {
    if (hits.length === 1) return hits[0];
    if (!hits.length) return null;
    const names = namesFor(hits.map((h) => h.chat_jid));
    const sameChat = new Set(hits.map((h) => h.chat_jid)).size === 1;
    throw new Error(
      (sameChat ? `"${input}" is in more than one linked number, pass number too:\n` : `"${what}" matches ${hits.length} chats, pass one chat_id instead:\n`) +
        hits.slice(0, 15).map((h) => `- ${label(h, names)}`).join("\n"),
    );
  };

  const exact = one(all.filter((c) => c.chat_jid === v), v);
  if (exact) return exact;
  const stripped = v.replace(/[\s+\-()]/g, "");
  if (/^\d{6,}$/.test(stripped)) {
    const d = stripped.startsWith("0") && COUNTRY_CODE ? COUNTRY_CODE + stripped.slice(1) : stripped;
    const hit = one(all.filter((c) => !isGroup(c.chat_jid) && digits(c.chat_jid) === d), v);
    if (hit) return hit;
  }
  const names = namesFor(all.map((c) => c.chat_jid));
  const needle = v.toLowerCase();
  const hits = all.filter((c) => (names.get(c.chat_jid) || "").toLowerCase().includes(needle));
  if (!hits.length) throw new Error(`no chat matches "${input}". Use list_chats to see the chats.`);
  if (hits.length > 1) {
    const whole = hits.filter((c) => (names.get(c.chat_jid) || "").toLowerCase() === needle);
    if (whole.length === 1) return whole[0];
  }
  return one(hits, v)!;
}

// Messages containing every word of `query` (also replied-to text and file
// names), newest first.
export function searchRows(query: string, numberId: string | null, chatJid: string | null, lo: number, hi: number, limit: number): Row[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: Row[] = [];
  for (const r of scanRows(numberId, chatJid, lo, hi)) {
    const b = parseBody(r.body_enc);
    const hay = `${b.t}\n${b.q || ""}\n${b.f || ""}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) {
      hits.push(r);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// one message as a text line (MCP) or JSON (API)
// ---------------------------------------------------------------------------

const FILE_KINDS = new Set(["image", "audio", "video", "document"]);

export function line(r: Row, names: Map<string, string>, opts: { withChat?: boolean; numbers?: Map<string, NumberView> } = {}): string {
  const b = parseBody(r.body_enc);
  const key = mediaKey(r.number_id, r.id);
  let tag = "";
  if (r.kind === "image") tag = `[image id=${key}]`;
  else if (r.kind === "document") tag = r.has_ref ? `[document id=${key}: ${b.f || "file"}]` : `[document: ${b.f || "file"}]`;
  else if (r.kind && FILE_KINDS.has(r.kind)) tag = r.has_ref ? `[${KIND_LABEL[r.kind]} id=${key}]` : `[${KIND_LABEL[r.kind]}, file not kept]`;
  else if (r.kind) tag = `[${r.kind}]`;
  const text = [tag, b.t].filter(Boolean).join(" ");
  const quote = b.q ? ` (replying to: "${b.q.replace(/\s+/g, " ").slice(0, 120)}")` : "";
  const num = opts.numbers && opts.numbers.size > 1 ? `${numberName(opts.numbers.get(r.number_id), r.number_id)} · ` : "";
  const where = opts.withChat ? `${num}${chatLabel(r.chat_jid, names)} · ` : "";
  return `[${fmt(r.ts)}] ${where}${senderLabel(r, names)}: ${text}${quote}${b.e ? " (edited)" : ""}`;
}

export interface MessageView {
  key: string; // number:id, for GET /media/:key
  number: string;
  id: string;
  chat: string;
  ts: number;
  fromMe: boolean;
  sender: string | null;
  senderName: string | null;
  kind: string | null;
  text: string;
  quote: string | null;
  file: string | null;
  edited: boolean;
  media: { kept: boolean; mime: string | null; seconds: number | null; bytes: number | null } | null;
}

export function messageView(r: Row, names: Map<string, string>): MessageView {
  const b = parseBody(r.body_enc);
  let media: MessageView["media"] = null;
  if (r.kind && FILE_KINDS.has(r.kind)) {
    media = { kept: !!r.has_ref, mime: null, seconds: null, bytes: null };
    if (r.has_ref) Object.assign(media, mediaDetails(mediaInfo(r.number_id, r.id)?.ref ?? null));
  }
  return {
    key: mediaKey(r.number_id, r.id),
    number: r.number_id,
    id: r.id,
    chat: r.chat_jid,
    ts: r.ts,
    fromMe: !!r.from_me,
    sender: r.from_me ? null : r.sender_jid,
    senderName: r.from_me ? null : senderLabel(r, names),
    kind: r.kind,
    text: b.t || "",
    quote: b.q || null,
    file: b.f || null,
    edited: !!b.e,
    media,
  };
}
