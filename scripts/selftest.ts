// Self-test, no WhatsApp and no real data. Feeds fake messages through the real
// code into a temp folder, then runs the BUILT files the way Claude does: start
// dist/index.mjs, talk MCP over stdio. Also kills the helper and checks that
// it comes back, and that two copies share one helper.
// Phone numbers are UK drama numbers (+44 7700 900xxx), reserved for fiction.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import express from "express";
import type { AddressInfo } from "net";

const home = mkdtempSync(join(tmpdir(), "whatsapp-mcp-test-"));
process.env.WHATSAPP_MCP_HOME = home;
process.env.TIMEZONE = "Asia/Kuala_Lumpur";

const SECRET = "zebra-pineapple-7731"; // must never reach the disk in plain text
const ALAN = "447700900123@s.whatsapp.net";
const key = crypto.randomBytes(32).toString("hex");
const token = crypto.randomBytes(32).toString("hex");
writeFileSync(join(home, "secrets.json"), JSON.stringify({ token, key }));

const { initCrypto } = await import("../src/crypto.js");
const { closeStore, initStore } = await import("../src/store.js");
const { ingest, ingestContacts } = await import("../src/ingest.js");
const { initNumbers } = await import("../src/numbers.js");
const { saveMedia } = await import("../src/store.js");

// A stand-in for Google Gemini, so the voice and video tools run without a real key.
const GOOD_KEY = "example.gemini-key-for-tests-0000";
const gemini = { generate: 0, uploads: 0, deletes: 0, keyInBody: false, sawInline: false, sawFile: false };
const mock = express();
mock.use((req, res, next) => (req.header("x-goog-api-key") === GOOD_KEY ? next() : res.status(400).json({ error: { message: "API key not valid. API_KEY_INVALID" } })));
mock.get("/v1beta/models", (_req, res) => res.json({ models: [] }));
mock.post("/upload/v1beta/files", (req, res) => {
  res.setHeader("x-goog-upload-url", `http://127.0.0.1:${mockPort}/upload/session1`);
  res.json({});
});
mock.post("/upload/session1", express.raw({ type: "*/*", limit: "40mb" }), (req, res) => {
  gemini.uploads += 1;
  res.json({ file: { uri: "https://example.invalid/files/abc", name: "files/abc", state: "ACTIVE" } });
});
mock.delete("/v1beta/files/abc", (_req, res) => {
  gemini.deletes += 1;
  res.json({});
});
mock.post(/^\/v1beta\/models\/(.+):generateContent$/, express.json({ limit: "40mb" }), (req, res) => {
  if (req.params[0] === "gemini-flash-latest") return res.status(404).json({});
  gemini.generate += 1;
  const body = JSON.stringify(req.body);
  if (body.includes(GOOD_KEY)) gemini.keyInBody = true;
  if (body.includes("inline_data")) gemini.sawInline = true;
  if (body.includes("file_data")) gemini.sawFile = true;
  res.json({ candidates: [{ content: { parts: [{ text: "MOCK hello from the voice note" }] } }] });
});
const mockServer = mock.listen(0, "127.0.0.1");
await new Promise((r) => mockServer.once("listening", r));
const mockPort = (mockServer.address() as AddressInfo).port;
process.env.WHATSAPP_MCP_GEMINI_URL = `http://127.0.0.1:${mockPort}`;

// And one for OpenAI (voice notes only).
const OAI_KEY = "example-openai-key-for-tests-0000";
const openai = { calls: 0, model: "" };
const oai = express();
oai.use((req, res, next) => (req.header("authorization") === `Bearer ${OAI_KEY}` ? next() : res.status(401).json({ error: { message: "Incorrect API key" } })));
oai.get("/v1/models", (_req, res) => res.json({ data: [] }));
oai.post("/v1/audio/transcriptions", express.raw({ type: "*/*", limit: "30mb" }), (req, res) => {
  openai.calls += 1;
  openai.model = /name="model"\r\n\r\n([^\r]+)/.exec(req.body.toString("latin1"))?.[1] || "";
  res.json({ text: "OPENAI heard the voice note" });
});
const oaiServer = oai.listen(0, "127.0.0.1");
await new Promise((r) => oaiServer.once("listening", r));
process.env.WHATSAPP_MCP_OPENAI_URL = `http://127.0.0.1:${(oaiServer.address() as AddressInfo).port}`;

