import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

const HELP_FLAGS = new Set(["--help", "-h", "help"]);
const SCOUT_TUI_BIN_NAME = "scout-tui";

export type TuiLaunchOptions =
  | { mode: "help" }
  | { mode: "monitor"; args: string[] }
  | { mode: "instrument"; passthrough: string[] };

export type ScoutTuiLaunch =
  | { kind: "bin"; command: string; args: string[] }
  | { kind: "cargo"; command: string; args: string[]; cwd: string };

export type TuiCommandDependencies = {
  spawnSync?: typeof spawnSync;
  exit?: (code: number) => void;
};

export function renderTuiCommandHelp(): string {
  return [
    "Usage:",
    "  scout tui [--take now|horizon|twin|mesh|quota|harvest|grid]",
    "  scout tui [--composition focus|watch|review|quad]",
    "  scout tui --probe",
    "",
    "Launch the Scout TUI in this terminal.",
    "",
    "This is the ratatui night instrument. The legacy v1 OpenTUI console `scout monitor` is retired.",
    "",
    "Binary resolution, in order:",
    "  SCOUT_TUI_BIN",
    "  <checkout>/target/release/scout-tui",
    "  <checkout>/target/debug/scout-tui",
    "  scout-tui on PATH",
    "  cargo run from crates/scout-tui in an OpenScout checkout",
    "",
    "Examples:",
    "  scout tui",
    "  scout tui --take mesh",
    "  scout tui --composition watch",
  ].join("\n");
}

export function parseTuiLaunchOptions(args: string[]): TuiLaunchOptions {
  if (args.some((arg) => HELP_FLAGS.has(arg))) return { mode: "help" };

  const monitorIndex = args.findIndex((arg) => arg === "--monitor" || arg === "monitor");
  if (monitorIndex >= 0) {
    return {
      mode: "monitor",
      args: args.filter((_, index) => index !== monitorIndex),
    };
  }

  return { mode: "instrument", passthrough: args };
}

export function resolveScoutTuiLaunch(input: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): ScoutTuiLaunch {
  const env = input.env ?? process.env;
  const cwd = resolve(input.cwd ?? process.cwd());
  const configured = env.SCOUT_TUI_BIN?.trim();
  if (configured) {
    if (!isExecutable(configured)) {
      throw new ScoutCliError(`SCOUT_TUI_BIN is not executable: ${configured}`);
    }
    return { kind: "bin", command: configured, args: [] };
  }

  const checkout = findScoutTuiCheckout(cwd, env);
  if (checkout) {
    for (const candidate of [
      join(checkout, "target/release", SCOUT_TUI_BIN_NAME),
      join(checkout, "target/debug", SCOUT_TUI_BIN_NAME),
    ]) {
      if (isExecutable(candidate)) {
        return { kind: "bin", command: candidate, args: [] };
      }
    }
  }

  const onPath = commandOnPath(SCOUT_TUI_BIN_NAME, env);
  if (onPath) {
    return { kind: "bin", command: onPath, args: [] };
  }

  if (checkout) {
    const cargo = cargoRunner(checkout, env);
    return {
      kind: "cargo",
      command: cargo.command,
      args: [
        ...cargo.prefixArgs,
        "run",
        "--manifest-path",
        "crates/scout-tui/Cargo.toml",
        "--bin",
        SCOUT_TUI_BIN_NAME,
      ],
      cwd: checkout,
    };
  }

  throw new ScoutCliError(
    "scout-tui not found. From an OpenScout checkout run `bun run scout:tui:build` or `bun run scout:tui:install`, or set SCOUT_TUI_BIN.",
  );
}

export async function runTuiCommand(
  context: ScoutCommandContext,
  args: string[],
  dependencies: TuiCommandDependencies = {},
): Promise<void> {
  if (context.output.mode === "json") {
    throw new ScoutCliError("scout tui does not support --json");
  }

  const options = parseTuiLaunchOptions(args);
  if (options.mode === "help") {
    context.output.writeText(renderTuiCommandHelp());
    return;
  }

  if (options.mode === "monitor") {
    context.stderr("`scout monitor` (the legacy v1 OpenTUI console) has been retired. Use `scout tui`.");
    return;
  }

  const launch = resolveScoutTuiLaunch({
    env: context.env,
    cwd: context.cwd,
  });
  const argv = launch.kind === "cargo"
    ? [...launch.args, "--", ...options.passthrough]
    : [...launch.args, ...options.passthrough];
  const result = (dependencies.spawnSync ?? spawnSync)(launch.command, argv, {
    stdio: "inherit",
    env: context.env,
    cwd: launch.kind === "cargo" ? launch.cwd : context.cwd,
  });
  finishSpawn(result, dependencies.exit ?? ((code) => process.exit(code)));
}

function finishSpawn(
  result: SpawnSyncReturns<string | Buffer>,
  exit: (code: number) => void,
): void {
  if (result.error) {
    throw new ScoutCliError(`failed to launch scout-tui: ${result.error.message}`);
  }
  if (result.status !== null && result.status !== 0) {
    exit(result.status);
  }
  if (result.signal) {
    throw new ScoutCliError(`scout-tui terminated by ${result.signal}`);
  }
}

function findScoutTuiCheckout(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const starts = [
    cwd,
    env.OPENSCOUT_SETUP_CWD?.trim(),
    dirname(fileURLToPath(import.meta.url)),
  ].filter((value): value is string => Boolean(value));

  for (const start of starts) {
    let current = resolve(start);
    while (true) {
      if (existsSync(join(current, "crates/scout-tui/Cargo.toml"))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

function cargoRunner(checkout: string, env: NodeJS.ProcessEnv): {
  command: string;
  prefixArgs: string[];
} {
  const script = join(checkout, "scripts/cargo.sh");
  if (isExecutable(script)) {
    return { command: script, prefixArgs: [] };
  }
  const cargo = env.CARGO?.trim() || commandOnPath("cargo", env);
  if (cargo) {
    return { command: cargo, prefixArgs: [] };
  }
  throw new ScoutCliError(
    "scout-tui is not built and cargo was not found. Run `bun run scout:tui:build` or install Rust.",
  );
}

function commandOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = env.PATH ?? "";
  for (const directory of pathValue.split(":")) {
    const trimmed = directory.trim();
    if (!trimmed) continue;
    const candidate = join(trimmed, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
