// SQLite on the volume (node:sqlite, no native build). Everything personal is
// sealed with crypto.ts before it is written; see the schema for what stays
// plain and why. Addresses (jids) and times stay plain so chats can be listed
// and sorted without opening every row.

import { DatabaseSync } from "node:sqlite";
import crypto from "crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { seal, sealText, unseal, unsealText } from "./crypto.js";

let db: DatabaseSync;
let mediaDir = "";

// lid alias -> phone jid, mirrored in memory (small, read on every message).
export const lidToPn = new Map<string, string>();

const MESSAGES_TABLE = `
  create table if not exists messages (
    number_id text not null,      -- which linked number received it (numbers.id)
    id text not null,             -- WhatsApp message id
    chat_jid text not null,       -- phone form for direct chats when known
    ts integer not null,          -- ms since epoch
    from_me integer not null,
    sender_jid text,
    sender_name_enc blob,
    kind text,                    -- null = text; image, video, audio, document, location, contact
    body_enc blob not null,       -- sealed JSON { t: text, q?: quoted text, f?: file name, e?: edited }
    media_ref_enc blob,           -- sealed message, for downloading the file later (image, voice note, video, document)
    media_file text,              -- file name under media/ once downloaded (the file is sealed)
    primary key (number_id, id)   -- the same group message reaches every linked number in the group
  );
  create index if not exists messages_chat_ts on messages(number_id, chat_jid, ts);
  create index if not exists messages_ts on messages(ts);
`;

export function initStore(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  mediaDir = join(dataDir, "media");
  mkdirSync(mediaDir, { recursive: true });
  db = new DatabaseSync(join(dataDir, "vault.db"));
  db.exec(`
    pragma journal_mode = wal;
    pragma synchronous = normal;
    -- linked numbers. id is short (n1, n2 ...), label is what the owner calls
    -- it, me_jid is the number's own address once linked.
    create table if not exists numbers (
      id text primary key,
      label text,
      me_jid text,
      created_at integer not null
    );
    -- names of groups and people. jid is the address, name is sealed.
    -- rank: 3 = group subject or saved contact, 2 = WhatsApp profile name, 1 = name on a message
    create table if not exists names (
      jid text primary key,
      name_enc blob not null,
      rank integer not null
    );
    create table if not exists lids (
      lid text primary key,
      pn text not null
    );
  `);
  migrateToNumbers();
  db.exec(MESSAGES_TABLE);
  for (const r of db.prepare("select lid, pn from lids").all() as { lid: string; pn: string }[]) lidToPn.set(r.lid, r.pn);
}

