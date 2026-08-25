import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SCOUT_PAIRING_SUPERVISOR_INTENT_FILE = "supervisor.json";
export const SCOUT_PAIRING_RUNTIME_PID_FILE = "runtime.pid";
export const SCOUT_PAIRING_RUNTIME_OWNER_FILE = "runtime-owner.json";
export const SCOUT_PAIRING_SUPERVISOR_PID_FILE = "supervisor.pid";
export const SCOUT_PAIRING_RUNTIME_PROCESS_MARKER = "pairing-runtime-controller";

export type ScoutPairingControlAction = "start" | "stop" | "restart";
export type ScoutPairingDesiredState = "running" | "stopped";

export type ScoutPairingSupervisorIntent = {
  desiredState: ScoutPairingDesiredState | null;
  restartGeneration: number;
};

export type ScoutPairingSupervisorPaths = {
  rootDir: string;
  intentPath: string;
  runtimePidPath: string;
  runtimeOwnerPath: string;
  supervisorPidPath: string;
};

export type ScoutPairingProcessIdentity = {
  pid: number;
  /** Raw OS process-birth stamp. Exact matching is more useful than reparsing. */
  startedAt: string;
  command: string;
};

export type ScoutPairingRuntimeOwner = ScoutPairingProcessIdentity & {
  version: 1;
  /** Per-launch nonce. Prevents a replacement controller inheriting authority. */
  token: string;
  claimedAt: number;
};

export type ScoutPairingProcessInspector = (pid: number) => ScoutPairingProcessIdentity | null;

type PairingIntentRecord = {
  desiredState?: ScoutPairingDesiredState;
  restartGeneration?: number;
};

export function resolveScoutPairingSupervisorPaths(
  env: NodeJS.ProcessEnv = process.env,
): ScoutPairingSupervisorPaths {
  const configuredRoot = env.OPENSCOUT_PAIRING_HOME?.trim()
    || env.SCOUT_PAIRING_HOME?.trim();
  const rootDir = configuredRoot || join(homedir(), ".scout", "pairing");
  return {
    rootDir,
    intentPath: join(rootDir, SCOUT_PAIRING_SUPERVISOR_INTENT_FILE),
    runtimePidPath: join(rootDir, SCOUT_PAIRING_RUNTIME_PID_FILE),
    runtimeOwnerPath: join(rootDir, SCOUT_PAIRING_RUNTIME_OWNER_FILE),
    supervisorPidPath: join(rootDir, SCOUT_PAIRING_SUPERVISOR_PID_FILE),
  };
}

export function readScoutPairingSupervisorIntent(
  intentPath: string = resolveScoutPairingSupervisorPaths().intentPath,
): ScoutPairingSupervisorIntent {
  const intent = readPairingIntent(intentPath);
  return {
    desiredState: intent.desiredState === "running" || intent.desiredState === "stopped"
      ? intent.desiredState
      : null,
    restartGeneration: validRestartGeneration(intent.restartGeneration),
  };
}

export function updateScoutPairingSupervisorIntent(
  action: ScoutPairingControlAction,
  intentPath: string = resolveScoutPairingSupervisorPaths().intentPath,
): ScoutPairingSupervisorIntent {
  const intent = readPairingIntent(intentPath);
  intent.desiredState = action === "stop" ? "stopped" : "running";
  if (action === "restart") {
    intent.restartGeneration = Math.max(
      Date.now(),
      validRestartGeneration(intent.restartGeneration) + 1,
    );
  }
  writePairingIntent(intentPath, intent);
  return readScoutPairingSupervisorIntent(intentPath);
}

