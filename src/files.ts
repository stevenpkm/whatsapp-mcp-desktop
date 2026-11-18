// Files out of WhatsApp: saved to Downloads (with the path and SHA-256 that
// another tool, like a Google Drive connector, needs to upload them), and the
// text inside PDFs and text files, so Claude can read them without file access.

import crypto from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { extname, join } from "path";

export const DOWNLOADS = process.env.WHATSAPP_MCP_DOWNLOADS || join(homedir(), "Downloads", "WhatsApp MCP");

const EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "video/mp4": ".mp4", "application/pdf": ".pdf",
  "text/plain": ".txt", "text/csv": ".csv", "text/markdown": ".md",
};

// A file name that is safe on Windows and Mac.
export function safeName(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 150);
  return clean || "file";
}

export function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Keeps the sender's file name. Same name with different content gets the
// message id added, so nothing is overwritten. Same content is not saved twice.
export function saveBytes(dir: string, fileName: string | null, mediaId: string, mime: string, bytes: Buffer): { path: string; sha256: string; same: boolean } {
  mkdirSync(dir, { recursive: true });
  const id = mediaId.replace(/[^A-Za-z0-9_-]/g, "_");
  const type = mime.split(";")[0].trim();
  let name = fileName ? safeName(fileName) : `${id}${EXT[type] || ""}`;
  if (!extname(name) && EXT[type]) name += EXT[type];
  const hash = sha256(bytes);
  let path = join(dir, name);
  if (existsSync(path)) {
    if (sha256(readFileSync(path)) === hash) return { path, sha256: hash, same: true };
    const ext = extname(name);
    path = join(dir, `${name.slice(0, name.length - ext.length)} (${id.slice(-6)})${ext}`);
  }
  writeFileSync(path, bytes);
  return { path, sha256: hash, same: false };
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|rtf)$)/;
const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".yaml", ".yml", ".log", ".ics", ".vcf"]);

// The text inside a document, or why it cannot be read.
export async function documentText(bytes: Buffer, mime: string, fileName: string | null): Promise<{ text: string; pages?: number } | { cannot: string }> {
  const type = mime.split(";")[0].trim().toLowerCase();
  const ext = extname(fileName || "").toLowerCase();
  if (type === "application/pdf" || ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    let pdf;
    try {
      pdf = await getDocumentProxy(new Uint8Array(bytes));
    } catch {
      return { cannot: "This PDF could not be opened (damaged, or locked with a password)." };
    }
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    // PDF fonts often map CJK to look-alike radicals (⽂ for 文): NFKC puts them back.
    const t = String(text).normalize("NFKC").trim();
    if (!t) return { cannot: `This PDF has ${totalPages} page(s) but no text inside: it is probably a scan or photo. Use save_file to keep it.` };
    return { text: t, pages: totalPages };
  }
  if (TEXT_TYPES.test(type) || TEXT_EXTS.has(ext)) return { text: bytes.toString("utf8").replace(/^﻿/, "") };
  return { cannot: `Reading ${ext || type} files is not supported (PDF and text files are). Use save_file to keep it.` };
}
