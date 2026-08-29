#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const DEFAULT_PORTS = {
  broker: 43110,
  web: 43120,
  vite: 43122,
  pairing: 43130,
};
const VALUE_FLAGS = new Set(["--port", "--web-port", "--vite-port", "--pairing-port"]);

function printHelp() {
  console.log(`OpenScout scout:up

Usage:
  bun run scout:up [options]
  bun run scout:verify

Options:
  --fresh             Remove generated build outputs before rebuilding.
                      Preserves OpenScout broker/control-plane data.
  --no-ios            Skip the iOS build/install step.
  --require-ios       Fail if the iOS build/install step fails.
  --verify-only       Do not mutate anything; verify the running suite.
  --port <n>          Web app port. Alias: --web-port.
  --vite-port <n>     Accepted for compatibility; managed restarts do not start Vite.
  --pairing-port <n>  Pairing bridge port.
  -h, --help          Show this help.

What it restarts:
  packages, relay broker, broker-managed web app, macOS Scout app,
  its embedded macOS menu helper, and iOS app.

Lifecycle:
  Stop, start, and verification belong to "scout app" — this script adds the
  build steps around them. For the app alone, use: scout app restart

Ownership:
  launchd -> scoutd -> base/probes -> broker/edge -> web
  LaunchServices -> Scout + embedded ScoutMenu -> pairing runtime`);
}

function parsePort(value, flagName) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) {
    throw new Error(`${flagName} must be a TCP port between 1 and 65535.`);
  }
  return parsed;
}

function takeValue(args, index, flagName) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flagName} requires a value.`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    fresh: false,
    ios: true,
    requireIos: false,
    help: false,
    webPort: null,
    vitePort: null,
    pairingPort: null,
    verifyOnly: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--fresh") {
      options.fresh = true;
      continue;
    }
    if (arg === "--no-ios") {
      options.ios = false;
      continue;
    }
    if (arg === "--require-ios") {
      options.ios = true;
      options.requireIos = true;
      continue;
    }
    if (arg === "--verify-only") {
      options.verifyOnly = true;
      options.ios = false;
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    if (!VALUE_FLAGS.has(name)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : null;
    const value = inlineValue ?? takeValue(args, i, name);
    if (inlineValue === null) i += 1;

    if (name === "--port" || name === "--web-port") {
      options.webPort = parsePort(value, name);
    } else if (name === "--vite-port") {
      options.vitePort = parsePort(value, name);
    } else if (name === "--pairing-port") {
      options.pairingPort = parsePort(value, name);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function resolveBunBin() {
  const explicit = process.env.OPENSCOUT_BUN_BIN?.trim()
    || process.env.SCOUT_BUN_BIN?.trim()
    || process.env.BUN_BIN?.trim();
  if (explicit) return explicit;
  if (process.versions.bun && process.execPath) return process.execPath;
  return "bun";
}

function runStep(label, command, args = [], options = {}) {
  const required = options.required ?? true;
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    if (!required) {
      console.warn(`warn: ${label} failed: ${result.error.message}`);
      return false;
    }
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    if (!required) {
      console.warn(`warn: ${label} failed (${detail}); continuing.`);
      return false;
    }
    throw new Error(`${label} failed (${detail}).`);
  }

  return true;
}

function freshGeneratedPaths() {
  return [
    "packages/protocol/dist",
    "packages/runtime/dist",
    "packages/cli/dist",
    "packages/web/dist",
    "apps/macos/.build",
    "apps/macos/dist/Scout.app",
    "apps/macos/dist/ScoutMenu.app",
    "apps/macos/dist/OpenScoutMenu.app",
    "apps/macos/dist/OpenScout Menu.app",
    "apps/ios/.deriveddata/devphone",
  ].map((relativePath) => resolve(repoRoot, relativePath));
}

function removeGeneratedOutputs() {
  console.log("\n==> Fresh generated outputs");
  for (const outputPath of freshGeneratedPaths()) {
    if (!existsSync(outputPath)) {
      continue;
    }
    rmSync(outputPath, { recursive: true, force: true });
    console.log(`removed ${outputPath}`);
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function waitForWeb(url, logPath) {
  const bootstrapUrl = `${url}/api/bootstrap.js`;
  const healthUrl = `${url}/api/health`;
  const deadline = Date.now() + 120_000;
  let lastStatus = null;
  let cookieHeader = "";
  while (Date.now() < deadline) {
    try {
      const bootstrap = await fetch(bootstrapUrl, {
        headers: { accept: "application/javascript" },
        cache: "no-store",
        signal: AbortSignal.timeout(2_500),
      });
      lastStatus = bootstrap.status;
      if (!bootstrap.ok) {
        await sleep(500);
        continue;
      }
      cookieHeader = bootstrap.headers.getSetCookie()
        .map((entry) => entry.split(";", 1)[0])
        .join("; ");
      const response = await fetch(healthUrl, {
        headers: {
          accept: "application/json",
          cookie: cookieHeader,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(2_500),
      });
      lastStatus = response.status;
      if (response.ok) {
        return cookieHeader;
      }
    } catch {
      // Keep polling until the server accepts connections.
    }
    await sleep(500);
  }
  const statusDetail = lastStatus === null ? "no HTTP response" : `last HTTP ${lastStatus}`;
  throw new Error(`Web app did not become ready at ${healthUrl} (${statusDetail}). See ${logPath}.`);
}

function defaultSupportDirectory() {
  return process.env.OPENSCOUT_SUPPORT_DIRECTORY?.trim()
    || join(homedir(), "Library", "Application Support", "OpenScout");
}

function supportDirectoryFromStatus(status) {
  return typeof status?.supportDirectory === "string" && status.supportDirectory.trim().length > 0
    ? status.supportDirectory
    : defaultSupportDirectory();
}

function supervisedWebLogPath(status) {
  return join(supportDirectoryFromStatus(status), "logs", "web", "supervised-web.log");
}

function readOptionalPort(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
}

function managedWebUrlFromStatus(status, options) {
  const webService = status?.health?.services?.web;
  if (typeof webService?.url === "string" && webService.url.trim().length > 0) {
    return webService.url;
  }
  const servicePort = readOptionalPort(webService?.port);
  if (servicePort) {
    return `http://127.0.0.1:${servicePort}`;
  }
  const explicitPort = options.webPort ?? readOptionalPort(process.env.OPENSCOUT_WEB_PORT);
  return `http://127.0.0.1:${explicitPort ?? DEFAULT_PORTS.web}`;
}

