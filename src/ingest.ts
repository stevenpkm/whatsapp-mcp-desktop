// WAMessage -> one sealed row. Every chat is kept (direct and group, both
// directions); only status, broadcast and channel traffic is skipped (see
// whatsapp.ts). Nothing here logs message content.
//
// Aliases: WhatsApp addresses some direct chats as <n>@lid. Incoming alias
// messages carry the phone in key.senderPn; we store the chat under the phone
// form and remember the pair (store.rememberLid moves older rows over).

import { getContentType, normalizeMessageContent, proto, type WAMessage } from "@whiskeysockets/baileys";
import { editBody, hasName, lidToPn, rememberLid, saveMedia, saveMessage, setName, setNumberMe, type Body } from "./store.js";
import { downloadMedia, getSession, serializeRef } from "./whatsapp.js";

// Kinds whose file can be fetched later. Images are also fetched on arrival;
// voice notes, videos and documents only when someone asks for them.
const FILE_KINDS = new Set(["image", "audio", "video", "document"]);

let retentionMs = 30 * 86_400_000;
export function setRetentionDays(days: number) {
  retentionMs = days * 86_400_000;
}

function tsToMs(ts: WAMessage["messageTimestamp"]): number | null {
  if (ts === null || ts === undefined) return null;
  const n = typeof ts === "number" ? ts : typeof (ts as any).toNumber === "function" ? (ts as any).toNumber() : Number(ts);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

interface Extracted {
  kind: string | null;
  text: string;
  file?: string;
}

function extract(content: proto.IMessage): Extracted {
  const type = getContentType(content);
  switch (type) {
    case "conversation":
      return { kind: null, text: content.conversation || "" };
    case "extendedTextMessage":
      return { kind: null, text: content.extendedTextMessage?.text || "" };
    case "imageMessage":
      return { kind: "image", text: content.imageMessage?.caption || "" };
    case "videoMessage":
      return { kind: "video", text: content.videoMessage?.caption || "" };
    case "audioMessage":
      return { kind: "audio", text: "" };
    case "documentMessage":
      return { kind: "document", text: content.documentMessage?.caption || "", file: content.documentMessage?.fileName || undefined };
    case "locationMessage": {
      const l = content.locationMessage;
      const where = [l?.name, l?.address].filter(Boolean).join(", ");
      return { kind: "location", text: `${l?.degreesLatitude},${l?.degreesLongitude}${where ? ` ${where}` : ""}` };
    }
    case "contactMessage":
      return { kind: "contact", text: content.contactMessage?.displayName || "" };
    default:
      // stickers, reactions, polls, protocol notices: not kept
      return { kind: null, text: "" };
  }
}

// Text of the message this one replies to, if any (first 300 chars).
function quoted(content: proto.IMessage): string | undefined {
  const type = getContentType(content);
  const ctx = type ? (content as any)[type]?.contextInfo : null;
  const q = ctx?.quotedMessage as proto.IMessage | undefined;
  if (!q) return undefined;
  const inner = normalizeMessageContent(q);
  if (!inner) return undefined;
  const t = extract(inner);
  const s = t.text || (t.kind ? `[${t.kind}]` : "");
  return s ? s.slice(0, 300) : undefined;
}

function isLid(jid: string | null | undefined): jid is string {
  return !!jid && jid.endsWith("@lid");
}

const groupNameAsked = new Set<string>();

export async function ingest(numberId: string, m: WAMessage, history: boolean): Promise<void> {
  const raw = m.key.remoteJid || "";
  const id = m.key.id || "";
  if (!raw || !id) return;
  if (raw.endsWith("@broadcast") || raw.endsWith("@newsletter")) return;

  const ts = tsToMs(m.messageTimestamp) ?? Date.now();
  if (ts < Date.now() - retentionMs) return;

  const content = normalizeMessageContent(m.message ?? undefined);
  if (!content) return;

  // An edit arrives as its own message pointing at the original.
  const pm = content.protocolMessage;
  if (pm) {
    if (pm.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && pm.key?.id && pm.editedMessage) {
      const inner = normalizeMessageContent(pm.editedMessage);
      const t = inner ? extract(inner) : null;
      if (t?.text) editBody(numberId, pm.key.id, t.text);
    }
    return;
  }

  const t = extract(content);
  if (!t.text && !t.kind) return;

  const isGroup = raw.endsWith("@g.us");
  const fromMe = !!m.key.fromMe;
  const key = m.key as WAMessage["key"] & { senderPn?: string; participantPn?: string };

  // Chat address: phone form for direct chats when we know it.
  let chat = raw;
  if (!isGroup && isLid(raw)) {
    const pn = (!fromMe && key.senderPn) || lidToPn.get(raw) || null;
    if (pn) {
      rememberLid(raw, pn);
      chat = pn;
    }
  }

  // Sender address: for groups the participant (phone form when given).
  let sender: string | null = null;
  if (!fromMe) {
    if (isGroup) {
      const p = key.participant || null;
      const pn = key.participantPn || (p ? lidToPn.get(p) : null) || null;
      if (isLid(p) && pn) rememberLid(p, pn);
      sender = pn || p;
    } else {
      sender = chat;
    }
  }

  // Names: the push name on a message is the weakest source (rank 1).
  if (!fromMe && sender && m.pushName) setName(sender, m.pushName, 1);
  if (isGroup && !hasName(chat) && !groupNameAsked.has(chat)) {
    groupNameAsked.add(chat);
    getSession(numberId)
      ?.groupSubject(chat)
      .then((s) => s && setName(chat, s, 3))
      .catch(() => {});
  }

  const body: Body = { t: t.text };
  const q = quoted(content);
  if (q) body.q = q;
  if (t.file) body.f = t.file;

  const fresh = saveMessage({
    numberId,
    id,
    chatJid: chat,
    ts,
    fromMe,
    senderJid: sender,
    senderName: fromMe ? null : m.pushName || null,
    kind: t.kind,
    body,
    mediaRef: t.kind && FILE_KINDS.has(t.kind) ? serializeRef(m) : null,
  });

  // Live images are fetched now (screenshots are the point); history images
  // are fetched the first time someone asks for them.
  const session = getSession(numberId);
  if (fresh && t.kind === "image" && !history && session?.status === "connected") {
    try {
      saveMedia(numberId, id, await downloadMedia(serializeRef(m), "image", session));
    } catch (e: any) {
      console.warn(`[vault] image not saved for one message: ${e?.message || e}`);
    }
  }
}

// Contacts: saved name (rank 3) beats WhatsApp profile name (rank 2).
export function ingestContacts(_numberId: string, list: { id?: string | null; name?: string | null; notify?: string | null; verifiedName?: string | null }[]): void {
  for (const c of list) {
    if (!c?.id || c.id.endsWith("@g.us")) continue;
    const jid = isLid(c.id) ? lidToPn.get(c.id) || c.id : c.id;
    if (c.name) setName(jid, c.name, 3);
    else if (c.notify || c.verifiedName) setName(jid, c.notify || c.verifiedName, 2);
  }
}

export function ingestGroups(_numberId: string, list: { id?: string | null; subject?: string | null }[]): void {
  for (const g of list) if (g?.id && g.subject) setName(g.id, g.subject, 3);
}

// A number finished linking: remember its own address.
export function ingestLinked(numberId: string, meJid: string): void {
  setNumberMe(numberId, meJid.split(":")[0].split("@")[0] + "@s.whatsapp.net");
}