export function readScoutPairingProcessPid(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isScoutPairingProcessRunning(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Cheap steady-state health hint for the supervisor loop.
 *
 * This deliberately checks only the recorded owner PID and `kill(pid, 0)`.
 * It is not authorization to signal: callers must still use
 * {@link signalScoutPairingRuntimeOwner}, which re-reads the nonce and proves
 * the exact command and OS birth stamp immediately before every signal.
 */
export function isScoutPairingRuntimeOwnerPidRunning(
  owner: ScoutPairingRuntimeOwner | null,
  expectedPid: number | null,
  options: {
    isRunning?: (pid: number | null) => boolean;
  } = {},
): owner is ScoutPairingRuntimeOwner {
  if (!owner || expectedPid === null || owner.pid !== expectedPid) return false;
  return (options.isRunning ?? isScoutPairingProcessRunning)(expectedPid);
}

/**
 * Read the two stable identity dimensions available on supported Unix hosts.
 * A PID alone is never ownership evidence because the kernel recycles it.
 */
export function inspectScoutPairingProcess(pid: number): ScoutPairingProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // POSIX `ps lstart` is the fixed-width 24-character ctime form. Reading it
    // in the same process-table query as `command` avoids constructing an
    // identity from two different processes if the PID turns over mid-read.
    const startedAt = output.slice(0, 24).trim().replace(/\s+/g, " ");
    const command = output.slice(24).trim();
    return startedAt && command ? { pid, startedAt, command } : null;
  } catch {
    return null;
  }
}

export function readScoutPairingRuntimeOwner(
  ownerPath: string = resolveScoutPairingSupervisorPaths().runtimeOwnerPath,
): ScoutPairingRuntimeOwner | null {
  if (!existsSync(ownerPath)) return null;
  try {
    const value = JSON.parse(readFileSync(ownerPath, "utf8")) as Partial<ScoutPairingRuntimeOwner>;
    return value.version === 1
      && Number.isInteger(value.pid)
      && (value.pid ?? 0) > 0
      && typeof value.token === "string"
      && value.token.length >= 16
      && typeof value.startedAt === "string"
      && value.startedAt.length > 0
      && typeof value.command === "string"
      && value.command.includes(SCOUT_PAIRING_RUNTIME_PROCESS_MARKER)
      && typeof value.claimedAt === "number"
      && Number.isFinite(value.claimedAt)
      ? value as ScoutPairingRuntimeOwner
      : null;
  } catch {
    return null;
  }
}

export function isScoutPairingRuntimeOwnerLive(
  owner: ScoutPairingRuntimeOwner | null,
  options: {
    expectedToken?: string;
    inspect?: ScoutPairingProcessInspector;
  } = {},
): owner is ScoutPairingRuntimeOwner {
  if (!owner || (options.expectedToken && owner.token !== options.expectedToken)) return false;
  const current = (options.inspect ?? inspectScoutPairingProcess)(owner.pid);
  return current !== null
    && current.startedAt === owner.startedAt
    && current.command === owner.command
    && current.command.includes(SCOUT_PAIRING_RUNTIME_PROCESS_MARKER);
}

export function readLiveScoutPairingRuntimeOwner(
  ownerPath: string = resolveScoutPairingSupervisorPaths().runtimeOwnerPath,
  options: {
    expectedToken?: string;
    inspect?: ScoutPairingProcessInspector;
  } = {},
): ScoutPairingRuntimeOwner | null {
  const owner = readScoutPairingRuntimeOwner(ownerPath);
  return isScoutPairingRuntimeOwnerLive(owner, options) ? owner : null;
}

