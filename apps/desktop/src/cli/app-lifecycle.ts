/**
 * The OpenScout app lifecycle: one ownership model shared by status, stop,
 * start, and verify.
 *
 * Two supervision trees make up a running OpenScout:
 *
 *   launchd        -> scoutd -> base/probes -> pairing/broker/edge -> web
 *   LaunchServices -> Scout  -> embedded ScoutMenu
 *
 * They tear down differently and the difference is load-bearing. The launchd
 * tree is *supervised*: killing a child directly only makes its owner start a
 * new one, so the whole tree comes down with a single `launchctl bootout` and
 * per-process kills are a straggler sweep, never the primary move. The
 * LaunchServices tree has no supervisor, so it comes down leaf-first by hand.
 *
 * Identity here is an **executable path**, never a process name. Two checkouts
 * of this repo produce two `Scout.app` bundles whose processes are both named
 * `Scout` and share a bundle identifier, so `pkill -x Scout` in one worktree
 * reaches into the other, and a stale helper satisfies any identifier-based
 * "already running?" check. Path identity is what makes "ours" a decidable
 * question, and processes that match by name but not by path are reported as
 * foreign rather than killed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type ProcessRecord = {
  pid: number;
  ppid: number;
  command: string;
  args: string;
  /**
   * argv[0] up to the first space. Exact for the supervised services, which
   * rewrite argv[0] to a bare title (`scout-broker`), and best-effort for
   * everything else. Use `argvZeroIs` for identity — never this.
   */
  executable: string;
  /** Seconds since the process started, from `ps -o etimes=`. */
  elapsedSeconds: number;
};

export type LifecycleLayerName =
  | "scoutd"
  | "base"
  | "probes"
  | "broker"
  | "edge"
  | "web"
  | "app"
  | "menu"
  | "pairing";

/** Leaf-first. The launchd tree is bootout'd as a unit before its sweep. */
export const SUPERVISED_LAYERS: LifecycleLayerName[] = ["pairing", "web", "edge", "broker", "probes", "base", "scoutd"];
export const LAUNCH_SERVICES_LAYERS: LifecycleLayerName[] = ["menu", "app"];

export const SCOUT_LAUNCHD_LABEL = "app.openscout";

/**
 * Mirrors `resolveBrokerServiceLabel` in packages/runtime/src/broker-process-manager.ts.
 *
 * Hardcoding the label is not a cosmetic bug: `bootout` on a label that is not
 * loaded fails with "No such process", which this module treats as "already
 * unloaded" — so the real job stays up, the straggler sweep kills its children,
 * and the still-loaded launchd job immediately respawns them. That is exactly
 * the kill-versus-supervisor fight the single-bootout design exists to avoid.
 */
export function resolveLaunchdLabel(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.OPENSCOUT_SERVICE_LABEL ?? "").trim()
    || (env.OPENSCOUT_BROKER_SERVICE_LABEL ?? "").trim();
  if (explicit) return explicit;

  const mode = (env.OPENSCOUT_BROKER_SERVICE_MODE ?? "").trim().toLowerCase();
  return mode === "custom" ? "app.openscout.custom" : SCOUT_LAUNCHD_LABEL;
}

export type AppBundlePaths = {
  appBundlePath: string;
  menuBundlePath: string;
  /** Absolute path to the app binary. Resolved, never assumed from the bundle name. */
  appExecutable: string;
  menuExecutable: string;
  /**
   * The checkout whose `packages/cli/bin/scoutd` this suite supervises, or null
   * for an installed bundle that owns no checkout.
   *
   * The supervised services cannot be identified the way the bundled apps are:
   * they rewrite argv[0] to a process title, and `scout-edge` carries no repo
   * path in its arguments at all. Their scoutd does carry one, so the root makes
   * that root process decidable — and every service under it inherits the
   * answer by descent.
   */
  serviceRoot: string | null;
};

