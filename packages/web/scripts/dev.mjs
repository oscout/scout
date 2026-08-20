#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, hostname as osHostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenScoutWebRoutes } from "../shared/runtime-config.js";
import {
  renderScoutAsciiMarkHtml,
  renderScoutAsciiMarkScript,
} from "@openscout/runtime/scout-ascii-mark";

const DEFAULT_PORTS = {
  broker: 43110,
  web: 43120,
  vite: 43122,
  pairing: 43130,
};
const DEFAULT_SCOUT_WEB_DOMAIN = "scout.local";
const WORKTREE_PORT_BASES = {
  web: 43200,
  vite: 43900,
  pairing: 44600,
};
const WORKTREE_PORT_RANGE = 700;

function parseFlags(argv) {
  const flags = {};
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const [name, inlineValue] =
      eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const nextArg = args[i + 1];
    const value = inlineValue ?? (!nextArg?.startsWith("-") ? nextArg : undefined);
    if (eq < 0 && value !== undefined) {
      i += 1;
    }
    if (name === "--port" || name === "-p") {
      flags.port = value;
    } else if (name === "--vite-port") {
      flags.vitePort = value;
    } else if (name === "--pairing-port") {
      flags.pairingPort = value;
    } else if (name === "--host") {
      flags.host = value;
    } else if (name === "--local-name") {
      flags.localName = value;
    } else if (name === "--edge") {
      flags.edge = true;
    } else if (name === "--http") {
      flags.edge = true;
      flags.edgeScheme = "http";
    } else if (name === "--https") {
      flags.edge = true;
      flags.edgeScheme = "https";
    } else if (name === "--both") {
      flags.edge = true;
      flags.edgeScheme = "both";
    } else if (name === "--caddy-bin") {
      flags.caddyBin = value;
    }
  }
  return flags;
}

function safeGit(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
    }).trim() || null;
  } catch {
    return null;
  }
}

function resolveGitContext(cwd) {
  const worktreeRoot = safeGit(["rev-parse", "--show-toplevel"], cwd);
  const commonGitDir = safeGit(["rev-parse", "--git-common-dir"], cwd);
  if (!worktreeRoot || !commonGitDir) {
    return null;
  }
  const commonRoot = resolve(cwd, commonGitDir, "..");
  return {
    worktreeRoot: resolve(worktreeRoot),
    commonRoot,
    isWorktree: resolve(worktreeRoot) !== commonRoot,
  };
}

function worktreeSlot(input) {
  return createHash("sha256").update(input).digest().readUInt16BE(0) % WORKTREE_PORT_RANGE;
}

function resolvePortDefaults(packageDir) {
  const gitContext = resolveGitContext(packageDir);
  if (!gitContext) {
    return {
      gitContext: null,
      brokerPort: DEFAULT_PORTS.broker,
      webPort: DEFAULT_PORTS.web,
      vitePort: DEFAULT_PORTS.vite,
      pairingPort: DEFAULT_PORTS.pairing,
    };
  }

  if (!gitContext.isWorktree) {
    return {
      gitContext,
      brokerPort: DEFAULT_PORTS.broker,
      webPort: DEFAULT_PORTS.web,
      vitePort: DEFAULT_PORTS.vite,
      pairingPort: DEFAULT_PORTS.pairing,
    };
  }

  const slot = worktreeSlot(gitContext.worktreeRoot);
  return {
    gitContext,
    brokerPort: DEFAULT_PORTS.broker,
    webPort: WORKTREE_PORT_BASES.web + slot,
    vitePort: WORKTREE_PORT_BASES.vite + slot,
    pairingPort: WORKTREE_PORT_BASES.pairing + slot,
  };
}

function resolveDevStateRoot(gitContext) {
  return resolve(
    gitContext?.commonRoot || resolve(packageDirectory, "..", ".."),
    ".openscout/dev/web",
  );
}

function resolveDevLocalEdgeRoot() {
  return resolve(homedir(), ".scout", "local-edge");
}

function loopbackHost(hostname) {
  return hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
}

function parsePort(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
}

function portLabel(port) {
  return String(port);
}

