import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimScoutPairingSupervision,
  readScoutPairingProcessPid,
  readScoutPairingSupervisorIntent,
  releaseScoutPairingSupervision,
  resolveScoutPairingSupervisorPaths,
  updateScoutPairingSupervisorIntent,
} from "./pairing-supervisor.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createPaths() {
  const root = mkdtempSync(join(tmpdir(), "openscout-pairing-supervisor-"));
  tempRoots.add(root);
  return resolveScoutPairingSupervisorPaths({ OPENSCOUT_PAIRING_HOME: root });
}

describe("pairing supervisor intent", () => {
  test("persists start, stop, and monotonic restart requests", () => {
    const paths = createPaths();

    expect(readScoutPairingSupervisorIntent(paths.intentPath)).toEqual({
      desiredState: null,
      restartGeneration: 0,
    });
    expect(updateScoutPairingSupervisorIntent("start", paths.intentPath)).toEqual({
      desiredState: "running",
      restartGeneration: 0,
    });

    const firstRestart = updateScoutPairingSupervisorIntent("restart", paths.intentPath);
    const secondRestart = updateScoutPairingSupervisorIntent("restart", paths.intentPath);
    expect(firstRestart.desiredState).toBe("running");
    expect(secondRestart.restartGeneration).toBeGreaterThan(firstRestart.restartGeneration);

    const stopped = updateScoutPairingSupervisorIntent("stop", paths.intentPath);
    expect(stopped).toEqual({
      desiredState: "stopped",
      restartGeneration: secondRestart.restartGeneration,
    });
  });

  test("fails closed on malformed intent and repairs it on an explicit request", () => {
    const paths = createPaths();
    writeFileSync(paths.intentPath, "not-json\n");
    expect(readScoutPairingSupervisorIntent(paths.intentPath)).toEqual({
      desiredState: "stopped",
      restartGeneration: 0,
    });


    expect(updateScoutPairingSupervisorIntent("stop", paths.intentPath)).toEqual({
      desiredState: "stopped",
      restartGeneration: 0,
    });
    expect(JSON.parse(readFileSync(paths.intentPath, "utf8"))).toEqual({
      desiredState: "stopped",
    });
  });
});

describe("pairing supervision ownership", () => {
  test("replaces a stale claim and rejects a second live owner", () => {
    const paths = createPaths();
    writeFileSync(paths.supervisorPidPath, "999999999\n");

    claimScoutPairingSupervision(process.pid, paths.supervisorPidPath);
    expect(readScoutPairingProcessPid(paths.supervisorPidPath)).toBe(process.pid);
    expect(() => claimScoutPairingSupervision(process.pid + 1, paths.supervisorPidPath)).toThrow(
      `Scout pairing is already supervised by pid ${process.pid}.`,
    );

    releaseScoutPairingSupervision(process.pid + 1, paths.supervisorPidPath);
    expect(existsSync(paths.supervisorPidPath)).toBe(true);
    releaseScoutPairingSupervision(process.pid, paths.supervisorPidPath);
    expect(existsSync(paths.supervisorPidPath)).toBe(false);
  });
});
