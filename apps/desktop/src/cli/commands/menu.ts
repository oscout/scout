import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ensureProviderTelemetryBootstrap } from "@openscout/runtime";
import { readProcessTable, terminateProcesses } from "../app-lifecycle.ts";
import type { ScoutCommandContext } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export type ScoutMenuAction = "launch" | "restart" | "quit" | "status";

type ScoutMenuCommand = {
  action: ScoutMenuAction;
  passthroughArgs: string[];
};

type ScoutMenuResult = {
  action: ScoutMenuAction;
  mode: "installed-app";
  bundleId: string;
  bundlePath: string | null;
  helperPath: string | null;
  installed: boolean;
  running: boolean;
  message: string;
};

const MENU_BUNDLE_ID = "app.openscout.scout.menu";
const MENU_BUNDLE_NAME = "ScoutMenu.app";
const MENU_PROCESS_NAME = "ScoutMenu";
// Installed builds ship the menu bar app as a helper embedded inside OpenScout.app.
const APP_BUNDLE_NAME = "OpenScout.app";
const EMBEDDED_MENU_RELATIVE_PATH = join("Contents", "Library", "LoginItems", "ScoutMenu.app");
const HELP_FLAGS = new Set(["help", "--help", "-h"]);
const COMMON_APP_BUNDLE_PATHS = [
  join("/Applications", APP_BUNDLE_NAME),
  join(homedir(), "Applications", APP_BUNDLE_NAME),
] as const;

export function renderMenuCommandHelp(): string {
  return [
    "scout menu — macOS menu bar app",
    "",
    "Usage:",
    "  scout menu",
    "  scout menu launch",
    "  scout menu status",
    "  scout menu restart",
    "  scout menu quit",
    "",
    "Aliases:",
    "  launch = open = start",
    "  quit   = stop",
    "",
    "Behavior:",
    "  On macOS, `scout menu` loads the menu bar app from the installed OpenScout.app",
    "  (the menu ships as an embedded helper). If OpenScout.app is not installed, it",
    "  points you to `scout install`. Native app build and DMG tooling lives in the",
    "  private OpenScout product repository and is not exposed by the public CLI.",
    "",
    "Examples:",
    "  scout menu",
    "  scout menu status",
    "  scout menu restart",
  ].join("\n");
}

export function parseMenuCommand(args: string[]): ScoutMenuCommand {
  const [first, ...rest] = args;
  if (!first) {
    return { action: "launch", passthroughArgs: [] };
  }

  if (first.startsWith("-")) {
    return { action: "launch", passthroughArgs: args };
  }

  switch (first) {
    case "launch":
    case "open":
    case "start":
      return { action: "launch", passthroughArgs: rest };
    case "restart":
      return { action: "restart", passthroughArgs: rest };
    case "quit":
    case "stop":
      return { action: "quit", passthroughArgs: rest };
    case "status":
      return { action: "status", passthroughArgs: rest };
    default:
      throw new ScoutCliError(`unknown subcommand: ${first} (try: scout menu)`);
  }
}

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    allowFailure?: boolean;
  },
): {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });

  if (result.error) {
    throw new ScoutCliError(`failed to run ${command}: ${result.error.message}`);
  }

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const ok = (result.status ?? 1) === 0;
  if (!ok && !options.allowFailure) {
    const detail = stderr || stdout || `${command} ${args.join(" ")} failed`;
    throw new ScoutCliError(detail);
  }

  return {
    ok,
    stdout,
    stderr,
    status: result.status,
  };
}

/**
 * Menu processes launched from `helperBundlePath`, and everything else wearing
 * the same name.
 *
 * `pgrep -x ScoutMenu` cannot tell these apart, and `pkill -x ScoutMenu` used to
 * kill both — including a helper belonging to another checkout. The repo builds
 * two ScoutMenu bundles (a standalone `dist/ScoutMenu.app` and the copy embedded
 * in Scout.app) that share a bundle identifier, so "is the menu running" is only
 * a meaningful question once you say *which* menu.
 */
function menuProcesses(helperBundlePath: string | null): { ours: number[]; others: number[] } {
  const expected = helperBundlePath
    ? join(helperBundlePath, "Contents", "MacOS", MENU_PROCESS_NAME)
    : null;
  const ours: number[] = [];
  const others: number[] = [];

  for (const record of readProcessTable()) {
    if (record.command !== MENU_PROCESS_NAME && !record.executable.endsWith(`/${MENU_PROCESS_NAME}`)) continue;
    if (expected && record.executable === expected) ours.push(record.pid);
    else others.push(record.pid);
  }

  return { ours, others };
}

function isMenuRunning(helperBundlePath: string | null): boolean {
  if (!helperBundlePath) return false;
  return menuProcesses(helperBundlePath).ours.length > 0;
}

