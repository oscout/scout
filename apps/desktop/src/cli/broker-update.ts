import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  extractRuntimeFreshnessDecisionFromScoutdPayload,
  shouldRestartBrokerForRuntimeFreshness,
} from "./runtime-freshness.ts";
import { SCOUTD_RESTART_TIMEOUT_MS } from "./scoutd-timing.ts";

type BrokerCommandOutcome =
  | { ok: true; raw: unknown }
  | { ok: false; error: string };

type BrokerRestartOutcome =
  | { ok: true }
  | { ok: false; error: string };

type BrokerUpdateLockPayload = {
  pid: number;
  startedAt: number;
  token: string;
};

type AcquiredBrokerUpdateLock = {
  acquired: true;
  release: () => Promise<void>;
};

type SkippedBrokerUpdateLock = {
  acquired: false;
  reason: string;
};

export type EnsureBrokerUptodateOptions = {
  checkpointPath: string;
  debug?: boolean;
  lockWaitTimeoutMs?: number;
  readCurrentMtime: () => number | null;
  report?: (message: string) => void;
  restart: () => Promise<BrokerRestartOutcome>;
  status: () => Promise<BrokerCommandOutcome>;
};

const BROKER_UPDATE_LOCK_DIRECTORY = "cli-broker-update.lock";
const BROKER_UPDATE_RECLAIM_DIRECTORY = "cli-broker-update.reclaim.lock";
const BROKER_UPDATE_LOCK_WAIT_GRACE_MS = 15_000;
export const BROKER_UPDATE_LOCK_WAIT_MS =
  SCOUTD_RESTART_TIMEOUT_MS + BROKER_UPDATE_LOCK_WAIT_GRACE_MS;
const BROKER_UPDATE_LOCK_POLL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function debugFlagEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function brokerUpdateDebugEnabled(env: NodeJS.ProcessEnv): boolean {
  return debugFlagEnabled(env.OPENSCOUT_DEBUG_BROKER_UPDATE);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function lockPayloadsMatch(
  left: BrokerUpdateLockPayload | null,
  right: BrokerUpdateLockPayload,
): boolean {
  return left?.pid === right.pid
    && left.startedAt === right.startedAt
    && left.token === right.token;
}

async function readLockPayload(lockPath: string): Promise<BrokerUpdateLockPayload | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf8"),
    ) as Partial<BrokerUpdateLockPayload>;
    if (
      Number.isInteger(raw.pid)
      && typeof raw.startedAt === "number"
      && Number.isFinite(raw.startedAt)
      && typeof raw.token === "string"
      && raw.token.length > 0
    ) {
      return {
        pid: raw.pid as number,
        startedAt: raw.startedAt,
        token: raw.token,
      };
    }
  } catch {
    // Invalid or incomplete ownership is uncertainty and cannot be reclaimed.
  }
  return null;
}

async function restoreMovedLock(movedPath: string, lockPath: string): Promise<void> {
  try {
    await rename(movedPath, lockPath);
  } catch {
    // Another owner may already hold lockPath. Preserve the moved directory for
    // diagnosis rather than deleting ownership we could not verify.
  }
}

