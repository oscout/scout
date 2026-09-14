import { SCOUT_WEB_LOGIN_API_PATH } from "./server-core.ts";

/**
 * Server-rendered operator login page for browsers no auto-issuance path
 * covers (Tailscale, LAN). Deliberately independent of the client bundle so
 * it works before any credential exists and never needs a vite build.
 */
export function renderScoutWebLoginPage(): string {
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
  .hint { font-size: 12px; color: var(--muted); margin-top: 18px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true"></div>
  <h1>Sign in to Scout</h1>
  <p>This portal needs the operator token once. It stays signed in after that.</p>
  <form id="login-form">
    <label for="token">Operator token</label>
    <input id="token" name="token" type="password" autocomplete="off" autofocus required>
    <button type="submit">Sign in</button>
    <div class="error" id="error" role="alert"></div>
  </form>
  <div class="hint">
    On the host, the token is at
    <code>&lt;support&gt;/runtime/web-auth-token</code>
    (or <code>$OPENSCOUT_WEB_AUTH_TOKEN</code>).
  </div>
</main>
<script>
  const form = document.getElementById("login-form");
  const input = document.getElementById("token");
  const error = document.getElementById("error");
  const button = form.querySelector("button");
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
        location.replace("/");
        return;
      }
      const body = await response.json().catch(() => null);
      error.textContent = (body && body.error) || ("Sign-in failed (" + response.status + ")");
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
