// Baileys sessions, copied from whatsapp-vault-mcp, one per linked number. RECEIVE
// ONLY: there is no send function in this service, no presence, no read
// receipts. The lifecycle (epochs, backoff, hard stops, watchdog, clean exit)
// is deliberate; do not loosen it.
//
//   - Only ONE live socket per number; old sockets get their listeners stripped.
//   - Each socket carries an epoch; only the latest epoch's handlers act.
//   - loggedOut / forbidden / multideviceMismatch = HARD STOP, re-scan needed.
//   - Everything else retries forever on a backoff capped at 15 min.
//   - A connection must hold STABLE_AFTER_MS before the backoff resets.
//   - Handlers never touch the socket; their errors are caught and logged.

import { Boom } from "@hapi/boom";
import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  normalizeMessageContent,
  useMultiFileAuthState,
  WAMessage,
  WASocket,
} from "@whiskeysockets/baileys";
import { copyFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import pino from "pino";

// Baileys logs raw packets (addresses, encrypted payloads) next to its
// message. Keep only the message string so logs never carry chat data.
// To stderr: when the helper runs inside the MCP process, stdout is the MCP stream.
const logger = pino(
  {
    level: "warn",
    base: undefined,
    hooks: {
      logMethod(args, method) {
        const text = args.find((a) => typeof a === "string") as string | undefined;
        const err = args.find((a) => a && typeof a === "object" && ((a as any).err || (a as any).error)) as any;
        const code = (err?.err || err?.error)?.output?.statusCode;
        return method.call(this, `[baileys] ${text || "log"}${code ? ` (${code})` : ""}`);
      },
    },
  },
  pino.destination(2),
);

// "off" = WhatsApp is switched off for local tests (WA_OFF=1).
export type Status = "starting" | "qr" | "connected" | "disconnected" | "logged_out" | "off";

// Hooks set by index.ts, so this file knows nothing about storage.
export interface Hooks {
  message(numberId: string, m: WAMessage, history: boolean): Promise<void> | void;
  contacts(numberId: string, list: { id?: string | null; name?: string | null; notify?: string | null; verifiedName?: string | null }[]): void;
  groups(numberId: string, list: { id?: string | null; subject?: string | null }[]): void;
  linked(numberId: string, meJid: string): void;
  // Connected, dropped or logged out. Used for the history page and alerts.
  status?(numberId: string, status: Status, code?: number): void;
}
let hooks: Hooks | null = null;
export function setHooks(h: Hooks) {
  hooks = h;
}

const RECONNECT_DELAYS = [3_000, 10_000, 30_000, 60_000, 120_000, 300_000, 900_000];
const MAX_FAST_RECONNECT_STREAK = 3;
const MAX_REPLACED_ATTEMPTS = 4;
const STABLE_AFTER_MS = 60_000;
// "Connected" is not proof: a socket can stay open while WhatsApp stops
// answering, and then nothing comes in. Ask it something small now and then.
const HEALTH_FIRST_MS = 90_000;
const HEALTH_EVERY_MS = 5 * 60_000;
const HEALTH_TIMEOUT_MS = 20_000;
// A damaged saved login keeps closing with "bad session". After a few in a
// row, a new scan is the only fix, so say so instead of looping.
const BAD_SESSION_LIMIT = 3;
const BAD_SESSION_WINDOW_MS = 2 * 3_600_000;
// On connect the library holds every incoming event until WhatsApp says all
// missed messages are delivered. With a big backlog it asks for one batch of
// 100 only, that signal never comes, and nothing reaches the database (seen in
// a real log: 105 messages held for 5 minutes). Ask for the next batches, and
// if events are still held, release them.
const HOLD_CHECK_MS = 10_000;
const HOLD_ASK_AFTER_MS = 15_000;
const HOLD_MAX_ASKS = 10;
const HOLD_RELEASE_AFTER_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 60_000;

let stopping = false;
let watchdogTimer: NodeJS.Timeout | null = null;

function safe(label: string, fn: () => unknown) {
  Promise.resolve()
    .then(fn)
    .catch((e) => console.error(`[vault] ${label} error:`, e?.message || e));
}

// A power cut while saving can leave the login file half written, which would
// mean scanning again for no reason. Keep a copy from the last good connection.
function restoreLoginIfBroken(authDir: string) {
  const creds = join(authDir, "creds.json");
  const backup = join(authDir, "creds.backup.json");
  if (!existsSync(creds) || !existsSync(backup)) return;
  try {
    JSON.parse(readFileSync(creds, "utf8"));
  } catch {
    console.warn("[vault] login file damaged, restoring the last good copy");
    copyFileSync(backup, creds);
  }
}

function closeSock(sock: WASocket | null) {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("creds.update");
    sock.ev.removeAllListeners("messages.upsert");
    sock.ev.removeAllListeners("messaging-history.set");
    sock.ev.removeAllListeners("contacts.upsert");
    sock.ev.removeAllListeners("contacts.update");
    sock.ev.removeAllListeners("groups.upsert");
    sock.ev.removeAllListeners("groups.update");
  } catch {
    /* ignore */
  }
  try {
    sock.end(undefined);
  } catch {
    /* ignore */
  }
}

