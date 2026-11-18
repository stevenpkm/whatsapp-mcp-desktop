// Files of image, voice note, video and document messages, shared by the MCP
// tools, the JSON API and GET /media/:key. A media key is "<number>:<message
// id>" (like n1:3EB0C4...), because the same message id can reach two linked
// numbers.

import { listNumbers, loadMedia, mediaInfo, saveMedia } from "./store.js";
import { downloadMedia, getSession, mediaDetails } from "./whatsapp.js";

export const KIND_LABEL: Record<string, string> = { image: "image", audio: "voice note", video: "video", document: "document" };
const DEFAULT_MIME: Record<string, string> = { image: "image/jpeg", audio: "audio/ogg", video: "video/mp4", document: "application/octet-stream" };

export const mediaKey = (numberId: string, id: string) => `${numberId}:${id}`;

// A bare message id is accepted while only one number is linked.
export function parseMediaKey(key: string): { numberId: string; id: string } {
  const v = key.trim();
  const i = v.indexOf(":");
  if (i > 0) return { numberId: v.slice(0, i), id: v.slice(i + 1) };
  const numbers = listNumbers();
  if (numbers.length === 1) return { numberId: numbers[0].id, id: v };
  throw new Error(`use the full id with its number, like n1:${v}`);
}

// The sealed copy on the volume, or downloaded from WhatsApp the first time
// and then kept (until retention deletes the message).
export async function mediaFile(
  key: string,
  kinds: string[],
): Promise<{ bytes: Buffer; kind: string; mime: string; seconds: number | null; fileName: string | null }> {
  const { numberId, id } = parseMediaKey(key);
  const info = mediaInfo(numberId, id);
  if (!info?.kind || !kinds.includes(info.kind)) throw new Error(`no ${kinds.map((k) => KIND_LABEL[k] || k).join(" or ")} with that id`);
  let bytes = info.file ? loadMedia(info.file) : null;
  if (!bytes) {
    if (!info.ref) throw new Error(`file not kept for this ${KIND_LABEL[info.kind]} (it arrived before files were kept)`);
    const session = getSession(numberId);
    if (session?.status !== "connected") throw new Error("that WhatsApp number is not connected, cannot fetch the file now");
    bytes = await downloadMedia(info.ref, info.kind, session);
    saveMedia(numberId, id, bytes);
  }
  const d = mediaDetails(info.ref);
  return { bytes, kind: info.kind, mime: d.mime || DEFAULT_MIME[info.kind], seconds: d.seconds, fileName: d.fileName };
}
