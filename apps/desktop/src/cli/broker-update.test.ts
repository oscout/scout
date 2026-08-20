import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BROKER_UPDATE_LOCK_WAIT_MS,
  brokerUpdateDebugEnabled,
  ensureBrokerUptodate,
  writeCliMtimeCheckpointAtomically,
} from "./broker-update.ts";
import { SCOUTD_RESTART_TIMEOUT_MS } from "./scoutd-timing.ts";

const temporaryDirectories: string[] = [];
const fixtureNames = [
  "scoutd-status-unverified.json",
  "scoutd-status-stale.json",
  "scoutd-status-pinned.json",
  "scoutd-status-pin-mismatch.json",
  "scoutd-status-stale-explicit-pin-defensive.json",
  "scoutd-status-stale-workspace-head.json",
] as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryCheckpointPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-broker-update-"));
  temporaryDirectories.push(directory);
  return join(directory, "state", "cli-mtime");
}

function readFixture(name: (typeof fixtureNames)[number]): unknown {
  return JSON.parse(
    readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), "utf8"),
  );
}

function statusFromFixture(name: (typeof fixtureNames)[number]) {
  return { ok: true as const, raw: readFixture(name) };
}

function writeLockOwner(
  lockPath: string,
  owner: { pid: number; startedAt: number; token: string },
): void {
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
}

