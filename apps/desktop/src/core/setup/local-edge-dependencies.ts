import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveExecutableFromSearch } from "@openscout/runtime/tool-resolution";

export type ScoutLocalEdgeDependencyStatus = "ready" | "installed" | "missing" | "skipped" | "error";
export type ScoutLocalEdgeTrustStatus = "trusted" | "installed" | "untrusted" | "unavailable" | "skipped" | "error";

export type ScoutLocalEdgeTrustReport = {
  status: ScoutLocalEdgeTrustStatus;
  rootCertificatePath: string;
  trustCommand: string | null;
  detail: string;
};

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
const MACOS_TRUST_COMMAND_LABEL = "security add-trusted-cert";

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

function resolveCaddyLocalRootCertificatePath(env: NodeJS.ProcessEnv): string {
  return join(
    env.HOME?.trim() || homedir(),
    "Library",
    "Application Support",
    "Caddy",
    "pki",
    "authorities",
    "local",
    "root.crt",
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderMacosTrustScript(rootCertificatePath: string): string {
  const command = [
    "security",
    "add-trusted-cert",
    "-d",
    "-r",
    "trustRoot",
    "-k",
    "/Library/Keychains/System.keychain",
    shellQuote(rootCertificatePath),
  ].join(" ");
  return `do shell script ${JSON.stringify(command)} with administrator privileges`;
}

function inspectScoutLocalEdgeTrust(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  runCommand: RunCommand;
}): ScoutLocalEdgeTrustReport {
  const rootCertificatePath = resolveCaddyLocalRootCertificatePath(input.env);
  const trustCommand = input.platform === "darwin" ? MACOS_TRUST_COMMAND_LABEL : "caddy trust";

  if (!existsSync(rootCertificatePath)) {
    return {
      status: "unavailable",
      rootCertificatePath,
      trustCommand,
      detail: "Caddy has not generated its local CA root yet. Start `scout server edge` once to create it.",
    };
  }

  if (input.platform !== "darwin") {
    return {
      status: "skipped",
      rootCertificatePath,
      trustCommand: "caddy trust",
      detail: "Automatic local HTTPS trust is only implemented for macOS right now.",
    };
  }

  const verifyResult = input.runCommand("security", ["verify-cert", "-c", rootCertificatePath, "-p", "ssl"], {
    encoding: "utf8",
    timeout: 10_000,
    env: input.env,
  });
  if (verifyResult.status === 0) {
    return {
      status: "trusted",
      rootCertificatePath,
      trustCommand: null,
      detail: "Caddy's local CA root is trusted by the macOS system keychain.",
    };
  }

  return {
    status: "untrusted",
    rootCertificatePath,
    trustCommand,
    detail: "Caddy's local CA root exists, but macOS does not trust it yet.",
  };
}

export function ensureScoutLocalEdgeTrust(
  options: LocalEdgeDependencyOptions = {},
): ScoutLocalEdgeTrustReport {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const current = inspectScoutLocalEdgeTrust({ env, platform, runCommand });

  if (current.status === "trusted") {
    return current;
  }
  if (current.status !== "untrusted") {
    return current;
  }
  if (platform !== "darwin") {
    return current;
  }

  const trustResult = runCommand("osascript", ["-e", renderMacosTrustScript(current.rootCertificatePath)], {
    encoding: "utf8",
    timeout: 120_000,
    env,
  });
  if (trustResult.status !== 0) {
    const detail = firstNonEmptyLine(trustResult.stderr)
      ?? firstNonEmptyLine(trustResult.stdout)
      ?? trustResult.error?.message
      ?? "macOS did not trust the Caddy local CA root.";
    return {
      ...current,
      status: "error",
      detail,
    };
  }

  const afterTrust = inspectScoutLocalEdgeTrust({ env, platform, runCommand });
  if (afterTrust.status === "trusted") {
    return {
      ...afterTrust,
      status: "installed",
      detail: "Trusted Caddy's local CA root in the macOS system keychain.",
    };
  }

  return {
    ...afterTrust,
    status: "error",
    detail: "macOS accepted the trust request, but the Caddy local CA root still does not verify as trusted.",
  };
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
