import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ScoutCoreCommandBusyError,
  acquireScoutCoreCommandLock,
} from "./command-lock.ts";

const cleanupDirectories: string[] = [];
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;

afterEach(async () => {
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function createSupportDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-core-command-lock-"));
  cleanupDirectories.push(directory);
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = directory;
  return directory;
}

test("prevents overlapping core Scout commands across processes", async () => {
  createSupportDirectory();

  const release = await acquireScoutCoreCommandLock("doctor");

  await expect(acquireScoutCoreCommandLock("setup")).rejects.toMatchObject({
    name: "ScoutCoreCommandBusyError",
    runningCommand: "doctor",
    runningPid: process.pid,
  } satisfies Partial<ScoutCoreCommandBusyError>);

  await release();

  const releaseAfter = await acquireScoutCoreCommandLock("setup");
  await releaseAfter();
});

test("reclaims a stale lock left by a dead process", async () => {
  const supportDirectory = createSupportDirectory();
  const runtimeLocksDirectory = join(supportDirectory, "runtime", "locks");
  const lockPath = join(runtimeLocksDirectory, "scout-core-command.lock.json");

  mkdirSync(runtimeLocksDirectory, { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    command: "runtimes",
    pid: 999_999_999,
    startedAt: Date.now() - 60_000,
    host: "stale-host",
  }));

  const release = await acquireScoutCoreCommandLock("doctor");
  await release();
});
