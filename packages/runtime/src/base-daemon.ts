import type { RuntimeErrnoError } from "./portable-types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLocalBrokerControlUrl,
  resolveBrokerServiceConfig,
  type BrokerServiceConfig,
} from "./broker-process-manager.js";
import {
  DEFAULT_SCOUT_WEB_PORTAL_HOST,
  resolveConfiguredScoutWebHostname,
  resolveScoutWebNamedHostname,
  resolveWebPort,
} from "./local-config.js";
import {
  renderOpenScoutCaddyfile,
  resolveOpenScoutLocalEdgeConfig,
  type OpenScoutLocalEdgeConfig,
  type OpenScoutLocalEdgeScheme,
} from "./local-edge.js";
import { openScoutNetworkServiceEnvironment } from "./open-scout-network.js";
import { readTailscaleSelfWebHostsSync } from "./tailscale.js";

const RESTART_MIN_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 30_000;
const BROKER_HEALTH_TIMEOUT_MS = 30_000;
const BROKER_HEALTH_POLL_MS = 250;
// Broker owns web shutdown and allows the web server 10s to drain. Base must
// give that child boundary enough room, while still finishing below scoutd's
// 18s outer child timeout.
const CHILD_SHUTDOWN_TIMEOUT_MS = 15_000;
const WEB_START_RETRY_MS = 5_000;
const MENU_BUNDLE_ID = "app.openscout.scout.menu";
const PROCESS_NAME = "scout-base";
// openscout-runtime.mjs runs broker-daemon in-process (no second bun child),
// so the process spawned here IS the broker; name it accordingly for ps/doctor.
const BROKER_PROCESS_NAME = "scout-broker";
const EDGE_PROCESS_NAME = "scout-edge";
const MDNS_PROCESS_NAME = "scout-mdns";

process.title = PROCESS_NAME;

let shuttingDown = false;
let brokerProcess: ChildProcess | null = null;
let caddyProcess: ChildProcess | null = null;
let mdnsProcesses: ChildProcess[] = [];
let brokerRestartDelayMs = RESTART_MIN_DELAY_MS;
let edgeRestartDelayMs = RESTART_MIN_DELAY_MS;
let baseKeepAlive: ReturnType<typeof setInterval> | null = null;
let webStartRetryTimer: ReturnType<typeof setTimeout> | null = null;
let webStartInFlight = false;
let parentWatcher: ReturnType<typeof setInterval> | null = null;

const parentPid = Number.parseInt(process.env.OPENSCOUT_PARENT_PID ?? "0", 10);

const config = resolveBrokerServiceConfig();
const brokerControlUrl = buildLocalBrokerControlUrl(config.brokerHost, config.brokerPort);

function log(message: string, details?: unknown): void {
  if (details === undefined) {
    console.log(`[openscout-base] ${message}`);
    return;
  }
  console.log(`[openscout-base] ${message}`, details);
}

function warn(message: string, details?: unknown): void {
  if (details === undefined) {
    console.warn(`[openscout-base] ${message}`);
    return;
  }
  console.warn(`[openscout-base] ${message}`, details);
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function appendCsvValues(input: string | undefined, values: string[]): string | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...splitCsv(input), ...values]) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out.length > 0 ? out.join(",") : undefined;
}

function resolveTailnetWebHosts(): string[] {
  return readTailscaleSelfWebHostsSync();
}