export type LifecycleProcess = ProcessRecord & {
  layer: LifecycleLayerName;
  /**
   * True when the executable lives where this layer's owner is supposed to put
   * it. False means the right name in the wrong place — another worktree, a
   * replaced bundle, a build from three rebuilds ago.
   */
  canonical: boolean;
  /** Right path, older binary — the bundle was rebuilt under a live process. */
  superseded: boolean;
};

export type LifecycleTree = {
  layers: Record<LifecycleLayerName, LifecycleProcess[]>;
  /** Matched a layer by name but not by path. Reported, never killed. */
  foreign: LifecycleProcess[];
  expected: AppBundlePaths;
};

const EMPTY_LAYERS = (): Record<LifecycleLayerName, LifecycleProcess[]> => ({
  scoutd: [],
  base: [],
  probes: [],
  broker: [],
  edge: [],
  web: [],
  app: [],
  menu: [],
  pairing: [],
});

/**
 * `OpenScout.app` ships with `CFBundleExecutable = Scout` — the release bundle
 * is renamed but the binary is not — so the executable name has to be read,
 * not inferred from the bundle it lives in.
 */
export function readBundleExecutableName(bundlePath: string, fallback: string): string {
  const result = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleExecutable", join(bundlePath, "Contents", "Info.plist")],
    { encoding: "utf8" },
  );
  const name = (result.stdout ?? "").trim();
  return (result.status ?? 1) === 0 && name.length > 0 ? name : fallback;
}

/** The scoutd a checkout supervises its services with. */
export function scoutdPathForRoot(root: string): string {
  return join(root, "packages", "cli", "bin", "scoutd");
}

/**
 * A repo bundle sits at `<root>/apps/macos/dist/Scout.app`, so the checkout is
 * four levels up — but only if it actually carries a scoutd. An installed
 * bundle has no checkout behind it and returns null.
 */
export function serviceRootForBundle(appBundlePath: string): string | null {
  const root = resolve(appBundlePath, "..", "..", "..", "..");
  return existsSync(scoutdPathForRoot(root)) ? root : null;
}

export function resolveAppBundlePaths(appBundlePath: string): AppBundlePaths {
  const menuBundlePath = join(appBundlePath, "Contents", "Library", "LoginItems", "ScoutMenu.app");
  return {
    appBundlePath,
    menuBundlePath,
    appExecutable: join(appBundlePath, "Contents", "MacOS", readBundleExecutableName(appBundlePath, "Scout")),
    menuExecutable: join(menuBundlePath, "Contents", "MacOS", readBundleExecutableName(menuBundlePath, "ScoutMenu")),
    serviceRoot: serviceRootForBundle(appBundlePath),
  };
}

export function appBundlePathsForRoot(distDirectory: string): AppBundlePaths {
  return resolveAppBundlePaths(join(distDirectory, "Scout.app"));
}

/**
 * `ps -o etime=` reports `[[dd-]hh:]mm:ss`. Darwin has no `etimes`, so the
 * elapsed time has to be parsed rather than read as an integer.
 */
export function parseElapsedSeconds(value: string): number {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return Number.NaN;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/**
 * `comm` is deliberately absent from the column list. Darwin truncates it to 16
 * characters, so it reports `/Users/art/dev/o` for a bundle path and is useless
 * for identity; worse, a truncated path can end mid-space and there is then no
 * way to tell where the column stops and `args` begins. `args` alone is
 * unambiguous because it is the last column.
 */
export function parseProcessTable(output: string): ProcessRecord[] {
  return String(output).split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:-]+)\s+(.*)$/);
    if (!match) return [];
    const args = (match[4] ?? "").trim();
    if (args.length === 0) return [];
    const head = args.split(/\s+/)[0] ?? "";
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      elapsedSeconds: parseElapsedSeconds(match[3] ?? ""),
      command: head,
      args,
      executable: head,
    }];
  });
}

/**
 * True when argv[0] is exactly `expected`.
 *
 * argv[0] cannot be recovered by splitting `args` on whitespace — a bundle under
 * a path containing a space (`/Users/First Last/…`) truncates to `/Users/First`
 * and then matches nothing, so the app is misfiled as foreign and `stop`
 * silently skips the user's own process. Testing the prefix instead of
 * splitting is exact: argv[0] is `expected` iff the args string is `expected`
 * or begins with `expected` followed by a space.
 */
