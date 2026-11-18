// The background helper: holds the one WhatsApp connection and the database.
// index.ts starts it and it keeps running after Claude closes, so messages
// keep coming in until the computer shuts down. Listens on 127.0.0.1 only, on
// a free port picked by the system, so there is no port to open or to clash.
//
// Endpoints:
//   GET  /health            { ok, version } (no auth, no data)
//   GET  /link/:key         the QR page (key in the link, local Host only)
//   GET  /link/:key/state   what that page polls
//   GET  /link/:key/panel   the settings page, which polls .../info and
//                           posts to .../settings, /reconnect, /connect, /test-alert
//   POST /mcp               MCP, stateless (auth)
//   POST /quit              stop this helper (auth), used on an update

import "./quiet-console.js";
import crypto from "crypto";
import express from "express";
import qrcode from "qrcode";
import { spawn } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "fs";
import type { AddressInfo } from "net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initCrypto, sameSecret } from "./crypto.js";
import { chatSummaries, initStore, listNumbers, prune, stats } from "./store.js";
import { ingest, ingestContacts, ingestGroups, ingestLinked, setRetentionDays } from "./ingest.js";
import { getSession, setHooks, shutdownForExit, startWatchdog, wakeAll } from "./whatsapp.js";
import { allNumbers, initNumbers, resetNumber } from "./numbers.js";
import { buildMcpServer } from "./mcp.js";
import { setCountryCode } from "./chats.js";
import { addEvent, ALERT_AFTER_MS, listEvents, loadSettings, notify, saveSettings } from "./panel.js";
import { panelPage } from "./panel-page.js";
import { geminiKeyHint, pruneMediaText, saveGeminiKey } from "./gemini.js";
import { openaiKeyHint, saveOpenAIKey } from "./openai.js";
import { cancelAll, counts, initSender, LIMITS } from "./sender.js";
import { AUTH_DIR, DATA_DIR, HELPER_FILE, HOME, LOCK_FILE, LOG_FILE, readHelperInfo, loadSecrets, VERSION } from "./paths.js";
import { linkPage } from "./link-page.js";

const WA_OFF = process.env.WA_OFF === "1";
const WAKE_CHECK_MS = 30_000;
const WAKE_GAP_MS = 120_000;
const SELF_CHECK_MS = 600_000;
const LOG_LIMIT = 2 * 1024 * 1024;

mkdirSync(HOME, { recursive: true });

// Only one helper per computer: two would fight over the same WhatsApp login.
async function takeLock(): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      if (await otherHelperAlive()) return false;
      rmSync(LOCK_FILE, { force: true });
    }
  }
  return false;
}

