import { parseAppCommand as parseLifecycleAppCommand, renderAppCommandHelp, type ScoutAppCommand } from "../../../../../packages/cli/bin/lifecycle-preflight.mjs";
export { renderAppCommandHelp };
export function parseAppCommand(args: string[]): ScoutAppCommand {
  try { return parseLifecycleAppCommand(args); } catch (error) { throw new ScoutCliError((error as Error).message); }
}
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  type AppBundlePaths,
  type LifecycleLayerName,
  type LifecycleTree,
  type StopScope,
  bootoutLaunchdJob,
  classifyProcesses,
  describeStopStep,
  detachedExpectedProcesses,
  isRunning,
  LAUNCH_SERVICES_LAYERS,
  layerProcesses,
  ownedSweepSurvivorPids,
  planStop,
  readProcessTable,
  resolveAppBundlePaths,
  resolveLaunchdLabel,
  startLaunchdJob,
  REQUIRED_SUPERVISED_LAYERS,
  SUPERVISED_LAYERS,
  terminateProcesses,
  verifyTree,
} from "../app-lifecycle.ts";
import {
  describeActiveFlight,
  formatDuration,
  readActiveFlights,
  resolveControlPlaneDbPath,
  waitForIdleFleet,
} from "../app-drain.ts";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export type ScoutAppAction = "status" | "stop" | "start" | "restart";

const HELP_FLAGS = new Set(["help", "--help", "-h"]);
const INSTALLED_APP_BUNDLE_ID = "app.openscout.scout";
const INSTALLED_APP_BUNDLE_NAME = "Scout.app";
/** Shipped as this through 0.2.105; still on every machine that installed one. */
const LEGACY_INSTALLED_APP_BUNDLE_NAMES = ["OpenScout.app"] as const;
const READY_TIMEOUT_MS = 30_000;
// `scoutd start` historically waited this long for broker health before the
// lifecycle command performed its final app/tree check. Opening Scout earlier
// must not shorten that complete supervised-tree reporting window.
const SUPERVISED_READY_TIMEOUT_MS = 120_000;
// scoutd gives its child tree 18 seconds to drain. Let that ownership contract
// run before directly signalling only the still-owned pre-bootout survivors.
const SUPERVISED_DRAIN_TIMEOUT_MS = 20_000;
const POLL_MS = 250;

type LayerReport = {
  layer: LifecycleLayerName;
  pids: number[];
};

type ScoutAppResult = {
  action: ScoutAppAction;
  bundlePath: string;
  menuBundlePath: string;
  running: boolean;
  layers: LayerReport[];
  foreign: Array<{ layer: LifecycleLayerName; pid: number; executable: string }>;
  problems: string[];
  steps: string[];
  message: string;
};