export function argvZeroIs(record: ProcessRecord, expected: string): boolean {
  if (!expected) return false;
  return record.args === expected || record.args.startsWith(`${expected} `);
}

export function readProcessTable(): ProcessRecord[] {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,etime=,args="], { encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error("Unable to inspect process ownership with ps.");
  }
  return parseProcessTable(result.stdout);
}

/**
 * True when the executable on disk is newer than the process running it.
 *
 * Path identity answers "is this process from the right bundle" but not "is it
 * from the current build of that bundle" — a rebuild writes a new binary at the
 * same path and the old process keeps running the old code, silently. This is
 * the same trap as a daemon that pins its modules at boot: the fix ships, the
 * process never picks it up, and nothing says so.
 */
/**
 * The file on disk whose mtime decides staleness, or null when we cannot say.
 *
 * The bundled apps execute their binary directly, so the expected executable is
 * the answer. The supervised services do not: argv[0] is a rewritten title
 * (`scout-broker`), so statting it resolves against the CLI's own cwd, throws,
 * and silently reports "not superseded" for exactly the layers the check was
 * written for. Their real entrypoint is the argument under the service root.
 *
 * `scout-edge` names no file it owns — only a Caddyfile in `~/.scout` — so it
 * returns null rather than treating a config edit as a stale binary. Claiming
 * nothing beats claiming wrong.
 */
export function supersessionTarget(
  record: ProcessRecord,
  expectedExecutable: string | null,
  serviceRoot: string | null,
): string | null {
  if (expectedExecutable) return expectedExecutable;
  if (!serviceRoot) return null;
  return record.args.split(/\s+/).find((part) => part.startsWith(`${serviceRoot}/`)) ?? null;
}

export function isSuperseded(
  record: ProcessRecord,
  binaryPath: string | null,
  now: number = Date.now(),
): boolean {
  if (!binaryPath || !Number.isFinite(record.elapsedSeconds)) return false;
  let modifiedAt: number;
  try {
    modifiedAt = statSync(binaryPath).mtimeMs;
  } catch {
    // The binary was replaced out from under us or never existed at that path.
    return false;
  }
  const startedAt = now - record.elapsedSeconds * 1_000;
  // One second of slack: ps reports whole seconds, so a process started in the
  // same second as the write is not evidence of staleness.
  return modifiedAt > startedAt + 1_000;
}

function matchesName(record: ProcessRecord, name: string): boolean {
  return record.command === name
    || record.command.endsWith(`/${name}`)
    || record.executable.endsWith(`/${name}`);
}

/**
 * The iOS simulator runs its own copy of Scout with the same process name.
 * It is never part of the desktop tree and must never be reaped by it.
 */
function isSimulatorProcess(record: ProcessRecord): boolean {
  return record.args.includes("/Library/Developer/CoreSimulator/Devices/");
}

/**
 * Which supervised roots belong to this checkout.
 *
 * A supervised service cannot be identified on its own: argv[0] is a rewritten
 * title and `scout-edge` names no path we own. What *is* identifiable is the
 * scoutd at the top of each tree, because its argv[0] is a real path. So the
 * root is decided by path, and every descendant inherits the answer — which is
 * the ownership tree this module already claims to model, applied rather than
 * assumed.
 *
 * With no service root (an installed bundle owning no checkout) the launchd-
 * parented scoutd is ours: launchd only runs the job we bootstrapped.
 */
export function canonicalServiceRoots(records: ProcessRecord[], serviceRoot: string | null): Set<number> {
  const expectedScoutd = serviceRoot ? scoutdPathForRoot(serviceRoot) : null;
  const roots = new Set<number>();
  for (const record of records) {
    if (!record.args.includes("scoutd supervise")) continue;
    const ours = expectedScoutd ? argvZeroIs(record, expectedScoutd) : record.ppid === 1;
    if (ours) roots.add(record.pid);
  }
  return roots;
}

