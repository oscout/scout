import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureProviderTelemetryBootstrap } from "@openscout/runtime";
import { readProcessTable, terminateProcesses } from "../app-lifecycle.ts";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export type ScoutMenuAction = "launch" | "restart" | "quit" | "status" | "build" | "dmg";

type ScoutMenuCommand = {
  action: ScoutMenuAction;
  passthroughArgs: string[];
};

type ScoutMenuResult = {
  action: ScoutMenuAction;
  mode: "repo-helper" | "installed-app";
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
const APP_BUNDLE_ID = "app.openscout.scout";
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
    "  scout menu build",
    "  scout menu dmg",
    "",
    "Aliases:",
    "  launch = open = start",
    "  quit   = stop",
    "",
    "Behavior:",
    "  On macOS, `scout menu` loads the menu bar app from the installed OpenScout.app",
    "  (the menu ships as an embedded helper). If OpenScout.app is not installed, it",
    "  points you to `scout install`. Inside an OpenScout repo checkout it prefers",
    "  `apps/macos/bin/openscout-menu.ts` so launch/build/restart reuse the repo helper.",
    "",
    "Examples:",
    "  scout menu",
    "  scout menu status",
    "  scout menu restart",
    "  scout menu build --version 0.2.16",
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
    case "build":
      return { action: "build", passthroughArgs: rest };
    case "dmg":
      return { action: "dmg", passthroughArgs: rest };
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

function findRepoMenuHelper(startDirectory: string): string | null {
  let current = resolve(startDirectory);

  while (true) {
    const candidate = join(current, "apps", "macos", "bin", "openscout-menu.ts");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const sourceRelativeCandidate = fileURLToPath(new URL("../../../../macos/bin/openscout-menu.ts", import.meta.url).toString());
  return existsSync(sourceRelativeCandidate) ? sourceRelativeCandidate : null;
}

/**
 * The helper a checkout actually runs is the one embedded in `Scout.app`, not
 * the standalone `dist/ScoutMenu.app`. They share a bundle identifier and
 * diverge freely — the standalone was nine days stale when this was written —
 * so pointing liveness checks at the standalone reported "not running" while the
 * embedded helper sat in the menu bar, and `launch` then started a second one.
 *
 * The standalone bundle is no longer a lifecycle target. `macos:build` may still
 * produce it, but nothing here starts, stops, or counts it.
 */
function resolveRepoBundlePath(helperPath: string): string {
  return resolve(dirname(helperPath), "..", "dist", "Scout.app", EMBEDDED_MENU_RELATIVE_PATH);
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
  const { ours, others } = menuProcesses(helperBundlePath);
  return helperBundlePath ? ours.length > 0 : others.length > 0;
}

/** Stops only the helper we own, and waits to confirm it actually exited. */
async function stopRunningMenu(helperBundlePath: string | null): Promise<boolean> {
  const { ours, others } = menuProcesses(helperBundlePath);
  const targets = helperBundlePath ? ours : others;
  if (targets.length === 0) return true;
  const { survivors } = await terminateProcesses(targets);
  return survivors.length === 0;
}

function resolveInstalledAppBundlePath(env: NodeJS.ProcessEnv): string | null {
  const spotlight = runProcess(
    "mdfind",
    [`kMDItemCFBundleIdentifier == '${APP_BUNDLE_ID}'`],
    { env, allowFailure: true },
  );
  const indexedPath = spotlight.stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (indexedPath) {
    return indexedPath;
  }

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
  const bundleAttempts: Array<{ command: string; args: string[] }> = [
    { command: "open", args: ["-b", MENU_BUNDLE_ID] },
  ];
  if (helperPath) {
    bundleAttempts.push({ command: "open", args: [helperPath] });
  }

  let lastFailure = "OpenScout is not installed.";
  for (const attempt of bundleAttempts) {
    const result = runProcess(attempt.command, attempt.args, { env, allowFailure: true });
    if (result.ok) {
      return;
    }
    lastFailure = result.stderr || result.stdout || lastFailure;
  }

  throw new ScoutCliError(
    `${lastFailure} Run \`scout install\` to download the OpenScout app, or run from the repo to build it.`,
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
    case "build":
      return "Built the OpenScout menu app bundle.";
    case "dmg":
      return "Built the OpenScout menu app DMG.";
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
  if (action === "build" || action === "dmg" || action === "quit") {
    return;
  }
  try {
    await ensureProviderTelemetryBootstrap({ env: context.env });
  } catch {
    // Launching the app should not fail because a provider telemetry hook could
    // not be repaired. The web server also retries this on startup.
  }
}

async function runWithRepoHelper(
  context: ScoutCommandContext,
  helperPath: string,
  command: ScoutMenuCommand,
): Promise<ScoutMenuResult> {
  const bundlePath = resolveRepoBundlePath(helperPath);

  // `quit` and `restart` are handled here rather than delegated, because
  // `openscout-menu.ts` stops the helper with `pkill -x ScoutMenu` — a
  // name-matched kill that reaches into every other checkout on the machine.
  // That is the exact behaviour this command exists to replace, and leaving the
  // repo branch delegating meant it survived in the one case (a dev checkout)
  // where two helpers are most likely to be running.
  if (command.action === "quit" || command.action === "restart") {
    await stopRunningMenu(bundlePath);
  }
  if (command.action !== "quit") {
    runProcess(process.execPath, [helperPath, command.action, ...command.passthroughArgs], {
      cwd: defaultScoutContextDirectory(context),
      env: context.env,
    });
  }

  const running = command.action === "quit" ? false : isMenuRunning(bundlePath);
  const installed = existsSync(bundlePath) || running;

  return {
    action: command.action,
    mode: "repo-helper",
    bundleId: MENU_BUNDLE_ID,
    bundlePath,
    helperPath,
    installed,
    running,
    message: renderActionMessage(command.action),
  };
}

async function runWithInstalledApp(
  context: ScoutCommandContext,
  command: ScoutMenuCommand,
): Promise<ScoutMenuResult> {
  if (command.action === "build" || command.action === "dmg") {
    throw new ScoutCliError(
      `scout menu ${command.action} requires an OpenScout repo checkout. Run from the repo root or use bun run macos:${command.action}.`,
    );
  }

  const appBundlePath = resolveInstalledAppBundlePath(context.env);
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
  const helperPath = findRepoMenuHelper(defaultScoutContextDirectory(context));
  const result = helperPath
    ? await runWithRepoHelper(context, helperPath, command)
    : await runWithInstalledApp(context, command);

  context.output.writeValue(result, renderMenuResult);
}