function resolveWebTrustedHostsEnv(): string | undefined {
  return appendCsvValues(process.env.OPENSCOUT_WEB_TRUSTED_HOSTS, resolveTailnetWebHosts());
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function logFile(name: string): number {
  const dir = join(config.supportDirectory, "logs", "base");
  ensureDirectory(dir);
  return openSync(join(dir, name), "a");
}

function runtimeEntrypoint(config: BrokerServiceConfig): string {
  return join(config.runtimePackageDir, "bin", "openscout-runtime.mjs");
}

function spawnBroker(): void {
  if (shuttingDown || brokerProcess) {
    return;
  }
  if (!config.bunExecutable) {
    warn("broker supervisor cannot start broker without Bun", {
      hint: "Use the headless broker entrypoint under Node or install Bun for the macOS base supervisor.",
    });
    scheduleBrokerRestart();
    return;
  }

  const webTrustedHostsEnv = resolveWebTrustedHostsEnv();
  const stdout = logFile("broker.stdout.log");
  const stderr = logFile("broker.stderr.log");
  brokerProcess = spawn(config.bunExecutable, [
    "run",
    runtimeEntrypoint(config),
    "broker",
  ], {
    argv0: BROKER_PROCESS_NAME,
    cwd: config.runtimePackageDir,
    env: {
      ...process.env,
      OPENSCOUT_PARENT_PID: String(process.pid),
      OPENSCOUT_BROKER_HOST: config.brokerHost,
      OPENSCOUT_BROKER_PORT: String(config.brokerPort),
      OPENSCOUT_BROKER_URL: config.brokerUrl,
      OPENSCOUT_BROKER_SOCKET_PATH: config.brokerSocketPath,
      OPENSCOUT_CONTROL_HOME: config.controlHome,
      OPENSCOUT_ADVERTISE_SCOPE: config.advertiseScope,
      ...openScoutNetworkServiceEnvironment(process.env),
      ...(webTrustedHostsEnv ? { OPENSCOUT_WEB_TRUSTED_HOSTS: webTrustedHostsEnv } : {}),
    },
    stdio: ["ignore", stdout, stderr],
  });

  log("broker started", { pid: brokerProcess.pid, url: config.brokerUrl });
  brokerProcess.once("exit", (code, signal) => {
    log("broker exited", { code, signal });
    brokerProcess = null;
    if (!shuttingDown) {
      scheduleBrokerRestart();
    }
  });
}

function scheduleBrokerRestart(): void {
  const delay = brokerRestartDelayMs;
  brokerRestartDelayMs = Math.min(brokerRestartDelayMs * 2, RESTART_MAX_DELAY_MS);
  setTimeout(() => {
    if (!shuttingDown) {
      spawnBroker();
      void startWebWhenBrokerIsReady();
    }
  }, delay).unref();
}

async function waitForBrokerHealth(timeoutMs = BROKER_HEALTH_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/health", brokerControlUrl), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const body = await response.json() as { ok?: boolean };
        if (body.ok === true) {
          brokerRestartDelayMs = RESTART_MIN_DELAY_MS;
          return true;
        }
      }
    } catch {
      // Broker is still starting.
    }
    await sleep(BROKER_HEALTH_POLL_MS);
  }
  return false;
}

function resolveEdgeScheme(): OpenScoutLocalEdgeScheme {
  const value = process.env.OPENSCOUT_WEB_EDGE_SCHEME?.trim().toLowerCase();
  if (value === "http" || value === "https" || value === "both") {
    return value;
  }
  return "http";
}

function forwardedProtoForEdgeScheme(scheme: OpenScoutLocalEdgeScheme): "http" | "https" {
  return scheme === "http" ? "http" : "https";
}

function resolveEdgeConfig(): OpenScoutLocalEdgeConfig {
  const portalHost = process.env.OPENSCOUT_WEB_PORTAL_HOST?.trim() || DEFAULT_SCOUT_WEB_PORTAL_HOST;
  const nodeHost = process.env.OPENSCOUT_WEB_ADVERTISED_HOST?.trim()
    || (process.env.OPENSCOUT_WEB_LOCAL_NAME?.trim()
      ? resolveScoutWebNamedHostname(process.env.OPENSCOUT_WEB_LOCAL_NAME)
      : resolveConfiguredScoutWebHostname());
  return resolveOpenScoutLocalEdgeConfig({
    portalHost,
    nodeHost,
    scheme: resolveEdgeScheme(),
    brokerPort: config.brokerPort,
    webPort: Number.parseInt(process.env.OPENSCOUT_WEB_PORT ?? "", 10) || resolveWebPort(),
    viteDevUrl: process.env.OPENSCOUT_WEB_VITE_URL,
    viteHmrPath: process.env.OPENSCOUT_WEB_VITE_HMR_PATH,
    extraHosts: [
      ...splitCsv(process.env.OPENSCOUT_WEB_TRUSTED_HOSTS),
      ...resolveTailnetWebHosts(),
    ],
  });
}

function resolveLocalEdgeCaddyfilePath(): string {
  const dir = join(homedir(), ".scout", "local-edge");
  ensureDirectory(dir);
  return join(dir, "Caddyfile");
}

function resolveCaddyExecutable(): string {
  return process.env.OPENSCOUT_CADDY_BIN?.trim() || "caddy";
}

function spawnMdnsProxy(input: {
  name: string;
  host: string;
  port: number;
  scheme: "http" | "https";
}): ChildProcess {
  return spawn("/usr/bin/dns-sd", [
    "-P",
    input.name,
    input.scheme === "https" ? "_https._tcp" : "_http._tcp",
    "local",
    String(input.port),
    input.host,
    "127.0.0.1",
    "path=/",
  ], {
    argv0: MDNS_PROCESS_NAME,
    stdio: ["ignore", logFile("mdns.stdout.log"), logFile("mdns.stderr.log")],
  });
}

