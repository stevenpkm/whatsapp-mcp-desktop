// AES-256-GCM for everything a person wrote or is called: message text,
// names, group subjects, image files. Ids, chat addresses and timestamps stay
// plain so they can be indexed.
//
// Blob layout: iv (12 bytes) | auth tag (16 bytes) | ciphertext.
// The key lives only in the VAULT_KEY env var, never on the volume, so a copy
// of the volume alone reads as noise.

import crypto from "crypto";

let key: Buffer | null = null;

export function initCrypto(hex: string): void {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("VAULT_KEY must be 64 hex characters (32 bytes)");
  key = Buffer.from(hex, "hex");
}

function k(): Buffer {
  if (!key) throw new Error("crypto not initialised");
  return key;
}

export function seal(data: Buffer | string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k(), iv);
  const body = Buffer.concat([cipher.update(typeof data === "string" ? Buffer.from(data, "utf8") : data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function unseal(blob: Uint8Array): Buffer {
  const b = Buffer.from(blob);
  const decipher = crypto.createDecipheriv("aes-256-gcm", k(), b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]);
}

// Text helpers. A blob that fails to open (wrong key, damaged) reads as null
// instead of throwing, so one bad row never breaks a whole listing.
export function sealText(s: string): Buffer {
  return seal(Buffer.from(s, "utf8"));
}

export function unsealText(blob: Uint8Array | null | undefined): string | null {
  if (!blob) return null;
  try {
    return unseal(blob).toString("utf8");
  } catch {
    return null;
  }
}

// Constant-time token check (hash first so lengths never leak).
export function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
