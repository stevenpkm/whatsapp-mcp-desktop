// The settings page's data: settings the person can change, a short history
// of connects and drops, and a desktop alert when WhatsApp stays down.
// The history keeps only times and kinds, never message text or names.

import { spawn } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { HOME } from "./paths.js";

const SETTINGS_FILE = join(HOME, "settings.json");
const EVENTS_FILE = join(HOME, "events.json");
const EVENTS_KEEP = 300;
const EVENTS_DAYS = 30;
export const ALERT_AFTER_MS = 3 * 60_000;

export const KEEP_DAY_CHOICES = [7, 14, 30, 90];

export interface Settings {
  keepDays: number;
  countryCode: string;
  alerts: boolean;
  // Which saved key turns voice notes into text when both are saved.
  voiceWith: "gemini" | "openai";
  // Off by default. Only the settings page turns it on, after the ban warning.
  sending: boolean;
}

const DEFAULTS: Settings = { keepDays: 30, countryCode: "", alerts: true, voiceWith: "gemini", sending: false };

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function loadSettings(): Settings {
  const s = { ...DEFAULTS, ...readJson<Partial<Settings>>(SETTINGS_FILE, {}) };
  return cleanSettings(s);
}

function cleanSettings(s: Partial<Settings>): Settings {
  const keepDays = KEEP_DAY_CHOICES.includes(Number(s.keepDays)) ? Number(s.keepDays) : DEFAULTS.keepDays;
  const countryCode = String(s.countryCode ?? DEFAULTS.countryCode).replace(/\D/g, "").slice(0, 4);
  return { keepDays, countryCode, alerts: s.alerts !== false, voiceWith: s.voiceWith === "openai" ? "openai" : "gemini", sending: s.sending === true };
}

export function saveSettings(input: Partial<Settings>): Settings {
  const s = cleanSettings({ ...loadSettings(), ...input });
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return s;
}

export type EventKind = "connected" | "disconnected" | "logged_out" | "helper_started" | "caught_up";
export interface ConnEvent {
  at: number;
  kind: EventKind;
  code?: number;
  // caught_up: how many messages that arrived while it was off came in.
  n?: number;
}

let events: ConnEvent[] | null = null;

export function listEvents(): ConnEvent[] {
  events ??= readJson<ConnEvent[]>(EVENTS_FILE, []).filter((e) => e && typeof e.at === "number");
  return events;
}

export function addEvent(kind: EventKind, code?: number, n?: number): void {
  const cutoff = Date.now() - EVENTS_DAYS * 86_400_000;
  const list = listEvents().filter((e) => e.at >= cutoff);
  const e: ConnEvent = { at: Date.now(), kind };
  if (code !== undefined) e.code = code;
  if (n !== undefined) e.n = n;
  list.push(e);
  events = list.slice(-EVENTS_KEEP);
  try {
    writeFileSync(EVENTS_FILE, JSON.stringify(events));
  } catch (e: any) {
    console.error("[helper] could not save the history:", e?.message || e);
  }
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A desktop notification. Clicking it opens `url` (Windows only; on a Mac the
// notification just shows). Best effort: an alert is never worth a crash.
export function notify(title: string, body: string, url: string): void {
  if (process.env.WHATSAPP_MCP_NO_ALERTS) return;
  let cmd: string;
  let args: string[];
  if (process.platform === "win32") {
    const toast = `<toast activationType="protocol" launch="${xml(url)}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
    const ps = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
      "$d = New-Object Windows.Data.Xml.Dom.XmlDocument",
      `$d.LoadXml('${toast.replace(/'/g, "''")}')`,
      "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($d))",
    ].join("\n");
    cmd = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")];
  } else if (process.platform === "darwin") {
    const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    cmd = "osascript";
    args = ["-e", `display notification ${q(body)} with title ${q(title)}`];
  } else {
    cmd = "notify-send";
    args = [title, body];
  }
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true })
    .on("error", (e) => console.error("[helper] could not show the alert:", e.message))
    .unref();
}