/** Every pid reachable from `roots` by parentage, roots included. */
export function descendantPids(records: ProcessRecord[], roots: Set<number>): Set<number> {
  const childrenOf = new Map<number, number[]>();
  for (const record of records) {
    const siblings = childrenOf.get(record.ppid);
    if (siblings) siblings.push(record.pid);
    else childrenOf.set(record.ppid, [record.pid]);
  }
  const owned = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    for (const child of childrenOf.get(pid) ?? []) {
      if (owned.has(child)) continue;
      owned.add(child);
      queue.push(child);
    }
  }
  return owned;
}

export function classifyProcesses(
  records: ProcessRecord[],
  expected: AppBundlePaths,
  now: number = Date.now(),
): LifecycleTree {
  const layers = EMPTY_LAYERS();
  const foreign: LifecycleProcess[] = [];

  const push = (
    record: ProcessRecord,
    layer: LifecycleLayerName,
    canonical: boolean,
    expectedExecutable: string | null = null,
  ) => {
    const entry: LifecycleProcess = {
      ...record,
      layer,
      canonical,
      superseded: canonical
        && isSuperseded(record, supersessionTarget(record, expectedExecutable, expected.serviceRoot), now),
    };
    if (canonical) layers[layer].push(entry);
    else foreign.push(entry);
  };

  const expectedApp = expected.appExecutable;
  const expectedMenu = expected.menuExecutable;

  // Ownership of the supervised tree is decided once, from its roots, before any
  // process is filed. Deciding it per-process is what let a sibling checkout's
  // broker be swept: nothing about a lone `scout-broker` says whose it is.
  const ourServices = descendantPids(records, canonicalServiceRoots(records, expected.serviceRoot));
  const supervisedIsOurs = (record: ProcessRecord) => ourServices.has(record.pid);

  // The LaunchServices tree is rooted on the two bundles we can name by path.
  // Pairing normally descends from base, with app descent retained only to
  // recognize the direct fallback used when the supervisor is unavailable.
  const appRoots = new Set<number>();
  for (const record of records) {
    if (isSimulatorProcess(record)) continue;
    if (argvZeroIs(record, expectedApp) || argvZeroIs(record, expectedMenu)) appRoots.add(record.pid);
  }
  const ourApps = descendantPids(records, appRoots);

  for (const record of records) {
    if (isSimulatorProcess(record)) continue;

    // The bundles we own are matched on the full path before any name-based
    // dispatch, because name matching reads argv[0] up to the first space and a
    // checkout under `/Users/First Last/…` therefore matches no name at all —
    // the app would not even reach its own branch.
    if (argvZeroIs(record, expectedMenu)) {
      push(record, "menu", true, expectedMenu);
      continue;
    }
    if (argvZeroIs(record, expectedApp)) {
      push(record, "app", true, expectedApp);
      continue;
    }

    if (record.args.includes("scoutd supervise")) {
      push(record, "scoutd", supervisedIsOurs(record));
      continue;
    }
    if (record.args.includes("scoutd probes serve")) {
      push(record, "probes", supervisedIsOurs(record));
      continue;
    }
    if (record.args.includes("pairing-runtime-controller")) {
      push(record, "pairing", supervisedIsOurs(record) || ourApps.has(record.pid));
      continue;
    }
    if (matchesName(record, "scout-base")) {
      push(record, "base", supervisedIsOurs(record));
      continue;
    }
    if (matchesName(record, "scout-broker")) {
      push(record, "broker", supervisedIsOurs(record));
      continue;
    }
    if (matchesName(record, "scout-edge")) {
      push(record, "edge", supervisedIsOurs(record));
      continue;
    }
    if (matchesName(record, "scout-web")) {
      push(record, "web", supervisedIsOurs(record));
      continue;
    }
    // The bundled apps are named by a path we control, so they are decided
    // directly rather than by descent.
    if (matchesName(record, "ScoutMenu")) {
      push(record, "menu", argvZeroIs(record, expectedMenu), expectedMenu);
      continue;
    }
    if (matchesName(record, "Scout")) {
      push(record, "app", argvZeroIs(record, expectedApp), expectedApp);
      continue;
    }
  }

  return { layers, foreign, expected };
}