export class Session {
  sock: WASocket | null = null;
  qr: string | null = null;
  status: Status = "starting";
  meJid: string | null = null;
  lastConnectedAt: number | null = null;
  lastDisconnectedAt: number | null = null;
  starting = false;
  private epoch = 0;
  private reconnectAttempt = 0;
  private fastReconnectStreak = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private holdTimer: NodeJS.Timeout | null = null;
  private healthFails = 0;
  private badSessions: number[] = [];

  constructor(
    readonly id: string,
    readonly authDir: string,
  ) {}

  private log(msg: string) {
    console.log(`[vault ${this.id}] ${msg}`);
  }

  private clearPendingReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.healthTimer) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.holdTimer) {
      clearInterval(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private watchHeldEvents(sock: WASocket, myEpoch: number) {
    if (this.holdTimer) clearInterval(this.holdTimer);
    const openedAt = Date.now();
    let asks = 0;
    this.holdTimer = setInterval(() => {
      const stop = () => {
        if (this.holdTimer) clearInterval(this.holdTimer);
        this.holdTimer = null;
      };
      if (myEpoch !== this.epoch || !sock.ev.isBuffering()) return stop();
      const age = Date.now() - openedAt;
      if (age >= HOLD_RELEASE_AFTER_MS) {
        console.warn(`[vault ${this.id}] incoming messages were still held after ${Math.round(age / 1000)}s, releasing them`);
        sock.ev.flush();
        return stop();
      }
      if (age >= HOLD_ASK_AFTER_MS && asks < HOLD_MAX_ASKS) {
        asks += 1;
        this.log(`messages still held, asking WhatsApp for the next batch (${asks})`);
        sock.sendNode({ tag: "ib", attrs: {}, content: [{ tag: "offline_batch", attrs: { count: "100" } }] }).catch(() => {});
      }
    }, HOLD_CHECK_MS);
    this.holdTimer.unref();
  }

  // Asks WhatsApp whether our own number exists. Two failures in a row mean
  // the open socket is dead: drop it and connect again.
  private scheduleHealth(sock: WASocket, myEpoch: number, delay: number) {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = setTimeout(async () => {
      this.healthTimer = null;
      if (myEpoch !== this.epoch || this.status !== "connected" || stopping) return;
      const me = (this.meJid || "").split(":")[0].split("@")[0];
      let ok = false;
      try {
        ok = !!me && Array.isArray(await Promise.race([sock.onWhatsApp(me), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), HEALTH_TIMEOUT_MS))]));
      } catch {
        ok = false;
      }
      if (myEpoch !== this.epoch) return;
      this.healthFails = ok ? 0 : this.healthFails + 1;
      if (this.healthFails >= 2) {
        this.healthFails = 0;
        console.warn(`[vault ${this.id}] connected but WhatsApp is not answering, reconnecting`);
        safe("status", () => hooks?.status?.(this.id, "disconnected", 408));
        this.status = "disconnected";
        this.lastDisconnectedAt = Date.now();
        this.start().catch((e) => console.error(`[vault ${this.id}] reconnect failed:`, e?.message || e));
        return;
      }
      this.scheduleHealth(sock, myEpoch, ok ? HEALTH_EVERY_MS : 30_000);
    }, delay);
  }

  // Watchdog: not connected, not waiting for a scan by design, and nothing scheduled.
  get stuck(): boolean {
    return this.status !== "connected" && this.status !== "logged_out" && this.status !== "off" && !this.starting && this.reconnectTimer === null;
  }

  async start(): Promise<void> {
    if (this.starting || stopping) return;
    this.starting = true;
    this.clearPendingReconnect();
    closeSock(this.sock);
    this.sock = null;
    this.epoch += 1;
    const myEpoch = this.epoch;
    const id = this.id;
    const live = () => myEpoch === this.epoch && hooks;

    try {
      restoreLoginIfBroken(this.authDir);
      const { state: authState, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: authState,
        logger,
        browser: ["WhatsApp MCP", "Chrome", "1.0.0"],
        markOnlineOnConnect: false,
        // Recent history only (what a new linked device normally gets). The
        // vault keeps 30 days, so a full-history pull would be wasted work.
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => true,
        // We never send, so there is nothing to hand back on a retry request.
        getMessage: async () => undefined,
        // Status updates, broadcast lists and channels are not chats.
        shouldIgnoreJid: (jid) => !!jid && (jid.endsWith("@broadcast") || jid.endsWith("@newsletter")),
      });
      this.sock = sock;

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("messaging-history.set", ({ messages, contacts, chats }) => {
        if (!live()) return;
        const h = hooks!;
        safe("history names", () => {
          h.contacts(id, contacts || []);
          h.groups(id, (chats || []).filter((c) => c.id?.endsWith("@g.us")).map((c) => ({ id: c.id, subject: c.name })));
          h.contacts(id, (chats || []).filter((c) => c.id && !c.id.endsWith("@g.us")).map((c) => ({ id: c.id, notify: c.name })));
        });
        const list = messages || [];
        this.log(`history chunk: ${list.length} messages`);
        safe("history", async () => {
          for (const m of list) {
            if (!m?.key || !m.message) continue;
            try {
              await h.message(id, m, true);
            } catch (e: any) {
              console.error(`[vault ${id}] history message error:`, e?.message || e);
            }
          }
        });
      });

      sock.ev.on("messages.upsert", ({ messages, type }) => {
        if (!live()) return;
        // notify = live; append = arrived while we were down. Keep both.
        if (type !== "notify" && type !== "append") return;
        const h = hooks!;
        for (const m of messages) {
          if (!m?.key || !m.message) continue;
          safe("message", () => h.message(id, m, false));
        }
      });

      sock.ev.on("contacts.upsert", (list) => {
        if (live()) safe("contacts", () => hooks!.contacts(id, list));
      });
      sock.ev.on("contacts.update", (list) => {
        if (live()) safe("contacts", () => hooks!.contacts(id, list as any));
      });
      sock.ev.on("groups.upsert", (list) => {
        if (live()) safe("groups", () => hooks!.groups(id, list));
      });
      sock.ev.on("groups.update", (list) => {
        if (live()) safe("groups", () => hooks!.groups(id, list as any));
      });

      sock.ev.on("connection.update", (update) => {
        if (myEpoch !== this.epoch) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qr = qr;
          this.status = "qr";
          this.log("QR ready");
        }

        if (connection === "open") {
          this.qr = null;
          this.status = "connected";
          this.lastConnectedAt = Date.now();
          this.meJid = sock.user?.id || null;
          if (this.meJid && hooks) safe("linked", () => hooks!.linked(id, this.meJid!));
          if (this.stableTimer) clearTimeout(this.stableTimer);
          this.stableTimer = setTimeout(() => {
            this.stableTimer = null;
            this.reconnectAttempt = 0;
            this.fastReconnectStreak = 0;
            // Held for a minute, so this login is good. Copy it.
            try {
              copyFileSync(join(this.authDir, "creds.json"), join(this.authDir, "creds.backup.json"));
            } catch (e: any) {
              console.warn(`[vault ${id}] login copy failed: ${e?.message || e}`);
            }
          }, STABLE_AFTER_MS);
          this.log(`connected (epoch ${myEpoch})`);
          this.healthFails = 0;
          this.scheduleHealth(sock, myEpoch, HEALTH_FIRST_MS);
          this.watchHeldEvents(sock, myEpoch);
          safe("status", () => hooks?.status?.(id, "connected"));
          // Group names, once per connection.
          setTimeout(() => {
            if (!live()) return;
            safe("group list", async () => {
              const all = await sock.groupFetchAllParticipating();
              hooks!.groups(id, Object.values(all));
            });
          }, 5_000);
        }

        if (connection === "close") {
          this.lastDisconnectedAt = Date.now();
          if (this.stableTimer) {
            clearTimeout(this.stableTimer);
            this.stableTimer = null;
          }
          const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
          this.handleClose(code, myEpoch);
        }
      });
    } finally {
      this.starting = false;
    }
  }

  private handleClose(code: number | undefined, myEpoch: number) {
    closeSock(this.sock);
    this.sock = null;
    if (stopping) return;

    const hardStop = [DisconnectReason.loggedOut, DisconnectReason.forbidden, DisconnectReason.multideviceMismatch];
    if (code !== undefined && hardStop.includes(code as DisconnectReason)) {
      this.status = "logged_out";
      this.meJid = null;
      this.reconnectAttempt = 0;
      this.fastReconnectStreak = 0;
      console.warn(`[vault ${this.id}] HARD STOP (code ${code}): reset this number and scan again`);
      safe("status", () => hooks?.status?.(this.id, "logged_out", code));
      return;
    }
    if (code === DisconnectReason.badSession) {
      const now = Date.now();
      this.badSessions = this.badSessions.filter((t) => t > now - BAD_SESSION_WINDOW_MS).concat(now);
      if (this.badSessions.length >= BAD_SESSION_LIMIT) {
        this.status = "logged_out";
        this.badSessions = [];
        this.reconnectAttempt = 0;
        this.fastReconnectStreak = 0;
        console.warn(`[vault ${this.id}] saved login looks damaged (bad session ${BAD_SESSION_LIMIT}x): scan again`);
        safe("status", () => hooks?.status?.(this.id, "logged_out", code));
        return;
      }
    }
    if (code === DisconnectReason.connectionReplaced && this.reconnectAttempt >= MAX_REPLACED_ATTEMPTS) {
      this.status = "logged_out";
      this.reconnectAttempt = 0;
      this.fastReconnectStreak = 0;
      console.warn(`[vault ${this.id}] connectionReplaced ${MAX_REPLACED_ATTEMPTS}x, stopping`);
      safe("status", () => hooks?.status?.(this.id, "logged_out", code));
      return;
    }

    const fastCodes = [DisconnectReason.restartRequired, DisconnectReason.timedOut];
    const useFast = code !== undefined && fastCodes.includes(code as DisconnectReason) && this.fastReconnectStreak < MAX_FAST_RECONNECT_STREAK;
    if (useFast) this.fastReconnectStreak += 1;
    else this.fastReconnectStreak = 0;
    const delay = useFast ? 1_000 : RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];

    if (this.status !== "disconnected") safe("status", () => hooks?.status?.(this.id, "disconnected", code));
    this.status = "disconnected";
    this.reconnectAttempt += 1;
    this.log(`disconnected (code ${code}, epoch ${myEpoch}), retry in ${delay / 1000}s`);
    this.clearPendingReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((e) => console.error(`[vault ${this.id}] reconnect failed:`, e?.message || e));
    }, delay);
  }

  // The computer just woke up: the old connection is dead and any long wait
  // was for a problem that may be gone. Reconnect once, now.
  wake(): void {
    if (stopping || this.status === "logged_out" || this.status === "off") return;
    this.reconnectAttempt = 0;
    this.fastReconnectStreak = 0;
    this.start().catch((e) => console.error(`[vault ${this.id}] wake reconnect failed:`, e?.message || e));
  }

  // Close the socket and forget timers. The caller decides what happens next.
  close(): void {
    this.clearPendingReconnect();
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    closeSock(this.sock);
    this.sock = null;
    this.epoch += 1;
    this.reconnectAttempt = 0;
    this.fastReconnectStreak = 0;
  }

  // Unlink from the phone (best effort) and close.
  async logout(): Promise<void> {
    const sock = this.sock;
    if (sock) {
      try {
        await sock.logout();
      } catch {
        /* offline or already unlinked */
      }
    }
    this.close();
    this.qr = null;
    this.meJid = null;
  }

  async groupSubject(jid: string): Promise<string | null> {
    if (!this.sock || this.status !== "connected") return null;
    try {
      return (await this.sock.groupMetadata(jid)).subject || null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// all sessions
// ---------------------------------------------------------------------------

const sessions = new Map<string, Session>();

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function addSession(id: string, authDir: string, run: boolean): Session {
  const s = new Session(id, authDir);
  sessions.set(id, s);
  if (run) s.start().catch((e) => console.error(`[vault ${id}] start failed:`, e?.message || e));
  else s.status = "off";
  return s;
}

export async function dropSession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s) return;
  await s.logout();
  sessions.delete(id);
}

