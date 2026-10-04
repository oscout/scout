#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const binDir = dirname(fileURLToPath(import.meta.url));
const runtimeDistDir = resolve(binDir, "../dist/runtime");

const entrypoints = {
  base: resolve(runtimeDistDir, "base-daemon.mjs"),
  broker: resolve(runtimeDistDir, "broker-daemon.mjs"),
  service: resolve(runtimeDistDir, "broker-process-manager.mjs"),
  discover: resolve(runtimeDistDir, "mesh-discover.mjs"),
};
const processNames = {
  base: "scout-base",
  broker: "scout-broker",
  service: "scout-service",
  discover: "scout-discover",
};

const [, , command = "service", ...args] = process.argv;
// Handle lifecycle help and validate arguments before importing or building any
// entrypoint. Daemon modules start work as a top-level import side effect.
const lifecycleCommands = new Set(["base", "broker", "service", "discover"]);
if (command === "--help" || command === "-h" || command === "help"
    || (lifecycleCommands.has(command) && args.some(arg => arg === "--help" || arg === "-h"))) {
  console.log("Usage: openscout-runtime <base|broker|service|discover> [options]\n"
    + "  base / broker        Run the daemon in the foreground (no flags).\n"
    + "  service [install|start|stop|restart|uninstall|status] [--json]\n"
    + "                       Manage the local broker service; default: status.\n"
    + "  discover [seed ...]  Discover mesh peers through the broker.\n"
    + "  --help, -h           Show help without starting or changing anything.");
  process.exit(0);
}
if (lifecycleCommands.has(command)) {
  const positional = args.filter(arg => !arg.startsWith("-"));
  const invalid = command === "service"
    ? args.some(arg => arg.startsWith("-") && arg !== "--json")
      || positional.length > 1
      || (positional.length === 1 && !["install", "start", "stop", "restart", "uninstall", "status"].includes(positional[0]))
    : command === "discover" ? args.some(arg => arg.startsWith("-")) : args.length > 0;
  if (invalid) {
    console.error(`Unsupported arguments for openscout-runtime ${command}: ${args.join(" ")} (try --help)`);
    process.exit(1);
  }
}

const entrypoint = entrypoints[command];

if (!entrypoint) {
  console.error(`Unknown openscout-runtime command: ${command}`);
  process.exit(1);
}

if (!existsSync(entrypoint)) {
  console.error(
    "Scout runtime dist entry is missing. Reinstall @openscout/scout or rebuild the package.",
  );
  process.exit(1);
}

const processName = processNames[command] ?? "scout-runtime";
process.title = processName;

// Long-lived daemons (base/broker/discover) run in-process: this wrapper BECOMES the
// daemon instead of spawning a second bun, so scoutd → scout-base → scout-broker stays
// three processes (no duplicate scout-broker for doctor to flag) and the daemon's own
// SIGINT/SIGTERM handlers are the only ones installed. `service` keeps the pass-through
// spawn path (short-lived, not part of the supervision tree).
const LONG_LIVED_COMMANDS = new Set(["base", "broker", "discover"]);

if (LONG_LIVED_COMMANDS.has(command)) {
  // Give the entry the same argv shape it saw when spawned: [exec, entry, ...args].
  process.argv = [process.argv[0], entrypoint, ...args];
  try {
    await import(pathToFileURL(entrypoint).href);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
} else {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    argv0: processName,
    stdio: "inherit",
  });

  let forwardingSignal = false;
  let childExited = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      forwardingSignal = true;
      if (!child.killed) {
        child.kill(signal);
      }
      setTimeout(() => {
        if (!childExited) {
          child.kill("SIGKILL");
        }
      }, 10_000).unref();
    });
  }

  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    childExited = true;
    if (signal && !forwardingSignal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? (signal ? 0 : 1));
    }
  });
}