function normalizeLocalHostnameLabel(value) {
  const firstLabel = value
    ?.trim()
    .replace(/\.local\.?$/i, "")
    .split(".")
    .find((part) => part.trim().length > 0)
    ?.trim();
  const normalized = firstLabel
    ?.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || "localhost";
}

function defaultScoutNodeHostname() {
  return `${normalizeLocalHostnameLabel(osHostname())}.${DEFAULT_SCOUT_WEB_DOMAIN}`;
}

function normalizeLocalHostname(value) {
  const trimmed = value?.trim().replace(/\.$/, "").toLowerCase();
  const labels = trimmed
    ?.split(".")
    .map((label) =>
      label
        .trim()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-")
    )
    .filter(Boolean);
  return labels && labels.length > 0 ? labels.join(".") : "localhost";
}

function resolveScoutWebNamedHostname(name) {
  const normalized = normalizeLocalHostname(name);
  return normalized.includes(".") ? normalized : `${normalized}.${DEFAULT_SCOUT_WEB_DOMAIN}`;
}

function readLocalWebName() {
  const configPath = resolve(process.env.OPENSCOUT_HOME || resolve(homedir(), ".openscout"), "config.json");
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof config.webLocalName === "string" && config.webLocalName.trim()
      ? config.webLocalName.trim()
      : null;
  } catch {
    return null;
  }
}

async function isPortOpenable(hostname, port) {
  return await new Promise((resolveOpenable) => {
    const server = createServer();
    let done = false;
    const finish = (value) => {
      if (done) {
        return;
      }
      done = true;
      resolveOpenable(value);
    };

    server.unref();
    server.once("error", () => finish(false));
    server.listen(
      {
        host: hostname,
        port,
        exclusive: true,
      },
      () => {
        server.close(() => finish(true));
      },
    );
  });
}

async function findAvailablePort(startPort, hostname, reservedPorts, options = {}) {
  const requireNeighborFree = options.requireNeighborFree ?? false;

  for (let port = startPort; port < 65535; port += 1) {
    if (reservedPorts.has(port)) {
      continue;
    }
    if (!await isPortOpenable(hostname, port)) {
      continue;
    }
    if (requireNeighborFree) {
      const neighbor = port + 1;
      if (neighbor >= 65535 || reservedPorts.has(neighbor) || !await isPortOpenable(hostname, neighbor)) {
        continue;
      }
    }
    return port;
  }

  throw new Error(`Could not find an open port starting from ${startPort}.`);
}

async function canResolveHost(hostname) {
  try {
    await lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fetchOk(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHttpOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchOk(url)) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

function resolveEdgeScheme(value) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "both";
  }
  if (normalized === "http" || normalized === "https" || normalized === "both") {
    return normalized;
  }
  console.error("@openscout/web: --edge scheme must be http, https, or both.");
  process.exit(1);
}

function edgeSchemes(scheme) {
  return scheme === "both" ? ["http", "https"] : [scheme];
}

function preferredEdgeScheme(scheme) {
  return scheme === "https" ? "https" : "http";
}