function stopEdgeProcesses(): void {
  for (const processRef of mdnsProcesses) {
    if (!processRef.killed) {
      processRef.kill("SIGTERM");
    }
  }
  mdnsProcesses = [];
  if (caddyProcess && !caddyProcess.killed) {
    caddyProcess.kill("SIGTERM");
  }
  caddyProcess = null;
}

function startLocalEdge(): void {
  if (process.env.OPENSCOUT_BASE_EDGE_ENABLED === "0" || process.platform !== "darwin") {
    return;
  }
  if (shuttingDown || caddyProcess) {
    return;
  }

  const edgeConfig = resolveEdgeConfig();
  const schemes = edgeConfig.scheme === "both" ? ["http", "https"] as const : [edgeConfig.scheme] as const;
  const caddyfilePath = resolveLocalEdgeCaddyfilePath();
  writeFileSync(caddyfilePath, renderOpenScoutCaddyfile(edgeConfig), "utf8");

  mdnsProcesses = schemes.flatMap((scheme) => {
    const edgePort = scheme === "https" ? 443 : 80;
    const suffix = scheme.toUpperCase();
    return [
      spawnMdnsProxy({
        name: `Scout Local ${suffix}`,
        host: edgeConfig.portalHost,
        port: edgePort,
        scheme,
      }),
      spawnMdnsProxy({
        name: `Scout ${edgeConfig.nodeHost} ${suffix}`,
        host: edgeConfig.nodeHost,
        port: edgePort,
        scheme,
      }),
    ];
  });

  caddyProcess = spawn(resolveCaddyExecutable(), [
    "run",
    "--config",
    caddyfilePath,
    "--adapter",
    "caddyfile",
  ], {
    argv0: EDGE_PROCESS_NAME,
    env: process.env,
    stdio: ["ignore", logFile("edge.stdout.log"), logFile("edge.stderr.log")],
  });

  log("local edge started", {
    pid: caddyProcess.pid,
    portal: edgeConfig.portalHost,
    node: edgeConfig.nodeHost,
    caddyfile: caddyfilePath,
  });

  caddyProcess.once("error", (error: RuntimeErrnoError) => {
    stopEdgeProcesses();
    warn("local edge failed to start", error.message);
    scheduleEdgeRestart();
  });
  caddyProcess.once("exit", (code, signal) => {
    log("local edge exited", { code, signal });
    stopEdgeProcesses();
    if (!shuttingDown) {
      scheduleEdgeRestart();
    }
  });
}

function scheduleEdgeRestart(): void {
  const delay = edgeRestartDelayMs;
  edgeRestartDelayMs = Math.min(edgeRestartDelayMs * 2, RESTART_MAX_DELAY_MS);
  setTimeout(() => {
    if (!shuttingDown) {
      startLocalEdge();
    }
  }, delay).unref();
}

