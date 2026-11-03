// The one page a person sees: a QR that refreshes by itself, then "connected".

export function linkPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect WhatsApp</title>
<style>
  :root { color-scheme: light; --ink: #111418; --muted: #5b6470; --line: #dfe3e8; --ok: #0a7d4f; --bad: #b3261e; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f5f6f8; color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  main { width: 100%; max-width: 420px; background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
  h1 { font-size: 22px; line-height: 1.3; margin: 0 0 16px; }
  ol { margin: 0 0 20px; padding-left: 22px; color: var(--muted); }
  #qr { width: 100%; aspect-ratio: 1; display: flex; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); text-align: center; padding: 8px; }
  #qr svg { width: 100%; height: 100%; display: block; }
  #note { margin: 14px 0 0; color: var(--muted); font-size: 14px; }
  .ok h1 { color: var(--ok); }
  .bad h1 { color: var(--bad); }
  .done #qr, .done ol { display: none; }
</style>
</head>
<body>
<main id="box">
  <h1 id="title">Connect WhatsApp</h1>
  <ol>
    <li>Open WhatsApp on your phone</li>
    <li>Settings &gt; Linked Devices &gt; Link a Device</li>
    <li>Scan the QR below</li>
  </ol>
  <div id="qr">Getting ready</div>
  <p id="note">The QR changes by itself when it expires. No need to refresh.</p>
</main>
<script>
  const base = location.pathname.replace(/\\/$/, "");
  const $ = (id) => document.getElementById(id);
  let last = null;
  async function tick() {
    let s;
    try { s = await (await fetch(base + "/state")).json(); }
    catch { $("note").textContent = "Can't reach the program on this computer. Open Claude and try again."; return; }
    if (s.status === "connected") {
      $("box").className = "ok done";
      $("title").textContent = "Connected";
      $("note").textContent = (s.phone ? "+" + s.phone + " is linked. " : "") + "You can close this page and go back to Claude.";
    } else if (s.svg) {
      $("box").className = "";
      $("title").textContent = "Connect WhatsApp";
      if (s.svg !== last) { $("qr").innerHTML = s.svg; last = s.svg; }
      $("note").textContent = "The QR changes by itself when it expires. No need to refresh.";
    } else if (s.status === "logged_out") {
      $("box").className = "bad done";
      $("title").textContent = "The link was removed on the phone";
      $("note").textContent = "Go back to Claude and say: reconnect my WhatsApp.";
    } else {
      $("box").className = "";
      $("qr").textContent = "Connecting to WhatsApp, one moment";
      last = null;
    }
  }
  tick();
  setInterval(tick, 2000);
</script>
</body>
</html>`;
}