// Version 1 held one number and had no number_id. Its rows become number n1.
function migrateToNumbers(): void {
  const cols = db.prepare("pragma table_info(messages)").all() as { name: string }[];
  if (!cols.length || cols.some((c) => c.name === "number_id")) return;
  db.exec("begin");
  try {
    db.exec(`
      alter table messages rename to messages_v1;
      drop index if exists messages_chat_ts;
      drop index if exists messages_ts;
    `);
    db.exec(MESSAGES_TABLE);
    db.exec(`
      insert into messages (number_id, id, chat_jid, ts, from_me, sender_jid, sender_name_enc, kind, body_enc, media_ref_enc, media_file)
        select 'n1', id, chat_jid, ts, from_me, sender_jid, sender_name_enc, kind, body_enc, media_ref_enc, media_file from messages_v1;
      drop table messages_v1;
    `);
    db.prepare("insert or ignore into numbers (id, created_at) values ('n1', ?)").run(Date.now());
    db.exec("commit");
    console.log("[vault] database moved to the multi-number layout (existing messages are number n1)");
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}

export function closeStore(): void {
  db?.close();
}

// ---------------------------------------------------------------------------
// numbers
// ---------------------------------------------------------------------------

export interface NumberRow {
  id: string;
  label: string | null;
  me_jid: string | null;
  created_at: number;
}

export function listNumbers(): NumberRow[] {
  return db.prepare("select id, label, me_jid, created_at from numbers order by created_at, id").all() as unknown as NumberRow[];
}

export function getNumber(id: string): NumberRow | undefined {
  return db.prepare("select id, label, me_jid, created_at from numbers where id = ?").get(id) as NumberRow | undefined;
}

// Next free id: n1, n2, ... (ids are never reused while the row exists).
export function createNumber(label: string | null): NumberRow {
  const used = new Set(listNumbers().map((n) => n.id));
  let i = 1;
  while (used.has(`n${i}`)) i += 1;
  const row: NumberRow = { id: `n${i}`, label: label?.trim() || null, me_jid: null, created_at: Date.now() };
  db.prepare("insert into numbers (id, label, me_jid, created_at) values (?, ?, ?, ?)").run(row.id, row.label, null, row.created_at);
  return row;
}

export function setNumberLabel(id: string, label: string | null): void {
  db.prepare("update numbers set label = ? where id = ?").run(label?.trim() || null, id);
}

export function setNumberMe(id: string, meJid: string | null): void {
  db.prepare("update numbers set me_jid = ? where id = ?").run(meJid, id);
}

// The number and everything it received: rows, media files.
export function deleteNumber(id: string): number {
  const files = db.prepare("select media_file from messages where number_id = ? and media_file is not null").all(id) as { media_file: string }[];
  for (const f of files) removeFile(f.media_file);
  const r = db.prepare("delete from messages where number_id = ?").run(id);
  db.prepare("delete from numbers where id = ?").run(id);
  return Number(r.changes);
}

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

export function setName(jid: string, name: string | null | undefined, rank: number): void {
  const n = (name || "").trim();
  if (!jid || !n) return;
  const cur = db.prepare("select name_enc, rank from names where jid = ?").get(jid) as { name_enc: Uint8Array; rank: number } | undefined;
  if (cur && (cur.rank > rank || unsealText(cur.name_enc) === n)) return;
  db.prepare("insert into names (jid, name_enc, rank) values (?, ?, ?) on conflict(jid) do update set name_enc = excluded.name_enc, rank = excluded.rank").run(
    jid,
    sealText(n),
    rank,
  );
}

export function hasName(jid: string): boolean {
  return !!db.prepare("select 1 from names where jid = ?").get(jid);
}

export function namesFor(jids: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  const q = db.prepare("select name_enc from names where jid = ?");
  for (const j of new Set(jids)) {
    const r = q.get(j) as { name_enc: Uint8Array } | undefined;
    const n = r ? unsealText(r.name_enc) : null;
    if (n) out.set(j, n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// alias (@lid) -> phone
// ---------------------------------------------------------------------------

// Learn that an alias is a phone number. Rows stored under the alias before we
// knew move to the phone form, so one person is one chat.
export function rememberLid(lid: string, pn: string): void {
  if (!lid || !pn || lidToPn.get(lid) === pn) return;
  lidToPn.set(lid, pn);
  db.prepare("insert into lids (lid, pn) values (?, ?) on conflict(lid) do update set pn = excluded.pn").run(lid, pn);
  db.prepare("update messages set chat_jid = ? where chat_jid = ?").run(pn, lid);
  db.prepare("update messages set sender_jid = ? where sender_jid = ?").run(pn, lid);
  const old = db.prepare("select name_enc, rank from names where jid = ?").get(lid) as { name_enc: Uint8Array; rank: number } | undefined;
  if (old) {
    setName(pn, unsealText(old.name_enc), old.rank);
    db.prepare("delete from names where jid = ?").run(lid);
  }
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export interface Body {
  t: string;
  q?: string;
  f?: string;
  e?: 1;
}

export interface NewMessage {
  numberId: string;
  id: string;
  chatJid: string;
  ts: number;
  fromMe: boolean;
  senderJid: string | null;
  senderName: string | null;
  kind: string | null;
  body: Body;
  mediaRef: string | null; // serialized message, for image / voice note / video / document
}

// Insert once; the same message can come from history and live. Returns true
// when the row is new.
export function saveMessage(m: NewMessage): boolean {
  const r = db
    .prepare(
      `insert or ignore into messages (number_id, id, chat_jid, ts, from_me, sender_jid, sender_name_enc, kind, body_enc, media_ref_enc)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.numberId,
      m.id,
      m.chatJid,
      m.ts,
      m.fromMe ? 1 : 0,
      m.senderJid,
      m.senderName ? sealText(m.senderName) : null,
      m.kind,
      sealText(JSON.stringify(m.body)),
      m.mediaRef ? sealText(m.mediaRef) : null,
    );
  return Number(r.changes) > 0;
}

export function editBody(numberId: string, id: string, text: string): boolean {
  const row = db.prepare("select body_enc from messages where number_id = ? and id = ?").get(numberId, id) as { body_enc: Uint8Array } | undefined;
  if (!row) return false;
  const body = parseBody(row.body_enc);
  db.prepare("update messages set body_enc = ? where number_id = ? and id = ?").run(sealText(JSON.stringify({ ...body, t: text, e: 1 })), numberId, id);
  return true;
}

export function parseBody(blob: Uint8Array): Body {
  const s = unsealText(blob);
  if (s === null) return { t: "[cannot decrypt]" };
  try {
    return JSON.parse(s) as Body;
  } catch {
    return { t: s };
  }
}

export interface Row {
  number_id: string;
  id: string;
  chat_jid: string;
  ts: number;
  from_me: number;
  sender_jid: string | null;
  sender_name_enc: Uint8Array | null;
  kind: string | null;
  body_enc: Uint8Array;
  has_ref: number; // 1 = the file can still be fetched
}

const ROW_COLS = "number_id, id, chat_jid, ts, from_me, sender_jid, sender_name_enc, kind, body_enc, (media_ref_enc is not null) as has_ref";

export interface ChatSummary {
  number_id: string;
  chat_jid: string;
  n: number;
  last: number;
}

export function chatSummaries(numberId: string | null = null): ChatSummary[] {
  const sql = `select number_id, chat_jid, count(*) as n, max(ts) as last from messages ${numberId ? "where number_id = ?" : ""}
               group by number_id, chat_jid order by last desc`;
  const rows = (numberId ? db.prepare(sql).all(numberId) : db.prepare(sql).all()) as any[];
  return rows.map((r) => ({ number_id: r.number_id, chat_jid: r.chat_jid, n: Number(r.n), last: Number(r.last) }));
}

// The newest row of a chat, for list previews.
export function lastRow(numberId: string, chatJid: string): Row | null {
  return (db.prepare(`select ${ROW_COLS} from messages where number_id = ? and chat_jid = ? order by ts desc limit 1`).get(numberId, chatJid) as unknown as Row) ?? null;
}

export function knownChats(numberId: string | null = null): { number_id: string; chat_jid: string }[] {
  const sql = `select distinct number_id, chat_jid from messages ${numberId ? "where number_id = ?" : ""}`;
  return (numberId ? db.prepare(sql).all(numberId) : db.prepare(sql).all()) as any[];
}

// Newest `limit` rows of a chat in [since, until], returned oldest first.
export function readChat(numberId: string, chatJid: string, since: number, until: number, limit: number): { rows: Row[]; total: number } {
  const total = (
    db.prepare("select count(*) as n from messages where number_id = ? and chat_jid = ? and ts between ? and ?").get(numberId, chatJid, since, until) as { n: number }
  ).n;
  const rows = db
    .prepare(`select ${ROW_COLS} from messages where number_id = ? and chat_jid = ? and ts between ? and ? order by ts desc limit ?`)
    .all(numberId, chatJid, since, until, limit) as unknown as Row[];
  return { rows: rows.reverse(), total: Number(total) };
}

// Rows for a text search or a media sweep, newest first. Text is sealed, so
// matching happens in memory after this; the cap keeps a scan bounded.
export function scanRows(
  numberId: string | null,
  chatJid: string | null,
  since: number,
  until: number,
  opts: { cap?: number; kinds?: string[] } = {},
): Row[] {
  const where = ["ts between ? and ?"];
  const args: (string | number)[] = [since, until];
  if (numberId) {
    where.push("number_id = ?");
    args.push(numberId);
  }
  if (chatJid) {
    where.push("chat_jid = ?");
    args.push(chatJid);
  }
  if (opts.kinds?.length) {
    where.push(`kind in (${opts.kinds.map(() => "?").join(",")})`);
    args.push(...opts.kinds);
  }
  args.push(opts.cap ?? 100_000);
  return db.prepare(`select ${ROW_COLS} from messages where ${where.join(" and ")} order by ts desc limit ?`).all(...args) as unknown as Row[];
}

export function stats(numberId: string | null = null): { messages: number; chats: number; oldest: number | null; newest: number | null } {
  const sql = `select count(*) as n, count(distinct chat_jid) as c, min(ts) as lo, max(ts) as hi from messages ${numberId ? "where number_id = ?" : ""}`;
  const r = (numberId ? db.prepare(sql).get(numberId) : db.prepare(sql).get()) as any;
  return { messages: Number(r.n), chats: Number(r.c), oldest: r.lo ?? null, newest: r.hi ?? null };
}

// ---------------------------------------------------------------------------
// media files (sealed on the volume)
// ---------------------------------------------------------------------------

export function mediaInfo(numberId: string, id: string): { kind: string | null; ref: string | null; file: string | null } | null {
  const r = db.prepare("select kind, media_ref_enc, media_file from messages where number_id = ? and id = ?").get(numberId, id) as
    | { kind: string | null; media_ref_enc: Uint8Array | null; media_file: string | null }
    | undefined;
  if (!r) return null;
  return { kind: r.kind, ref: unsealText(r.media_ref_enc), file: r.media_file };
}

export function saveMedia(numberId: string, id: string, bytes: Buffer): void {
  const file = crypto.createHash("sha256").update(`${numberId}:${id}`).digest("hex").slice(0, 32) + ".bin";
  writeFileSync(join(mediaDir, file), seal(bytes));
  db.prepare("update messages set media_file = ? where number_id = ? and id = ?").run(file, numberId, id);
}

export function loadMedia(file: string): Buffer | null {
  try {
    return unseal(readFileSync(join(mediaDir, file)));
  } catch {
    return null;
  }
}

function removeFile(file: string): void {
  try {
    unlinkSync(join(mediaDir, file));
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

export function prune(cutoffMs: number): number {
  const files = db.prepare("select media_file from messages where ts < ? and media_file is not null").all(cutoffMs) as { media_file: string }[];
  for (const f of files) removeFile(f.media_file);
  const r = db.prepare("delete from messages where ts < ?").run(cutoffMs);
  return Number(r.changes);
}
