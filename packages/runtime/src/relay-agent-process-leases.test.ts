import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readRelayAgentProcessLeases,
  reconcileRelayAgentProcessLeases,
  relayAgentProcessLeasePath,
  removeRelayAgentProcessLease,
  writeRelayAgentProcessLease,
} from "./relay-agent-process-leases.js";

const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
let supportDirectory: string;

beforeEach(() => {
  supportDirectory = mkdtempSync(join(tmpdir(), "openscout-leases-"));
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = supportDirectory;
});

afterEach(() => {
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
  rmSync(supportDirectory, { recursive: true, force: true });
});

describe("relay-agent process leases", () => {
  test("writes, lists, and removes a lease", () => {
    writeRelayAgentProcessLease({
      agentId: "session-abc",
      sessionName: "session-abc",
      ownerPid: 4242,
      startedAtMs: 1_000,
      projectRoot: "/tmp/project",
      harness: "claude",
    });

    const leases = readRelayAgentProcessLeases();
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      version: 1,
      kind: "relay_agent",
      agentId: "session-abc",
      sessionName: "session-abc",
      ownerPid: 4242,
    });

    removeRelayAgentProcessLease("session-abc");
    expect(readRelayAgentProcessLeases()).toEqual([]);
    expect(existsSync(relayAgentProcessLeasePath("session-abc"))).toBe(false);
  });

  test("reconcile drops leases for dead sessions and adopts live unclaimed ones", () => {
    writeRelayAgentProcessLease({
      agentId: "session-dead",
      sessionName: "session-dead",
      ownerPid: 1111,
      startedAtMs: 1_000,
    });
    writeRelayAgentProcessLease({
      agentId: "session-live",
      sessionName: "session-live",
      ownerPid: 1111,
      startedAtMs: 2_000,
      projectRoot: "/tmp/project",
    });

    const result = reconcileRelayAgentProcessLeases({
      liveSessionNames: new Set(["session-live", "session-adopted"]),
      owners: new Map([
        ["session-live", "session-live"],
        ["session-adopted", "session-adopted"],
      ]),
      ownerPid: 2222,
      now: 5_000,
    });

    expect(result.removed).toEqual(["session-dead"]);
    expect(result.adopted.sort()).toEqual(["session-adopted", "session-live"]);

    const leases = new Map(readRelayAgentProcessLeases().map((lease) => [lease.sessionName, lease]));
    expect(leases.has("session-dead")).toBe(false);
    // Adoption re-claims ownership but preserves the original start time.
    expect(leases.get("session-live")).toMatchObject({
      ownerPid: 2222,
      startedAtMs: 2_000,
      adoptedAtMs: 5_000,
      projectRoot: "/tmp/project",
    });
    expect(leases.get("session-adopted")).toMatchObject({ ownerPid: 2222, startedAtMs: 5_000 });
  });

  test("reconcile never adopts a live session without positive attribution", () => {
    const result = reconcileRelayAgentProcessLeases({
      liveSessionNames: new Set(["operator-scratchpad"]),
      owners: new Map(),
      ownerPid: 2222,
    });
    expect(result.adopted).toEqual([]);
    expect(readRelayAgentProcessLeases()).toEqual([]);
  });
});
