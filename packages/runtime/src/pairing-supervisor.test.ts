import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimScoutPairingSupervision,
  claimScoutPairingRuntimeOwnership,
  isScoutPairingRuntimeOwnerLive,
  isScoutPairingRuntimeOwnerPidRunning,
  readLiveScoutPairingRuntimeOwner,
  readScoutPairingProcessPid,
  readScoutPairingRuntimeOwner,
  readScoutPairingSupervisorIntent,
  releaseScoutPairingRuntimeOwnership,
  releaseScoutPairingSupervision,
  resolveScoutPairingSupervisorPaths,
  signalScoutPairingRuntimeOwner,
  updateScoutPairingSupervisorIntent,
  type ScoutPairingProcessIdentity,
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

  test("binds runtime ownership to token, executable, and process birth", () => {
    const paths = createPaths();
    let identity: ScoutPairingProcessIdentity | null = {
      pid: 4242,
      startedAt: "Mon Aug 25 10:00:00 2026",
      command: "/opt/homebrew/bin/bun pairing-runtime-controller.mjs",
    };
    const inspect = () => identity;
    const owner = claimScoutPairingRuntimeOwnership({
      pid: 4242,
      token: "0123456789abcdef",
      ownerPath: paths.runtimeOwnerPath,
      inspect,
      now: 123,
    });

    expect(readScoutPairingRuntimeOwner(paths.runtimeOwnerPath)).toEqual(owner);
    expect(readLiveScoutPairingRuntimeOwner(paths.runtimeOwnerPath, { inspect })).toEqual(owner);
    expect(isScoutPairingRuntimeOwnerLive(owner, { inspect })).toBe(true);
    expect(isScoutPairingRuntimeOwnerLive(owner, {
      expectedToken: "fedcba9876543210",
      inspect,
    })).toBe(false);

    // Same PID, same command, different birth: the kernel recycled the PID.
    identity = { ...identity, startedAt: "Mon Aug 25 11:00:00 2026" };
    expect(readLiveScoutPairingRuntimeOwner(paths.runtimeOwnerPath, { inspect })).toBeNull();
  });

  test("uses a cheap PID probe for steady health without weakening signal proof", () => {
    const paths = createPaths();
    const identity: ScoutPairingProcessIdentity = {
      pid: 4343,
      startedAt: "Mon Aug 25 10:00:00 2026",
      command: "/opt/homebrew/bin/bun pairing-runtime-controller.mjs",
    };
    const owner = claimScoutPairingRuntimeOwnership({
      pid: identity.pid,
      token: "0123456789abcdef",
      ownerPath: paths.runtimeOwnerPath,
      inspect: () => identity,
    });
    const probes: Array<number | null> = [];
    const isRunning = (pid: number | null) => {
      probes.push(pid);
      return true;
    };

    expect(isScoutPairingRuntimeOwnerPidRunning(owner, identity.pid, { isRunning })).toBe(true);
    expect(isScoutPairingRuntimeOwnerPidRunning(owner, identity.pid + 1, { isRunning })).toBe(false);
    expect(probes).toEqual([identity.pid]);

    // The cheap hint may still see a recycled PID as occupied. It is never the
    // authorization boundary: exact command+birth proof rejects the signal.
    const recycled = {
      ...identity,
      startedAt: "Mon Aug 25 11:00:00 2026",
      command: "/usr/bin/sleep 600",
    };
    const signals: string[] = [];
    expect(signalScoutPairingRuntimeOwner(owner, "SIGTERM", {
      ownerPath: paths.runtimeOwnerPath,
      inspect: () => recycled,
      kill: (_pid, signal) => { signals.push(signal); },
    })).toBe(false);
    expect(signals).toEqual([]);
  });

  test("revalidates ownership before TERM and KILL", () => {
    const paths = createPaths();
    let identity: ScoutPairingProcessIdentity | null = {
      pid: 5151,
      startedAt: "Mon Aug 25 10:00:00 2026",
      command: "/opt/homebrew/bin/bun pairing-runtime-controller.mjs",
    };
    const inspect = () => identity;
    const owner = claimScoutPairingRuntimeOwnership({
      pid: 5151,
      token: "0123456789abcdef",
      ownerPath: paths.runtimeOwnerPath,
      inspect,
    });
    const signals: string[] = [];
    const kill = (_pid: number, signal: NodeJS.Signals) => signals.push(signal);

    expect(signalScoutPairingRuntimeOwner(owner, "SIGTERM", {
      ownerPath: paths.runtimeOwnerPath,
      inspect,
      kill,
    })).toBe(true);

    identity = {
      pid: 5151,
      startedAt: "Mon Aug 25 11:00:00 2026",
      command: "/usr/bin/sleep 600",
    };
    expect(signalScoutPairingRuntimeOwner(owner, "SIGKILL", {
      ownerPath: paths.runtimeOwnerPath,
      inspect,
      kill,
    })).toBe(false);
    expect(signals).toEqual(["SIGTERM"]);

    releaseScoutPairingRuntimeOwnership(owner, paths.runtimeOwnerPath);
    expect(existsSync(paths.runtimeOwnerPath)).toBe(false);
  });
});
