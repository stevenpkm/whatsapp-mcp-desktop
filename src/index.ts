// What Claude starts. A small pipe: MCP messages in on stdin, passed to the
// background helper (helper.ts), answers out on stdout. No WhatsApp code here,
// so it starts at once and many copies can run side by side.
//
// Nothing else may ever go to stdout: it would break the MCP stream.

import { spawn } from "child_process";
import { appendFileSync, mkdirSync, openSync } from "fs";
import { dirname, join } from "path";
import { createInterface } from "readline";
import { fileURLToPath, pathToFileURL } from "url";
import { HOME, LOG_FILE, loadSecrets, readHelperInfo, VERSION } from "./paths.js";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "helper.mjs");
const START_WAIT_MS = 15_000;

mkdirSync(HOME, { recursive: true });
const { token } = loadSecrets();
const authHeaders = { authorization: `Bearer ${token}` };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function healthyPort(): Promise<{ port: number; version: string } | null> {
  const info = readHelperInfo();
  if (!info) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(2_000) });
    if (r.ok) return { port: info.port, version: (await r.json()).version };
  } catch {
    /* not running */
  }
  return null;
}

// Under Claude Desktop's built-in runtime this program is the app itself, and
// starting it again could open another Claude. So there the helper runs inside
// this process: it stops when Claude closes, but it can never pop up a window.
const CAN_SPAWN = !process.versions.electron && !process.env.WHATSAPP_MCP_FORCE_INPROCESS;

function spawnHelper() {
  const log = openSync(LOG_FILE, "a");
  spawn(process.execPath, [HELPER], { detached: true, stdio: ["ignore", log, log], windowsHide: true }).unref();
}

appendFileSync(LOG_FILE, `[mcp] ${new Date().toISOString()} ${VERSION} node ${process.version} electron ${process.versions.electron ?? "no"} separate-helper ${CAN_SPAWN} ${process.platform}\n`);

async function waitForHelper(ms: number): Promise<number | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const h = await healthyPort();
    if (h && h.version === VERSION) return h.port;
    await sleep(300);
  }
  return null;
}

let starting: Promise<number> | null = null;

function ensureHelper(): Promise<number> {
  starting ??= (async () => {
    const running = await healthyPort();
    if (running?.version === VERSION) return running.port;
    if (running) {
      // An older version is still running after an update.
      const info = readHelperInfo();
      await fetch(`http://127.0.0.1:${info?.port}/quit`, { method: "POST", headers: authHeaders }).catch(() => {});
      await sleep(1_500);
    }
    let port: number | null = null;
    if (CAN_SPAWN) {
      try {
        spawnHelper();
      } catch (e: any) {
        console.error("[mcp] could not start the helper:", e?.message || e);
      }
      port = await waitForHelper(START_WAIT_MS);
      if (port) return port;
      console.error("[mcp] helper did not start on its own");
    }
    // stdout belongs to MCP, so the helper's logs must not reach it.
    console.log = console.error;
    process.env.WHATSAPP_MCP_INPROCESS = "1";
    await import(pathToFileURL(HELPER).href);
    port = await waitForHelper(START_WAIT_MS);
    if (!port) throw new Error("the WhatsApp helper could not start");
    return port;
  })().finally(() => {
    starting = null;
  });
  return starting;
}

async function post(port: number, line: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: line,
  });
}

function reply(text: string) {
  process.stdout.write(`${JSON.stringify(JSON.parse(text))}\n`);
}

async function forward(line: string) {
  let id: unknown = null;
  try {
    id = JSON.parse(line).id ?? null;
    let res: Response;
    try {
      res = await post(await ensureHelper(), line);
    } catch {
      // The helper went away between two calls. Start it and try once more.
      await sleep(500);
      res = await post(await ensureHelper(), line);
    }
    const text = await res.text();
    if (text.trim()) reply(text);
  } catch (e: any) {
    console.error("[mcp] request failed:", e?.message || e);
    if (id !== null) reply(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "The WhatsApp helper is not running. Close and reopen Claude, then try again." } }));
  }
}

// Start the helper as soon as Claude starts us, not only on the first question,
// so messages come in from the moment Claude is open.
ensureHelper().catch((e) => console.error("[mcp] helper start failed:", e?.message || e));

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim()) void forward(line);
});
rl.on("close", () => process.exit(0));
