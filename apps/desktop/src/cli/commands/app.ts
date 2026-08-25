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
  planStop,
  readProcessTable,
  resolveAppBundlePaths,
  resolveLaunchdLabel,
  startLaunchdJob,
  SUPERVISED_LAYERS,
  terminateProcesses,
  verifyTree,
} from "../app-lifecycle.ts";
import type { ScoutCommandContext } from "../context.ts";
import { defaultScoutContextDirectory } from "../context.ts";
import { ScoutCliError } from "../errors.ts";

export type ScoutAppAction = "status" | "stop" | "start" | "restart";

const HELP_FLAGS = new Set(["help", "--help", "-h"]);
const INSTALLED_APP_BUNDLE_ID = "app.openscout.scout";
const INSTALLED_APP_BUNDLE_NAME = "OpenScout.app";
const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

type ScoutAppCommand = {
  action: ScoutAppAction;
  scope: StopScope;
  json: boolean;
};

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

export function renderAppCommandHelp(): string {
  return [
    "scout app — OpenScout application lifecycle",
    "",
    "Usage:",
    "  scout app status",
    "  scout app stop",
    "  scout app start",
    "  scout app restart",
    "",
    "Options:",
    "  --apps-only   Act only on the macOS app and its menu helper, leaving the",
    "                launchd services alone — on start and restart as well as on",
    "                stop. This is what a rebuild needs: the new bundle",
    "                invalidates the processes running from it, but not the",
    "                services, and bouncing those disconnects every agent.",
    "  --json        Structured output.",
    "",
    "Aliases:",
    "  stop = down = quit",
    "  start = up",
    "",
    "Ownership:",
    "  launchd        -> scoutd -> base/probes -> pairing/broker/edge -> web",
    "  LaunchServices -> Scout  -> embedded ScoutMenu",
    "",
    "Behavior:",
    "  Stop walks the tree leaf-first. The LaunchServices apps are signalled",
    "  individually (TERM, then KILL if they linger); the launchd tree comes down",
    "  with one bootout, because killing a supervised child only makes scoutd",
    "  start a new one. Processes are matched by executable path, so a Scout from",
    "  another checkout is reported rather than killed.",
    "",
    "  `scout up` / `scout down` manage local agents. This command manages the app.",
    "",
    "Examples:",
    "  scout app status",
    "  scout app restart",
    "  scout app status --json",
  ].join("\n");
}

export function parseAppCommand(args: string[]): ScoutAppCommand {
  const json = args.includes("--json");
  const scope: StopScope = args.includes("--apps-only") ? "apps" : "all";
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const first = positional[0];

  if (!first) {
    return { action: "status", scope, json };
  }

  switch (first) {
    case "status":
      return { action: "status", scope, json };
    case "stop":
    case "down":
    case "quit":
      return { action: "stop", scope, json };
    case "start":
    case "up":
      return { action: "start", scope, json };
    case "restart":
      return { action: "restart", scope, json };
    default:
      throw new ScoutCliError(`unknown subcommand: ${first} (try: scout app)`);
  }
}

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

export function selectInstalledAppBundle(
  indexedPaths: string[],
  home: string,
  pathExists: (path: string) => boolean = existsSync,
): string | null {
  // Prefer the two conventional install locations. Repo builds share the same
  // bundle identifier, so an unfiltered Spotlight result can otherwise select
  // an arbitrary worktree's `Scout.app` when the caller meant the installed
  // `OpenScout.app`.
  for (const candidate of [
    join("/Applications", INSTALLED_APP_BUNDLE_NAME),
    join(home, "Applications", INSTALLED_APP_BUNDLE_NAME),
  ]) {
    if (pathExists(candidate)) return candidate;
  }

  return indexedPaths
    .map((line) => line.trim())
    .filter((candidate) => basename(candidate) === INSTALLED_APP_BUNDLE_NAME)
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
    "No OpenScout app bundle found. Build one with `bun run scout:build` from a checkout, or install with `scout install`.",
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

    const { escalated, survivors } = await terminateProcesses(step.pids);
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
    });
    steps.push(launched.ok
      ? `${launched.method} ${label}`
      : `${launched.method} ${label} — failed: ${launched.detail || "unknown error"}`);

    const supervised = await waitFor(
      paths,
      (tree) => SUPERVISED_LAYERS.every((layer) => tree.layers[layer].length > 0),
      READY_TIMEOUT_MS,
    );
    const missing = SUPERVISED_LAYERS.filter((layer) => supervised.layers[layer].length === 0);
    steps.push(missing.length === 0
      ? "supervised tree ready"
      : `supervised tree incomplete — missing ${missing.join(", ")}`);
  }

  const open = spawnSync("open", [paths.appBundlePath], { encoding: "utf8" });
  steps.push((open.status ?? 1) === 0
    ? `open ${paths.appBundlePath}`
    : `open ${paths.appBundlePath} — failed: ${(open.stderr ?? "").trim() || "unknown error"}`);

  const tree = await waitFor(
    paths,
    (candidate) => candidate.layers.app.length > 0 && candidate.layers.menu.length > 0,
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
  if (HELP_FLAGS.has(args[0] ?? "")) {
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
