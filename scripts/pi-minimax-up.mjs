#!/usr/bin/env bun

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  brokerServiceStatus,
  resolveBrokerServiceConfig,
  startBrokerService,
} from "../packages/runtime/src/broker-process-manager.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_MODEL = "MiniMax-M3";
const DEFAULT_THINKING = "low";
const DEFAULT_ALIAS = "@pi-minimax";
const DEFAULT_NAME = "Pi MiniMax M3";
const DEFAULT_TIMEOUT_MS = 30_000;
const PI_SCOUT_EXTENSION_CANDIDATES = [
  process.env.OPENSCOUT_PI_SCOUT_EXTENSION_PATH,
  join(homedir(), ".pi", "agent", "extensions", "pi-scout"),
  join(homedir(), "dev", "pi-scout"),
].filter(Boolean);
const PAIRING_RUNTIME_CONTROLLER_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
];

function usage() {
  console.log(`Spin up a Scout-attached Pi session using the MiniMax provider.

Usage:
  bun scripts/pi-minimax-up.mjs [options]

Options:
  --model <model>       MiniMax model (default: ${DEFAULT_MODEL})
  --thinking <level>    Pi thinking level (default: ${DEFAULT_THINKING})
  --cwd <path>          Session working directory (default: repo root)
  --alias <alias>       Scout alias to attach (default: ${DEFAULT_ALIAS})
  --name <name>         Session display name (default: ${DEFAULT_NAME})
  --restart             Restart the pairing runtime controller before starting
  --no-pi-scout         Do not load the Pi Scout extension
  --no-attach           Start the pairing session but skip broker attachment
  --no-broker-start     Do not start the broker service automatically
  --configure-only      Only write ~/.scout/pairing/config.json
  --down                Stop the pairing runtime controller
  --timeout-ms <ms>     Wait timeout (default: ${DEFAULT_TIMEOUT_MS})
  --help                Show this help

Environment:
  MINIMAX_API_KEY       Preferred MiniMax key name used by pi
  MINIMAX_TOKEN         Accepted fallback when MINIMAX_API_KEY is unset
  macOS Keychain secret Used as fallback when env values are unset
  OPENSCOUT_PI_MINIMAX_MODEL
  OPENSCOUT_PI_MINIMAX_THINKING
  OPENSCOUT_PI_SCOUT_EXTENSION_PATH`);
}

