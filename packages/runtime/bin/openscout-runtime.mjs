#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const binDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(binDir, "..");
const distDir = resolve(binDir, "../dist");
const sourceDir = resolve(binDir, "../src");
const sourceMain = {
  base: resolve(sourceDir, "base-daemon.ts"),
  broker: resolve(sourceDir, "broker-daemon.ts"),
  service: resolve(sourceDir, "broker-process-manager.ts"),
  discover: resolve(sourceDir, "mesh-discover.ts"),
};
const distMain = {
  base: resolve(distDir, "base-daemon.js"),
  broker: resolve(distDir, "broker-daemon.js"),
  service: resolve(distDir, "broker-process-manager.js"),
  discover: resolve(distDir, "mesh-discover.js"),
};
const processNames = {
  base: "scout-base",
  broker: "scout-broker",
  service: "scout-service",
  discover: "scout-discover",
};
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const [, , command = "service", ...args] = process.argv;

if (!(command in sourceMain)) {
  console.error(`Unknown openscout-runtime command: ${command}`);
  process.exit(1);
}

const processName = processNames[command] ?? "scout-runtime";
process.title = processName;

function runServiceEntrypoint(entry, entryArgs) {
  const result = spawnSync(process.execPath, [entry, ...entryArgs], {
    encoding: "utf8",
    argv0: processName,
    stdio: ["inherit", "pipe", "pipe"],
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }

  process.exit(result.status ?? 0);
}

async function runInProcessEntrypoint(entry, entryArgs) {
  // Long-lived commands (base/broker/discover) run in-process: this wrapper
  // BECOMES the daemon instead of spawning a second runtime, which removes one
  // redundant supervision layer per hop (scoutd → scout-base → scout-broker is
  // three processes instead of five). The daemon entries install their own
  // SIGINT/SIGTERM handlers (base-daemon.ts / broker-daemon.ts), and the
  // supervisors above already escalate TERM → wait → KILL, so the wrapper must
  // not register competing signal handlers or SIGKILL timers here.
  //
  // Rewrite argv so entries that parse process.argv (mesh-discover.ts reads
  // process.argv.slice(2) for seeds) see the same shape as when they were
  // spawned directly: [execPath, entry, ...entryArgs].
  process.argv = [process.argv[0], entry, ...entryArgs];
  try {
    await import(pathToFileURL(entry).href);
  } catch (error) {
    // A top-level throw during daemon startup must surface as a non-zero exit
    // so the parent supervisor sees the real failure.
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
}

async function runEntrypoint(entry, entryArgs) {
  if (command === "service") {
    runServiceEntrypoint(entry, entryArgs);
    return;
  }
  await runInProcessEntrypoint(entry, entryArgs);
}

function canRunTypeScriptSource() {
  return typeof globalThis.Bun !== "undefined";
}

function shouldPreferSourceEntry() {
  const preference = process.env.OPENSCOUT_RUNTIME_ENTRYPOINT?.trim().toLowerCase();
  if (preference === "source" || preference === "src") {
    return true;
  }
  if (preference === "dist") {
    return false;
  }
  return process.env.OPENSCOUT_BROKER_SERVICE_MODE?.trim().toLowerCase() === "dev";
}

const distEntry = distMain[command];
const sourceEntry = sourceMain[command];
if (canRunTypeScriptSource() && shouldPreferSourceEntry() && existsSync(sourceEntry)) {
  await runEntrypoint(sourceEntry, args);
} else if (existsSync(distEntry)) {
  await runEntrypoint(distEntry, args);
} else {
  const buildResult = spawnSync(npmCommand, ["run", "build"], {
    cwd: packageDir,
    stdio: "inherit",
  });

  if ((buildResult.status ?? 1) !== 0) {
    process.exit(buildResult.status ?? 1);
  }

  const rebuiltEntry = distMain[command];
  if (!existsSync(rebuiltEntry)) {
    console.error(`Missing openscout-runtime dist entry for ${command} after build.`);
    process.exit(1);
  }

  await runEntrypoint(rebuiltEntry, args);
}