initCrypto(key);
const data = join(home, "data");
mkdirSync(data, { recursive: true });
initStore(data);
initNumbers({ authRoot: join(data, "auth"), run: false, max: 1 });
ingestContacts("n1", [{ id: ALAN, name: "Alan Fake" }]);
const now = Math.floor(Date.now() / 1000);
await ingest("n1", { key: { remoteJid: ALAN, id: "A1", fromMe: false }, messageTimestamp: now - 60, pushName: "Alan", message: { conversation: `invoice ${SECRET}` } } as any, false);
await ingest("n1", { key: { remoteJid: ALAN, id: "A2", fromMe: true }, messageTimestamp: now - 30, message: { conversation: "ok noted" } } as any, false);
await ingest("n1", { key: { remoteJid: ALAN, id: "V1", fromMe: false }, messageTimestamp: now - 20, message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 7, ptt: true } } } as any, false);
saveMedia("n1", "V1", Buffer.from("fake voice bytes"));
await ingest("n1", { key: { remoteJid: ALAN, id: "V2", fromMe: false }, messageTimestamp: now - 15, message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 4, ptt: true } } } as any, false);
saveMedia("n1", "V2", Buffer.from("second fake voice"));
await ingest("n1", { key: { remoteJid: ALAN, id: "V3", fromMe: false }, messageTimestamp: now - 12, message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 3, ptt: true } } } as any, false);
saveMedia("n1", "V3", Buffer.from("third fake voice"));

// Documents: a real one-page PDF with text, one without text (like a scan),
// a markdown file and a Word file.
const pdf = (text: string | null) => {
  const stream = text ? `BT /F1 18 Tf 72 720 Td (${text}) Tj ET` : "0 0 1 rg 72 600 200 100 re f";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
};
const doc = async (id: string, fileName: string, mimetype: string, bytes: Buffer, caption = "") => {
  await ingest("n1", { key: { remoteJid: ALAN, id, fromMe: false }, messageTimestamp: now - 5, message: { documentMessage: { mimetype, fileName, caption } } } as any, false);
  saveMedia("n1", id, bytes);
};
const INVOICE_PDF = pdf("Invoice INV-1001 Total RM 350.00");
await doc("D1", "INV-1001.pdf", "application/pdf", INVOICE_PDF, "October bill");
await doc("D2", "scan.pdf", "application/pdf", pdf(null));
await doc("D3", "notes.md", "text/markdown", Buffer.from("# Meeting\n- pay invoice by Friday\n"));
await doc("D4", "quote.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK fake docx"));
await ingest("n1", { key: { remoteJid: ALAN, id: "VID1", fromMe: false }, messageTimestamp: now - 10, message: { videoMessage: { mimetype: "video/mp4", seconds: 30 } } } as any, false);
saveMedia("n1", "VID1", Buffer.alloc(16 * 1024 * 1024, 7));
closeStore();