function renderDevStartPage() {
  const pageConfig = JSON.stringify({ startPath: "/__openscout/web/start" });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Start Scout</title>
  <script>
    (function () {
      var theme = "dark";
      try {
        var query = new URLSearchParams(window.location.search).get("theme");
        var stored = JSON.parse(window.localStorage.getItem("openscout.theme") || "{}").theme;
        var preference = query || stored;
        if (preference === "light") theme = "light";
        if (preference === "system") {
          theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
        }
      } catch {}
      document.documentElement.dataset.scoutTheme = theme;
    })();
  </script>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #080a07;
      --surface: #10130e;
      --ink: #f5f1e8;
      --muted: #aaa69b;
      --edge: #303729;
      --accent: #a6e15e;
      --orb-0: #2a2723;
      --orb-1: #444038;
      --orb-2: #6d675a;
      --orb-3: #9a9181;
      --orb-4: #d8d0c0;
      font-family: "Inter Tight", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 28px;
      background: var(--bg);
    }
    main {
      width: min(640px, 100%);
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 14px;
      margin-bottom: 36px;
      border-bottom: 1px solid color-mix(in srgb, var(--edge) 80%, transparent);
    }
    .host {
      overflow: hidden;
      color: var(--muted);
      font: 500 11px/1.2 ui-monospace, "SF Mono", Menlo, monospace;
      letter-spacing: 0.08em;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .service {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0.01em;
      white-space: nowrap;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px 36px;
      align-items: center;
    }
    .orb {
      position: relative;
      justify-self: end;
      user-select: none;
      pointer-events: none;
    }
    .orb-l {
      margin: 0;
      color: var(--orb-0);
      font: 400 5px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: 0;
      white-space: pre;
      -webkit-font-smoothing: none;
      -moz-osx-font-smoothing: unset;
      font-smooth: never;
      text-rendering: geometricPrecision;
      font-variant-ligatures: none;
      font-kerning: none;
    }
    .orb-l + .orb-l { position: absolute; inset: 0; }
    .orb-l[data-t="1"] { color: var(--orb-1); }
    .orb-l[data-t="2"] { color: var(--orb-2); }
    .orb-l[data-t="3"] { color: var(--orb-3); }
    .orb-l[data-t="4"] { color: var(--orb-4); }
    h1 {
      margin-bottom: 10px;
      color: var(--ink);
      font-size: clamp(24px, 3.6vw, 28px);
      font-weight: 560;
      letter-spacing: -0.04em;
      line-height: 1.12;
    }
    p {
      max-width: 34ch;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
      margin-bottom: 22px;
    }
    button {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid var(--edge);
      border-radius: 8px;
      padding: 0 14px;
      background: var(--surface);
      color: var(--ink);
      font: inherit;
      font-size: 13px;
      font-weight: 550;
      letter-spacing: -0.015em;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
    }
    button:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--accent) 42%, var(--edge));
      background: color-mix(in srgb, var(--surface) 88%, var(--accent));
    }
    button:active:not(:disabled) {
      background: color-mix(in srgb, var(--surface) 78%, var(--accent));
    }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button:disabled { cursor: progress; opacity: 0.55; }
    .button-arrow {
      color: var(--accent);
      font-size: 14px;
      font-weight: 500;
      line-height: 1;
      transition: transform 120ms ease;
    }
    button:hover:not(:disabled) .button-arrow { transform: translateX(1px); }
    .progress {
      width: min(220px, 100%);
      height: 1px;
      margin-top: 18px;
      border-radius: 1px;
      background: color-mix(in srgb, var(--edge) 70%, transparent);
      overflow: hidden;
      opacity: 0;
      transition: opacity 120ms ease;
    }
    main.is-waiting .progress { opacity: 1; }
    @keyframes sweep {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(500%); }
    }
    .progress-bar {
      height: 100%;
      width: 20%;
      border-radius: 1px;
      background: var(--accent);
      transform: translateX(-100%);
    }
    .progress-bar.running {
      animation: sweep 1.5s ease-in-out infinite;
    }
    output {
      display: block;
      min-height: 16px;
      margin-top: 10px;
      color: var(--muted);
      font-family: ui-monospace, "SF Mono", Menlo, "Cascadia Code", monospace;
      font-size: 11px;
      line-height: 1.4;
    }
    :root[data-scout-theme="dark"] { color-scheme: dark; }
    :root[data-scout-theme="light"] {
      color-scheme: light;
      --bg: #f3f1ea;
      --surface: #fbfaf5;
      --ink: #171914;
      --muted: #65655d;
      --edge: #c6c8ba;
      --accent: #3a6807;
      --orb-0: #d2cec4;
      --orb-1: #a19d94;
      --orb-2: #717068;
      --orb-3: #484b44;
      --orb-4: #1c2019;
    }
    @media (max-width: 520px) {
      body { place-items: start center; padding: 24px 20px; }
      main { padding-top: 10vh; }
      .brand { margin-bottom: 28px; }
      .service { display: none; }
      .hero { grid-template-columns: 1fr; gap: 28px; }
      .orb { order: -1; justify-self: start; }
      .orb-l { font-size: 4.5px; }
      h1 { font-size: clamp(22px, 6.5vw, 26px); }
      p { max-width: none; }
      button { width: 100%; }
      .progress { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      button, .button-arrow, .progress { transition: none; }
      button:hover:not(:disabled) .button-arrow { transform: none; }
      .progress-bar.running { animation: none; transform: none; width: 100%; }
    }
  </style>
</head>
<body>
  <main id="shell">
    <div class="brand">
      <span class="host" id="host">Scout local</span>
      <span class="service">Local web service</span>
    </div>
    <div class="hero">
      <section>
        <h1>Bring Scout online.</h1>
        <p>The web interface is not running yet. Start it to return to your agents, messages, and activity.</p>
        <button id="start" type="button"><span>Start Scout</span><span class="button-arrow" aria-hidden="true">→</span></button>
        <div class="progress"><div class="progress-bar" id="bar"></div></div>
        <output id="status" role="status"></output>
      </section>
      <div class="orb" aria-hidden="true">${renderScoutAsciiMarkHtml()}</div>
    </div>
  </main>
  ${renderScoutAsciiMarkScript()}
  <script>
    const config = ${pageConfig};
    const shell = document.getElementById('shell');
    const host = document.getElementById('host');
    const button = document.getElementById('start');
    const bar = document.getElementById('bar');
    const status = document.getElementById('status');
    const targetPath = window.location.pathname + window.location.search + window.location.hash;
    const healthUrl = new URL('/api/health', window.location.origin);
    const startUrl = new URL(config.startPath, window.location.origin);
    host.textContent = window.location.host;

    function setStatus(message) {
      status.textContent = message;
    }

    function setWaiting(on) {
      shell.classList.toggle('is-waiting', on);
      bar.classList.toggle('running', on);
    }

    async function waitForWeb() {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(healthUrl, { headers: { accept: 'application/json' }, cache: 'no-store' });
          if (response.ok) {
            const body = await response.json();
            if (body && body.ok === true) {
              window.location.replace(targetPath || '/');
              return true;
            }
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return false;
    }

    button.addEventListener('click', async () => {
      button.disabled = true;
      setWaiting(true);
      setStatus('Starting Scout web...');
      try {
        const response = await fetch(startUrl, {
          method: 'POST',
          headers: { accept: 'application/json' },
        });
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          throw new Error('Scout broker is not reachable yet.');
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.error) {
          throw new Error(body.error || 'Scout web did not start.');
        }
        setStatus('Waiting for the web app...');
        const ready = await waitForWeb();
        if (!ready) {
          setWaiting(false);
          setStatus('Scout web did not become ready. Try again in a moment.');
          button.disabled = false;
        }
      } catch (error) {
        setWaiting(false);
        setStatus(error instanceof Error ? error.message : String(error));
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function renderDevCaddyfile({ portalHost, scheme, upstream, brokerUrl }) {
  const brokerUpstream = new URL(brokerUrl).host;
  const startPage = renderDevStartPage();
  return edgeSchemes(scheme)
    .flatMap((currentScheme) =>
      [portalHost, `*.${portalHost}`].map((host) => {
        const caddyHost = currentScheme === "http" ? `http://${host}` : host;
        return `${caddyHost} {\n`
          + (currentScheme === "https" ? "  tls internal\n" : "")
          + `  @openscout_web_start_local {\n`
          + `    path /__openscout/web/start\n`
          + `    remote_ip 127.0.0.1 ::1\n`
          + `  }\n`
          + `  handle @openscout_web_start_local {\n`
          + `    rewrite * /v1/web/start\n`
          + `    reverse_proxy ${brokerUpstream}\n`
          + `  }\n`
          + `  handle /__openscout/web/start {\n`
          + `    respond "Forbidden" 403\n`
          + `  }\n`
          + `  @openscout_web_status_local {\n`
          + `    path /__openscout/web/status\n`
          + `    remote_ip 127.0.0.1 ::1\n`
          + `  }\n`
          + `  handle @openscout_web_status_local {\n`
          + `    rewrite * /v1/web/status\n`
          + `    reverse_proxy ${brokerUpstream}\n`
          + `  }\n`
          + `  handle /__openscout/web/status {\n`
          + `    respond "Forbidden" 403\n`
          + `  }\n`
          + `  handle /ws/hmr* {\n`
          + `    reverse_proxy ${upstream}\n`
          + `  }\n`
          + `  handle {\n`
          + `    reverse_proxy ${upstream} {\n`
          + `      lb_try_duration 15s\n`
          + `      lb_try_interval 500ms\n`
          + `    }\n`
          + `  }\n`
          + `  handle_errors {\n`
          + `    header Content-Type "text/html; charset=utf-8"\n`
          + `    respond <<HTML\n`
          + `${startPage}\n`
          + `HTML 200\n`
          + `  }\n`
          + `}`;
      }),
    )
    .join("\n\n") + "\n";
}

function spawnMdnsProxy({ name, host, port, scheme }) {
  return spawn("/usr/bin/dns-sd", [
    "-P",
    name,
    scheme === "https" ? "_https._tcp" : "_http._tcp",
    "local",
    String(port),
    host,
    "127.0.0.1",
    "path=/",
  ], {
    stdio: "ignore",
  });
}

function spawnLocalEdge({
  caddyBin,
  portalHost,
  advertisedHost,
  scheme,
  upstream,
  brokerUrl,
}) {
  mkdirSync(resolveDevLocalEdgeRoot(), { recursive: true });
  const caddyfilePath = resolve(resolveDevLocalEdgeRoot(), "dev-Caddyfile");
  writeFileSync(
    caddyfilePath,
    renderDevCaddyfile({
      portalHost,
      scheme,
      upstream,
      brokerUrl,
    }),
    "utf8",
  );

  const mdns = edgeSchemes(scheme).flatMap((currentScheme) => {
    const edgePort = currentScheme === "https" ? 443 : 80;
    const suffix = currentScheme.toUpperCase();
    return [
      spawnMdnsProxy({
        name: `Scout Local Dev ${suffix}`,
        host: portalHost,
        port: edgePort,
        scheme: currentScheme,
      }),
      spawnMdnsProxy({
        name: `Scout ${advertisedHost} Dev ${suffix}`,
        host: advertisedHost,
        port: edgePort,
        scheme: currentScheme,
      }),
    ];
  });

  const caddy = spawn(caddyBin, [
    "run",
    "--config",
    caddyfilePath,
    "--adapter",
    "caddyfile",
  ], {
    stdio: "inherit",
  });

  return { caddy, caddyfilePath, mdns };
}

const flags = parseFlags(process.argv);

if (flags.help) {
  console.log(`@openscout/web dev

Usage: bun dev [options]

Options:
  -p, --port <n>       Bun app port
      --vite-port <n>  Vite asset port
      --pairing-port <n>
                       Pairing bridge port
      --host <h>       Bind host (default 127.0.0.1; explicit non-loopback opts into LAN)
      --local-name <n> Node hostname or short alias to advertise (default <machine>.scout.local)
      --edge           Publish scout.local names and run Caddy against the chosen web port
      --http           With --edge, serve only local HTTP on port 80
      --https          With --edge, serve only local HTTPS on port 443
      --both           With --edge, serve HTTP and HTTPS (default)
      --caddy-bin <p>  Caddy executable (default caddy, env OPENSCOUT_CADDY_BIN)
  -h, --help           Show this help

Notes:
  Main checkout prefers 43120/43122/43130.
  Extra git worktrees prefer isolated port bands automatically.
  If a preferred port is busy, dev mode increments until it finds an open one.
  Local edge mode requires Caddy and macOS dns-sd.

Examples:
  bun dev
  bun dev --edge --local-name m1
  bun dev --port 43200
  bun dev --port 43200 --vite-port 43900 --pairing-port 44600
`);
  process.exit(0);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const viteBin = resolve(packageDirectory, "node_modules/vite/bin/vite.js");
const viteSocketGuard = resolve(scriptDirectory, "vite-socket-guard.mjs");
const serverEntry = resolve(packageDirectory, "server/index.ts");

if (!existsSync(viteBin)) {
  console.error(
    "@openscout/web: missing local Vite install. Run the workspace install first.",
  );
  process.exit(1);
}

const portDefaults = resolvePortDefaults(packageDirectory);
const routes = resolveOpenScoutWebRoutes(process.env);
const publicHost = flags.host
  || process.env.OPENSCOUT_WEB_HOST?.trim()
  || process.env.SCOUT_WEB_HOST?.trim()
  || "127.0.0.1";
const internalHost = loopbackHost(publicHost);
const configuredLocalName = flags.localName
  || process.env.OPENSCOUT_WEB_LOCAL_NAME?.trim()
  || readLocalWebName()
  || defaultScoutNodeHostname();
const portalHost = DEFAULT_SCOUT_WEB_DOMAIN;
const advertisedHost = process.env.OPENSCOUT_WEB_ADVERTISED_HOST?.trim()
  || resolveScoutWebNamedHostname(configuredLocalName);
const edgeEnabled = Boolean(flags.edge);
const edgeScheme = resolveEdgeScheme(flags.edgeScheme || process.env.OPENSCOUT_WEB_EDGE_SCHEME);
const edgePublicOrigin = edgeEnabled
  ? `${preferredEdgeScheme(edgeScheme)}://${portalHost}`
  : null;
const edgeHmrScheme = preferredEdgeScheme(edgeScheme);
const edgeHmrClientPort = edgeHmrScheme === "https" ? 443 : 80;
const brokerPort = parsePort(process.env.OPENSCOUT_BROKER_PORT)
  ?? portDefaults.brokerPort
  ?? DEFAULT_PORTS.broker;
const brokerUrl = process.env.OPENSCOUT_BROKER_URL?.trim()
  || `http://127.0.0.1:${portLabel(brokerPort)}`;
const explicitWebPort = parsePort(flags.port)
  ?? parsePort(process.env.OPENSCOUT_WEB_PORT)
  ?? parsePort(process.env.SCOUT_WEB_PORT);
const explicitPairingPort = parsePort(flags.pairingPort)
  ?? parsePort(process.env.OPENSCOUT_PAIRING_PORT)
  ?? parsePort(process.env.SCOUT_PAIRING_PORT);
const configuredViteUrl = process.env.OPENSCOUT_WEB_VITE_URL?.trim() || null;
const defaultViteUrl = configuredViteUrl
  || `http://${internalHost}:${portLabel(portDefaults.vitePort)}`;
const viteUrl = new URL(defaultViteUrl);
if (flags.host && !configuredViteUrl) {
  viteUrl.hostname = internalHost;
}
const explicitVitePort = parsePort(flags.vitePort)
  ?? (configuredViteUrl ? parsePort(viteUrl.port) : null);
const reservedPorts = new Set();

const bunPort = explicitWebPort ?? await findAvailablePort(
  portDefaults.webPort,
  internalHost,
  reservedPorts,
  { requireNeighborFree: true },
);
reservedPorts.add(bunPort);
reservedPorts.add(bunPort + 1);

const vitePort = explicitVitePort ?? await findAvailablePort(
  portDefaults.vitePort,
  internalHost,
  reservedPorts,
);
reservedPorts.add(vitePort);
viteUrl.port = portLabel(vitePort);

const pairingPort = explicitPairingPort ?? await findAvailablePort(
  portDefaults.pairingPort,
  internalHost,
  reservedPorts,
);

const viteHost = flags.host || viteUrl.hostname || "127.0.0.1";
const stateRoot = resolveDevStateRoot(portDefaults.gitContext);
const stateFile = resolve(
  stateRoot,
  "runs",
  `${Date.now()}-${process.pid}.json`,
);
const env = {
  ...process.env,
  OPENSCOUT_SETUP_CWD: portDefaults.gitContext?.worktreeRoot || process.cwd(),
  OPENSCOUT_WEB_HOST: publicHost,
  ...(flags.host && !["127.0.0.1", "localhost", "::1"].includes(flags.host)
    ? { OPENSCOUT_WEB_ALLOW_LAN: "1" }
    : {}),
  OPENSCOUT_WEB_PORT: portLabel(bunPort),
  OPENSCOUT_WEB_VITE_URL: viteUrl.origin,
  OPENSCOUT_WEB_BUN_URL: `http://${internalHost}:${portLabel(bunPort)}`,
  OPENSCOUT_WEB_VITE_HMR_PATH: routes.viteHmrPath,
  OPENSCOUT_WEB_TERMINAL_RELAY_PATH: routes.terminalRelayPath,
  OPENSCOUT_WEB_DEV_STATE_FILE: stateFile,
  OPENSCOUT_PAIRING_PORT: portLabel(pairingPort),
};
if (edgeEnabled) {
  env.OPENSCOUT_WEB_VITE_HMR_PROTOCOL = edgeHmrScheme === "https" ? "wss" : "ws";
  env.OPENSCOUT_WEB_VITE_HMR_CLIENT_PORT = portLabel(edgeHmrClientPort);
}
if (!process.env.OPENSCOUT_WEB_FLAG_BUNDLE?.trim()
  && !process.env.OPENSCOUT_WEB_EXPERIENCE?.trim()
  && !process.env.OPENSCOUT_WEB_AB_VARIANT?.trim()) {
  env.OPENSCOUT_WEB_FLAG_BUNDLE = "max-pro";
}
if (edgePublicOrigin && !process.env.OPENSCOUT_WEB_PUBLIC_ORIGIN?.trim()) {
  env.OPENSCOUT_WEB_PUBLIC_ORIGIN = edgePublicOrigin;
}
if (configuredLocalName) {
  env.OPENSCOUT_WEB_LOCAL_NAME = configuredLocalName;
}
env.OPENSCOUT_WEB_PORTAL_HOST = portalHost;
if (process.env.OPENSCOUT_WEB_ADVERTISED_HOST?.trim()) {
  env.OPENSCOUT_WEB_ADVERTISED_HOST = process.env.OPENSCOUT_WEB_ADVERTISED_HOST.trim();
}

if (portDefaults.gitContext?.isWorktree && !process.env.OPENSCOUT_PAIRING_HOME?.trim()) {
  env.OPENSCOUT_PAIRING_HOME = resolve(
    portDefaults.gitContext.worktreeRoot,
    ".openscout/pairing",
  );
}

const modeLabel = portDefaults.gitContext?.isWorktree
  ? `worktree ${portDefaults.gitContext.worktreeRoot}`
  : "main checkout";
const openUrl = `http://${advertisedHost}:${portLabel(bunPort)}`;
const portalUrl = `http://${portalHost}:${portLabel(bunPort)}`;
const edgeSchemeLabel = edgePublicOrigin?.startsWith("https:") ? "https" : "http";
const edgePortalUrl = edgeEnabled ? `${edgeSchemeLabel}://${portalHost}` : null;
const edgeNodeUrl = edgeEnabled ? `${edgeSchemeLabel}://${advertisedHost}` : null;
const fallbackUrl = `http://127.0.0.1:${portLabel(bunPort)}`;
const advertisedHostResolves = await canResolveHost(advertisedHost);
const portalHostResolves = await canResolveHost(portalHost);
console.log(
  `@openscout/web dev -> ${modeLabel}\n`
  + `  bun:     http://${publicHost}:${portLabel(bunPort)}\n`
  + `  portal:  ${portalUrl}${portalHostResolves ? "" : "  (name not resolving yet)"}\n`
  + `  node:    ${openUrl}${advertisedHostResolves ? "" : "  (name not resolving yet)"}\n`
  + (edgeEnabled
    ? `  edge:    ${edgePortalUrl} -> 127.0.0.1:${portLabel(bunPort)}\n`
      + `  edge node: ${edgeNodeUrl} -> 127.0.0.1:${portLabel(bunPort)}\n`
    : "")
  + `  local:   ${fallbackUrl}\n`
  + `  vite:    ${viteUrl.origin}  (internal asset server)\n`
  + `  pairing: ${portLabel(pairingPort)}`
  + (portalHostResolves && advertisedHostResolves
    ? ""
    : `\n  note:    configure DNS/hosts/Caddy for ${portalHost} and ${advertisedHost}; until then use ${fallbackUrl}`),
);

function spawnVite() {
  const viteEnv = {
    ...env,
    NODE_OPTIONS: [
      env.NODE_OPTIONS,
      `--import=${viteSocketGuard}`,
    ].filter(Boolean).join(" "),
  };

  return spawn(
    process.execPath,
    [viteBin, "--host", viteHost, "--port", portLabel(vitePort), "--strictPort"],
    {
      cwd: packageDirectory,
      env: viteEnv,
      stdio: "inherit",
    },
  );
}

function spawnServer() {
  return spawn("bun", ["run", "--hot", serverEntry], {
    cwd: packageDirectory,
    env,
    stdio: "inherit",
  });
}

const localEdge = edgeEnabled
  ? spawnLocalEdge({
    caddyBin: flags.caddyBin || process.env.OPENSCOUT_CADDY_BIN?.trim() || "caddy",
    portalHost,
    advertisedHost,
    scheme: edgeScheme,
    upstream: `127.0.0.1:${portLabel(bunPort)}`,
    brokerUrl,
  })
  : null;

const children = {
  vite: null,
  server: null,
  edge: localEdge?.caddy ?? null,
};
const mdnsProcesses = localEdge?.mdns ?? [];

let exiting = false;
const viteRestartWindowMs = 30_000;
const viteRestartLimit = 5;
let viteRestartTimestamps = [];

async function shutdown(code = 0) {
  if (exiting) {
    return;
  }
  exiting = true;
  for (const child of [...Object.values(children), ...mdnsProcesses]) {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }
  await rm(stateFile, { force: true }).catch(() => {});
  process.exit(code);
}

function attachChildHandlers(name, child) {
  child.on("error", (error) => {
    console.error(
      `@openscout/web: failed to start ${name} dev process: ${error.message}`,
    );
    void shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (exiting) {
      return;
    }
    if (signal === "SIGINT" || signal === "SIGTERM") {
      void shutdown(0);
      return;
    }

    if (name === "vite") {
      const now = Date.now();
      viteRestartTimestamps = viteRestartTimestamps.filter((ts) => now - ts < viteRestartWindowMs);
      viteRestartTimestamps.push(now);
      if (viteRestartTimestamps.length <= viteRestartLimit) {
        console.warn(
          `@openscout/web: vite exited (${signal ?? `code ${code ?? 0}`}); restarting so the Bun API server stays up.`,
        );
        children.vite = spawnVite();
        attachChildHandlers("vite", children.vite);
        return;
      }
      console.error("@openscout/web: vite is crash-looping; shutting down dev stack.");
    }

    void shutdown(code ?? 1);
  });
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

children.server = spawnServer();
attachChildHandlers("server", children.server);
if (children.edge) {
  attachChildHandlers("local edge", children.edge);
}

const serverHealthUrl = `http://${internalHost}:${portLabel(bunPort)}${routes.healthPath}`;
if (!await waitForHttpOk(serverHealthUrl, 15_000) && !exiting) {
  console.warn(
    `@openscout/web: Bun app did not answer ${routes.healthPath} within 15s; starting Vite anyway.`,
  );
}
if (!exiting) {
  children.vite = spawnVite();
  attachChildHandlers("vite", children.vite);
}

try {
  await mkdir(resolve(stateRoot, "runs"), { recursive: true });
  await writeFile(
    stateFile,
    JSON.stringify({
      kind: "openscout-web-dev",
      version: 1,
      startedAt: new Date().toISOString(),
      repoRoot: portDefaults.gitContext?.commonRoot || resolve(packageDirectory, "..", ".."),
      worktreeRoot: portDefaults.gitContext?.worktreeRoot || resolve(packageDirectory, "..", ".."),
      packageDirectory,
      publicHost,
      internalHost,
      routes: {
        terminalRelayPath: routes.terminalRelayPath,
        viteHmrPath: routes.viteHmrPath,
      },
      ports: {
        web: bunPort,
        relay: bunPort + 1,
        vite: vitePort,
        pairing: pairingPort,
      },
      processes: {
        manager: process.pid,
        vite: children.vite?.pid ?? null,
        server: children.server?.pid ?? null,
        edge: children.edge?.pid ?? null,
      },
      localEdge: localEdge ? {
        enabled: true,
        scheme: edgeScheme,
        caddyfilePath: localEdge.caddyfilePath,
        portalUrl: edgePortalUrl,
        nodeUrl: edgeNodeUrl,
      } : {
        enabled: false,
      },
      pairingHome: env.OPENSCOUT_PAIRING_HOME || null,
    }, null, 2),
    "utf8",
  );
} catch (error) {
  console.warn(
    `@openscout/web: failed to record dev state at ${stateFile}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

process.on("exit", () => {
  try {
    rmSync(stateFile, { force: true });
  } catch {
    // best-effort exit cleanup
  }
});