export function wakeAll(): void {
  for (const s of sessions.values()) s.wake();
}

export function startWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    for (const s of sessions.values()) {
      if (!s.stuck) continue;
      console.warn(`[vault ${s.id}] watchdog: stuck in '${s.status}', restarting`);
      s.start().catch((e) => console.error(`[vault ${s.id}] watchdog restart failed:`, e?.message || e));
    }
  }, WATCHDOG_INTERVAL_MS);
}

// Hosts like Railway send SIGTERM on a redeploy: close once, never reconnect,
// so the new container takes the sessions without a fight.
export function shutdownForExit(): void {
  stopping = true;
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  for (const s of sessions.values()) {
    s.close();
    s.status = "disconnected";
  }
}

// ---------------------------------------------------------------------------
// media files
// ---------------------------------------------------------------------------

// Files of image, voice note, video and document messages. `ref` is a message
// serialized with serializeRef below. The size cap is checked before
// downloading when the message says its size, and again after.
const MAX_BYTES: Record<string, number> = {
  image: 15 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  document: 25 * 1024 * 1024,
};
const MB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export async function downloadMedia(ref: string, kind: string, session?: Session): Promise<Buffer> {
  const max = MAX_BYTES[kind] ?? MAX_BYTES.image;
  const size = mediaDetails(ref).bytes;
  if (size && size > max) throw new Error(`${kind} too large (${MB(size)}, limit ${MB(max)})`);
  const m = JSON.parse(ref, BufferJSON.reviver) as WAMessage;
  const sock = session?.sock;
  const buf = (await downloadMediaMessage(m, "buffer", {}, sock ? { logger, reuploadRequest: sock.updateMediaMessage } : ({ logger } as any))) as Buffer;
  if (!buf?.length) throw new Error(`empty ${kind}`);
  if (buf.length > max) throw new Error(`${kind} too large (${MB(buf.length)}, limit ${MB(max)})`);
  return buf;
}

// File type, length and size as the message states them (no download).
export function mediaDetails(ref: string | null): { mime: string | null; seconds: number | null; bytes: number | null; fileName: string | null } {
  const none = { mime: null, seconds: null, bytes: null, fileName: null };
  if (!ref) return none;
  try {
    const m = JSON.parse(ref, BufferJSON.reviver) as WAMessage;
    const content = normalizeMessageContent(m.message ?? undefined);
    const type = content ? getContentType(content) : undefined;
    const media = type ? (content as any)[type] : null;
    if (!media) return none;
    return { mime: media.mimetype || null, seconds: toNum(media.seconds), bytes: toNum(media.fileLength), fileName: media.fileName || null };
  } catch {
    return none;
  }
}

// Protobuf longs arrive as numbers, strings or { low, high } after JSON.
function toNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return Number(v) || null;
  if (typeof v.low === "number") return (v.low >>> 0) + (v.high || 0) * 4294967296;
  return null;
}

export function serializeRef(m: WAMessage): string {
  return JSON.stringify({ key: m.key, message: m.message, messageTimestamp: m.messageTimestamp }, BufferJSON.replacer);
}