export function readLifecycleTree(expected: AppBundlePaths): LifecycleTree {
  return classifyProcesses(readProcessTable(), expected);
}

export function layerProcesses(tree: LifecycleTree, layers: LifecycleLayerName[]): LifecycleProcess[] {
  return layers.flatMap((layer) => tree.layers[layer]);
}

export function isRunning(tree: LifecycleTree): boolean {
  return layerProcesses(tree, [...SUPERVISED_LAYERS, ...LAUNCH_SERVICES_LAYERS]).length > 0;
}

/**
 * Layer-shaped processes that explicitly name this checkout but are detached
 * from its canonical ownership roots. These are not sibling-checkout context:
 * they are malformed remnants of the suite this invocation owns.
 */
export function detachedExpectedProcesses(tree: LifecycleTree): LifecycleProcess[] {
  const expectedPathPrefixes = [
    tree.expected.serviceRoot,
    tree.expected.appBundlePath,
    tree.expected.menuBundlePath,
  ].flatMap((path) => path ? [`${path}/`] : []);
  return tree.foreign.filter((entry) =>
    expectedPathPrefixes.some((prefix) => entry.args.includes(prefix))
  );
}

// --- stop -------------------------------------------------------------------

export type StopStep =
  | { kind: "signal"; layer: LifecycleLayerName; pids: number[] }
  | { kind: "bootout"; label: string }
  | { kind: "sweep"; layers: LifecycleLayerName[]; pids: number[] };

/**
 * Leaf-first, with the supervised tree taken down as a unit.
 *
 * The LaunchServices apps go first and individually; nothing restarts them.
 * Then one bootout collapses the entire launchd tree, including the pairing
 * controller owned by base.
 * Anything still standing after that is a straggler, not a supervised child,
 * and only then is a direct kill correct.
 */
export type StopScope = "all" | "apps";

export function planStop(tree: LifecycleTree, scope: StopScope = "all"): StopStep[] {
  const steps: StopStep[] = [];

  for (const layer of LAUNCH_SERVICES_LAYERS) {
    const pids = tree.layers[layer].map((entry) => entry.pid);
    if (pids.length > 0) steps.push({ kind: "signal", layer, pids });
  }

  // `apps` exists for the build path: replacing the app bundle invalidates the
  // processes running from it, but says nothing about the launchd services, and
  // bouncing those would disconnect every agent for a rebuild that did not
  // touch them.
  if (scope === "apps") return steps;

  const supervised = layerProcesses(tree, SUPERVISED_LAYERS);
  if (supervised.length > 0) {
    steps.push({ kind: "bootout", label: resolveLaunchdLabel() });
    steps.push({
      kind: "sweep",
      layers: SUPERVISED_LAYERS,
      pids: supervised.map((entry) => entry.pid),
    });
  }

  return steps;
}

export function describeStopStep(step: StopStep): string {
  switch (step.kind) {
    case "signal":
      return `stop ${step.layer} (${step.pids.length} process${step.pids.length === 1 ? "" : "es"})`;
    case "bootout":
      return `bootout ${step.label}`;
    case "sweep":
      return `sweep supervised stragglers (${step.pids.length} candidate${step.pids.length === 1 ? "" : "s"})`;
  }
}