function findRepoDistDirectory(startDirectory: string): string | null {
  let current = resolve(startDirectory);
  while (true) {
    const candidate = join(current, "apps", "macos", "dist", "Scout.app");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** `<checkout>/apps/macos/dist/Scout.app` — a build, not an install. */
function isRepoBuildOutput(bundlePath: string): boolean {
  const distDir = dirname(bundlePath);
  return basename(distDir) === "dist" && basename(dirname(distDir)) === "macos";
}

export function selectInstalledAppBundle(
  indexedPaths: string[],
  home: string,
  pathExists: (path: string) => boolean = existsSync,
): string | null {
  // Prefer the conventional install locations, current name first.
  const names = [INSTALLED_APP_BUNDLE_NAME, ...LEGACY_INSTALLED_APP_BUNDLE_NAMES];
  for (const name of names) {
    for (const root of ["/Applications", join(home, "Applications")]) {
      const candidate = join(root, name);
      if (pathExists(candidate)) return candidate;
    }
  }

  // Repo builds share the bundle identifier, so an unfiltered Spotlight result
  // can select an arbitrary worktree's bundle when the caller meant the
  // installed one. Before the rename the names alone separated them; now they
  // do not, so a checkout's build is excluded by where it is built instead —
  // which still leaves a relocated install (an external volume, say) findable.
  return indexedPaths
    .map((line) => line.trim())
    .filter((candidate) => names.includes(basename(candidate)))
    .filter((candidate) => !isRepoBuildOutput(candidate))
    .find(pathExists) ?? null;
}

function findInstalledAppBundle(env: NodeJS.ProcessEnv): string | null {
  const spotlight = spawnSync("mdfind", [`kMDItemCFBundleIdentifier == '${INSTALLED_APP_BUNDLE_ID}'`], {
    encoding: "utf8",
    env,
  });
  return selectInstalledAppBundle((spotlight.stdout ?? "").split("\n"), homedir());
}

/**
 * A repo checkout wins over an installed app: inside a checkout, the bundle you
 * just built is the one you mean. This is also what makes cross-worktree
 * staleness detectable — the expected path is *this* checkout's bundle, so a
 * Scout from a sibling checkout lands in `foreign`.
 */
function resolveBundlePaths(context: ScoutCommandContext): AppBundlePaths {
  const repoBundle = findRepoDistDirectory(defaultScoutContextDirectory(context));
  if (repoBundle) return resolveAppBundlePaths(repoBundle);

  const installed = findInstalledAppBundle(context.env);
  if (installed) return resolveAppBundlePaths(installed);

  throw new ScoutCliError(
    "No Scout app bundle found. Build one with `bun run scout:build` from a checkout, or install with `scout install`.",
  );
}

function readTree(paths: AppBundlePaths): LifecycleTree {
  return classifyProcesses(readProcessTable(), paths);
}

function toLayerReports(tree: LifecycleTree): LayerReport[] {
  return [...SUPERVISED_LAYERS].reverse().concat(LAUNCH_SERVICES_LAYERS).map((layer) => ({
    layer,
    pids: tree.layers[layer].map((entry) => entry.pid),
  }));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(
  paths: AppBundlePaths,
  predicate: (tree: LifecycleTree) => boolean,
  timeoutMs: number,
): Promise<LifecycleTree> {
  const deadline = Date.now() + timeoutMs;
  let tree = readTree(paths);
  while (!predicate(tree) && Date.now() < deadline) {
    await delay(POLL_MS);
    tree = readTree(paths);
  }
  return tree;
}

export function startTreeReady(tree: LifecycleTree, scope: StopScope): boolean {
  const appsReady = tree.layers.app.length > 0 && tree.layers.menu.length > 0;
  if (!appsReady || scope === "apps") {
    return appsReady;
  }
  return REQUIRED_SUPERVISED_LAYERS.every((layer) => tree.layers[layer].length > 0);
}

async function stopSuite(paths: AppBundlePaths, steps: string[], scope: StopScope): Promise<LifecycleTree> {
  const tree = readTree(paths);
  const uid = process.getuid?.() ?? 0;

  for (const step of planStop(tree, scope)) {
    const label = describeStopStep(step);

    if (step.kind === "bootout") {
      const result = bootoutLaunchdJob(step.label, uid);
      steps.push(result.ok ? label : `${label} — failed: ${result.detail || "unknown error"}`);
      continue;
    }

    let pids = step.pids;
    if (step.kind === "sweep") {
      const drainedTree = await waitFor(
        paths,
        (candidate) => ownedSweepSurvivorPids(step, candidate).length === 0,
        SUPERVISED_DRAIN_TIMEOUT_MS,
      );
      pids = ownedSweepSurvivorPids(step, drainedTree);
    }

    const { escalated, survivors } = await terminateProcesses(pids);
    const notes: string[] = [];
    if (escalated.length > 0) notes.push(`escalated to SIGKILL: ${escalated.join(", ")}`);
    if (survivors.length > 0) notes.push(`still alive: ${survivors.join(", ")}`);
    steps.push(notes.length > 0 ? `${label} — ${notes.join("; ")}` : label);
  }

  // Confirm rather than assume. A stop that leaves its targets standing has to say so.
  const settled = (candidate: LifecycleTree) => scope === "apps"
    ? layerProcesses(candidate, LAUNCH_SERVICES_LAYERS).length === 0
    : !isRunning(candidate);
  return await waitFor(paths, settled, 10_000);
}

async function startSuite(
  paths: AppBundlePaths,
  steps: string[],
  scope: StopScope,
  options: { restart?: boolean } = {},
): Promise<LifecycleTree> {
  const uid = process.getuid?.() ?? 0;
  let supervisedReadiness: Promise<LifecycleTree> | null = null;

  // `--apps-only` has to scope the start as well as the stop. Scoping only half
  // of a restart is worse than not scoping it: the stop leaves the services up,
  // then the start bounces them anyway, so the flag reads as honoured while
  // every agent's connection drops.
  if (scope === "apps") {
    steps.push("skip launchd (--apps-only)");
  } else {
    const label = resolveLaunchdLabel();
    const launched = startLaunchdJob(label, uid, homedir(), {
      restart: options.restart,
      serviceRoot: paths.serviceRoot,
      // `startSuite` owns the complete-tree readiness wait below. Asking
      // scoutd to perform the same broker-health wait here would keep this
      // synchronous call between the launchd kick and opening native Scout.
      waitForHealth: false,
    });
    steps.push(launched.ok
      ? `${launched.method} ${label}`
      : `${launched.method} ${label} — failed: ${launched.detail || "unknown error"}`);

    supervisedReadiness = waitFor(
      paths,
      (tree) => REQUIRED_SUPERVISED_LAYERS.every((layer) => tree.layers[layer].length > 0),
      SUPERVISED_READY_TIMEOUT_MS,
    );
  }

  // The native Messages surface is backed by the last materialized snapshot,
  // so opening the app does not need to wait for broker projection recovery or
  // the web child. Keep the readiness promise running in parallel and still
  // report the complete supervised result before this command returns.
  const open = spawnSync("open", [paths.appBundlePath], { encoding: "utf8" });
  steps.push((open.status ?? 1) === 0
    ? `open ${paths.appBundlePath}`
    : `open ${paths.appBundlePath} — failed: ${(open.stderr ?? "").trim() || "unknown error"}`);

  if (supervisedReadiness) {
    const supervised = await supervisedReadiness;
    const missing = REQUIRED_SUPERVISED_LAYERS.filter((layer) => supervised.layers[layer].length === 0);
    steps.push(missing.length === 0
      ? "supervised tree ready"
      : `supervised tree still starting — missing ${missing.join(", ")}`);
  }

  const tree = await waitFor(
    paths,
    (candidate) => startTreeReady(candidate, scope),
    READY_TIMEOUT_MS,
  );
  const appsMissing = LAUNCH_SERVICES_LAYERS.filter(
    (layer) => layer !== "pairing" && tree.layers[layer].length === 0,
  );
  steps.push(appsMissing.length === 0
    ? "Scout and embedded ScoutMenu ready"
    : `apps incomplete — missing ${appsMissing.join(", ")}`);

  return tree;
}

function summarize(action: ScoutAppAction, scope: StopScope, tree: LifecycleTree, problems: string[]): string {
  switch (action) {
    case "stop":
      if (scope === "apps") {
        return problems.length === 0
          ? "Stopped the OpenScout app and its menu helper. Services left running."
          : "The OpenScout app did not fully stop.";
      }
      return problems.length === 0
        ? "OpenScout stopped."
        : "OpenScout did not fully stop.";
    case "start":
    case "restart":
      return problems.length === 0
        ? `OpenScout ${action === "restart" ? "restarted" : "started"}.`
        : `OpenScout ${action === "restart" ? "restarted" : "started"} with ${problems.length} problem${problems.length === 1 ? "" : "s"}.`;
    case "status":
    default:
      if (!isRunning(tree)) return "OpenScout is not running.";
      return problems.length === 0
        ? "OpenScout is running and correctly owned."
        : `OpenScout is running with ${problems.length} problem${problems.length === 1 ? "" : "s"}.`;
  }
}

/**
 * Command-failing lifecycle problems for the suite this invocation owns.
 *
 * True sibling-checkout processes are reported separately for operator context
 * and cannot make this checkout's action fail. A stop fails only when one of
 * its own targeted layers is still alive after the bounded settle wait.
 */
export function lifecycleProblems(
  action: ScoutAppAction,
  scope: StopScope,
  tree: LifecycleTree,
): string[] {
  if (action === "stop") {
    const targetedLayers = scope === "apps"
      ? LAUNCH_SERVICES_LAYERS
      : [...SUPERVISED_LAYERS, ...LAUNCH_SERVICES_LAYERS];
    const detachedSurvivors = detachedExpectedProcesses(tree).filter((entry) =>
      targetedLayers.includes(entry.layer)
    );
    return [...layerProcesses(tree, targetedLayers), ...detachedSurvivors].map(
      (survivor) => `${survivor.layer} pid ${survivor.pid} is still running after stop`,
    );
  }
  if (action === "status" && !isRunning(tree)) {
    return detachedExpectedProcesses(tree).map(
      (stray) => `${stray.layer} pid ${stray.pid} references this checkout but is detached from its expected process tree: ${stray.executable}`,
    );
  }
  return verifyTree(tree).map((problem) => problem.message);
}

/**
 * Wait for in-flight work before the supervised tree comes down. Throws
 * (stopping nothing) when the fleet does not go quiet within the timeout.
 */
async function drainFleet(
  context: ScoutCommandContext,
  command: ScoutAppCommand,
  steps: string[],
): Promise<void> {
  const dbPath = resolveControlPlaneDbPath(context.env);
  const readFlights = () => {
    try {
      return readActiveFlights(dbPath);
    } catch (error) {
      throw new ScoutCliError(
        `cannot read in-flight work from ${dbPath}: ${error instanceof Error ? error.message : String(error)}. `
          + `Re-run with --now to ${command.action} without waiting.`,
      );
    }
  };
  const result = await waitForIdleFleet({
    readFlights,
    timeoutMs: command.drainTimeoutMs,
    onWaiting: (state, waitedMs) => {
      const clock = Date.now();
      context.stderr(
        `Waiting for ${state.blocking.length} in-flight flight${state.blocking.length === 1 ? "" : "s"} before ${command.action}`
          + ` (${formatDuration(waitedMs)} of ${formatDuration(command.drainTimeoutMs)}; --now skips):`,
      );
      for (const flight of state.blocking) context.stderr(`  ${describeActiveFlight(flight, clock)}`);
    },
  });
  const clock = Date.now();
  for (const flight of result.stale) {
    steps.push(`ignored stale flight ${describeActiveFlight(flight, clock)}`);
  }
  if (!result.idle) {
    throw new ScoutCliError(
      [
        `Still ${result.blocking.length} flight${result.blocking.length === 1 ? "" : "s"} in flight after ${formatDuration(result.waitedMs)}; nothing was stopped.`,
        ...result.blocking.map((flight) => `  ${describeActiveFlight(flight, clock)}`),
        `Wait longer with --timeout, or ${command.action} anyway with --now.`,
      ].join("\n"),
    );
  }
  steps.push(result.waitedMs > 0
    ? `waited ${formatDuration(result.waitedMs)} for in-flight work`
    : "no in-flight work");
}

function renderAppResult(result: ScoutAppResult): string {
  const lines: string[] = [result.message, ""];

  lines.push(`Bundle: ${result.bundlePath}`);

  if (result.steps.length > 0) {
    lines.push("", "Steps:");
    for (const step of result.steps) lines.push(`  ${step}`);
  }

  if (result.running || result.action === "status") {
    lines.push("", "Processes:");
    for (const layer of result.layers) {
      const value = layer.pids.length > 0 ? layer.pids.join(", ") : "—";
      lines.push(`  ${layer.layer.padEnd(8)} ${value}`);
    }
  }

  if (result.foreign.length > 0) {
    lines.push("", "Foreign (matched by name, not by path — not touched):");
    for (const stray of result.foreign) {
      lines.push(`  ${stray.layer.padEnd(8)} ${stray.pid}  ${stray.executable}`);
    }
  }

  if (result.problems.length > 0) {
    lines.push("", "Problems:");
    for (const problem of result.problems) lines.push(`  ${problem}`);
  }

  return lines.join("\n");
}

export async function runAppCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  // Anywhere in argv, not just first: `scout app restart --help` used to fall
  // through and perform the restart.
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    context.output.writeText(renderAppCommandHelp());
    return;
  }

  if (process.platform !== "darwin") {
    throw new ScoutCliError("scout app is only supported on macOS.");
  }

  const command = parseAppCommand(args);

  // Nothing to stop is a stopped suite, not an error. `scout:up` opens with a
  // stop, so throwing here killed the very first step on a fresh clone — the
  // checkout that most needs the script to run is the one with no bundle yet.
  let paths: AppBundlePaths;
  try {
    paths = resolveBundlePaths(context);
  } catch (error) {
    if (command.action === "stop") {
      context.output.writeValue(
        {
          action: command.action,
          bundlePath: null,
          menuBundlePath: null,
          running: false,
          layers: [],
          foreign: [],
          problems: [],
          steps: ["no app bundle found — nothing to stop"],
          message: "No OpenScout app bundle found; nothing to stop.",
        },
        (value) => `${value.message}`,
      );
      return;
    }
    throw error;
  }
  const steps: string[] = [];

  if (
    (command.action === "stop" || command.action === "restart")
    && command.scope === "all"
    && !command.now
  ) {
    await drainFleet(context, command, steps);
  }

  let tree: LifecycleTree;
  switch (command.action) {
    case "stop":
      tree = await stopSuite(paths, steps, command.scope);
      break;
    case "start":
      tree = await startSuite(paths, steps, command.scope);
      break;
    case "restart":
      await stopSuite(paths, steps, command.scope);
      tree = await startSuite(paths, steps, command.scope, { restart: true });
      break;
    case "status":
    default:
      tree = readTree(paths);
      break;
  }

  const problems = lifecycleProblems(command.action, command.scope, tree);

  const result: ScoutAppResult = {
    action: command.action,
    bundlePath: paths.appBundlePath,
    menuBundlePath: paths.menuBundlePath,
    running: isRunning(tree),
    layers: toLayerReports(tree),
    foreign: tree.foreign.map((stray) => ({ layer: stray.layer, pid: stray.pid, executable: stray.executable })),
    problems,
    steps,
    message: summarize(command.action, command.scope, tree, problems),
  };

  context.output.writeValue(result, renderAppResult);

  if (result.problems.length > 0 && command.action !== "status") {
    throw new ScoutCliError(result.message);
  }
}