function parseArgs(argv) {
  const options = {
    model: process.env.OPENSCOUT_PI_MINIMAX_MODEL || DEFAULT_MODEL,
    thinking: process.env.OPENSCOUT_PI_MINIMAX_THINKING || DEFAULT_THINKING,
    cwd: REPO_ROOT,
    alias: DEFAULT_ALIAS,
    name: DEFAULT_NAME,
    restart: false,
    piScout: true,
    attach: true,
    brokerStart: true,
    configureOnly: false,
    down: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  const requireValue = (flag, value) => {
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index] ?? "";
    switch (current) {
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      case "--model":
        options.model = requireValue(current, argv[index + 1]);
        index += 1;
        break;
      case "--thinking":
        options.thinking = requireValue(current, argv[index + 1]);
        index += 1;
        break;
      case "--cwd":
        options.cwd = resolve(requireValue(current, argv[index + 1]));
        index += 1;
        break;
      case "--alias":
        options.alias = normalizeAlias(requireValue(current, argv[index + 1]));
        index += 1;
        break;
      case "--name":
        options.name = requireValue(current, argv[index + 1]);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number.parseInt(requireValue(current, argv[index + 1]), 10);
        index += 1;
        break;
      case "--restart":
        options.restart = true;
        break;
      case "--no-pi-scout":
        options.piScout = false;
        break;
      case "--no-attach":
        options.attach = false;
        break;
      case "--no-broker-start":
        options.brokerStart = false;
        break;
      case "--configure-only":
        options.configureOnly = true;
        break;
      case "--down":
        options.down = true;
        break;
      default:
        if (current.startsWith("--model=")) {
          options.model = current.slice("--model=".length);
          break;
        }
        if (current.startsWith("--thinking=")) {
          options.thinking = current.slice("--thinking=".length);
          break;
        }
        if (current.startsWith("--cwd=")) {
          options.cwd = resolve(current.slice("--cwd=".length));
          break;
        }
        if (current.startsWith("--alias=")) {
          options.alias = normalizeAlias(current.slice("--alias=".length));
          break;
        }
        if (current.startsWith("--name=")) {
          options.name = current.slice("--name=".length);
          break;
        }
        if (current.startsWith("--timeout-ms=")) {
          options.timeoutMs = Number.parseInt(current.slice("--timeout-ms=".length), 10);
          break;
        }
        throw new Error(`Unknown option: ${current}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }

  return options;
}

function normalizeAlias(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("--alias must not be empty.");
  }
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function pairingPaths() {
  const rootDir = join(homedir(), ".scout", "pairing");
  return {
    rootDir,
    configPath: join(rootDir, "config.json"),
    runtimePidPath: join(rootDir, "runtime.pid"),
    runtimeStatePath: join(rootDir, "runtime.json"),
    upLogPath: join(rootDir, "pi-minimax-up.log"),
  };
}

function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writePairingConfig(options) {
  const paths = pairingPaths();
  const current = readJsonFile(paths.configPath, {});
  const piScoutExtensionPath = options.piScout ? resolvePiScoutExtensionPath() : null;
  const next = {
    ...current,
    secure: false,
    workspace: {
      ...(current.workspace && typeof current.workspace === "object" ? current.workspace : {}),
      root: current.workspace?.root || dirname(options.cwd),
    },
    adapters: {
      ...(current.adapters && typeof current.adapters === "object" ? current.adapters : {}),
      "pi-minimax": {
        type: "pi",
        options: {
          provider: "minimax",
          model: options.model,
          thinking: options.thinking,
          ...(piScoutExtensionPath ? { extensions: [piScoutExtensionPath] } : {}),
        },
      },
    },
  };

  const sessions = Array.isArray(current.sessions) ? current.sessions : [];
  next.sessions = [
    ...sessions.filter((session) => (
      session?.adapter !== "pi-minimax"
      && session?.name !== options.name
    )),
    {
      adapter: "pi-minimax",
      name: options.name,
      cwd: options.cwd,
      options: {},
    },
  ];

  mkdirSync(paths.rootDir, { recursive: true });
  writeFileSync(paths.configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (options.piScout && !piScoutExtensionPath) {
    console.warn("Pi Scout extension not found; install pi-scout or set OPENSCOUT_PI_SCOUT_EXTENSION_PATH.");
  }
  return paths.configPath;
}

function resolvePiScoutExtensionPath() {
  for (const candidate of PI_SCOUT_EXTENSION_CANDIDATES) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readPid() {
  const { runtimePidPath } = pairingPaths();
  if (!existsSync(runtimePidPath)) {
    return null;
  }
  const pid = Number.parseInt(readFileSync(runtimePidPath, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

async function stopPairingRuntimeController() {
  const pid = readPid();
  if (!pid || !isProcessAlive(pid)) {
    return false;
  }
  process.kill(pid, "SIGTERM");
  const stopped = await waitForProcessExit(pid);
  if (!stopped) {
    throw new Error(`Pairing runtime controller pid ${pid} did not stop after SIGTERM.`);
  }
  return true;
}

function readProcessEnv(key) {
  const value = process.env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readLocalSecret(key) {
  try {
    const value = execFileSync("secret", ["get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function resolveMiniMaxKey() {
  return readProcessEnv("MINIMAX_API_KEY")
    || readProcessEnv("MINIMAX_TOKEN")
    || readLocalSecret("MINIMAX_API_KEY");
}

function buildPairingRuntimeControllerEnv() {
  const env = {};
  for (const key of PAIRING_RUNTIME_CONTROLLER_ENV_KEYS) {
    const value = readProcessEnv(key);
    if (value) {
      env[key] = value;
    }
  }

  const miniMaxKey = resolveMiniMaxKey();
  if (!miniMaxKey) {
    throw new Error("Missing MiniMax key. Set it in the shell or local secret store.");
  }
  env.MINIMAX_API_KEY = miniMaxKey;
  return env;
}

async function startPairingRuntimeController(options) {
  const paths = pairingPaths();
  const existingPid = readPid();
  if (options.restart && existingPid && isProcessAlive(existingPid)) {
    await stopPairingRuntimeController();
  }

  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    return { started: false, pid };
  }

  const env = buildPairingRuntimeControllerEnv();
  mkdirSync(paths.rootDir, { recursive: true });
  appendFileSync(paths.upLogPath, `\n[${new Date().toISOString()}] starting pi-minimax pairing runtime controller\n`);
  const logFd = openSync(paths.upLogPath, "a");
  const child = spawn(process.execPath || "bun", [join(REPO_ROOT, "packages", "web", "server", "pairing-runtime-controller.ts")], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  return { started: true, pid: child.pid ?? null };
}

async function waitForPairingHealth(timeoutMs) {
  const config = readJsonFile(pairingPaths().configPath, {});
  const port = Number.isFinite(config.port) && config.port > 0 ? Number(config.port) : 43130;
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return { port, url };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }

  throw new Error(`Pairing bridge did not become healthy at ${url}: ${lastError}`);
}

async function ensureBroker(options) {
  const config = resolveBrokerServiceConfig();
  let status = await brokerServiceStatus(config);
  if (!status.reachable && options.brokerStart) {
    status = await startBrokerService(config);
  }
  if (!status.reachable) {
    throw new Error(`Broker is not reachable at ${config.brokerUrl}. Run scout setup, or rerun with broker enabled.`);
  }
  return status.brokerUrl;
}

async function fetchJson(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const detail = body?.detail || body?.error || text || `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  return body;
}

async function waitForPiSession(brokerUrl, options) {
  const deadline = Date.now() + options.timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const sessions = await fetchJson(new URL("/v1/pairing/sessions", brokerUrl));
      const match = sessions.find((session) => (
        session?.name === options.name
        || (session?.adapterType === "pi" && session?.cwd === options.cwd)
      ));
      if (match) {
        return match;
      }
      lastError = `saw ${sessions.length} pairing session(s), but not ${options.name}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }

  throw new Error(
    `Pi MiniMax session did not appear in the broker. ${lastError}. `
      + "If the pairing runtime controller was already running, rerun with --restart so it reloads the new config and environment.",
  );
}

async function attachSession(brokerUrl, session, options) {
  return fetchJson(new URL("/v1/pairing/attach", brokerUrl), {
    method: "POST",
    body: JSON.stringify({
      externalSessionId: session.externalSessionId,
      alias: options.alias,
      displayName: options.name,
    }),
  });
}

async function detachSession(options) {
  const brokerUrl = await ensureBroker({ ...options, brokerStart: false }).catch(() => null);
  if (!brokerUrl) {
    return null;
  }
  return fetchJson(new URL("/v1/pairing/detach", brokerUrl), {
    method: "POST",
    body: JSON.stringify({ alias: options.alias }),
  }).catch(() => null);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.down) {
    const detached = await detachSession(options);
    const stopped = await stopPairingRuntimeController();
    console.log(stopped ? "Stopped Pi MiniMax pairing runtime controller." : "Pi MiniMax pairing runtime controller was not running.");
    if (detached?.detached) {
      console.log(`Detached ${options.alias} from Scout.`);
    }
    return;
  }

  const configPath = writePairingConfig(options);
  console.log(`Configured Pi MiniMax pairing session: ${configPath}`);

  if (options.configureOnly) {
    return;
  }

  const pairingRuntimeController = await startPairingRuntimeController(options);
  console.log(
    pairingRuntimeController.started
      ? `Started pairing runtime controller pid ${pairingRuntimeController.pid ?? "unknown"}.`
      : `Pairing runtime controller already running pid ${pairingRuntimeController.pid}.`,
  );

  const pairing = await waitForPairingHealth(options.timeoutMs);
  console.log(`Pairing bridge is healthy: ${pairing.url}`);

  if (!options.attach) {
    return;
  }

  const brokerUrl = await ensureBroker(options);
  const session = await waitForPiSession(brokerUrl, options);
  const attached = await attachSession(brokerUrl, session, options);
  console.log(`Attached ${options.alias} to ${attached.agentId}.`);
  console.log(`Try it with: bun packages/cli/src/main.ts ask --to ${options.alias.slice(1)} "Reply exactly: ok"`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