function brokerUrlFromStatus(status) {
  if (typeof status?.brokerUrl === "string" && status.brokerUrl.trim().length > 0) {
    try {
      const port = readOptionalPort(new URL(status.brokerUrl).port);
      if (port) {
        return `http://127.0.0.1:${port}`;
      }
    } catch {
      // Fall back to the configured/default local broker port.
    }
  }
  const brokerPort = readOptionalPort(process.env.OPENSCOUT_BROKER_PORT) ?? DEFAULT_PORTS.broker;
  return `http://127.0.0.1:${brokerPort}`;
}

async function waitForBrokerReady(bunBin) {
  const deadline = Date.now() + 120_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const status = readBrokerStatus(bunBin);
    if (status) {
      lastStatus = status;
      if (status.reachable === true && status.health?.ok === true) {
        return status;
      }
    }
    await sleep(500);
  }
  const detail = lastStatus?.health?.error ?? lastStatus?.lastLogLine ?? "status unavailable";
  throw new Error(`Relay broker did not become ready: ${detail}`);
}

async function startManagedWeb(status, options) {
  const brokerUrl = brokerUrlFromStatus(status);
  const response = await fetch(new URL("/v1/web/start", brokerUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "x-forwarded-host": "scout.local",
      "x-forwarded-proto": "http",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (!response.ok) {
    const detail = body?.error ?? response.statusText;
    throw new Error(`Broker-managed web app did not start: ${detail}`);
  }
  if (body?.ok !== true) {
    const detail = body?.error ?? "startup is still pending";
    console.warn(`web start accepted; waiting for /api/health (${detail})`);
  }
  return {
    url: typeof body.webUrl === "string" && body.webUrl.trim().length > 0
      ? body.webUrl
      : managedWebUrlFromStatus(status, options),
    logPath: supervisedWebLogPath(status),
    pid: typeof body.pid === "number" ? body.pid : null,
  };
}

function applyManagedWebEnvironment(options) {
  const overrides = [];
  if (options.webPort !== null) {
    process.env.OPENSCOUT_WEB_PORT = String(options.webPort);
    overrides.push(`web ${options.webPort}`);
  }
  if (options.pairingPort !== null) {
    process.env.OPENSCOUT_PAIRING_PORT = String(options.pairingPort);
    overrides.push(`pairing ${options.pairingPort}`);
  }
  if (options.vitePort !== null) {
    console.warn("warn: --vite-port is ignored because restart:all uses broker-managed static web.");
  }
  if (overrides.length > 0) {
    console.log(`managed web env override: ${overrides.join(", ")}`);
  }
}

function readBrokerStatus(_bunBin) {
  const result = spawnSync(
    resolve(repoRoot, "packages", "cli", "bin", "scoutd"),
    ["status", "--json"],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if ((result.status ?? 1) !== 0 || !result.stdout.trim()) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Runs a `scout app` lifecycle verb and returns its JSON result.
 *
 * The ownership tree, the stop order, and the verification rules used to live in
 * this script. They are `scout app`'s now — the same model the CLI, the build
 * script, and the menu command all consult — so this file is left with what is
 * genuinely dev-only: build flags, package builds, and the iOS push.
 */
function scoutApp(verb, { required = true, allowSharedServiceRepoint = false } = {}) {
  const cli = resolve(repoRoot, "apps", "desktop", "src", "cli", "main.ts");
  const result = spawnSync(resolveBunBin(), [cli, "app", verb, "--json"], {
    cwd: repoRoot,
    env: allowSharedServiceRepoint
      ? { ...process.env, OPENSCOUT_ALLOW_SHARED_SERVICE_REPOINT: "1" }
      : process.env,
    encoding: "utf8",
  });

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }

  // A non-zero exit is a failure whether or not the JSON parsed. `scout app`
  // writes its result and *then* throws when it found problems, so the stdout of
  // a failed stop parses perfectly — and treating "parsed" as success let the
  // build carry on and install over a suite that never stopped.
  if ((result.status ?? 1) !== 0 && required) {
    const detail = parsed?.problems?.length
      ? `${parsed.message} (${parsed.problems.join("; ")})`
      : (result.stderr || result.stdout || "").trim();
    throw new Error(`scout app ${verb} failed: ${detail || "unknown error"}`);
  }
  return parsed;
}

function reportLifecycle(label, report) {
  console.log(`\n==> ${label}`);
  if (!report) {
    console.log("  (no structured result)");
    return;
  }
  for (const step of report.steps ?? []) console.log(`  ${step}`);
  for (const problem of report.problems ?? []) console.log(`  problem: ${problem}`);
}

function legacyServiceLoaded(label) {
  const result = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], { stdio: "ignore" });
  return (result.status ?? 1) === 0;
}

export function legacyScoutServiceLabels(mode) {
  return mode === "custom"
    ? ["com.openscout.custom"]
    : ["dev.openscout", "com.openscout"];
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function pairingRelayRuntimeReady(snapshot, isAlive = processIsAlive) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const relay = typeof snapshot.relay === "string" ? snapshot.relay.trim() : "";
  if (!relay) return false;
  return [snapshot.pid, snapshot.childPid].some((pid) => Number.isInteger(pid) && pid > 0 && isAlive(pid));
}

function readPairingRuntimeSnapshot() {
  const path = join(homedir(), ".scout", "pairing", "runtime.json");
  try {
    return { path, snapshot: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { path, snapshot: null };
  }
}

async function verifySuite(bunBin, options) {
  const status = await waitForBrokerReady(bunBin);
  const webUrl = managedWebUrlFromStatus(status, options);
  const cookieHeader = await waitForWeb(webUrl, supervisedWebLogPath(status));

  const loadedLegacyLabels = legacyScoutServiceLabels(status?.mode).filter(legacyServiceLoaded);
  if (loadedLegacyLabels.length > 0) {
    throw new Error(`Legacy launchd services are still loaded: ${loadedLegacyLabels.join(", ")}.`);
  }

  const tree = scoutApp("status");
  if (!tree) throw new Error("scout app status did not return a result.");
  if (tree.problems.length > 0) {
    throw new Error(`Process ownership is wrong:\n  ${tree.problems.join("\n  ")}`);
  }

  const pairingRuntime = readPairingRuntimeSnapshot();
  if (!pairingRelayRuntimeReady(pairingRuntime.snapshot)) {
    throw new Error(`Pairing relay runtime is not ready at ${pairingRuntime.path}.`);
  }

  const agents = await fetch(new URL("/api/agents?detail=summary&limit=1", webUrl), {
    headers: {
      accept: "application/json",
      cookie: cookieHeader,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!agents.ok) throw new Error(`Web agents summary failed verification with HTTP ${agents.status}.`);
  return { status, tree, webUrl, pairingRuntime: pairingRuntime.snapshot };
}

function describeTree(tree) {
  const pid = (layer) => tree.layers.find((entry) => entry.layer === layer)?.pids.join(",") || "none";
  return {
    ownership: `launchd -> scoutd ${pid("scoutd")} -> base ${pid("base")} -> broker ${pid("broker")} -> web ${pid("web")}`,
    relay: `pairing ${pid("pairing")}`,
    apps: `Scout ${pid("app")}; embedded ScoutMenu ${pid("menu")}`,
  };
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return;
  }

  const bunBin = resolveBunBin();
  applyManagedWebEnvironment(options);

  if (options.verifyOnly) {
    const verified = await verifySuite(bunBin, options);
    const described = describeTree(verified.tree);
    console.log(`suite verified: ${described.ownership}`);
    console.log(`relay verified: ${described.relay}`);
    console.log(`apps verified: ${described.apps}`);
    console.log(`web ready: ${verified.webUrl}`);
    return;
  }

  reportLifecycle("Stop OpenScout", scoutApp("stop"));

  if (options.fresh) {
    removeGeneratedOutputs();
  }

  runStep("Build packages", bunBin, ["run", "build"]);
  runStep("Build Scout and embedded menu helper", bunBin, ["apps/macos/bin/scout-app.ts", "dev-build"]);

  reportLifecycle("Start OpenScout", scoutApp("start", { allowSharedServiceRepoint: true }));

  console.log("\n==> Start broker-managed web app");
  const brokerReadyStatus = await waitForBrokerReady(bunBin);
  const web = await startManagedWeb(brokerReadyStatus, options);
  console.log(`web pid ${web.pid ?? "unknown"}; log ${web.logPath}`);
  await waitForWeb(web.url, web.logPath);
  console.log(`web ready at ${web.url}`);

  let iosStatus = "skipped";
  if (options.ios) {
    const ok = runStep("Build and install iOS app", "bash", ["apps/ios/scripts/push-device.sh"], {
      required: options.requireIos,
    });
    iosStatus = ok ? "pushed" : "failed (continued)";
  }

  const verified = await verifySuite(bunBin, options);
  const brokerStatus = verified.status;
  const brokerHealth = brokerStatus
    ? `${brokerStatus.reachable ? "reachable" : "unreachable"}, health ${
      brokerStatus.health?.ok ? "ok" : brokerStatus.health?.error ?? "unknown"
    }, pid ${brokerStatus.pid ?? "unknown"}`
    : "status unavailable";

  const described = describeTree(verified.tree);
  console.log("\nscout:up complete");
  console.log(`broker: ${brokerHealth}`);
  console.log(`web: ${web.url} (log ${web.logPath})`);
  console.log(`ownership: ${described.ownership}`);
  console.log(`relay: ${described.relay}`);
  console.log(`macOS: ${described.apps}`);
  console.log(`iOS: ${iosStatus}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
