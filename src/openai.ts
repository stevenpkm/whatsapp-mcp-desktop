// Voice notes only, turned into text by OpenAI with the person's own API key.
// OpenAI's speech-to-text takes audio, not video, so videos stay with Gemini.
// The key is sealed on disk, never logged, and only ever sent to OpenAI.

import { readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { sealText, unsealText } from "./crypto.js";
import { cached } from "./gemini.js";
import { HOME } from "./paths.js";

const KEY_FILE = join(HOME, "openai-key.bin");
const API = process.env.WHATSAPP_MCP_OPENAI_URL || "https://api.openai.com";
// Newest first; the second is the long-standing fallback.
const MODELS = ["gpt-4o-transcribe", "whisper-1"];
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const EXT: Record<string, string> = { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "m4a", "audio/wav": "wav", "audio/webm": "webm" };

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

export function hasOpenAIKey(): boolean {
  return !!readKey();
}

export function openaiKeyHint(): string | null {
  const k = readKey();
  return k ? k.slice(-4) : null;
}

class OpenAIError extends Error {}

function failure(status: number, body: string): OpenAIError {
  if (status === 401) return new OpenAIError("OpenAI rejected the key. Check it on the settings page.");
  if (status === 429 && /insufficient_quota/i.test(body)) return new OpenAIError("The OpenAI key has no credit left. Add credit at platform.openai.com, or save another key.");
  if (status === 429) return new OpenAIError("The OpenAI key has hit its limit for now. Try again later.");
  return new OpenAIError(`OpenAI did not answer (error ${status}). Try again in a minute.`);
}

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

// Checked once on save, so a wrong key is caught at the settings page.
export async function saveOpenAIKey(input: string | null): Promise<void> {
  if (!input) {
    rmSync(KEY_FILE, { force: true });
    cachedKey = null;
    return;
  }
  const key = input.trim();
  if (!/^[A-Za-z0-9._-]{20,300}$/.test(key)) throw new OpenAIError("That does not look like an OpenAI API key.");
  const r = await fetch(`${API}/v1/models`, { headers: auth(key), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw failure(r.status, await r.text());
  writeFileSync(KEY_FILE, sealText(key), { mode: 0o600 });
  cachedKey = key;
}

export async function transcribeOpenAI(mediaKey: string, bytes: Buffer, mimeType: string): Promise<{ text: string; cached: boolean }> {
  const key = readKey();
  if (!key) throw new OpenAIError("No OpenAI key saved.");
  if (bytes.length > MAX_BYTES) throw new OpenAIError("This voice note is over 25 MB, too big for OpenAI.");
  const mime = mimeType.split(";")[0].trim();
  return cached(mediaKey, "voice", undefined, async () => {
    let lastStatus = 0;
    let lastBody = "";
    for (const model of MODELS) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), `voice.${EXT[mime] || "ogg"}`);
      form.append("model", model);
      const r = await fetch(`${API}/v1/audio/transcriptions`, { method: "POST", headers: auth(key), body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) {
        const text = String((await r.json()).text || "").trim();
        return text || "[no speech]";
      }
      lastStatus = r.status;
      lastBody = await r.text();
      // A model this key cannot use: try the next one. Anything else is final.
      if (!(r.status === 404 || (r.status === 400 && /model/i.test(lastBody)) || (r.status === 403 && /model/i.test(lastBody)))) break;
    }
    throw failure(lastStatus, lastBody);
  });
}