// A lock can be left behind by a crash or a power cut. It counts only if its
// process is alive and it is either answering or has only just started.
async function otherHelperAlive(): Promise<boolean> {
  let pid = 0;
  try {
    pid = Number(readFileSync(LOCK_FILE, "utf8"));
    process.kill(pid, 0);
  } catch (e: any) {
    if (e?.code !== "EPERM") return false;
  }
  const info = readHelperInfo();
  if (info?.pid === pid) {
    try {
      if ((await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return true;
    } catch {
      /* not answering */
    }
  }
  return Date.now() - statSync(LOCK_FILE).mtimeMs < 30_000;
}

if (!(await takeLock())) {
  console.log("[helper] another helper is running, exiting");
  // Inside Claude's own process (see index.ts) exiting would end the MCP too.
  if (!process.env.WHATSAPP_MCP_INPROCESS) process.exit(0);
} else {
  start();
}

function start() {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_LIMIT) writeFileSync(LOG_FILE, "");
  } catch {
    /* a log is never worth failing over */
  }

  const { token, key } = loadSecrets();
  const linkKey = crypto.randomBytes(16).toString("hex");

  initCrypto(key);
  initStore(DATA_DIR);
  let settings = loadSettings();
  setRetentionDays(settings.keepDays);
  setCountryCode(settings.countryCode);
  addEvent("helper_started");
  initSender(() => settings.sending);

  // A drop that fixes itself within a few minutes (sleep, a wifi blip) is
  // normal. Alert only when it lasts, or when a new scan is needed.
  let alertTimer: NodeJS.Timeout | null = null;
  let alerted = false;
  const panelUrl = () => `http://127.0.0.1:${port}/link/${linkKey}/panel`;
  function alert(title: string, body: string) {
    if (!settings.alerts) return;
    alerted = true;
    notify(title, body, panelUrl());
  }
  function onStatus(_id: string, status: string, code?: number) {
    addEvent(status as "connected" | "disconnected" | "logged_out", code);
    if (alertTimer) clearTimeout(alertTimer);
    alertTimer = null;
    if (status === "connected") {
      if (alerted) alert("WhatsApp is back", "Connected again, all good.");
      alerted = false;
    } else if (status === "logged_out") {
      alert("WhatsApp needs a new scan", "The link was removed on the phone or by WhatsApp. Click to open the settings page.");
    } else if (status === "disconnected") {
      alertTimer = setTimeout(() => {
        alertTimer = null;
        if (firstSession().session?.status !== "connected") alert("WhatsApp is disconnected", "Down for 3 minutes. It keeps retrying by itself. Click to see the status.");
      }, ALERT_AFTER_MS);
      alertTimer.unref();
    }
  }
  // Messages sent while this was off come in right after it connects again.
  // Count them for the history, so a gap that was caught up is visible.
  let catchUp: { since: number; n: number; timer: NodeJS.Timeout } | null = null;
  const CATCH_UP_MS = 120_000;
  function startCatchUp() {
    if (catchUp) clearTimeout(catchUp.timer);
    const c = { since: Date.now(), n: 0, timer: setTimeout(() => {
      if (c.n) addEvent("caught_up", undefined, c.n);
      console.log(`[helper] caught up ${c.n} message(s) from while it was off`);
      if (catchUp === c) catchUp = null;
    }, CATCH_UP_MS) };
    c.timer.unref();
    catchUp = c;
  }
  const countingIngest: typeof ingest = (numberId, m, history) => {
    const ts = Number(m.messageTimestamp || 0) * 1000;
    if (catchUp && !history && ts && ts < catchUp.since - 5_000) catchUp.n += 1;
    return ingest(numberId, m, history);
  };
  setHooks({ message: countingIngest, contacts: ingestContacts, groups: ingestGroups, linked: ingestLinked, status: (id, status, code) => {
    if (status === "connected") startCatchUp();
    onStatus(id, status, code);
  } });
  initNumbers({ authRoot: AUTH_DIR, run: !WA_OFF, max: 1 });

  const runPrune = () => {
    try {
      prune(Date.now() - settings.keepDays * 86_400_000);
      pruneMediaText(Date.now() - settings.keepDays * 86_400_000);
    } catch (e: any) {
      console.error("[helper] retention failed:", e?.message || e);
    }
  };
  runPrune();
  setInterval(runPrune, 3_600_000).unref();

  const firstSession = () => {
    const id = listNumbers()[0]?.id;
    return { id, session: id ? getSession(id) : undefined };
  };

  let port = 0;

  function openLinkPage(url: string) {
    if (process.env.WHATSAPP_MCP_NO_BROWSER) return;
    const [cmd, args] =
      process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(cmd as string, args as string[], { detached: true, stdio: "ignore", windowsHide: true })
      .on("error", (e) => console.error("[helper] could not open the browser:", e.message))
      .unref();
  }

  // Get a QR ready: a link that was removed needs a fresh start first.
  async function prepareLink(startOver: boolean): Promise<string | null> {
    const { id, session } = firstSession();
    if (!id) throw new Error("no number");
    if (startOver || session?.status === "logged_out") await resetNumber(id);
    else if (session?.status === "connected") {
      const me = allNumbers()[0];
      return `Already connected${me?.phone ? ` as +${me.phone}` : ""}. Nothing to scan.`;
    }
    return null;
  }

  // What the connect_whatsapp tool does.
  async function connect(startOver: boolean): Promise<string> {
    const already = await prepareLink(startOver);
    if (already) return already;
    const url = `http://127.0.0.1:${port}/link/${linkKey}`;
    openLinkPage(url);
    return `The QR page is open in the browser (if not, open ${url}). On the phone: WhatsApp > Settings > Linked Devices > Link a Device, then scan. The page refreshes the QR by itself and says when it is connected. Do not show the QR as an image in chat, it expires in about 20 seconds.`;
  }

  // What the open_settings_page tool does.
  function openPanel(): string {
    openLinkPage(panelUrl());
    return `The settings page is open in the browser (if not, open ${panelUrl()}). It shows whether WhatsApp is connected, the drops of the last 7 days, and settings: how many days to keep messages, the phone country code, and desktop alerts when WhatsApp stays disconnected.`;
  }

  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  // A web page on another site must not be able to reach this through a
  // look-alike address, and the key stops anything that only guesses the port.
  const pageGuard: express.RequestHandler = (req, res, next) => {
    const localHost = req.hostname === "127.0.0.1" || req.hostname === "localhost";
    if (!localHost || !sameSecret(String(req.params.key), linkKey)) {
      res.status(404).end();
      return;
    }
    next();
  };

  app.get("/link/:key", pageGuard, (_req, res) => {
    res.type("html").send(linkPage());
  });

  app.get("/link/:key/state", pageGuard, async (_req, res) => {
    const { session } = firstSession();
    const status = session?.status ?? "starting";
    const svg = session?.qr ? await qrcode.toString(session.qr, { type: "svg", margin: 1 }) : null;
    res.json({ status, svg, phone: allNumbers()[0]?.phone ?? null });
  });

  app.get("/link/:key/panel", pageGuard, (_req, res) => {
    res.type("html").send(panelPage());
  });

  app.get("/link/:key/info", pageGuard, (_req, res) => {
    const n = allNumbers()[0];
    const s = stats();
    const chats = chatSummaries();
    const groups = chats.filter((c) => c.chat_jid.endsWith("@g.us")).length;
    res.json({
      version: VERSION,
      status: n?.status ?? "starting",
      phone: n?.phone ?? null,
      lastConnectedAt: n?.lastConnectedAt ?? null,
      lastDisconnectedAt: n?.lastDisconnectedAt ?? null,
      messages: s.messages,
      chats: n?.chats ?? 0,
      groups,
      directChats: chats.length - groups,
      oldest: s.oldest,
      newest: s.newest,
      settings,
      geminiKey: geminiKeyHint(),
      openaiKey: openaiKeyHint(),
      sending: { on: settings.sending, limits: LIMITS, ...counts() },
      events: listEvents(),
      home: HOME,
      alertAfterMin: ALERT_AFTER_MS / 60_000,
    });
  });

  // JSON only: a plain form on another site can never post here.
  const needJson: express.RequestHandler = (req, res, next) => (req.is("application/json") ? next() : void res.status(415).end());
  const jsonBody = express.json({ limit: "4kb" });

  app.post("/link/:key/settings", pageGuard, needJson, jsonBody, (req, res) => {
    const before = settings.keepDays;
    const b = req.body || {};
    const input = Object.fromEntries(["keepDays", "countryCode", "alerts", "voiceWith"].filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
    settings = saveSettings(input);
    setRetentionDays(settings.keepDays);
    setCountryCode(settings.countryCode);
    if (settings.keepDays < before) runPrune();
    console.log(`[helper] settings saved: keep ${settings.keepDays} days, alerts ${settings.alerts ? "on" : "off"}`);
    res.json(settings);
  });

  app.post("/link/:key/gemini-key", pageGuard, needJson, jsonBody, async (req, res) => {
    const key = typeof req.body?.key === "string" ? req.body.key : null;
    try {
      await saveGeminiKey(key);
      console.log(`[helper] gemini key ${key ? "saved" : "removed"}`);
      res.json({ geminiKey: geminiKeyHint() });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "could not save the key" });
    }
  });

  app.post("/link/:key/openai-key", pageGuard, needJson, jsonBody, async (req, res) => {
    const key = typeof req.body?.key === "string" ? req.body.key : null;
    try {
      await saveOpenAIKey(key);
      console.log(`[helper] openai key ${key ? "saved" : "removed"}`);
      res.json({ openaiKey: openaiKeyHint() });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "could not save the key" });
    }
  });

  // Turning sending on needs the person to tick the ban-risk box on the page.
  app.post("/link/:key/sending", pageGuard, needJson, jsonBody, (req, res) => {
    const on = req.body?.on === true;
    if (on && req.body?.acceptRisk !== true) {
      res.status(400).json({ error: "Tick the box to accept the ban risk first." });
      return;
    }
    settings = saveSettings({ sending: on });
    const cancelled = on ? 0 : cancelAll();
    console.log(`[helper] sending turned ${on ? "on" : "off"}`);
    res.json({ on: settings.sending, cancelled });
  });

  app.post("/link/:key/outbox-clear", pageGuard, needJson, (_req, res) => {
    res.json({ cancelled: cancelAll() });
  });

  app.post("/link/:key/reconnect", pageGuard, needJson, (_req, res) => {
    console.log("[helper] reconnect asked from the settings page");
    if (!WA_OFF) wakeAll();
    res.json({ ok: true });
  });

  app.post("/link/:key/connect", pageGuard, needJson, async (_req, res) => {
    try {
      await prepareLink(false);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "failed" });
    }
  });

  app.post("/link/:key/test-alert", pageGuard, needJson, (_req, res) => {
    notify("WhatsApp MCP test alert", "Alerts work. You will see one like this if WhatsApp stays disconnected.", panelUrl());
    res.json({ ok: true });
  });

  app.use((req, res, next) => {
    const h = req.header("authorization") || "";
    const provided = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!provided || !sameSecret(provided, token)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  app.post("/quit", (_req, res) => {
    res.json({ ok: true });
    shutdown("quit");
  });

  app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
    const server = buildMcpServer(settings.keepDays, connect, openPanel);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e: any) {
      console.error("[helper] mcp error:", e?.message || e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[helper] http error:", err?.message || err);
    if (!res.headersSent) res.status(err?.status === 413 ? 413 : 500).json({ error: "request failed" });
  });

  const http = app.listen(0, "127.0.0.1", () => {
    port = (http.address() as AddressInfo).port;
    writeFileSync(HELPER_FILE, JSON.stringify({ pid: process.pid, port, version: VERSION }));
    console.log(`[helper] ${VERSION} listening on 127.0.0.1:${port}${WA_OFF ? " (WhatsApp off)" : ""}`);
  });

  if (!WA_OFF) startWatchdog();

  // After sleep the old connection is dead but nothing has noticed yet. A long
  // gap between two ticks means the computer was asleep: reconnect right away.
  let lastTick = Date.now();
  setInterval(() => {
    const gap = Date.now() - lastTick;
    lastTick = Date.now();
    if (gap > WAKE_GAP_MS && !WA_OFF) {
      console.log(`[helper] awake after ${Math.round(gap / 1000)}s, reconnecting`);
      wakeAll();
    }
  }, WAKE_CHECK_MS).unref();

  // The extension was removed: its files are gone, so stop too.
  const self = process.argv[1];
  setInterval(() => {
    if (self && !existsSync(self) && !process.env.WHATSAPP_MCP_INPROCESS) shutdown("extension removed");
  }, SELF_CHECK_MS).unref();

  let stopping = false;
  function shutdown(why: string) {
    if (stopping) return;
    stopping = true;
    console.log(`[helper] stopping: ${why}`);
    try {
      shutdownForExit();
    } catch {
      /* exiting anyway */
    }
    rmSync(HELPER_FILE, { force: true });
    rmSync(LOCK_FILE, { force: true });
    setTimeout(() => process.exit(0), 800).unref();
  }

  process.on("unhandledRejection", (e: any) => console.error("[helper] unhandled rejection:", e?.message || e));
  process.on("uncaughtException", (e: any) => console.error("[helper] uncaught exception:", e?.message || e));
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => shutdown(sig));
}
