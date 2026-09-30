import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

import {
  ensureScoutLocalEdgeTrust,
  inspectScoutLocalEdgeTrust,
  type ScoutLocalEdgeTrustReport,
} from "@openscout/runtime/local-edge";
import { resolveExecutableFromSearch } from "@openscout/runtime/tool-resolution";

export {
  ensureScoutLocalEdgeTrust,
  inspectScoutLocalEdgeTrust,
  type ScoutLocalEdgeTrustReport,
  type ScoutLocalEdgeTrustStatus,
} from "@openscout/runtime/local-edge";

export type ScoutLocalEdgeDependencyStatus = "ready" | "installed" | "missing" | "skipped" | "error";

export type ScoutLocalEdgeDependencyReport = {
  status: ScoutLocalEdgeDependencyStatus;
  caddyPath: string | null;
  caddyVersion: string | null;
  installCommand: string | null;
  trust: ScoutLocalEdgeTrustReport;
  detail: string;
};

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type RunCommand = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => CommandResult;

type LocalEdgeDependencyOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: RunCommand;
  commonDirectories?: string[];
  trustLocalHttps?: boolean;
};

const CADDY_INSTALL_COMMAND = "brew install caddy";

function defaultRunCommand(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): CommandResult {
  const result = spawnSync(command, args, options);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function firstNonEmptyLine(value: string): string | null {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function resolveCaddyExecutable(env: NodeJS.ProcessEnv, commonDirectories?: string[]): string | null {
  return resolveExecutableFromSearch({
    env,
    envKeys: ["OPENSCOUT_CADDY_BIN"],
    names: ["caddy"],
    commonDirectories,
  })?.path ?? null;
}

function resolveBrewExecutable(env: NodeJS.ProcessEnv, commonDirectories?: string[]): string | null {
  return resolveExecutableFromSearch({
    env,
    names: ["brew"],
    commonDirectories,
  })?.path ?? null;
}

function readCaddyVersion(caddyPath: string, runCommand: RunCommand): string | null {
  const result = runCommand(caddyPath, ["version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) {
    return null;
  }
  return firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr);
}

export function inspectScoutLocalEdgeDependencies(
  options: LocalEdgeDependencyOptions = {},
): ScoutLocalEdgeDependencyReport {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const trust = inspectScoutLocalEdgeTrust({ env, platform, runCommand });
  const caddyPath = resolveCaddyExecutable(env, options.commonDirectories);
  if (caddyPath) {
    return {
      status: "ready",
      caddyPath,
      caddyVersion: readCaddyVersion(caddyPath, runCommand),
      installCommand: null,
      trust,
      detail: "Caddy is available for the Scout local edge.",
    };
  }

  return {
    status: "missing",
    caddyPath: null,
    caddyVersion: null,
    installCommand: CADDY_INSTALL_COMMAND,
    trust,
    detail: "Caddy is not installed. Scout needs it for `scout server edge`.",
  };
}

export function ensureScoutLocalEdgeDependencies(
  options: LocalEdgeDependencyOptions = {},
): ScoutLocalEdgeDependencyReport {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const trustLocalHttps = options.trustLocalHttps ?? false;
  const current = inspectScoutLocalEdgeDependencies({
    env,
    platform,
    runCommand,
    commonDirectories: options.commonDirectories,
  });
  if (current.status === "ready") {
    return trustLocalHttps
      ? { ...current, trust: ensureScoutLocalEdgeTrust({ env, platform, runCommand }) }
      : current;
  }

  if (platform !== "darwin") {
    return {
      ...current,
      status: "skipped",
      installCommand: null,
      detail: "Automatic Caddy install is only enabled on macOS. Install Caddy and set OPENSCOUT_CADDY_BIN if it is not on PATH.",
    };
  }

  const brewPath = resolveBrewExecutable(env, options.commonDirectories);
  if (!brewPath) {
    return {
      ...current,
      status: "missing",
      detail: "Homebrew was not found, so Scout could not install Caddy automatically. Install Caddy manually or set OPENSCOUT_CADDY_BIN.",
    };
  }

  const installResult = runCommand(brewPath, ["install", "caddy"], {
    encoding: "utf8",
    timeout: 120_000,
    env,
  });
  if (installResult.status !== 0) {
    const detail = firstNonEmptyLine(installResult.stderr)
      ?? firstNonEmptyLine(installResult.stdout)
      ?? installResult.error?.message
      ?? "brew install caddy failed.";
    return {
      ...current,
      status: "error",
      detail,
    };
  }

  const caddyPath = resolveCaddyExecutable(env, options.commonDirectories);
  if (!caddyPath) {
    return {
      ...current,
      status: "error",
      detail: "Homebrew completed, but `caddy` is still not on PATH. Set OPENSCOUT_CADDY_BIN to the installed Caddy executable.",
    };
  }

  return {
    status: "installed",
    caddyPath,
    caddyVersion: readCaddyVersion(caddyPath, runCommand),
    installCommand: CADDY_INSTALL_COMMAND,
    trust: trustLocalHttps
      ? ensureScoutLocalEdgeTrust({ env, platform, runCommand })
      : inspectScoutLocalEdgeTrust({ env, platform, runCommand }),
    detail: "Installed Caddy with Homebrew. Scout runs Caddy with its generated local-edge Caddyfile.",
  };
}
