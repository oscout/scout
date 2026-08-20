import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { parseScoutArgv } from "./argv.ts";
import { createScoutCommandContext, defaultScoutContextDirectory } from "./context.ts";
import { ScoutCliError } from "./errors.ts";
import { runAskWithOptions } from "./commands/ask.ts";
import { loadScoutCommandHandler } from "./commands/index.ts";
import { renderScoutHelp } from "./help.ts";
import { parseImplicitAskCommandOptions } from "./options.ts";
import { findScoutCommandRegistration } from "./registry.ts";
import {
  normalizeCliBinaryMtimeMs,
  shouldEnsureBrokerUptodateForCommand,
} from "./uptodate.ts";
import { brokerUpdateDebugEnabled, ensureBrokerUptodate } from "./broker-update.ts";
import { runNativeScoutdJson } from "./scoutd.ts";
import { SCOUT_APP_VERSION } from "../shared/product.ts";

async function main() {
  const input = parseScoutArgv(process.argv.slice(2));
  const context = createScoutCommandContext({ outputMode: input.outputMode });
  let command = input.command;
  let commandArgs = input.args;

  // MCP stdio hosts expect the protocol handshake immediately; broker
  // maintenance here can leave the host terminal waiting with input disabled.
  if (shouldEnsureBrokerUptodateForCommand(command)) {
    // Let scoutd authorize and own any runtime refresh required after an update.
    await ensureBrokerUptodate({
      checkpointPath: cliMtimeCheckpointPath(),
      debug: brokerUpdateDebugEnabled(context.env),
      readCurrentMtime: readCurrentCliMtime,
      report: (message) => context.stderr(message),
      restart: async () => runNativeScoutdJson("restart"),
      status: async () => runNativeScoutdJson("status", { timeoutMs: 5_000 }),
    });
  }

  if (input.versionRequested) {
    context.output.writeText(SCOUT_APP_VERSION);
    return;
  }

  if (input.helpRequested || !command) {
    context.output.writeText(renderScoutHelp(SCOUT_APP_VERSION));
    return;
  }

  if (command === "relay") {
    command = commandArgs[0] ?? null;
    commandArgs = commandArgs.slice(1);
    if (!command || command === "help" || command === "--help" || command === "-h") {
      context.output.writeText(renderScoutHelp(SCOUT_APP_VERSION));
      return;
    }
  }

  const registration = findScoutCommandRegistration(command);
  if (!registration) {
    const implicitPromptArgs = [command, ...commandArgs];
    try {
      const options = parseImplicitAskCommandOptions(implicitPromptArgs, defaultScoutContextDirectory(context));
      await runAskWithOptions(context, options);
      exitAfterCompletedCommand("ask");
      return;
    } catch (error) {
      if (error instanceof ScoutCliError && error.message.startsWith("implicit ask requires")) {
        throw new ScoutCliError(`unknown command: ${command}`);
      }
      throw error;
    }
  }

  if (registration.status === "deprecated" && registration.deprecationMessage) {
    context.stderr(`warning: ${registration.deprecationMessage}`);
  }

  const resolvedCommand = registration.canonicalName ?? registration.name;
  const handler = await loadScoutCommandHandler(resolvedCommand as Parameters<typeof loadScoutCommandHandler>[0]);
  await handler(context, commandArgs);
  exitAfterCompletedCommand(resolvedCommand);
}

const FORCE_EXIT_AFTER_COMPLETED_COMMANDS = new Set(["ask"]);

function exitAfterCompletedCommand(command: string | null): void {
  if (!command || !FORCE_EXIT_AFTER_COMPLETED_COMMANDS.has(command)) {
    return;
  }
  process.exit(process.exitCode ?? 0);
}

/** Cached scout shim path — resolved once per process. */
let _scoutBinPath: string | null = null;

function getScoutBinPath(): string {
  if (_scoutBinPath) return _scoutBinPath;
  // Bun scripts: process.execPath is the bun binary, not the shim.
  // The shim is always at ~/.bun/bin/scout on macOS.
  _scoutBinPath = join(homedir(), ".bun", "bin", "scout");
  if (!existsSync(_scoutBinPath)) {
    // Fallback: resolve via $PATH
    _scoutBinPath = spawnSync("which", ["scout"], { encoding: "utf8" }).stdout.trim();
  }
  return _scoutBinPath;
}

function readCurrentCliMtime(): number | null {
  try {
    return normalizeCliBinaryMtimeMs(statSync(getScoutBinPath()).mtimeMs);
  } catch {
    return null;
  }
}

function cliMtimeCheckpointPath(): string {
  return join(homedir(), ".scout", "cli-mtime");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
}
