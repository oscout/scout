import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { isMeshBridgeCommand } from "./scout-bridge-command.js";

/**
 * The suite's own mesh bridge (`scout mesh bridge`, SCO-095) is a child of
 * scout-base, like the pairing controller: it restarts, upgrades and shuts down
 * with the rest of the service tree. It used to be its own LaunchAgent, which
 * pinned whatever build ran `mesh bridge install` and drifted silently.
 */

export const MESH_BRIDGE_CONFIG_FILENAME = "mcp-bridge.json";
export const LEGACY_MESH_BRIDGE_LAUNCH_AGENT_LABEL = "app.openscout.mcp-bridge";

/** `scout mesh bridge` exits with this (EX_CONFIG) when it has no relay token. */
export const MESH_BRIDGE_EXIT_UNCONFIGURED = 78;

export function meshBridgeConfigPath(supportDirectory: string): string {
  return join(supportDirectory, MESH_BRIDGE_CONFIG_FILENAME);
}

export function legacyMeshBridgeLaunchAgentPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LEGACY_MESH_BRIDGE_LAUNCH_AGENT_LABEL}.plist`);
}

export type MeshBridgeDesiredState =
  | { run: true; configPath: string; configMtimeMs: number }
  | { run: false; reason: "disabled-by-env" | "no-config" | "disabled-in-config" | "invalid-config" | "legacy-launch-agent" };

export function resolveMeshBridgeDesiredState(input: {
  supportDirectory: string;
  env: NodeJS.ProcessEnv;
  home?: string;
}): MeshBridgeDesiredState {
  if (input.env.OPENSCOUT_BASE_MESH_BRIDGE_ENABLED === "0") {
    return { run: false, reason: "disabled-by-env" };
  }
  const configPath = meshBridgeConfigPath(input.supportDirectory);
  if (!existsSync(configPath)) {
    return { run: false, reason: "no-config" };
  }
  let configMtimeMs: number;
  let parsed: unknown;
  try {
    configMtimeMs = statSync(configPath).mtimeMs;
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return { run: false, reason: "invalid-config" };
  }
  if (parsed && typeof parsed === "object" && (parsed as { enabled?: unknown }).enabled === false) {
    return { run: false, reason: "disabled-in-config" };
  }
  // Two bridges would both hold the relay connection for this node. The old
  // LaunchAgent wins until `scout mesh bridge install` retires it.
  if (existsSync(legacyMeshBridgeLaunchAgentPath(input.home))) {
    return { run: false, reason: "legacy-launch-agent" };
  }
  return { run: true, configPath, configMtimeMs };
}

export type MeshBridgeCommand = { entrypoint: string; args: string[] };

/**
 * Dev mode runs the CLI from source so the bridge loads the same tree as the
 * broker; otherwise prefer a built CLI next to this runtime, then the global
 * install.
 */
export function resolveMeshBridgeEntrypoint(input: {
  repoRoot: string | null;
  moduleDirectory: string;
  serviceMode: string;
  env: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
}): string | null {
  const exists = input.exists ?? existsSync;
  const home = input.home ?? homedir();
  const repo = input.repoRoot;
  const source = repo ? join(repo, "apps", "desktop", "bin", "scout.ts") : null;
  const candidates = [
    input.env.OPENSCOUT_MESH_BRIDGE_BIN?.trim() || null,
    input.serviceMode === "dev" ? source : null,
    repo ? join(repo, "packages", "cli", "dist", "main.mjs") : null,
    resolve(input.moduleDirectory, "..", "main.mjs"),
    join(home, ".bun", "install", "global", "node_modules", "@openscout", "scout", "dist", "main.mjs"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

export function meshBridgeArgs(entrypoint: string, configPath: string): string[] {
  return [entrypoint, "mesh", "bridge", "--config", configPath];
}

export { isMeshBridgeCommand };

export function meshBridgeStatePath(supportDirectory: string): string {
  return join(supportDirectory, "runtime", "mesh-bridge.json");
}

export type ProcessIdentity = { args: string; startedAt: string };

/** `ps` args plus start time; the pair identifies one process across pid reuse. */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
  const result = spawnSync("ps", ["-o", "lstart=,args=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  // lstart is a fixed five-field date: "Fri 25 Sep 23:14:23 2026".
  const match = /^\s*(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(result.stdout.trim());
  return match ? { startedAt: match[1]!, args: match[2]! } : null;
}

/**
 * The bridge a previous scout-base recorded, only while that exact process is
 * still alive: same pid, same start time, still a mesh bridge. A reused pid
 * fails the start-time check, so fencing can never signal an unrelated process.
 */
export function findRecordedLiveMeshBridgePid(
  supportDirectory: string,
  readIdentity: (pid: number) => ProcessIdentity | null = readProcessIdentity,
): number | null {
  let recorded: { pid?: unknown; processStartedAt?: unknown };
  try {
    recorded = JSON.parse(readFileSync(meshBridgeStatePath(supportDirectory), "utf8")) as typeof recorded;
  } catch {
    return null;
  }
  const { pid, processStartedAt } = recorded;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return null;
  if (typeof processStartedAt !== "string" || !processStartedAt) return null;
  const identity = readIdentity(pid);
  if (!identity || identity.startedAt !== processStartedAt) return null;
  return isMeshBridgeCommand(identity.args) ? pid : null;
}

export type LaunchdJobState = "loaded" | "absent" | "unknown";

/**
 * Whether a launchd job is loaded. Only launchd's explicit "could not find
 * service" counts as absent; any other failure is unknown, and callers that
 * guard against a second owner must treat unknown as possibly loaded.
 */
export function inspectLaunchdJob(
  target: string,
  run: (args: string[]) => { status: number | null; output: string } = runLaunchctl,
): LaunchdJobState {
  const result = run(["print", target]);
  if (result.status === 0) return "loaded";
  if (result.status === 113 || /could not find service/i.test(result.output)) return "absent";
  return "unknown";
}

/**
 * `launchctl bootout` returns before launchd finishes tearing the job down, so
 * an immediate inspect still reports it loaded. Poll until it is absent or the
 * deadline passes; anything but absent at the end is returned as-is.
 */
export async function waitForLaunchdJobAbsent(
  target: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    inspect?: (target: string) => LaunchdJobState;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<LaunchdJobState> {
  const inspect = options.inspect ?? ((value: string) => inspectLaunchdJob(value));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 10_000);
  let state = inspect(target);
  while (state !== "absent" && now() < deadline) {
    await sleep(options.pollMs ?? 250);
    state = inspect(target);
  }
  return state;
}

export function legacyMeshBridgeLaunchdTarget(uid = process.getuid?.() ?? 501): string {
  return `gui/${uid}/${LEGACY_MESH_BRIDGE_LAUNCH_AGENT_LABEL}`;
}

type LaunchctlSpawn = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf8" },
) => { status: number | null; stdout?: string | null; stderr?: string | null };

export function runLaunchctlProbe(
  args: string[],
  spawn?: LaunchctlSpawn,
): { status: number | null; output: string } {
  if (process.platform !== "darwin") {
    return { status: 113, output: "Could not find service" };
  }
  const result = spawn
    ? spawn("launchctl", args, { encoding: "utf8" })
    : spawnSync("launchctl", args, { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function runLaunchctl(args: string[]): { status: number | null; output: string } {
  return runLaunchctlProbe(args);
}