async function releaseOwnedLock(
  lockPath: string,
  owner: BrokerUpdateLockPayload,
): Promise<void> {
  if (!lockPayloadsMatch(await readLockPayload(lockPath), owner)) {
    return;
  }

  const releasedPath = `${lockPath}.released.${owner.token}`;
  try {
    await rename(lockPath, releasedPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }

  if (!lockPayloadsMatch(await readLockPayload(releasedPath), owner)) {
    await restoreMovedLock(releasedPath, lockPath);
    return;
  }
  await rm(releasedPath, { recursive: true, force: true });
}

async function tryCreateOwnedLock(
  lockPath: string,
): Promise<AcquiredBrokerUpdateLock | SkippedBrokerUpdateLock> {
  const owner: BrokerUpdateLockPayload = {
    pid: process.pid,
    startedAt: Date.now(),
    token: randomUUID(),
  };
  let created = false;

  try {
    await mkdir(lockPath, { mode: 0o700 });
    created = true;
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify(owner)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (created) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
    if (errorCode(error) === "EEXIST") {
      return { acquired: false, reason: "lock already exists" };
    }
    throw error;
  }

  let released = false;
  return {
    acquired: true,
    release: async () => {
      if (released) return;
      released = true;
      await releaseOwnedLock(lockPath, owner);
    },
  };
}

async function tryReclaimDeadLock(
  lockPath: string,
  observedOwner: BrokerUpdateLockPayload,
): Promise<boolean> {
  const reclaimPath = join(dirname(lockPath), BROKER_UPDATE_RECLAIM_DIRECTORY);
  const reclaimGuard = await tryCreateOwnedLock(reclaimPath);
  if (!reclaimGuard.acquired) {
    return false;
  }

  try {
    const currentOwner = await readLockPayload(lockPath);
    if (!lockPayloadsMatch(currentOwner, observedOwner) || isProcessAlive(observedOwner.pid)) {
      return false;
    }

    const stalePath = `${lockPath}.stale.${observedOwner.token}.${randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }

    if (!lockPayloadsMatch(await readLockPayload(stalePath), observedOwner)) {
      await restoreMovedLock(stalePath, lockPath);
      return false;
    }

    await rm(stalePath, { recursive: true, force: true });
    return true;
  } finally {
    await reclaimGuard.release();
  }
}

async function waitForBrokerUpdateLockRelease(
  lockPath: string,
  deadline: number,
): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      await stat(lockPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return true;
      }
    }
    await sleep(BROKER_UPDATE_LOCK_POLL_MS);
  }
  return false;
}

async function acquireBrokerUpdateLock(
  lockPath: string,
  waitTimeoutMs: number,
): Promise<AcquiredBrokerUpdateLock | SkippedBrokerUpdateLock> {
  await mkdir(dirname(lockPath), { recursive: true });
  const waitDeadline = Date.now() + waitTimeoutMs;

  for (;;) {
    const created = await tryCreateOwnedLock(lockPath);
    if (created.acquired) {
      return created;
    }

    const observedOwner = await readLockPayload(lockPath);
    if (!observedOwner) {
      return {
        acquired: false,
        reason: "lock owner is missing or invalid; refusing to reclaim uncertain ownership",
      };
    }

    if (!isProcessAlive(observedOwner.pid)) {
      if (await tryReclaimDeadLock(lockPath, observedOwner)) {
        continue;
      }
    }

    const released = await waitForBrokerUpdateLockRelease(lockPath, waitDeadline);
    return {
      acquired: false,
      reason: released
        ? "another updater completed while this command waited"
        : `lock is still owned by live pid ${observedOwner.pid}`,
    };
  }
}

export async function writeCliMtimeCheckpointAtomically(
  checkpointPath: string,
  mtime: number,
): Promise<void> {
  const checkpointDirectory = dirname(checkpointPath);
  await mkdir(checkpointDirectory, { recursive: true });
  const temporaryPath = join(
    checkpointDirectory,
    `.${basename(checkpointPath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, String(mtime), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, checkpointPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function reportDebug(
  options: EnsureBrokerUptodateOptions,
  message: string,
): void {
  if (!options.debug || !options.report) return;
  try {
    options.report(`debug: broker update ${message}`);
  } catch {
    // Diagnostics must not turn best-effort maintenance into a command failure.
  }
}

async function refreshLegacyCliMtimeCheckpoint(
  options: EnsureBrokerUptodateOptions,
): Promise<void> {
  const mtime = options.readCurrentMtime();
  if (mtime === null) {
    reportDebug(options, "compatibility checkpoint skipped: CLI mtime is unavailable");
    return;
  }

  try {
    // This is a one-way compatibility fence, not restart authorization. Current
    // CLIs never read it, but older CLIs still interpret a newer mtime as license
    // to run their destructive launchctl fallback. Advance it even when status is
    // uncertain so a mixed install cannot re-arm that retired restart path.
    await writeCliMtimeCheckpointAtomically(options.checkpointPath, mtime);
  } catch (error) {
    reportDebug(
      options,
      `compatibility checkpoint failed: ${errorMessage(error) || "unknown error"}`,
    );
  }
}

/**
 * Restarts only when scoutd explicitly reports a stale, non-intentional runtime.
 * Failed probes, malformed verdicts, and lock uncertainty cannot authorize a
 * lifecycle change. The compatibility checkpoint is write-only in this CLI.
 */
export async function ensureBrokerUptodate(options: EnsureBrokerUptodateOptions): Promise<void> {
  const report = options.report ?? (() => undefined);
  const lockPath = join(dirname(options.checkpointPath), BROKER_UPDATE_LOCK_DIRECTORY);
  let lock: AcquiredBrokerUpdateLock | SkippedBrokerUpdateLock;

  try {
    lock = await acquireBrokerUpdateLock(
      lockPath,
      options.lockWaitTimeoutMs ?? BROKER_UPDATE_LOCK_WAIT_MS,
    );
  } catch (error) {
    reportDebug(
      options,
      `skipped: lock acquisition failed: ${errorMessage(error) || "unknown error"}`,
    );
    return;
  }
  if (!lock.acquired) {
    reportDebug(options, `skipped: ${lock.reason}`);
    return;
  }

  try {
    await refreshLegacyCliMtimeCheckpoint(options);

    const nativeStatus = await options.status();
    if (!nativeStatus.ok) {
      reportDebug(
        options,
        `not authorized: scoutd status failed: ${errorMessage(nativeStatus.error) || "unknown error"}`,
      );
      return;
    }

    const freshness = extractRuntimeFreshnessDecisionFromScoutdPayload(nativeStatus.raw);
    if (!freshness) {
      reportDebug(
        options,
        "not authorized: scoutd status omitted a valid runtimeFreshness decision",
      );
      return;
    }

    if (!shouldRestartBrokerForRuntimeFreshness(freshness)) {
      const reasonCode = freshness.reasonCode
        ? ` reasonCode=${freshness.reasonCode}`
        : "";
      const detail = freshness.detail ? ` detail=${JSON.stringify(freshness.detail)}` : "";
      reportDebug(
        options,
        `not authorized: state=${freshness.state} intentional=${freshness.intentional} basis=${freshness.basis}${reasonCode}${detail}`,
      );
      return;
    }

    report("Scoutd reports a stale runtime; restarting the broker service to load the updated artifact.");
    const restarted = await options.restart();
    if (!restarted.ok) {
      report(
        `warning: Scout broker restart failed: ${errorMessage(restarted.error) || "unknown scoutd error"}`,
      );
    }
  } catch (error) {
    reportDebug(
      options,
      `check failed: ${errorMessage(error) || "unknown error"}`,
    );
  } finally {
    try {
      await lock.release();
    } catch (error) {
      reportDebug(
        options,
        `lock cleanup failed: ${errorMessage(error) || "unknown error"}`,
      );
    }
  }
}