const downloads = join(home, "downloads-test");
const env = { ...process.env, WA_OFF: "1", WHATSAPP_MCP_NO_BROWSER: "1", WHATSAPP_MCP_NO_ALERTS: "1", WHATSAPP_MCP_DOWNLOADS: downloads, WHATSAPP_MCP_FAKE_SEND: "1", WHATSAPP_MCP_SEND_GAP_MS: "400" } as Record<string, string>;
const open = async () => {
  const client = new Client({ name: "selftest", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/stage/dist/index.mjs"], env, stderr: "ignore" }));
  return client;
};
const text = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  return r.content.map((x: any) => x.text).join("\n") as string;
};
const helperInfo = () => JSON.parse(readFileSync(join(home, "helper.json"), "utf8"));

let passed = false;
try {
  const a = await open();

  const tools = (await a.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["connect_whatsapp", "get_image", "list_chats", "open_settings_page", "read_chat", "read_file", "save_file", "save_files", "search", "send_message", "status", "transcribe_voice", "watch_video"], "tool list");
  assert.deepEqual(tools.filter((t) => /send|reply|delete|forward/i.test(t)), ["send_message"], "send_message is the only tool that can send");
  console.log("tools: ok");

  assert.match(await text(a, "status"), /test mode/, "status in plain words");
  assert.match(await text(a, "list_chats"), /Alan Fake/, "contact name");
  assert.match(await text(a, "read_chat", { chat: "Alan" }), new RegExp(SECRET), "read a chat");
  assert.match(await text(a, "search", { query: "invoice" }), /1 match/, "search");
  assert.match(await text(a, "connect_whatsapp"), /\/link\//, "connect gives the QR page");
  console.log("reading: ok");

  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(home)) assert.ok(!readFileSync(f).includes(SECRET), `plain text in ${f}`);
  console.log("no plain text on disk: ok");

  const { port, pid } = helperInfo();
  assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" })).status, 401, "mcp needs the token");
  assert.equal((await fetch(`http://127.0.0.1:${port}/link/wrongkey`)).status, 404, "QR page needs its key");
  const page = (await text(a, "connect_whatsapp")).match(/http:\/\/127\.0\.0\.1:\d+(\/link\/[0-9a-f]+)/)!;
  assert.equal((await fetch(page[0])).status, 200, "QR page opens");
  assert.equal((await (await fetch(`${page[0]}/state`)).json()).status, "off", "QR page state");
  console.log("guards: ok");

  const panel = (await text(a, "open_settings_page")).match(/http:\/\/127\.0\.0\.1:\d+\/link\/[0-9a-f]+\/panel/)!;
  assert.ok(panel, "settings tool gives the page");
  assert.equal((await fetch(panel[0])).status, 200, "settings page opens");
  const pbase = panel[0].replace(/\/panel$/, "");
  const info = await (await fetch(`${pbase}/info`)).json();
  assert.equal(info.settings.keepDays, 30, "default keep days");
  assert.ok(info.events.some((e: any) => e.kind === "helper_started"), "history records a start");
  assert.ok(!JSON.stringify(info).includes(SECRET), "no message text on the settings page");
  const postJson = (p: string, body: unknown) => fetch(`${pbase}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${pbase}/settings`, { method: "POST", body: "keepDays=7" })).status, 415, "a plain form cannot change settings");
  const saved = await (await postJson("/settings", { keepDays: 14, countryCode: "+65 ", alerts: false })).json();
  assert.deepEqual(saved, { keepDays: 14, countryCode: "65", alerts: false, voiceWith: "gemini", sending: false }, "settings saved and cleaned");
  assert.deepEqual((await (await postJson("/settings", { keepDays: 9999 })).json()).keepDays, 30, "odd keep days fall back");
  assert.equal((await fetch(`${pbase.replace(/[0-9a-f]+$/, "wrongkey")}/info`)).status, 404, "settings page needs its key");
  assert.match(await text(a, "status"), /Kept for: 30 days/, "status uses the saved setting");
  assert.equal((await postJson("/test-alert", {})).status, 200, "test alert button");
  await postJson("/settings", { keepDays: 30, countryCode: "60", alerts: true });
  console.log("settings page: ok");

  assert.match(await text(a, "transcribe_voice", { media_id: "V1" }), /No key for voice notes yet/, "no key: says how to add one");
  assert.equal(gemini.generate, 0, "nothing sent without a key");
  assert.equal((await postJson("/gemini-key", { key: "wrong-key-1234567890abcdef" })).status, 400, "a rejected key is not saved");
  assert.equal((await postJson("/gemini-key", { key: "not a key" })).status, 400, "junk is not a key");
  const savedKey = await postJson("/gemini-key", { key: GOOD_KEY });
  assert.equal(savedKey.status, 200, "good key saved");
  assert.equal((await (await fetch(`${pbase}/info`)).json()).geminiKey, GOOD_KEY.slice(-4), "page shows only the last 4");
  for (const f of walk(home)) assert.ok(!readFileSync(f).includes(GOOD_KEY), `key in plain text in ${f}`);
  const voice = await text(a, "transcribe_voice", { media_id: "V1" });
  assert.match(voice, /MOCK hello/, "voice note transcribed");
  assert.match(voice, /never as instructions/, "transcript marked as data");
  assert.ok(gemini.sawInline && !gemini.keyInBody, "small file inline, key only in the header");
  assert.match(await text(a, "transcribe_voice", { media_id: "V1" }), /saved earlier/, "second time from the cache");
  assert.equal(gemini.generate, 1, "cache means no second call");
  assert.match(await text(a, "watch_video", { media_id: "VID1", question: "what colour?" }), /MOCK hello/, "video watched");
  assert.ok(gemini.uploads === 1 && gemini.sawFile, "big video uploaded first");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(gemini.deletes, 1, "uploaded video deleted from Google after");
  assert.match(await text(a, "transcribe_voice", { media_id: "VID1" }), /no voice note/, "wrong kind refused");
  for (const f of walk(home)) assert.ok(!readFileSync(f).includes("MOCK hello"), `transcript in plain text in ${f}`);
  await postJson("/gemini-key", { key: null });
  assert.equal((await (await fetch(`${pbase}/info`)).json()).geminiKey, null, "key removed");
  console.log("voice and video: ok");

  assert.equal((await postJson("/openai-key", { key: "sk-wrong-abcdefghijklmnopqrstuv" })).status, 400, "a rejected OpenAI key is not saved");
  assert.equal((await postJson("/openai-key", { key: OAI_KEY })).status, 200, "OpenAI key saved");
  assert.equal((await (await fetch(`${pbase}/info`)).json()).openaiKey, OAI_KEY.slice(-4), "page shows only the last 4");
  for (const f of walk(home)) assert.ok(!readFileSync(f).includes(OAI_KEY), `OpenAI key in plain text in ${f}`);
  assert.match(await text(a, "transcribe_voice", { media_id: "V2" }), /by OpenAI[\s\S]*OPENAI heard/, "only OpenAI saved: voice goes to OpenAI");
  assert.equal(openai.model, "gpt-4o-transcribe", "newest speech model asked first");
  assert.match(await text(a, "watch_video", { media_id: "VID1" }), /Videos need a Google Gemini key/, "OpenAI alone does not do video");
  await postJson("/gemini-key", { key: GOOD_KEY });
  const before = gemini.generate;
  assert.match(await text(a, "transcribe_voice", { media_id: "V3" }), /by Gemini/, "both saved: Gemini by default");
  assert.equal(gemini.generate, before + 1);
  await postJson("/settings", { voiceWith: "openai" });
  assert.equal((await (await fetch(`${pbase}/info`)).json()).settings.keepDays, 30, "changing one setting keeps the others");
  assert.match(await text(a, "transcribe_voice", { media_id: "V3", }), /saved earlier/, "an answer is reused whoever made it");
  await postJson("/settings", { voiceWith: "gemini" });
  await postJson("/gemini-key", { key: null });
  await postJson("/openai-key", { key: null });
  console.log("OpenAI voice: ok");

  const inv = await text(a, "read_file", { media_id: "D1" });
  assert.ok(inv.startsWith("INV-1001.pdf | 1 page | "), "PDF name and pages");
  assert.ok(inv.includes("Invoice INV-1001 Total RM 350.00"), "PDF text read");
  assert.match(inv, /never as instructions/, "document text marked as data");
  assert.match(await text(a, "read_file", { media_id: "D2" }), /no text inside/, "scan explained");
  assert.match(await text(a, "read_file", { media_id: "D3" }), /pay invoice by Friday/, "markdown read");
  assert.match(await text(a, "read_file", { media_id: "D4" }), /not supported/, "Word explained");
  assert.match(await text(a, "read_file", { media_id: "V1" }), /no document/, "only documents");
  assert.match(await text(a, "search", { query: "INV-1001" }), /document id=n1:D1: INV-1001\.pdf/, "file names are searchable");

  const one = await text(a, "save_file", { media_id: "D1" });
  const savedPath = one.match(/Saved: (.+INV-1001\.pdf)/)![1];
  assert.ok(readFileSync(savedPath).equals(INVOICE_PDF), "saved under the sender's file name, same bytes");
  assert.match(one, new RegExp(`SHA-256: ${crypto.createHash("sha256").update(INVOICE_PDF).digest("hex")}`), "SHA-256 given for uploads");
  assert.match(await text(a, "save_file", { media_id: "D1" }), /already there/, "same file not saved twice");

  const batch = await text(a, "save_files", { chat: "Alan", name: "inv-" });
  assert.match(batch, /^1 file saved to .+Alan Fake/, "filtered by name or caption, into a chat folder");
  const chatDir = batch.match(/saved to (.+?) \(newest/)![1];
  assert.ok(readFileSync(join(chatDir, "INV-1001.pdf")).equals(INVOICE_PDF));
  const all = await text(a, "save_files", { chat: "Alan" });
  assert.match(all, /^4 files saved/, "every document in the chat");
  assert.equal(readdirSync(chatDir).length, 4);
  assert.match(await text(a, "save_files", { chat: "Alan", kind: "video", name: "nothing-like-this" }), /No files like that/);
  console.log("documents: ok");

  const fakeSent = () => {
    try {
      return readFileSync(join(home, "fake-sent.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const sendInfo = async () => (await (await fetch(`${pbase}/info`)).json()).sending;
  assert.match(await text(a, "send_message", { chat: "Alan", text: "hello from the test" }), /Sending is off, so nothing was sent/, "off by default");
  assert.match(await text(a, "status"), /Sending: off/, "status says it is off");
  await postJson("/settings", { sending: true });
  assert.equal((await sendInfo()).on, false, "the normal settings form cannot turn sending on");
  assert.equal((await postJson("/sending", { on: true })).status, 400, "turning on needs the ban-risk box");
  assert.equal((await (await postJson("/sending", { on: true, acceptRisk: true })).json()).on, true, "on after accepting the risk");
  assert.match(await text(a, "send_message", { chat: "Alan", text: "hello from the test" }), /Queued for Alan Fake/, "queued");
  assert.match(await text(a, "send_message", { chat: "Nobody Like This", text: "hi" }), /No chat|no chat|not found/i, "only existing chats");
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(fakeSent().map((m) => [m.to, m.text]), [[ALAN, "hello from the test"]], "sent once, to the right chat, with the right text");
  assert.equal((await sendInfo()).lastDay, 1, "the page counts it");
  await text(a, "send_message", { chat: "Alan", text: "second" });
  await text(a, "send_message", { chat: "Alan", text: "third" });
  await new Promise((r) => setTimeout(r, 2500));
  const sent = fakeSent();
  assert.equal(sent.length, 3, "all three sent");
  assert.ok(sent[2].at - sent[1].at >= 400 && sent[1].at - sent[0].at >= 400, "never two at once: a gap between sends");
  await text(a, "send_message", { chat: "Alan", text: "fourth" });
  await text(a, "send_message", { chat: "Alan", text: "fifth" });
  const stopped = await (await postJson("/sending", { on: false })).json();
  assert.ok(stopped.cancelled >= 1 && stopped.on === false, "turning off stops what is waiting");
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!fakeSent().some((m) => m.text === "fifth"), "a stopped message never goes out");
  assert.match(await text(a, "send_message", { chat: "Alan", text: "after off" }), /Sending is off/, "off again");
  for (const f of walk(home).filter((p) => !p.endsWith("fake-sent.jsonl"))) assert.ok(!readFileSync(f).includes("hello from the test"), `sent text in plain text in ${f}`);
  console.log("sending: ok");

  const b = await open();
  assert.match(await text(b, "status"), /test mode/);
  assert.equal(helperInfo().pid, pid, "a second copy shares the one helper");
  console.log("one helper: ok");

  process.kill(pid);
  await new Promise((r) => setTimeout(r, 500));
  assert.match(await text(a, "search", { query: "invoice" }), /1 match/, "works again after the helper was killed");
  assert.notEqual(helperInfo().pid, pid, "a new helper started");
  console.log("helper comes back: ok");

  const again = helperInfo();
  await a.close();
  await b.close();
  await new Promise((r) => setTimeout(r, 500));
  process.kill(again.pid, 0); // throws if the helper died with Claude
  assert.ok((await fetch(`http://127.0.0.1:${again.port}/health`)).ok);
  console.log("helper survives Claude closing: ok");

  await fetch(`http://127.0.0.1:${again.port}/quit`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  await new Promise((r) => setTimeout(r, 1_200));

  // Claude Desktop's built-in runtime: the helper runs inside the MCP process.
  env.WHATSAPP_MCP_FORCE_INPROCESS = "1";
  const c = await open();
  assert.match(await text(c, "search", { query: "invoice" }), /1 match/, "works with the helper inside the MCP process");
  assert.equal((await c.listTools()).tools.length, 13);
  await c.close();
  await new Promise((r) => setTimeout(r, 800));
  delete env.WHATSAPP_MCP_FORCE_INPROCESS;
  const d = await open(); // the first process died hard and left its lock behind
  assert.match(await text(d, "search", { query: "invoice" }), /1 match/, "a stale lock does not block the next start");
  const last = helperInfo();
  await d.close();
  await fetch(`http://127.0.0.1:${last.port}/quit`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  await new Promise((r) => setTimeout(r, 1_200));
  console.log("helper inside MCP, stale lock: ok");
  passed = true;
} finally {
  try {
    const p = helperInfo().pid;
    if (!passed) process.kill(p);
  } catch {
    /* already gone */
  }
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // a helper still holding a file must not hide the real failure
    console.error(`could not remove ${home}`);
  }
}
mockServer.close();
oaiServer.close();
console.log("ALL PASSED");
