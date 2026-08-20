import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExecutableFromSearch } from "@openscout/runtime/tool-resolution";

export type ScoutTerminalPtyStatus =
  | "ready"
  | "missing-node"
  | "missing-binding"
  | "load-failed"
  | "spawn-failed";

export type ScoutTerminalPtyReport = {
  status: ScoutTerminalPtyStatus;
  nodePath: string | null;
  nodeVersion: string | null;
  bindingPackage: string;
  nodePtyPath: string | null;
  bindingPath: string | null;
  installCommand: string | null;
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

type ResolveModule = (specifier: string, fromPath: string) => string | null;

type TerminalPtyDependencyOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  runCommand?: RunCommand;
  resolveModule?: ResolveModule;
  relayBundlePath?: string;
  commonDirectories?: string[];
};

const NODE_INSTALL_COMMAND = "brew install node";
const SMOKE_TIMEOUT_MS = 5_000;

const MISSING_NODE_DETAIL =
  "Terminal sessions run under Node.js (the PTY relay). Install Node 20+ (brew install node) — the Scout web terminal will not start without it.";

function renderMissingBindingDetail(bindingPackage: string): string {
  return `${bindingPackage} is not installed. Reinstall @openscout/scout and ensure optional dependencies are not disabled.`;
}

function renderArchMismatchDetail(error: string): string {
  const verbatim = error.trim() || "node-pty failed without an error message.";
  return `${verbatim} — usually an architecture mismatch (e.g. x64 Node under Rosetta with arm64 bindings). Check \`node -p process.arch\`, then reinstall.`;
}

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

function defaultResolveModule(specifier: string, fromPath: string): string | null {
  try {
    return createRequire(fromPath).resolve(specifier);
  } catch {
    return null;
  }
}

function defaultRelayBundlePath(): string {
  // In the published/bundled CLI, this module and the Node PTY relay bundle are
  // co-located in packages/cli/dist, so module resolution from here walks into
  // packages/cli/node_modules — exactly where @lydell/node-pty is installed.
  const selfDir = dirname(fileURLToPath(import.meta.url));
  return join(selfDir, "openscout-terminal-relay.mjs");
}

function firstNonEmptyLine(value: string): string | null {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function lastNonEmptyLine(value: string): string | null {
  const lines = value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

function resolveNodeExecutable(env: NodeJS.ProcessEnv, commonDirectories?: string[]): string | null {
  return resolveExecutableFromSearch({
    env,
    envKeys: ["OPENSCOUT_NODE_BIN"],
    names: ["node"],
    commonDirectories,
  })?.path ?? null;
}

function readNodeVersion(nodePath: string, runCommand: RunCommand): string | null {
  const result = runCommand(nodePath, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) {
    return null;
  }
  return firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr);
}

function buildPtySmokeScript(nodePtyPath: string): string {
  const target = JSON.stringify(nodePtyPath);
  return [
    "let done = false;",
    "const out = (verdict) => { if (done) return; done = true; process.stdout.write(JSON.stringify(verdict)); process.exit(0); };",
    "let pty;",
    "try {",
    `  pty = require(${target});`,
    "} catch (error) {",
    '  out({ ok: false, stage: "load", message: String((error && error.message) || error) });',
    "}",
    "try {",
    '  const term = pty.spawn("/bin/sh", ["-c", "exit 0"], {});',
    "  term.onExit((event) => out({ ok: true, exitCode: event.exitCode }));",
    '  setTimeout(() => out({ ok: false, stage: "spawn", message: "PTY did not exit within the timeout" }), 4000);',
    "} catch (error) {",
    '  out({ ok: false, stage: "spawn", message: String((error && error.message) || error) });',
    "}",
  ].join("\n");
}

type SmokeVerdict = {
  ok: boolean;
  stage?: string;
  message?: string;
  exitCode?: number;
};

function parseSmokeVerdict(stdout: string): SmokeVerdict | null {
  const line = lastNonEmptyLine(stdout);
  if (!line) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as SmokeVerdict;
    return typeof parsed === "object" && parsed !== null && typeof parsed.ok === "boolean"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function inspectScoutTerminalPtyDependencies(
  options: TerminalPtyDependencyOptions = {},
): ScoutTerminalPtyReport {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const resolveModule = options.resolveModule ?? defaultResolveModule;
  const relayBundlePath = options.relayBundlePath ?? defaultRelayBundlePath();
  const bindingPackage = `@lydell/node-pty-${platform}-${arch}`;

  // Probe 1 — the terminal relay is spawned with literal `node`; without it on
  // PATH the Scout web terminal can never start.
  const nodePath = resolveNodeExecutable(env, options.commonDirectories);
  if (!nodePath) {
    return {
      status: "missing-node",
      nodePath: null,
      nodeVersion: null,
      bindingPackage,
      nodePtyPath: null,
      bindingPath: null,
      installCommand: NODE_INSTALL_COMMAND,
      detail: MISSING_NODE_DETAIL,
    };
  }
  const nodeVersion = readNodeVersion(nodePath, runCommand);

  // Probe 2 — @lydell/node-pty ships its prebuilt N-API binary via a
  // per-platform optional dependency. Resolve the loader from the relay bundle's
  // location, then the platform binding the way node-pty resolves it internally.
  const nodePtyPath = resolveModule("@lydell/node-pty", relayBundlePath);
  const bindingPath = nodePtyPath ? resolveModule(bindingPackage, nodePtyPath) : null;
  if (!nodePtyPath || !bindingPath) {
    return {
      status: "missing-binding",
      nodePath,
      nodeVersion,
      bindingPackage,
      nodePtyPath,
      bindingPath,
      installCommand: null,
      detail: renderMissingBindingDetail(bindingPackage),
    };
  }

  // Probe 3 — dlopen + forkpty in the exact host runtime production uses.
  const smoke = runCommand(nodePath, ["-e", buildPtySmokeScript(nodePtyPath)], {
    encoding: "utf8",
    timeout: SMOKE_TIMEOUT_MS,
    env,
  });
  const verdict = parseSmokeVerdict(smoke.stdout);

  if (verdict?.ok) {
    const version = nodeVersion ? `${nodeVersion}, ` : "";
    return {
      status: "ready",
      nodePath,
      nodeVersion,
      bindingPackage,
      nodePtyPath,
      bindingPath,
      installCommand: null,
      detail: `Node.js PTY relay is ready (${version}${bindingPackage}).`,
    };
  }

  const errorText =
    verdict?.message
    ?? firstNonEmptyLine(smoke.stderr)
    ?? smoke.error?.message
    ?? (smoke.status === null ? "node -e smoke check timed out." : "node -e smoke check failed.");

  return {
    status: verdict?.stage === "load" ? "load-failed" : "spawn-failed",
    nodePath,
    nodeVersion,
    bindingPackage,
    nodePtyPath,
    bindingPath,
    installCommand: null,
    detail: renderArchMismatchDetail(errorText),
  };
}
