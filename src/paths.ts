// Where everything lives. Always the home folder: Windows Store style Claude
// installs redirect AppData, so a process started by Claude and one started by
// anything else would otherwise see two different folders.

import crypto from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const VERSION = "1.7.1";

export const HOME = process.env.WHATSAPP_MCP_HOME || join(homedir(), "WhatsApp MCP");
export const DATA_DIR = join(HOME, "data");
export const AUTH_DIR = join(DATA_DIR, "auth");
export const HELPER_FILE = join(HOME, "helper.json");
export const LOCK_FILE = join(HOME, "helper.lock");
export const LOG_FILE = join(HOME, "helper.log");
const SECRETS_FILE = join(HOME, "secrets.json");

export interface HelperInfo {
  pid: number;
  port: number;
  version: string;
}

export function readHelperInfo(): HelperInfo | null {
  try {
    return JSON.parse(readFileSync(HELPER_FILE, "utf8"));
  } catch {
    return null;
  }
}

// Made once, on the first start. Nobody ever types or sees these.
export function loadSecrets(): { token: string; key: string } {
  mkdirSync(HOME, { recursive: true });
  if (existsSync(SECRETS_FILE)) return JSON.parse(readFileSync(SECRETS_FILE, "utf8"));
  const secrets = { token: crypto.randomBytes(32).toString("hex"), key: crypto.randomBytes(32).toString("hex") };
  writeFileSync(SECRETS_FILE, JSON.stringify(secrets), { mode: 0o600 });
  return secrets;
}