async function startWebWhenBrokerIsReady(): Promise<void> {
  if (process.env.OPENSCOUT_BASE_START_WEB === "0") {
    return;
  }
  if (webStartInFlight) {
    return;
  }
  webStartInFlight = true;
  try {
    if (!(await waitForBrokerHealth())) {
      warn("broker did not become healthy before web startup timeout");
      scheduleWebStartRetry();
      return;
    }

    try {
      const edgeConfig = resolveEdgeConfig();
      const scheme = forwardedProtoForEdgeScheme(edgeConfig.scheme);
      const response = await fetch(new URL("/v1/web/start", brokerControlUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          "x-forwarded-host": edgeConfig.portalHost,
          "x-forwarded-proto": scheme,
        },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json() as { ok?: boolean; pid?: number | null; error?: string | null };
      if (!response.ok || body.ok !== true) {
        warn("web server did not report healthy", body.error ?? response.statusText);
        scheduleWebStartRetry();
        return;
      }
      log("web server ready", { pid: body.pid ?? null });
    } catch (error) {
      warn("web server startup failed", error instanceof Error ? error.message : String(error));
      scheduleWebStartRetry();
    }
  } finally {
    webStartInFlight = false;
  }
}

function scheduleWebStartRetry(): void {
  if (shuttingDown || webStartRetryTimer || process.env.OPENSCOUT_BASE_START_WEB === "0") {
    return;
  }
  webStartRetryTimer = setTimeout(() => {
    webStartRetryTimer = null;
    void startWebWhenBrokerIsReady();
  }, WEB_START_RETRY_MS);
  webStartRetryTimer.unref();
}

function findRepoMenuBundle(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const distRoot = resolve(current, "apps", "macos", "dist");
    const candidates = [
      resolve(distRoot, "Scout.app", "Contents", "Library", "LoginItems", "ScoutMenu.app"),
      // Backward compatibility for older builds that emitted a standalone
      // helper. Current builds embed the helper in Scout.app, so prefer that
      // artifact and never launch a stale sibling when both happen to exist.
      resolve(distRoot, "ScoutMenu.app"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function startMenuBarApp(): void {
  if (process.env.OPENSCOUT_BASE_MENU_ENABLED === "0" || process.platform !== "darwin") {
    return;
  }

  const explicitBundle = process.env.OPENSCOUT_MENU_BUNDLE_PATH?.trim();
  const repoBundle = explicitBundle && existsSync(explicitBundle) ? explicitBundle : findRepoMenuBundle();
  const args = repoBundle ? [repoBundle] : ["-b", MENU_BUNDLE_ID];
  const child = spawn("open", args, {
    stdio: ["ignore", logFile("menu.stdout.log"), logFile("menu.stderr.log")],
  });
  child.once("exit", (code) => {
    if (code === 0) {
      log("menu bar app launch requested", { target: repoBundle ?? MENU_BUNDLE_ID });
      return;
    }
    warn("menu bar app launch failed", { target: repoBundle ?? MENU_BUNDLE_ID, code });
  });
}

function isChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isChildExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timeout.unref();
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function terminateChildProcess(
  child: ChildProcess | null,
  label: string,
  timeoutMs = CHILD_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  if (!child || isChildExited(child)) {
    return;
  }
  if (!child.killed) {
    child.kill("SIGTERM");
  }
  if (await waitForChildExit(child, timeoutMs)) {
    return;
  }
  warn(`${label} did not exit after SIGTERM; forcing shutdown`, { pid: child.pid });
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await waitForChildExit(child, 2_000);
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (baseKeepAlive) {
    clearInterval(baseKeepAlive);
    baseKeepAlive = null;
  }
  if (parentWatcher) {
    clearInterval(parentWatcher);
    parentWatcher = null;
  }
  if (webStartRetryTimer) {
    clearTimeout(webStartRetryTimer);
    webStartRetryTimer = null;
  }
  // The broker is the sole owner of scout-web and awaits its drain in its own
  // shutdown path. Scout.app owns its embedded helper through LaunchServices;
  // base must not use a same-name process kill as a substitute for that
  // registration boundary.
  const activeCaddyProcess = caddyProcess;
  stopEdgeProcesses();
  await terminateChildProcess(brokerProcess, "broker");
  await terminateChildProcess(activeCaddyProcess, "local edge", 2_000);
  process.exit(exitCode);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function anchorBaseDaemonLifetime(): void {
  if (baseKeepAlive) {
    return;
  }

  // scout-base's lifetime must never depend on incidental handle refs. During
  // broker/edge restart backoff the only pending work is an unref'd restart
  // timer (scheduleBrokerRestart / scheduleEdgeRestart above both call
  // `.unref()`), so once a child exits the event loop can drain to zero
  // referenced handles before the timer fires — a drained loop is a clean exit,
  // which makes launchd tear down the whole broker/web/edge tree. This is
  // load-bearing on any runtime, not a Bun bug workaround. Keep one explicit
  // referenced anchor so the process stays alive across those windows; shutdown()
  // clears it and calls process.exit() itself.
  baseKeepAlive = setInterval(() => undefined, 60_000);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdown(0).catch((error) => {
      warn("shutdown failed", error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  });
}

// scoutd exports OPENSCOUT_PARENT_PID when it spawns scout-base. Watch it the
// same way broker-daemon watches this process, so a dead scoutd cannot leave
// the base/broker/web/edge tree orphaned under launchd.
if (Number.isFinite(parentPid) && parentPid > 0 && parentPid !== process.pid) {
  parentWatcher = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      log(`parent ${parentPid} is gone, shutting down base`);
      shutdown(0).catch((error) => {
        warn("shutdown failed", error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
    }
  }, 2_000);
  parentWatcher.unref();
}

log("starting Scout base service", {
  label: config.label,
  brokerUrl: config.brokerUrl,
  bootout: `launchctl bootout ${config.serviceTarget}`,
});
anchorBaseDaemonLifetime();
spawnBroker();
startLocalEdge();
startMenuBarApp();
void startWebWhenBrokerIsReady();
