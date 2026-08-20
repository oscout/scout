#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_WAIT_MS = 2_000;
const CAPTURE_PROFILE_PREFIX = "openscout-web-capture-";

function usage() {
  return `Usage: bun scripts/capture-web.mjs --url <url> --output <png> [options]

Options:
  --width <px>       Viewport width (default: 1440)
  --height <px>      Viewport height (default: 900)
  --scale <number>   Device scale factor (default: 1)
  --wait-ms <ms>     Virtual-time budget (default: 2000)
  --timeout-ms <ms>  Hard process deadline (default: 20000)
  --chrome <path>    Chrome/Chromium executable

The command exits only after the browser process group and temporary profile
have been cleaned up. An expiring lease lets scoutd finish cleanup if this
wrapper is interrupted.`;
}

function positiveNumber(value, label, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

export function parseCaptureArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg, value);
    index += 1;
  }

  const url = values.get("--url")?.trim();
  const outputValue = values.get("--output")?.trim();
  if (!url) throw new Error("--url is required");
  if (!outputValue) throw new Error("--output is required");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("--url must use http or https");
  }

  return {
    help: false,
    url: parsedUrl.toString(),
    output: isAbsolute(outputValue) ? outputValue : resolve(outputValue),
    width: Math.round(positiveNumber(values.get("--width"), "--width", 1440)),
    height: Math.round(positiveNumber(values.get("--height"), "--height", 900)),
    scale: positiveNumber(values.get("--scale"), "--scale", 1),
    waitMs: Math.round(positiveNumber(values.get("--wait-ms"), "--wait-ms", DEFAULT_WAIT_MS)),
    timeoutMs: Math.round(positiveNumber(values.get("--timeout-ms"), "--timeout-ms", DEFAULT_TIMEOUT_MS)),
    chromePath: values.get("--chrome")?.trim(),
  };
}

function executableExists(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandPath(command) {
  const result = spawnSync("/usr/bin/env", ["which", command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function resolveChromeExecutable(explicitPath, env = process.env) {
  const candidates = [
    explicitPath,
    env.OPENSCOUT_CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    commandPath("google-chrome"),
    commandPath("chromium"),
    commandPath("chromium-browser"),
  ].filter(Boolean);
  const resolved = candidates.find(executableExists);
  if (!resolved) {
    throw new Error("Chrome/Chromium not found; pass --chrome or OPENSCOUT_CHROME_BIN");
  }
  return resolved;
}

function supportDirectory(env) {
  return env.OPENSCOUT_SUPPORT_DIRECTORY?.trim()
    || join(homedir(), "Library", "Application Support", "OpenScout");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function terminateProcessGroup(child, exitPromise) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") child.kill(signal);
    }
  };
  signalGroup("SIGTERM");
  await Promise.race([exitPromise, delay(1_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    signalGroup("SIGKILL");
    await Promise.race([exitPromise, delay(1_000)]);
  }
}

async function waitForStableCapture(output, exitPromise, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let previousSize = 0;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const size = fileSize(output);
    if (size > 0 && size === previousSize) {
      stableReads += 1;
      if (stableReads >= 2) return { captured: true, childExited: false };
    } else {
      stableReads = 0;
      previousSize = size;
    }
    const result = await Promise.race([
      exitPromise.then((exit) => ({ kind: "exit", exit })),
      delay(100).then(() => ({ kind: "tick" })),
    ]);
    if (result.kind === "exit") {
      return { captured: fileSize(output) > 0, childExited: true, exit: result.exit };
    }
  }
  return { captured: false, childExited: false, timedOut: true };
}

function safeUnlink(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function captureWeb(options, env = process.env) {
  const chromePath = resolveChromeExecutable(options.chromePath, env);
  const output = isAbsolute(options.output) ? options.output : resolve(options.output);
  mkdirSync(dirname(output), { recursive: true });
  safeUnlink(output);

  const profileDir = mkdtempSync(join(tmpdir(), CAPTURE_PROFILE_PREFIX));
  const leaseDirectory = join(supportDirectory(env), "runtime", "process-leases");
  mkdirSync(leaseDirectory, { recursive: true });

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
    `--window-size=${options.width},${options.height}`,
    `--force-device-scale-factor=${options.scale}`,
    "--run-all-compositor-stages-before-draw",
    `--virtual-time-budget=${options.waitMs}`,
    `--screenshot=${output}`,
    options.url,
  ];
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });
  if (!child.pid) throw new Error("Chrome started without a pid");

  const leasePath = join(leaseDirectory, `web-capture-${child.pid}.json`);
  writeFileSync(leasePath, `${JSON.stringify({
    version: 1,
    kind: "web_capture",
    pid: child.pid,
    processGroupId: child.pid,
    profileDir,
    outputPath: output,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + options.timeoutMs + 5_000,
  }, null, 2)}\n`, { mode: 0o600 });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16 * 1024);
  });
  const exitPromise = new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

  let interruptCapture;
  const interrupted = new Promise((resolveInterrupt) => {
    interruptCapture = resolveInterrupt;
  });
  const interrupt = (signal) => interruptCapture({ captured: false, interrupted: signal });
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await Promise.race([
      waitForStableCapture(output, exitPromise, options.timeoutMs),
      interrupted,
    ]);
    if (result.interrupted) throw new Error(`capture interrupted by ${result.interrupted}`);
    if (!result.captured) {
      const detail = stderr.trim() || (result.timedOut ? `timed out after ${options.timeoutMs}ms` : "Chrome exited before writing a screenshot");
      throw new Error(`web capture failed: ${detail}`);
    }
    return { output, bytes: fileSize(output), chromePath };
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await terminateProcessGroup(child, exitPromise);
    safeUnlink(leasePath);
    rmSync(profileDir, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const options = parseCaptureArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const result = await captureWeb(options);
    console.log(`${result.output} (${result.bytes} bytes)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
