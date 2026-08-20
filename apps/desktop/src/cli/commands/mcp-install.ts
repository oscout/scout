import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export type ScoutMcpInstallHost = "claude" | "codex";

type ScoutMcpInstallOptions = {
  dryRun: boolean;
  force: boolean;
  hosts: ScoutMcpInstallHost[];
};

type ScoutMcpLaunchCommand = {
  command: string;
  args: string[];
};

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type CommandRunner = (
  command: string,
  args: string[],
) => CommandResult;

type HostInstallOutcome =
  | {
      host: ScoutMcpInstallHost;
      status: "installed" | "already_installed";
      detail: string;
    }
  | {
      host: ScoutMcpInstallHost;
      status: "skipped" | "failed";
      detail: string;
    };

const HELP_FLAGS = new Set(["--help", "-h"]);

function isExecutable(filePath: string | undefined | null): filePath is string {
  if (!filePath) {
    return false;
  }

  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutableFromSearchPath(
  names: string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const pathEntries = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  const commonDirectories = [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Applications/Codex.app/Contents/Resources",
  ];

  for (const directory of [...pathEntries, ...commonDirectories]) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveHostExecutable(
  host: ScoutMcpInstallHost,
  env: NodeJS.ProcessEnv,
): string | null {
  if (host === "codex") {
    return resolveExecutableFromSearchPath(["codex"], env);
  }
  return resolveExecutableFromSearchPath(["claude"], env);
}

function resolveCurrentScoutMcpLaunchCommand(
  env: NodeJS.ProcessEnv,
): ScoutMcpLaunchCommand {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript) && isExecutable(process.execPath)) {
    return {
      command: process.execPath,
      args: [resolve(currentScript), "mcp"],
    };
  }

  const explicitCandidates = [
    env.OPENSCOUT_CLI_BIN,
    env.SCOUT_CLI_BIN,
    env.OPENSCOUT_SCOUT_BIN,
    env.SCOUT_BIN,
  ];
  for (const candidate of explicitCandidates) {
    if (isExecutable(candidate)) {
      return {
        command: candidate,
        args: ["mcp"],
      };
    }
  }

  const scoutExecutable = resolveExecutableFromSearchPath(["scout"], env);
  if (scoutExecutable) {
    return {
      command: scoutExecutable,
      args: ["mcp"],
    };
  }

  throw new ScoutCliError(
    "Could not resolve a Scout CLI command to register with MCP hosts.",
  );
}

function parseFlagValue(args: string[], index: number, flag: string): {
  value: string;
  nextIndex: number;
} {
  const current = args[index] ?? "";
  if (current === flag) {
    const value = args[index + 1];
    if (!value) {
      throw new ScoutCliError(`missing value for ${flag}`);
    }
    return { value, nextIndex: index + 1 };
  }

  const prefix = `${flag}=`;
  if (current.startsWith(prefix)) {
    return { value: current.slice(prefix.length), nextIndex: index };
  }

  throw new ScoutCliError(`missing value for ${flag}`);
}

function parseHostValue(value: string): ScoutMcpInstallHost {
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new ScoutCliError(`unsupported MCP host "${value}" (expected codex or claude)`);
}

export function renderMcpInstallHelp(): string {
  return [
    "Usage: scout mcp install [--host <codex|claude>] [--force] [--dry-run]",
    "",
    "Register the current Scout MCP server command with supported local hosts.",
    "",
    "Defaults to every detected host. Codex is installed through its global",
    "config, and Claude Code is installed at user scope.",
    "",
    "Examples:",
    "  scout mcp install",
    "  scout mcp install --host codex --force",
    "  scout mcp install --host claude --dry-run",
  ].join("\n");
}

export function parseMcpInstallCommandOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
): ScoutMcpInstallOptions {
  const hosts: ScoutMcpInstallHost[] = [];
  let force = false;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (!current) {
      continue;
    }
    if (HELP_FLAGS.has(current)) {
      continue;
    }
    if (current === "--force") {
      force = true;
      continue;
    }
    if (current === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (current === "--host" || current.startsWith("--host=")) {
      const parsed = parseFlagValue(args, index, "--host");
      hosts.push(parseHostValue(parsed.value));
      index = parsed.nextIndex;
      continue;
    }
    throw new ScoutCliError(`unexpected argument for mcp install: ${current}`);
  }

  const resolvedHosts = hosts.length > 0
    ? [...new Set(hosts)]
    : (["codex", "claude"] as const).filter((host) => resolveHostExecutable(host, env) !== null);

  return {
    dryRun,
    force,
    hosts: [...resolvedHosts],
  };
}