/** Claim the current controller process with identity that survives PID reuse. */
export function claimScoutPairingRuntimeOwnership(options: {
  pid?: number;
  token?: string;
  ownerPath?: string;
  inspect?: ScoutPairingProcessInspector;
  now?: number;
} = {}): ScoutPairingRuntimeOwner {
  const pid = options.pid ?? process.pid;
  const ownerPath = options.ownerPath ?? resolveScoutPairingSupervisorPaths().runtimeOwnerPath;
  const inspect = options.inspect ?? inspectScoutPairingProcess;
  const existing = readLiveScoutPairingRuntimeOwner(ownerPath, { inspect });
  if (existing && existing.pid !== pid) {
    throw new Error(`Scout pairing runtime is already owned by pid ${existing.pid}.`);
  }
  const identity = inspect(pid);
  if (!identity || !identity.command.includes(SCOUT_PAIRING_RUNTIME_PROCESS_MARKER)) {
    throw new Error(`Cannot prove Scout pairing runtime ownership for pid ${pid}.`);
  }
  const owner: ScoutPairingRuntimeOwner = {
    version: 1,
    ...identity,
    token: options.token?.trim() || randomUUID(),
    claimedAt: options.now ?? Date.now(),
  };
  mkdirSync(dirname(ownerPath), { recursive: true });
  writeFileAtomically(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
  return owner;
}

export function releaseScoutPairingRuntimeOwnership(
  owner: Pick<ScoutPairingRuntimeOwner, "pid" | "token">,
  ownerPath: string = resolveScoutPairingSupervisorPaths().runtimeOwnerPath,
): void {
  const current = readScoutPairingRuntimeOwner(ownerPath);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) return;
  rmSync(ownerPath, { force: true });
}

/**
 * Signal only while the on-disk nonce and the live executable+birth identity
 * still match the claim. Call this separately for TERM and KILL so a process
 * that exits during the grace window cannot donate its PID to the KILL target.
 */
export function signalScoutPairingRuntimeOwner(
  owner: ScoutPairingRuntimeOwner,
  signal: NodeJS.Signals,
  options: {
    ownerPath?: string;
    inspect?: ScoutPairingProcessInspector;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): boolean {
  const ownerPath = options.ownerPath ?? resolveScoutPairingSupervisorPaths().runtimeOwnerPath;
  const current = readLiveScoutPairingRuntimeOwner(ownerPath, {
    expectedToken: owner.token,
    inspect: options.inspect,
  });
  if (!current || current.pid !== owner.pid) return false;
  try {
    (options.kill ?? ((pid, nextSignal) => process.kill(pid, nextSignal)))(owner.pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function readLiveScoutPairingSupervisorPid(
  supervisorPidPath: string = resolveScoutPairingSupervisorPaths().supervisorPidPath,
): number | null {
  const pid = readScoutPairingProcessPid(supervisorPidPath);
  return isScoutPairingProcessRunning(pid) ? pid : null;
}

export function claimScoutPairingSupervision(
  pid: number = process.pid,
  supervisorPidPath: string = resolveScoutPairingSupervisorPaths().supervisorPidPath,
): void {
  const currentPid = readLiveScoutPairingSupervisorPid(supervisorPidPath);
  if (currentPid && currentPid !== pid) {
    throw new Error(`Scout pairing is already supervised by pid ${currentPid}.`);
  }
  mkdirSync(dirname(supervisorPidPath), { recursive: true });
  writeFileAtomically(supervisorPidPath, `${pid}\n`);
}

export function releaseScoutPairingSupervision(
  pid: number = process.pid,
  supervisorPidPath: string = resolveScoutPairingSupervisorPaths().supervisorPidPath,
): void {
  if (readScoutPairingProcessPid(supervisorPidPath) !== pid) return;
  rmSync(supervisorPidPath, { force: true });
}

function readPairingIntent(intentPath: string): PairingIntentRecord {
  if (!existsSync(intentPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(intentPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { desiredState: "stopped" };
    }
    const intent = parsed as PairingIntentRecord;
    if (intent.desiredState !== "running" && intent.desiredState !== "stopped") {
      intent.desiredState = "stopped";
    }
    return intent;
  } catch {
    return { desiredState: "stopped" };
  }
}

function writePairingIntent(intentPath: string, intent: PairingIntentRecord): void {
  mkdirSync(dirname(intentPath), { recursive: true });
  writeFileAtomically(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
}

function writeFileAtomically(path: string, contents: string): void {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function validRestartGeneration(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
