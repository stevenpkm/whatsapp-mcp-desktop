// The settings page: is WhatsApp connected, what is synced, how long it is
// kept, the last 7 days of drops, the Gemini key and the settings. It polls
// `info` every few seconds. Look: Emerald Bento, the same as WhatsApp Vault
// (sage ground, white cards, one emerald accent, red only when something needs
// the person). Font and icons are inline, so the page loads nothing from the
// internet.

import manrope from "../assets/manrope.woff2";

// Lucide icons (ISC), stroke 2.
const ICON: Record<string, string> = {
  logo: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  sliders: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};
const icon = (name: string, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

export function panelPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhatsApp MCP</title>
<style>
  @font-face { font-family: "Manrope"; font-weight: 200 800; font-display: swap; src: url(data:font/woff2;base64,${manrope}) format("woff2"); }
  :root {
    color-scheme: light;
    --canvas: #e8eeeb; --bg: #ffffff; --panel: #f0f4f2; --line: #e3eae6;
    --ink: #10201c; --ink-2: #4b635c; --ink-3: #5b726b;
    --accent: #087a57; --accent-soft: #e5f4ee; --accent-strong: #065f46;
    --ok: #16a34a; --bad: #c81e1e; --bad-soft: #fdeaea; --mint: #34d399; --side: #0e2a24;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--canvas); color: var(--ink); font: 15px/1.5 "Manrope", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  .page { padding: 24px clamp(16px, 3vw, 40px) 48px; display: grid; gap: 14px; }
  .num, time { font-variant-numeric: tabular-nums; }

  header { display: flex; align-items: center; gap: 12px; padding: 4px 4px 8px; }
  .logo { width: 40px; height: 40px; border-radius: 12px; background: var(--side); color: var(--mint); display: grid; place-items: center; }
  header h1 { font-size: 20px; font-weight: 800; letter-spacing: -0.03em; margin: 0; white-space: nowrap; }
  .pill { white-space: nowrap; font-size: 13px; font-weight: 700; color: var(--accent-strong); background: var(--bg); border-radius: 999px; padding: 4px 12px; }
  header .ver { margin-left: auto; color: var(--ink-3); font-size: 13px; }

  .grid { display: grid; gap: 14px; grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .card { background: var(--bg); border-radius: 24px; padding: 22px 24px; min-width: 0; }
  .span-2 { grid-column: span 2; } .span-3 { grid-column: span 3; } .span-4 { grid-column: span 4; }
  .label { display: flex; align-items: center; gap: 8px; color: var(--ink-2); font-size: 14px; font-weight: 700; margin: 0 0 14px; }
  .label svg { color: var(--accent); }
  .big { font-size: 34px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.1; }
  .sub { color: var(--ink-3); font-size: 14px; margin: 6px 0 0; }

  .status { display: flex; flex-direction: column; justify-content: space-between; gap: 16px; background: var(--side); color: #e4f1ec; }
  .status .label { color: #a9c9bf; } .status .label svg { color: var(--mint); }
  .state { display: flex; align-items: center; gap: 12px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: #a9c9bf; flex: none; }
  .ok .dot { background: var(--mint); box-shadow: 0 0 0 6px rgba(52, 211, 153, 0.18); }
  .bad .dot { background: #ff6b6b; box-shadow: 0 0 0 6px rgba(255, 107, 107, 0.18); }
  .status .sub { color: #a9c9bf; }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 14px; margin: 0; }
  .facts dt { color: #a9c9bf; } .facts dd { margin: 0; color: #e4f1ec; font-weight: 600; }

  button { appearance: none; font: inherit; font-weight: 700; font-size: 14px; height: 40px; padding: 0 16px; border-radius: 12px; border: 0; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
  .primary { background: var(--accent); color: #fff; } .primary:hover { background: var(--accent-strong); }
  .secondary { background: var(--panel); color: var(--ink); } .secondary:hover { background: var(--line); }
  .on-dark { background: #1d4a40; color: #e4f1ec; } .on-dark:hover { background: #24584c; }
  button:disabled { opacity: 0.45; cursor: default; }
  .row-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

  .keep .unit { font-size: 18px; font-weight: 700; color: var(--ink-2); letter-spacing: 0; }
  .kept { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 14px; margin: 16px 0 0; }
  .kept dt { color: var(--ink-3); } .kept dd { margin: 0; font-weight: 600; }

  .days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; margin-bottom: 18px; }
  .day { background: var(--accent-soft); border-radius: 14px; padding: 10px 12px; }
  .day.down { background: var(--bad-soft); }
  .day small { display: block; color: var(--ink-3); font-size: 12px; font-weight: 600; }
  .day b { display: block; font-size: 20px; font-weight: 800; color: var(--accent-strong); }
  .day.down b { color: var(--bad); }
  .day span { font-size: 12px; color: var(--ink-3); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: grid; grid-template-columns: 9em 1fr; gap: 12px; padding: 9px 0; border-top: 1px solid var(--line); font-size: 14px; }
  li:first-child { border-top: 0; }
  li time { color: var(--ink-3); }
  li .bad-text { color: var(--bad); font-weight: 600; }
  li span { min-width: 0; overflow-wrap: anywhere; }
  .empty { color: var(--ink-3); }

  .key-state { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
  .provider { padding: 16px 0; border-top: 1px solid var(--line); }
  .provider:first-of-type { border-top: 0; padding-top: 0; }
  .tag { color: var(--ink-3); font-size: 13px; }
  .key-state .chip { margin-left: auto; }
  .voice-with { border-top: 1px solid var(--line); padding-top: 14px; }
  .chip { font-size: 12px; font-weight: 700; border-radius: 999px; padding: 3px 10px; background: var(--panel); color: var(--ink-2); }
  .chip.on { background: var(--accent-soft); color: var(--accent-strong); }
  .field { display: flex; gap: 8px; flex-wrap: wrap; }
  input[type=password], input[type=text], select { font: inherit; font-size: 16px; height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--ink); }
  input[type=password] { flex: 1; min-width: 10em; }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; background: #fff; }
  .note { color: var(--ink-3); font-size: 13px; margin: 12px 0 0; }
  .note a { color: var(--accent-strong); font-weight: 700; }
  .msg { font-size: 13px; font-weight: 600; color: var(--accent-strong); }
  .msg.err { color: var(--bad); }

  .set { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 16px; padding: 14px 0; border-top: 1px solid var(--line); }
  .set:first-of-type { border-top: 0; padding-top: 0; }
  .set b { font-weight: 700; } .set small { display: block; color: var(--ink-3); font-size: 13px; }
  .cc { white-space: nowrap; font-weight: 700; color: var(--ink-2); } .cc input { width: 5.5em; margin-left: 6px; }
  .switch { position: relative; width: 44px; height: 26px; }
  .switch input { opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; position: absolute; z-index: 1; }
  .switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--line); transition: background 0.15s; }
  .switch span::after { content: ""; position: absolute; left: 3px; top: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: transform 0.15s; box-shadow: 0 1px 2px rgba(16, 32, 28, 0.2); }
  .switch input:checked + span { background: var(--accent); }
  .switch input:checked + span::after { transform: translateX(18px); }
  .switch input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
  .save-row { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin-top: 16px; flex-wrap: wrap; }

  .path { overflow-wrap: anywhere; }

  .val { font-weight: 600; color: var(--ink-2); text-align: right; }
  .tips { background: var(--panel); border-radius: 16px; padding: 14px 16px; margin: 4px 0 6px; font-size: 14px; }
  .tips b { display: block; margin-bottom: 6px; }
  .tips ul { list-style: disc; padding-left: 18px; margin: 0; color: var(--ink-2); }
  .tips li { display: list-item; border: 0; padding: 2px 0; }
  .tips p { margin: 8px 0 0; font-weight: 700; color: var(--bad); }
  .tips + .set { border-top: 0; }
  .chip.risk { background: var(--bad-soft); color: var(--bad); }
  .providers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 32px; }
  .providers .provider { border-top: 0; padding-top: 0; }
  .rules { margin: 10px 0 16px; padding-left: 18px; color: var(--ink-2); font-size: 14px; list-style: disc; }
  .rules li { display: list-item; border: 0; padding: 2px 0; grid-template-columns: none; }
  dialog { margin: auto; border: 0; border-radius: 24px; padding: 28px; max-width: 520px; width: calc(100% - 32px); color: var(--ink); box-shadow: 0 24px 60px rgba(16, 32, 28, 0.25); }
  dialog::backdrop { background: rgba(14, 42, 36, 0.45); }
  dialog h3 { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 12px; }
  dialog h3 svg { color: var(--bad); }
  dialog ul.rules li { padding: 4px 0; }
  .accept { display: flex; gap: 10px; align-items: flex-start; background: var(--bad-soft); border-radius: 14px; padding: 12px 14px; font-weight: 600; font-size: 14px; cursor: pointer; }
  .accept input { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--bad); flex: none; }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .danger { background: var(--bad); color: #fff; } .danger:hover { background: #a51b1b; }

  @media (max-width: 1100px) {
    .providers { grid-template-columns: minmax(0, 1fr); }
    .providers .provider + .provider { border-top: 1px solid var(--line); padding-top: 16px; }
    .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .span-2, .span-3, .span-4 { grid-column: span 2; }
    .stat { grid-column: span 1; }
  }
  @media (max-width: 560px) {
    .card { padding: 18px; }
    .stat .sub { font-size: 13px; }
    .days { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    li { grid-template-columns: 1fr; gap: 0; }
    .big { font-size: 28px; }
  }
</style>
</head>
<body>
<div class="page">
  <header>
    <div class="logo">${icon("logo", 22)}</div>
    <h1>WhatsApp MCP</h1>
    <span class="pill" id="modePill">Read only</span>
    <span class="ver" id="ver"></span>
  </header>

  <div class="grid">
    <section class="card status span-2" id="now">
      <div>
        <p class="label">${icon("activity")} Connection</p>
        <div class="state"><span class="dot"></span><span class="big" id="state">Loading</span></div>
        <p class="sub" id="hint"></p>
      </div>
      <dl class="facts">
        <dt>Number</dt><dd id="phone" class="num">-</dd>
        <dt>Connected since</dt><dd id="since">-</dd>
      </dl>
      <div class="row-actions">
        <button id="reconnect" class="on-dark" hidden>${icon("refresh", 16)} Reconnect now</button>
        <button id="scan" class="primary" hidden>${icon("qr", 16)} Scan the QR</button>
      </div>
    </section>

    <section class="card stat">
      <p class="label">${icon("users")} Groups</p>
      <div class="big num" id="groups">-</div>
      <p class="sub">synced</p>
    </section>
    <section class="card stat">
      <p class="label">${icon("user")} Direct chats</p>
      <div class="big num" id="directs">-</div>
      <p class="sub">synced</p>
    </section>
    <section class="card stat">
      <p class="label">${icon("message")} Messages</p>
      <div class="big num" id="messages">-</div>
      <p class="sub" id="range">stored</p>
    </section>
    <section class="card stat">
      <p class="label">${icon("clock")} Last update</p>
      <div class="big num" id="newest">-</div>
      <p class="sub" id="newestDay">newest message</p>
    </section>

    <section class="card span-4">
      <p class="label">${icon("activity")} Last 7 days</p>
      <div class="days" id="days"></div>
      <ul id="events"><li><span class="empty">Nothing yet</span></li></ul>
    </section>

    <section class="card span-2 keep">
      <p class="label">${icon("lock")} Storage</p>
      <div class="big"><span id="keepNum" class="num">30</span> <span class="unit">days</span></div>
      <p class="sub">Older messages are deleted automatically.</p>
      <dl class="kept">
        <dt>Oldest kept</dt><dd id="oldest">-</dd>
        <dt>Encrypted in</dt><dd class="path" id="home"></dd>
      </dl>
    </section>

    <section class="card span-3">
      <p class="label">${icon("sliders")} Settings</p>
      <form id="form">
        <label class="set"><span><b>Keep messages for</b></span>
          <select name="keepDays"><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label>
        <label class="set"><span><b>Country code</b><small>For local numbers starting with 0</small></span>
          <span class="cc">+<input type="text" name="countryCode" inputmode="numeric" maxlength="4"></span></label>
        <label class="set"><span><b>Disconnect alerts</b><small>After <span id="alertMin">3</span> min down, or when a new scan is needed</small></span>
          <span class="switch"><input type="checkbox" name="alerts"><span></span></span></label>
        <div class="save-row">
          <span id="saved" class="msg"></span>
          <button type="button" id="testAlert" class="secondary">${icon("bell", 16)} Test alert</button>
          <button type="submit" id="saveBtn" class="primary" disabled>Save</button>
        </div>
      </form>
    </section>

    <section class="card span-3" id="sendCard">
      <p class="label">${icon("send")} Sending</p>
      <div class="set"><span><b>Send messages</b><small id="sendHint">Off: Claude can only read</small></span>
        <span class="row-actions"><span class="chip" id="sendChip">Off</span><button type="button" id="sendOn" class="secondary">Turn on</button><button type="button" id="sendOff" class="secondary" hidden>Turn off</button></span></div>
      <div class="tips">
        <b>If you send, keep it safe</b>
        <ul>
          <li>Send slowly, a few messages at a time, not many in a row</li>
          <li>Only message people who know you</li>
          <li>No bulk, promo or the same text to many people</li>
          <li>Use a second number, not your main one</li>
          <li>Stop if people block you or WhatsApp warns you</li>
        </ul>
        <p>These lower the risk. They do not stop a ban.</p>
      </div>
      <div class="set"><span><b>Sent today</b></span><span class="val num" id="sentDay">0</span></div>
      <div class="set" id="waitRow" hidden><span><b>Waiting to send</b></span>
        <span class="row-actions"><span class="val num" id="waiting">0</span><button type="button" id="clearQueue" class="secondary">Stop</button></span></div>
      <p class="note"><span id="sendMsg" class="msg"></span></p>
    </section>

    <section class="card" style="grid-column: 1 / -1">
      <p class="label">${icon("mic")} Voice notes and videos</p>
      <div class="providers">
      <div class="provider">
        <div class="key-state"><b>Google Gemini</b><span class="tag">Voice notes and videos</span><span class="chip" id="geminiChip">Off</span></div>
        <form id="geminiForm" class="field">
          <input type="password" name="key" autocomplete="off" spellcheck="false" aria-label="Gemini API key">
          <button type="submit" class="primary">Save key</button>
          <button type="button" id="geminiRemove" class="secondary" hidden>Remove</button>
        </form>
        <p class="note"><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Get a key</a>. On the free tier, Google may use what you send. <span id="geminiMsg" class="msg"></span></p>
      </div>
      <div class="provider">
        <div class="key-state"><b>OpenAI</b><span class="tag">Voice notes only</span><span class="chip" id="openaiChip">Off</span></div>
        <form id="openaiForm" class="field">
          <input type="password" name="key" autocomplete="off" spellcheck="false" aria-label="OpenAI API key">
          <button type="submit" class="primary">Save key</button>
          <button type="button" id="openaiRemove" class="secondary" hidden>Remove</button>
        </form>
        <p class="note"><a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Get a key</a>. <span id="openaiMsg" class="msg"></span></p>
      </div>
      </div>
      <label class="set voice-with" id="voiceWithRow" hidden><span><b>Voice notes with</b></span>
        <select id="voiceWith"><option value="gemini">Gemini</option><option value="openai">OpenAI</option></select></label>
      <p class="note">Only the file you ask about is sent, and each answer is kept so asking again is free.</p>
    </section>
  </div>
</div>

<dialog id="riskDialog">
  <h3>${icon("warn", 22)} Turn on sending?</h3>
  <p style="margin: 0 0 6px">Read this first:</p>
  <ul class="rules">
    <li><b>Your number can be banned.</b> WhatsApp does not allow unofficial apps to send messages. A ban can be temporary or permanent.</li>
    <li>Sending slowly lowers the risk but never removes it. Do not use it for bulk or marketing messages.</li>
    <li>Claude must show you each message and get your OK before sending.</li>
    <li>Messages from other people can try to trick Claude into sending. Never approve a message you did not ask for.</li>
  </ul>
  <label class="accept"><input type="checkbox" id="acceptRisk"> I understand my number can be banned, and I use sending at my own risk.</label>
  <div class="dialog-actions">
    <button type="button" id="riskCancel" class="secondary">Cancel</button>
    <button type="button" id="riskConfirm" class="danger" disabled>Turn on sending</button>
  </div>
</dialog>
<script>
  const base = location.pathname.replace(/\\/panel\\/?$/, "");
  const $ = (id) => document.getElementById(id);
  const form = $("form");
  let loaded = false, savedValues = "";

  const pad = (n) => String(n).padStart(2, "0");
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  function dayName(d) {
    const now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, now)) return "Today";
    if (sameDay(d, y)) return "Yesterday";
    return d.toLocaleDateString("en", { month: "short", day: "numeric" });
  }
  const hm = (d) => pad(d.getHours()) + ":" + pad(d.getMinutes());
  const when = (ms) => (ms ? dayName(new Date(ms)) + " " + hm(new Date(ms)) : "-");
  function span(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return s + " sec";
    const m = Math.round(s / 60);
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60);
    return h + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
  }
  const count = (n) => Number(n || 0).toLocaleString("en");

  const STATES = {
    connected: ["ok", "Connected", "Receiving messages"],
    disconnected: ["bad", "Disconnected", "Retrying by itself"],
    logged_out: ["bad", "Needs a new scan", "The link was removed on the phone"],
    qr: ["", "Not linked", "Scan the QR to start"],
    starting: ["", "Connecting", "One moment"],
    off: ["", "Test mode", "WhatsApp is off"],
  };

  function render(s) {
    const [cls, title, hint] = STATES[s.status] || ["", s.status, ""];
    $("now").className = "card status span-2 " + cls;
    $("state").textContent = title;
    $("hint").textContent = hint;
    $("ver").textContent = "v" + s.version;
    $("phone").textContent = s.phone ? "+" + s.phone : "-";
    $("since").textContent = s.status === "connected" ? when(s.lastConnectedAt) : "-";
    $("reconnect").hidden = s.status !== "disconnected";
    $("scan").hidden = !(s.status === "qr" || s.status === "logged_out");

    $("groups").textContent = count(s.groups);
    $("directs").textContent = count(s.directChats);
    $("messages").textContent = count(s.messages);
    $("range").textContent = s.oldest ? "since " + dayName(new Date(s.oldest)) : "stored";
    $("newest").textContent = s.newest ? hm(new Date(s.newest)) : "-";
    $("newestDay").textContent = s.newest ? dayName(new Date(s.newest)) + ", newest message" : "newest message";
    $("keepNum").textContent = s.settings.keepDays;
    $("oldest").textContent = s.oldest ? when(s.oldest) : "-";
    $("home").textContent = s.home;
    $("alertMin").textContent = s.alertAfterMin;

    const snd = s.sending;
    $("modePill").textContent = snd.on ? "Sending on" : "Read only";
    $("sendChip").textContent = snd.on ? "On, at your own risk" : "Off";
    $("sendChip").className = "chip" + (snd.on ? " risk" : "");
    $("sendHint").textContent = snd.on ? "Only after you say OK to each message" : "Off: Claude can only read";
    $("sendOn").hidden = snd.on;
    $("sendOff").hidden = !snd.on;
    $("sentDay").textContent = snd.lastDay;
    $("waitRow").hidden = !snd.queued;
    $("waiting").textContent = snd.queued;

    for (const name of ["gemini", "openai"]) {
      const hint = s[name + "Key"];
      $(name + "Chip").textContent = hint ? "Saved, ends in " + hint : "Off";
      $(name + "Chip").className = "chip" + (hint ? " on" : "");
      $(name + "Remove").hidden = !hint;
    }
    $("voiceWithRow").hidden = !(s.geminiKey && s.openaiKey);
    if (document.activeElement !== $("voiceWith")) $("voiceWith").value = s.settings.voiceWith;

    // Drops: one tile per day, then the list.
    const ev = s.events, now = Date.now();
    const drops = [];
    const rows = [];
    ev.forEach((e, i) => {
      let text = "", bad = false;
      if (e.kind === "connected") text = "Connected";
      else if (e.kind === "helper_started") text = "Started (Claude opened or computer restarted)";
      else {
        const back = ev.slice(i + 1).find((x) => x.kind === "connected");
        const dur = back ? back.at - e.at : (s.status === "connected" ? 0 : now - e.at);
        drops.push({ at: e.at, dur });
        text = (e.kind === "logged_out" ? "Link removed, needs a new scan" : "Disconnected") + (back ? ", back after " + span(dur) : (s.status === "connected" ? "" : ", not back yet"));
        bad = true;
      }
      if (e.at >= now - 7 * 86400000) rows.push({ at: e.at, text, bad });
    });
    $("days").innerHTML = "";
    for (let k = 6; k >= 0; k--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - k);
      const next = new Date(d); next.setDate(d.getDate() + 1);
      const dayDrops = drops.filter((x) => x.at >= d.getTime() && x.at < next.getTime());
      const down = dayDrops.reduce((t, x) => t + x.dur, 0);
      const tile = document.createElement("div");
      tile.className = "day" + (dayDrops.length ? " down" : "");
      const label = document.createElement("small");
      label.textContent = k === 0 ? "Today" : d.toLocaleDateString("en", { weekday: "short" });
      const n = document.createElement("b");
      n.className = "num";
      n.textContent = dayDrops.length;
      const sub = document.createElement("span");
      sub.textContent = dayDrops.length ? (down ? span(down) + " down" : "drops") : "no drops";
      tile.append(label, n, sub);
      $("days").append(tile);
    }
    const list = rows.reverse().slice(0, 12);
    $("events").innerHTML = "";
    if (!list.length) $("events").innerHTML = '<li><span class="empty">Nothing yet</span></li>';
    for (const r of list) {
      const li = document.createElement("li");
      const t = document.createElement("time");
      t.textContent = when(r.at);
      const d = document.createElement("span");
      d.textContent = r.text;
      if (r.bad) d.className = "bad-text";
      li.append(t, d);
      $("events").append(li);
    }

    if (!loaded) {
      form.keepDays.value = String(s.settings.keepDays);
      form.countryCode.value = s.settings.countryCode;
      form.alerts.checked = s.settings.alerts;
      savedValues = values();
      loaded = true;
    }
  }

  const values = () => JSON.stringify([form.keepDays.value, form.countryCode.value.replace(/\\D/g, ""), form.alerts.checked]);
  form.addEventListener("input", () => ($("saveBtn").disabled = values() === savedValues));
  form.addEventListener("change", () => ($("saveBtn").disabled = values() === savedValues));

  async function tick() {
    try { render(await (await fetch(base + "/info")).json()); }
    catch { $("now").className = "card status span-2 bad"; $("state").textContent = "Not reachable"; $("hint").textContent = "Open Claude and try again"; }
  }

  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const timers = {};
  function flash(id, text, err) {
    $(id).textContent = text;
    $(id).className = "msg" + (err ? " err" : "");
    clearTimeout(timers[id]);
    timers[id] = setTimeout(() => ($(id).textContent = ""), 4000);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await post("/settings", { keepDays: Number(form.keepDays.value), countryCode: form.countryCode.value, alerts: form.alerts.checked });
    if (r.ok) {
      const s = await r.json();
      form.countryCode.value = s.countryCode;
      savedValues = values();
      $("saveBtn").disabled = true;
      flash("saved", "Saved");
      tick();
    } else flash("saved", "Could not save", true);
  });
  const dlg = $("riskDialog");
  $("sendOn").addEventListener("click", () => { $("acceptRisk").checked = false; $("riskConfirm").disabled = true; dlg.showModal(); });
  $("acceptRisk").addEventListener("change", () => ($("riskConfirm").disabled = !$("acceptRisk").checked));
  $("riskCancel").addEventListener("click", () => dlg.close());
  $("riskConfirm").addEventListener("click", async () => {
    const r = await post("/sending", { on: true, acceptRisk: $("acceptRisk").checked });
    dlg.close();
    flash("sendMsg", r.ok ? "Sending is on" : "Could not turn it on", !r.ok);
    tick();
  });
  $("sendOff").addEventListener("click", async () => {
    const r = await post("/sending", { on: false });
    const out = await r.json().catch(() => ({}));
    flash("sendMsg", "Sending is off" + (out.cancelled ? ", " + out.cancelled + " waiting stopped" : ""));
    tick();
  });
  $("clearQueue").addEventListener("click", async () => {
    const out = await (await post("/outbox-clear")).json().catch(() => ({}));
    flash("sendMsg", (out.cancelled || 0) + " stopped");
    tick();
  });
  $("testAlert").addEventListener("click", async () => {
    await post("/test-alert");
    flash("saved", "Alert sent, check the corner of your screen");
  });
  for (const [name, who] of [["gemini", "Google"], ["openai", "OpenAI"]]) {
    $(name + "Form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $(name + "Form").key;
      if (!input.value.trim()) return;
      $(name + "Msg").className = "msg";
      $(name + "Msg").textContent = "Checking with " + who + "...";
      const r = await post("/" + name + "-key", { key: input.value });
      const out = await r.json().catch(() => ({}));
      if (r.ok) { input.value = ""; flash(name + "Msg", "Key saved"); }
      else flash(name + "Msg", out.error || "Could not save the key", true);
      tick();
    });
    $(name + "Remove").addEventListener("click", async () => {
      await post("/" + name + "-key", { key: null });
      flash(name + "Msg", "Key removed");
      tick();
    });
  }
  $("voiceWith").addEventListener("change", async () => {
    await post("/settings", { voiceWith: $("voiceWith").value });
    tick();
  });
  $("scan").addEventListener("click", async () => {
    await post("/connect");
    location.href = base;
  });
  $("reconnect").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    await post("/reconnect");
    setTimeout(() => { b.disabled = false; tick(); }, 3000);
  });

  tick();
  setInterval(tick, 3000);
</script>
</body>
</html>`;
}