function defaultCommandRunner(
  context: ScoutCommandContext,
): CommandRunner {
  return (command, args) => {
    const result = spawnSync(command, args, {
      cwd: context.cwd,
      env: context.env,
      encoding: "utf8",
      stdio: "pipe",
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  };
}

function commandFailed(result: CommandResult): boolean {
  return Boolean(result.error) || result.status !== 0;
}

function installForCodex(input: {
  executablePath: string;
  launch: ScoutMcpLaunchCommand;
  force: boolean;
  dryRun: boolean;
  run: CommandRunner;
}): HostInstallOutcome {
  const existing = input.run(input.executablePath, ["mcp", "get", "scout"]);
  if (!commandFailed(existing) && !input.force) {
    return {
      host: "codex",
      status: "already_installed",
      detail: "Codex already has a scout MCP entry.",
    };
  }

  if (input.dryRun) {
    return {
      host: "codex",
      status: "installed",
      detail: `Would run: ${input.executablePath} mcp add scout -- ${input.launch.command} ${input.launch.args.join(" ")}`,
    };
  }

  if (!commandFailed(existing) && input.force) {
    const removed = input.run(input.executablePath, ["mcp", "remove", "scout"]);
    if (commandFailed(removed)) {
      return {
        host: "codex",
        status: "failed",
        detail: removed.stderr.trim() || removed.stdout.trim() || "Failed to replace existing Codex MCP config.",
      };
    }
  }

  const added = input.run(input.executablePath, [
    "mcp",
    "add",
    "scout",
    "--",
    input.launch.command,
    ...input.launch.args,
  ]);
  if (commandFailed(added)) {
    return {
      host: "codex",
      status: "failed",
      detail: added.stderr.trim() || added.stdout.trim() || "Failed to install scout MCP into Codex.",
    };
  }

  return {
    host: "codex",
    status: "installed",
    detail: "Installed scout MCP for Codex.",
  };
}

function installForClaude(input: {
  executablePath: string;
  launch: ScoutMcpLaunchCommand;
  force: boolean;
  dryRun: boolean;
  run: CommandRunner;
}): HostInstallOutcome {
  const existing = input.run(input.executablePath, ["mcp", "get", "scout"]);
  if (!commandFailed(existing) && !input.force) {
    return {
      host: "claude",
      status: "already_installed",
      detail: "Claude Code already has a scout MCP entry.",
    };
  }

  if (input.dryRun) {
    return {
      host: "claude",
      status: "installed",
      detail: `Would run: ${input.executablePath} mcp add --scope user scout -- ${input.launch.command} ${input.launch.args.join(" ")}`,
    };
  }

  if (!commandFailed(existing) && input.force) {
    const removed = input.run(input.executablePath, ["mcp", "remove", "--scope", "user", "scout"]);
    if (commandFailed(removed)) {
      return {
        host: "claude",
        status: "failed",
        detail: removed.stderr.trim() || removed.stdout.trim() || "Failed to replace existing Claude Code MCP config.",
      };
    }
  }

  const added = input.run(input.executablePath, [
    "mcp",
    "add",
    "--scope",
    "user",
    "scout",
    "--",
    input.launch.command,
    ...input.launch.args,
  ]);
  if (commandFailed(added)) {
    return {
      host: "claude",
      status: "failed",
      detail: added.stderr.trim() || added.stdout.trim() || "Failed to install scout MCP into Claude Code.",
    };
  }

  return {
    host: "claude",
    status: "installed",
    detail: "Installed scout MCP for Claude Code.",
  };
}

export function installScoutMcpForHosts(input: {
  env: NodeJS.ProcessEnv;
  hosts: ScoutMcpInstallHost[];
  force: boolean;
  dryRun: boolean;
  run?: CommandRunner;
  context?: ScoutCommandContext;
  resolveHostPath?: (host: ScoutMcpInstallHost, env: NodeJS.ProcessEnv) => string | null;
  resolveLaunchCommand?: (env: NodeJS.ProcessEnv) => ScoutMcpLaunchCommand;
}): HostInstallOutcome[] {
  const launch = (input.resolveLaunchCommand ?? resolveCurrentScoutMcpLaunchCommand)(input.env);
  const run = input.run
    ?? (input.context ? defaultCommandRunner(input.context) : undefined);
  const resolveHostPath = input.resolveHostPath ?? resolveHostExecutable;
  if (!run) {
    throw new ScoutCliError("A command runner or command context is required.");
  }

  return input.hosts.map((host) => {
    const executablePath = resolveHostPath(host, input.env);
    if (!executablePath) {
      return {
        host,
        status: "skipped",
        detail: `Skipped ${host}: executable not found.`,
      };
    }
    if (host === "codex") {
      return installForCodex({
        executablePath,
        launch,
        force: input.force,
        dryRun: input.dryRun,
        run,
      });
    }
    return installForClaude({
      executablePath,
      launch,
      force: input.force,
      dryRun: input.dryRun,
      run,
    });
  });
}

export async function runMcpInstallCommand(
  context: ScoutCommandContext,
  args: string[],
): Promise<void> {
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderMcpInstallHelp());
    return;
  }

  const options = parseMcpInstallCommandOptions(args, context.env);
  if (options.hosts.length === 0) {
    context.output.writeText("No supported hosts detected. Looked for codex and claude.");
    return;
  }

  const outcomes = installScoutMcpForHosts({
    env: context.env,
    hosts: options.hosts,
    force: options.force,
    dryRun: options.dryRun,
    context,
  });

  context.output.writeText(
    outcomes.map((outcome) => `[${outcome.host}] ${outcome.detail}`).join("\n"),
  );
}