describe("CLI broker update coordination", () => {
  test("fails closed and reports when the native status probe fails", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const reports: string[] = [];
    let restartCount = 0;

    await ensureBrokerUptodate({
      checkpointPath,
      debug: true,
      readCurrentMtime: () => 2_000,
      report: (message) => reports.push(message),
      restart: async () => {
        restartCount += 1;
        return { ok: true };
      },
      status: async () => ({ ok: false, error: "timed out" }),
    });

    expect(restartCount).toBe(0);
    expect(readFileSync(checkpointPath, "utf8")).toBe("2000");
    expect(reports).toEqual([
      "debug: broker update not authorized: scoutd status failed: timed out",
    ]);
  });

  test("fails closed and reports when status omits runtime freshness", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const reports: string[] = [];
    let restartCount = 0;

    await ensureBrokerUptodate({
      checkpointPath,
      debug: true,
      readCurrentMtime: () => 2_000,
      report: (message) => reports.push(message),
      restart: async () => {
        restartCount += 1;
        return { ok: true };
      },
      status: async () => ({ ok: true, raw: { status: { loaded: true } } }),
    });

    expect(restartCount).toBe(0);
    expect(readFileSync(checkpointPath, "utf8")).toBe("2000");
    expect(reports).toEqual([
      "debug: broker update not authorized: scoutd status omitted a valid runtimeFreshness decision",
    ]);
  });

  test("reports the decision fields for a live unverified status", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const reports: string[] = [];
    let restartCount = 0;

    await ensureBrokerUptodate({
      checkpointPath,
      debug: true,
      readCurrentMtime: () => 2_000,
      report: (message) => reports.push(message),
      restart: async () => {
        restartCount += 1;
        return { ok: true };
      },
      status: async () => statusFromFixture("scoutd-status-unverified.json"),
    });

    expect(restartCount).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(
      "not authorized: state=unverified intentional=false basis=workspace_head",
    );
  });

  test("restarts once for a stale non-intentional runtime", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const reports: string[] = [];
    let restartCount = 0;

    await ensureBrokerUptodate({
      checkpointPath,
      readCurrentMtime: () => 2_000,
      report: (message) => reports.push(message),
      restart: async () => {
        restartCount += 1;
        return { ok: true };
      },
      status: async () => statusFromFixture("scoutd-status-stale.json"),
    });

    expect(restartCount).toBe(1);
    expect(reports).toEqual([
      "Scoutd reports a stale runtime; restarting the broker service to load the updated artifact.",
    ]);
    expect(readFileSync(checkpointPath, "utf8")).toBe("2000");
  });

  test("does not restart an intentionally pinned runtime", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const reports: string[] = [];

    await ensureBrokerUptodate({
      checkpointPath,
      debug: true,
      readCurrentMtime: () => 2_000,
      report: (message) => reports.push(message),
      restart: async () => ({ ok: true }),
      status: async () => statusFromFixture("scoutd-status-pinned.json"),
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(
      "not authorized: state=pinned intentional=true basis=explicit_pin",
    );
  });

  test("reports and does not restart when the running build contradicts an explicit pin", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const reports: string[] = [];
    let restartCount = 0;

    await ensureBrokerUptodate({
      checkpointPath,
      debug: true,
      readCurrentMtime: () => 2_000,
      report: (message) => reports.push(message),
      restart: async () => {
        restartCount += 1;
        return { ok: true };
      },
      status: async () => statusFromFixture("scoutd-status-pin-mismatch.json"),
    });

    expect(restartCount).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(
      "not authorized: state=unverified intentional=false basis=explicit_pin reasonCode=pin_mismatch",
    );
  });

  test("defensively does not restart a stale explicit-pin verdict", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const reports: string[] = [];
    let restartCount = 0;

    await ensureBrokerUptodate({
      checkpointPath,
      debug: true,
      readCurrentMtime: () => 2_000,
      report: (message) => reports.push(message),
      restart: async () => {
        restartCount += 1;
        return { ok: true };
      },
      status: async () =>
        statusFromFixture("scoutd-status-stale-explicit-pin-defensive.json"),
    });

    expect(restartCount).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(
      "not authorized: state=stale intentional=false basis=explicit_pin",
    );
  });

  test("does not restart for workspace source movement", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const reports: string[] = [];
    let restartCount = 0;

    await ensureBrokerUptodate({
      checkpointPath,
      debug: true,
      readCurrentMtime: () => 2_000,
      report: (message) => reports.push(message),
      restart: async () => {
        restartCount += 1;
        return { ok: true };
      },
      status: async () => statusFromFixture("scoutd-status-stale-workspace-head.json"),
    });

    expect(restartCount).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(
      "not authorized: state=stale intentional=false basis=workspace_head",
    );
  });

  test("warns on restart failure after advancing the compatibility fence", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const reports: string[] = [];

    await ensureBrokerUptodate({
      checkpointPath,
      readCurrentMtime: () => 2_000,
      report: (message) => reports.push(message),
      restart: async () => ({ ok: false, error: "bootstrap failed\nservice not loaded" }),
      status: async () => statusFromFixture("scoutd-status-stale.json"),
    });

    expect(readFileSync(checkpointPath, "utf8")).toBe("2000");
    expect(reports).toEqual([
      "Scoutd reports a stale runtime; restarting the broker service to load the updated artifact.",
      "warning: Scout broker restart failed: bootstrap failed service not loaded",
    ]);
  });

  test("allows one updater through and holds concurrent commands until it releases the lock", async () => {
    const checkpointPath = temporaryCheckpointPath();
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    let statusCount = 0;
    let restartCount = 0;

    const options = {
      checkpointPath,
      readCurrentMtime: () => 2_000,
      restart: async () => {
        restartCount += 1;
        return { ok: true as const };
      },
      status: async () => {
        statusCount += 1;
        await statusGate;
        return statusFromFixture("scoutd-status-stale.json");
      },
    };

    const owner = ensureBrokerUptodate(options);
    while (statusCount === 0) {
      await Bun.sleep(1);
    }
    let skippedSettled = false;
    const skipped = ensureBrokerUptodate(options).then(() => {
      skippedSettled = true;
    });
    await Bun.sleep(5);
    expect(skippedSettled).toBe(false);
    releaseStatus();
    await Promise.all([owner, skipped]);

    expect(skippedSettled).toBe(true);
    expect(statusCount).toBe(1);
    expect(restartCount).toBe(1);
  });

  test("reclaims a lock owned by a dead process", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const lockPath = join(dirname(checkpointPath), "cli-broker-update.lock");
    writeLockOwner(lockPath, {
      pid: 99_999_999,
      startedAt: 1,
      token: "dead-owner",
    });
    let statusCount = 0;

    await ensureBrokerUptodate({
      checkpointPath,
      lockWaitTimeoutMs: 0,
      readCurrentMtime: () => 2_000,
      restart: async () => ({ ok: true }),
      status: async () => {
        statusCount += 1;
        return statusFromFixture("scoutd-status-unverified.json");
      },
    });

    expect(statusCount).toBe(1);
    expect(readFileSync(checkpointPath, "utf8")).toBe("2000");
  });

  test("never expires a live owner because wall-clock time advanced", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const lockPath = join(dirname(checkpointPath), "cli-broker-update.lock");
    writeLockOwner(lockPath, {
      pid: process.pid,
      startedAt: 1,
      token: "live-owner",
    });
    let statusCount = 0;

    await ensureBrokerUptodate({
      checkpointPath,
      lockWaitTimeoutMs: 0,
      readCurrentMtime: () => 2_000,
      restart: async () => ({ ok: true }),
      status: async () => {
        statusCount += 1;
        return statusFromFixture("scoutd-status-unverified.json");
      },
    });

    expect(statusCount).toBe(0);
    expect(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"))).toMatchObject({
      token: "live-owner",
    });
  });

  test("serializes concurrent dead-owner reclamation", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const lockPath = join(dirname(checkpointPath), "cli-broker-update.lock");
    writeLockOwner(lockPath, {
      pid: 99_999_999,
      startedAt: 1,
      token: "dead-owner-storm",
    });
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    let statusCount = 0;

    const options = {
      checkpointPath,
      lockWaitTimeoutMs: 2_000,
      readCurrentMtime: () => 2_000,
      restart: async () => ({ ok: true as const }),
      status: async () => {
        statusCount += 1;
        await statusGate;
        return statusFromFixture("scoutd-status-unverified.json");
      },
    };
    const contenders = Array.from({ length: 12 }, () => ensureBrokerUptodate(options));

    while (statusCount === 0) {
      await Bun.sleep(1);
    }
    await Bun.sleep(10);
    releaseStatus();
    await Promise.all(contenders);

    expect(statusCount).toBe(1);
  });

  test("release preserves a replacement lock with a different ownership token", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const lockPath = join(dirname(checkpointPath), "cli-broker-update.lock");
    const movedPath = `${lockPath}.simulated-stolen`;

    await ensureBrokerUptodate({
      checkpointPath,
      readCurrentMtime: () => 2_000,
      restart: async () => ({ ok: true }),
      status: async () => {
        renameSync(lockPath, movedPath);
        writeLockOwner(lockPath, {
          pid: process.pid,
          startedAt: Date.now(),
          token: "replacement-owner",
        });
        return statusFromFixture("scoutd-status-unverified.json");
      },
    });

    expect(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"))).toMatchObject({
      token: "replacement-owner",
    });
  });

  test("does not reclaim a lock with uncertain ownership", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const lockPath = join(dirname(checkpointPath), "cli-broker-update.lock");
    mkdirSync(lockPath, { recursive: true });
    let statusCount = 0;

    await ensureBrokerUptodate({
      checkpointPath,
      lockWaitTimeoutMs: 0,
      readCurrentMtime: () => 2_000,
      restart: async () => ({ ok: true }),
      status: async () => {
        statusCount += 1;
        return statusFromFixture("scoutd-status-unverified.json");
      },
    });

    expect(statusCount).toBe(0);
  });

  test("atomically replaces checkpoints with one complete written value", async () => {
    const checkpointPath = temporaryCheckpointPath();
    const values = Array.from({ length: 20 }, (_, index) => index + 1_000);

    await Promise.all(
      values.map((value) => writeCliMtimeCheckpointAtomically(checkpointPath, value)),
    );

    const persisted = readFileSync(checkpointPath, "utf8");
    expect(persisted).toMatch(/^\d+$/);
    expect(values.map(String)).toContain(persisted);
    expect(readdirSync(dirname(checkpointPath))).toEqual(["cli-mtime"]);
  });

  test("derives the lock wait from the native restart timeout", () => {
    expect(SCOUTD_RESTART_TIMEOUT_MS).toBe(180_000);
    expect(BROKER_UPDATE_LOCK_WAIT_MS).toBe(SCOUTD_RESTART_TIMEOUT_MS + 15_000);
  });

  test("enables diagnostics only for explicit truthy values", () => {
    expect(brokerUpdateDebugEnabled({ OPENSCOUT_DEBUG_BROKER_UPDATE: "1" })).toBe(true);
    expect(brokerUpdateDebugEnabled({ OPENSCOUT_DEBUG_BROKER_UPDATE: "true" })).toBe(true);
    expect(brokerUpdateDebugEnabled({ OPENSCOUT_DEBUG_BROKER_UPDATE: "0" })).toBe(false);
    expect(brokerUpdateDebugEnabled({})).toBe(false);
  });
});
