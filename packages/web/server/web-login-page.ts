import { SCOUT_WEB_LOGIN_API_PATH } from "./server-core.ts";

/**
 * Server-rendered operator login page for browsers no auto-issuance path
 * covers (Tailscale, LAN). Deliberately independent of the client bundle so
 * it works before any credential exists and never needs a vite build.
 */
export function renderScoutWebLoginPage(bootstrapPath = "/api/bootstrap.js"): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Scout — Sign in</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f6f4;
    --panel: #ffffff;
    --ink: #1a1c1a;
    --muted: #6b6f6b;
    --line: #d9dbd7;
    --accent: #0f8a5f;
    --danger: #b3403a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121412;
      --panel: #1a1d1a;
      --ink: #e8eae6;
      --muted: #8a8f8a;
      --line: #2a2e2a;
      --accent: #2bb583;
      --danger: #d76a63;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main {
    width: min(360px, calc(100vw - 32px));
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 28px;
  }
  .mark {
    width: 10px; height: 10px;
    background: var(--accent);
    transform: rotate(45deg);
    margin-bottom: 18px;
  }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 18px; color: var(--muted); }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  input {
    width: 100%;
    padding: 9px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
  }
  input:focus { outline: 1px solid var(--accent); outline-offset: 0; border-color: var(--accent); }
  button {
    width: 100%;
    margin-top: 14px;
    padding: 9px 10px;
    border: 0;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  button[disabled] { opacity: 0.6; cursor: default; }
  .error { color: var(--danger); font-size: 13px; margin-top: 12px; min-height: 1.2em; }
  summary { cursor: pointer; }
  details p { margin: 10px 0 0; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 18px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true"></div>
  <h1>Sign in to Scout</h1>
  <p id="sign-in-status" role="status">On this Mac, Scout signs you in automatically.</p>
  <form id="login-form">
    <input name="username" type="hidden" autocomplete="username" value="Scout host">
    <label for="token">Host access key</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    <div class="error" id="error" role="alert"></div>
  </form>
  <details class="hint" id="sign-in-help">
    <summary>Need help signing in?</summary>
    <p>Joining a channel? Open the invitation link your host sent you.</p>
    <p>If you run this Scout, open Chat on that Mac to sign in automatically.
    From another device, use the host access key (also called the operator token)
    saved at <code>~/Library/Application Support/OpenScout/runtime/web-auth-token</code>.</p>
  </details>
</main>
<script>
  const form = document.getElementById("login-form");
  const input = document.getElementById("token");
  const error = document.getElementById("error");
  const button = form.querySelector("button");
  const status = document.getElementById("sign-in-status");
  const help = document.getElementById("sign-in-help");
  const automaticSignIn = new AbortController();
  const next = new URL(location.href).searchParams.get("next");
  let destination = "/";
  if (next) {
    try {
      const target = new URL(next, location.origin);
      if (target.origin === location.origin && target.pathname !== "/login") {
        destination = target.pathname + target.search + target.hash;
      }
    } catch { /* Keep the local home destination. */ }
  }
  async function tryAutomaticSignIn() {
    form.hidden = true;
    help.hidden = true;
    status.textContent = "Signing you in…";
    const timeout = setTimeout(() => automaticSignIn.abort(), 5000);
    try {
      const response = await fetch(${JSON.stringify(bootstrapPath).replace(/</g, "\\u003c")}, {
        credentials: "same-origin",
        cache: "no-store",
        signal: automaticSignIn.signal,
      });
      if (response.ok) {
        location.replace(destination);
        return;
      }
    } catch { /* The key form remains available if local sign-in is unavailable. */ }
    finally { clearTimeout(timeout); }
    status.textContent = "Enter your host access key to sign in from this browser.";
    form.hidden = false;
    help.hidden = false;
    input.focus();
  }
  void tryAutomaticSignIn();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    button.disabled = true;
    try {
      const response = await fetch(${JSON.stringify(SCOUT_WEB_LOGIN_API_PATH)}, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: input.value.trim() }),
      });
      if (response.ok) {
        location.replace(destination);
        return;
      }
      const body = await response.json().catch(() => null);
      error.textContent = response.status === 401 ? "That key did not match. Check it and try again." : ((body && body.error) || "Could not sign in. Please try again.");
    } catch {
      error.textContent = "Sign-in failed — the server is unreachable.";
    } finally {
      button.disabled = false;
    }
  });
</script>
</body>
</html>
`;
}
