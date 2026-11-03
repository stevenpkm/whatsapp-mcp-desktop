// Voice notes and videos, understood by Google Gemini with the person's own
// API key. Claude cannot hear audio or watch video, so this turns them into
// text. Nothing is sent anywhere until a key is saved on the settings page.
// The key is sealed on disk, never logged, and only ever sent to Google.
// Answers are cached (sealed), so asking twice costs nothing.

import crypto from "crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { sealText, unsealText } from "./crypto.js";
import { DATA_DIR, HOME } from "./paths.js";

const KEY_FILE = join(HOME, "gemini-key.bin");
const CACHE_DIR = join(DATA_DIR, "media-text");
const API = process.env.WHATSAPP_MCP_GEMINI_URL || "https://generativelanguage.googleapis.com";
// The first is Google's alias for its current Flash model; the second is the
// fallback if the alias is ever retired.
const MODELS = ["gemini-flash-latest", "gemini-2.5-flash"];
const INLINE_LIMIT = 15 * 1024 * 1024;
const TIMEOUT_MS = 180_000;

export const KEY_PAGE = "https://aistudio.google.com/apikey";
export const NO_KEY = `No Gemini key yet, so voice notes and videos cannot be understood. Call open_settings_page and tell the person to paste a Google Gemini API key under "Voice notes and videos" (a free key is at ${KEY_PAGE}).`;

const PROMPTS = {
  voice:
    "Transcribe this WhatsApp voice note word for word. People often mix languages in one sentence; keep every word in the language it was spoken. Return only the transcript. If nothing is said, return [no speech].",
  video:
    "This is a video from a WhatsApp chat. First describe what is shown, briefly and factually. Then give a word for word transcript of any speech, keeping every word in the language it was spoken, or write [no speech].",
};

let cachedKey: string | null | undefined;

function readKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  try {
    cachedKey = unsealText(readFileSync(KEY_FILE));
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

export function hasGeminiKey(): boolean {
  return !!readKey();
}

// What the settings page may show: the last 4 characters, never the key.
export function geminiKeyHint(): string | null {
  const k = readKey();
  return k ? k.slice(-4) : null;
}

class GeminiError extends Error {}

function failure(status: number, body: string): GeminiError {
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) return new GeminiError("Google rejected the Gemini key. Check it on the settings page.");
  if (status === 401 || status === 403) return new GeminiError("Google refused the Gemini key (no access). Check it on the settings page.");
  if (status === 402) return new GeminiError("The Gemini key has no credit left. Top up or turn on billing in Google AI Studio (https://ai.studio/projects), or save another key.");
  if (status === 429) return new GeminiError("The Gemini key has hit its limit for now. Try again later.");
  return new GeminiError(`Gemini did not answer (error ${status}). Try again in a minute.`);
}

async function call(path: string, key: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, { ...init, headers: { "x-goog-api-key": key, ...(init.headers || {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// Checked once on save, so a wrong key is caught at the settings page.
export async function saveGeminiKey(input: string | null): Promise<void> {
  if (!input) {
    rmSync(KEY_FILE, { force: true });
    cachedKey = null;
    return;
  }
  const key = input.trim();
  if (!/^[A-Za-z0-9._-]{20,200}$/.test(key)) throw new GeminiError("That does not look like a Gemini API key.");
  const r = await call("/v1beta/models?pageSize=1", key);
  if (!r.ok) throw failure(r.status, await r.text());
  writeFileSync(KEY_FILE, sealText(key), { mode: 0o600 });
  cachedKey = key;
}

// Files over the inline limit go through Google's upload API first.
async function upload(key: string, bytes: Buffer, mime: string): Promise<{ uri: string; name: string }> {
  const start = await call("/upload/v1beta/files", key, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(bytes.length),
      "x-goog-upload-header-content-type": mime,
    },
    body: JSON.stringify({ file: { display_name: "whatsapp-media" } }),
  });
  if (!start.ok) throw failure(start.status, await start.text());
  const url = start.headers.get("x-goog-upload-url");
  // The key goes along with the upload, so only ever to Google's own host.
  if (!url || new URL(url).origin !== new URL(API).origin) throw new GeminiError("Gemini gave an unexpected upload address.");
  const done = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": key, "x-goog-upload-offset": "0", "x-goog-upload-command": "upload, finalize" },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!done.ok) throw failure(done.status, await done.text());
  let file = (await done.json()).file as { uri: string; name: string; state?: string };
  const until = Date.now() + 120_000;
  while (file.state === "PROCESSING" && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2_000));
    const r = await call(`/v1beta/${file.name}`, key);
    if (!r.ok) throw failure(r.status, await r.text());
    file = await r.json();
  }
  if (file.state && file.state !== "ACTIVE") throw new GeminiError("Gemini could not process this file.");
  return file;
}

async function generate(key: string, parts: unknown[]): Promise<string> {
  let last: GeminiError | null = null;
  for (const model of MODELS) {
    const r = await call(`/v1beta/models/${model}:generateContent`, key, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }] }),
    });
    if (r.status === 404) {
      last = failure(404, "");
      continue;
    }
    if (!r.ok) throw failure(r.status, await r.text());
    const data = await r.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("").trim();
    if (!text) throw new GeminiError("Gemini gave an empty answer for this file.");
    return text;
  }
  throw last ?? new GeminiError("Gemini did not answer.");
}

// Cached answers go when their messages would: same retention.
export function pruneMediaText(cutoffMs: number): void {
  let names: string[] = [];
  try {
    names = readdirSync(CACHE_DIR);
  } catch {
    return;
  }
  for (const n of names) {
    const f = join(CACHE_DIR, n);
    try {
      if (statSync(f).mtimeMs < cutoffMs) rmSync(f, { force: true });
    } catch {
      /* gone already */
    }
  }
}

// One answer per file (and question), whichever service made it.
export async function cached(mediaKey: string, mode: "voice" | "video", question: string | undefined, run: () => Promise<string>): Promise<{ text: string; cached: boolean }> {
  const id = crypto.createHash("sha256").update(`${mediaKey}\n${mode}\n${question || ""}`).digest("hex");
  const cacheFile = join(CACHE_DIR, `${id}.bin`);
  try {
    const hit = unsealText(readFileSync(cacheFile));
    if (hit) return { text: hit, cached: true };
  } catch {
    /* not cached yet */
  }
  const text = await run();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cacheFile, sealText(text));
  return { text, cached: false };
}

export async function understand(
  mediaKey: string,
  mode: "voice" | "video",
  bytes: Buffer,
  mimeType: string,
  question?: string,
): Promise<{ text: string; cached: boolean }> {
  const key = readKey();
  if (!key) throw new GeminiError(NO_KEY);
  return cached(mediaKey, mode, question, async () => {
    const mime = mimeType.split(";")[0].trim();
    let uploaded: { uri: string; name: string } | null = null;
    try {
      let media: unknown;
      if (bytes.length <= INLINE_LIMIT) media = { inline_data: { mime_type: mime, data: bytes.toString("base64") } };
      else {
        uploaded = await upload(key, bytes, mime);
        media = { file_data: { mime_type: mime, file_uri: uploaded.uri } };
      }
      const prompt = question ? `${PROMPTS[mode]}\nAfter that, answer this question about it: ${question}` : PROMPTS[mode];
      return await generate(key, [media, { text: prompt }]);
    } finally {
      if (uploaded) call(`/v1beta/${uploaded.name}`, key, { method: "DELETE" }).catch(() => {});
    }
  });
}