/** Stops only the helper we own, and waits to confirm it actually exited. */
async function stopRunningMenu(helperBundlePath: string | null): Promise<boolean> {
  if (!helperBundlePath) return true;
  const targets = menuProcesses(helperBundlePath).ours;
  if (targets.length === 0) return true;
  const { survivors } = await terminateProcesses(targets);
  return survivors.length === 0;
}

function resolveInstalledAppBundlePath(): string | null {
  for (const candidate of COMMON_APP_BUNDLE_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveEmbeddedMenuBundlePath(appBundlePath: string): string {
  return join(appBundlePath, EMBEDDED_MENU_RELATIVE_PATH);
}

function openInstalledMenuApp(helperPath: string | null, env: NodeJS.ProcessEnv): void {
  const bundleAttempts: Array<{ command: string; args: string[] }> = [];
  if (helperPath) {
    bundleAttempts.push({ command: "open", args: [helperPath] });
  }
  bundleAttempts.push({ command: "open", args: ["-b", MENU_BUNDLE_ID] });

  let lastFailure = "OpenScout is not installed.";
  for (const attempt of bundleAttempts) {
    const result = runProcess(attempt.command, attempt.args, { env, allowFailure: true });
    if (result.ok) {
      return;
    }
    lastFailure = result.stderr || result.stdout || lastFailure;
  }

  throw new ScoutCliError(
    `${lastFailure} Run \`scout install\` to download the OpenScout app.`,
  );
}

function renderMenuResult(result: ScoutMenuResult): string {
  if (result.action === "status") {
    const lines = [
      `Installed: ${result.installed ? "yes" : "no"}`,
      `Running: ${result.running ? "yes" : "no"}`,
    ];
    if (result.bundlePath) {
      lines.splice(1, 0, `Bundle: ${result.bundlePath}`);
    }
    if (result.helperPath) {
      lines.push(`Helper: ${result.helperPath}`);
    }
    if (!result.installed) {
      lines.push("Run `scout install` to download the macOS app.");
    }
    return lines.join("\n");
  }

  const lines = [result.message];
  if (result.bundlePath) {
    lines.push(`Bundle: ${result.bundlePath}`);
  }
  return lines.join("\n");
}

function renderActionMessage(action: ScoutMenuAction): string {
  switch (action) {
    case "restart":
      return "Restarted the OpenScout menu app.";
    case "quit":
      return "Stopped the OpenScout menu app.";
    case "status":
      return "Checked the OpenScout menu app status.";
    case "launch":
    default:
      return "Opened the OpenScout menu app.";
  }
}

async function ensureMenuProviderTelemetry(context: ScoutCommandContext, action: ScoutMenuAction): Promise<void> {
  if (action === "quit") {
    return;
  }
  try {
    await ensureProviderTelemetryBootstrap({ env: context.env });
  } catch {
    // Launching the app should not fail because a provider telemetry hook could
    // not be repaired. The web server also retries this on startup.
  }
}

async function runWithInstalledApp(
  context: ScoutCommandContext,
  command: ScoutMenuCommand,
): Promise<ScoutMenuResult> {
  const appBundlePath = resolveInstalledAppBundlePath();
  const helperPath = appBundlePath ? resolveEmbeddedMenuBundlePath(appBundlePath) : null;

  if (!appBundlePath && command.action !== "status") {
    throw new ScoutCliError(
      "OpenScout is not installed. Run `scout install` to download the macOS app.",
    );
  }

  switch (command.action) {
    case "launch":
      if (!isMenuRunning(helperPath)) {
        openInstalledMenuApp(helperPath, context.env);
      }
      break;
    case "restart":
      await stopRunningMenu(helperPath);
      openInstalledMenuApp(helperPath, context.env);
      break;
    case "quit":
      await stopRunningMenu(helperPath);
      break;
    case "status":
      break;
    default:
      break;
  }

  const running = command.action === "quit" ? false : isMenuRunning(helperPath);
  const installed = Boolean(appBundlePath) || running;

  return {
    action: command.action,
    mode: "installed-app",
    bundleId: MENU_BUNDLE_ID,
    bundlePath: appBundlePath,
    helperPath,
    installed,
    running,
    message: installed
      ? renderActionMessage(command.action)
      : "OpenScout is not installed. Run `scout install` to download the macOS app.",
  };
}

export async function runMenuCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  if (HELP_FLAGS.has(args[0] ?? "")) {
    context.output.writeText(renderMenuCommandHelp());
    return;
  }

  if (process.platform !== "darwin") {
    throw new ScoutCliError("scout menu is only supported on macOS.");
  }

  const command = parseMenuCommand(args);
  await ensureMenuProviderTelemetry(context, command.action);
  const result = await runWithInstalledApp(context, command);

  context.output.writeValue(result, renderMenuResult);
}