export type StopOutcome = {
  step: string;
  pids: number[];
  escalated: number[];
  survivors: number[];
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone, or not ours to signal. Liveness is re-checked either way.
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * TERM, wait for the process to actually go, then KILL what is left. Returns
 * the pids that needed escalation and the ones that survived both, so callers
 * can report honestly instead of assuming a fire-and-forget kill worked.
 */
export async function terminateProcesses(
  pids: number[],
  options: { graceMs?: number; pollMs?: number } = {},
): Promise<{ escalated: number[]; survivors: number[] }> {
  const graceMs = options.graceMs ?? 5_000;
  const pollMs = options.pollMs ?? 100;
  const escalated: number[] = [];

  const live = pids.filter(processAlive);
  for (const pid of live) signal(pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  let remaining = live.filter(processAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(pollMs);
    remaining = remaining.filter(processAlive);
  }

  for (const pid of remaining) {
    escalated.push(pid);
    signal(pid, "SIGKILL");
  }

  if (escalated.length > 0) {
    const killDeadline = Date.now() + 2_000;
    let stubborn = escalated.filter(processAlive);
    while (stubborn.length > 0 && Date.now() < killDeadline) {
      await delay(pollMs);
      stubborn = stubborn.filter(processAlive);
    }
    return { escalated, survivors: stubborn };
  }

  return { escalated, survivors: [] };
}

export function bootoutLaunchdJob(label: string, uid: number): { ok: boolean; detail: string } {
  const result = spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`], { encoding: "utf8" });
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  // "No such process" means the job was already unloaded, which is the state we
  // wanted anyway.
  const ok = (result.status ?? 1) === 0 || /No such process/i.test(detail);
  return { ok, detail };
}

/**
 * `-k` kills the running job before restarting it, so it belongs to `restart`
 * and never to `start`. Sending it unconditionally made `scout app start` bounce
 * a healthy supervised tree — which is what `--apps-only` exists to prevent, and
 * it disconnects every agent for a rebuild that did not touch the services.
 * Without `-k`, kickstart starts a stopped job and is a no-op on a running one.
 */
export function kickstartLaunchdJob(
  label: string,
  uid: number,
  options: { restart?: boolean } = {},
): { ok: boolean; detail: string } {
  const flags = options.restart ? ["-k"] : [];
  const result = spawnSync("launchctl", ["kickstart", ...flags, `gui/${uid}/${label}`], { encoding: "utf8" });
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: (result.status ?? 1) === 0, detail };
}

export function launchdJobLoaded(label: string, uid: number): boolean {
  const result = spawnSync("launchctl", ["print", `gui/${uid}/${label}`], { stdio: "ignore" });
  return (result.status ?? 1) === 0;
}

export function launchAgentPlistPath(label: string, home: string): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export function bootstrapLaunchdJob(plistPath: string, uid: number): { ok: boolean; detail: string } {
  const result = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { encoding: "utf8" });
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  // Already bootstrapped is the state we wanted.
  const ok = (result.status ?? 1) === 0 || /already bootstrapped|Operation already in progress/i.test(detail);
  return { ok, detail };
}

/**
 * Selects the launch mechanism without preserving a stale service definition.
 *
 * `bootout` pairs with `bootstrap`, not with `kickstart`: booting a job out
 * *unloads it from the domain*, so a subsequent kickstart fails with "Could not
 * find service ... in domain for user".
 *
 * When a checkout supplies scoutd, its `start_service` must run whether or not
 * the shared job label is already loaded. It regenerates the LaunchAgent from
 * this checkout's config before replacing the job. Kickstarting would preserve
 * a globally installed or stale Program path and leave this checkout's entire
 * supervised tree classified as foreign.
 */
export type LaunchdStartMethod = "kickstart" | "scoutd" | "bootstrap" | "unavailable";

export function chooseLaunchdStartMethod(input: {
  loaded: boolean;
  plistExists: boolean;
  scoutdPath?: string | null;
}): LaunchdStartMethod {
  if (input.scoutdPath) return "scoutd";
  if (input.loaded) return "kickstart";
  return input.plistExists ? "bootstrap" : "unavailable";
}

export function startLaunchdJob(
  label: string,
  uid: number,
  home: string,
  options: { restart?: boolean; serviceRoot?: string | null } = {},
): { ok: boolean; detail: string; method: LaunchdStartMethod } {
  const plistPath = launchAgentPlistPath(label, home);
  const scoutdPath = options.serviceRoot ? scoutdPathForRoot(options.serviceRoot) : null;
  const method = chooseLaunchdStartMethod({
    loaded: launchdJobLoaded(label, uid),
    plistExists: existsSync(plistPath),
    scoutdPath: scoutdPath && existsSync(scoutdPath) ? scoutdPath : null,
  });

  switch (method) {
    case "kickstart":
      return { ...kickstartLaunchdJob(label, uid, { restart: options.restart }), method };
    case "scoutd": {
      const result = spawnSync(scoutdPath as string, ["start"], { encoding: "utf8" });
      const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      return { ok: (result.status ?? 1) === 0, detail, method };
    }
    case "bootstrap":
      return { ...bootstrapLaunchdJob(plistPath, uid), method };
    case "unavailable":
      return {
        ok: false,
        detail: `launchd job ${label} is not loaded and no plist exists at ${plistPath}`,
        method,
      };
  }
}

// --- verify -----------------------------------------------------------------

export type VerifyProblem = {
  layer: LifecycleLayerName | "launchd";
  message: string;
};

/**
 * Every layer must hold exactly one process, owned by the layer above it. This
 * is the assertion set `scripts/restart-all.mjs` has always made; it lives here
 * now so stop and start can consult the same definition of "correct" that
 * verification does.
 */
export function verifyTree(tree: LifecycleTree): VerifyProblem[] {
  const problems: VerifyProblem[] = [];

  const single = (layer: LifecycleLayerName): LifecycleProcess | null => {
    const found = tree.layers[layer];
    if (found.length === 0) {
      problems.push({ layer, message: `no ${layer} process is running` });
      return null;
    }
    if (found.length > 1) {
      problems.push({
        layer,
        message: `expected exactly one ${layer} process, found ${found.length} (pids ${found.map((entry) => entry.pid).join(", ")})`,
      });
      return null;
    }
    return found[0] ?? null;
  };

  const ownedBy = (child: LifecycleProcess | null, parent: LifecycleProcess | null, layer: LifecycleLayerName) => {
    if (!child || !parent) return;
    if (child.ppid !== parent.pid) {
      problems.push({
        layer,
        message: `${layer} pid ${child.pid} is owned by pid ${child.ppid}, expected ${parent.pid}`,
      });
    }
  };

  const scoutd = single("scoutd");
  if (scoutd && scoutd.ppid !== 1) {
    problems.push({ layer: "scoutd", message: `scoutd pid ${scoutd.pid} is not owned by launchd (ppid ${scoutd.ppid})` });
  }

  const base = single("base");
  const probes = single("probes");
  ownedBy(base, scoutd, "base");
  ownedBy(probes, scoutd, "probes");

  const broker = single("broker");
  const edge = single("edge");
  ownedBy(broker, base, "broker");
  ownedBy(edge, base, "edge");

  const web = single("web");
  ownedBy(web, broker, "web");

  const app = single("app");
  const menu = single("menu");

  const pairing = single("pairing");
  // Pairing normally belongs to the canonical base process. A direct
  // menu-owned controller is valid only when no base supervisor exists at all;
  // duplicate base processes are unhealthy, not fallback eligibility.
  const pairingOwner = tree.layers.base[0] ?? menu;
  ownedBy(pairing, pairingOwner, "pairing");

  // A process that names one of this checkout's paths but is detached from the
  // expected ownership tree is ours-and-malformed, not a harmless sibling.
  // True sibling-checkout processes remain informational in `tree.foreign`.
  for (const stray of detachedExpectedProcesses(tree)) {
    problems.push({
      layer: stray.layer,
      message: `${stray.layer} pid ${stray.pid} references this checkout but is detached from its expected process tree: ${stray.executable}`,
    });
  }

  for (const stale of layerProcesses(tree, [...SUPERVISED_LAYERS, ...LAUNCH_SERVICES_LAYERS])) {
    if (!stale.superseded) continue;
    problems.push({
      layer: stale.layer,
      message: `${stale.layer} pid ${stale.pid} is running a superseded build — ${stale.executable} was rebuilt after it started; restart to pick it up`,
    });
  }

  void app;
  void menu;
  return problems;
}
