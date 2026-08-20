import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRelayAgentWatchdogDirectives,
  resolveRelayAgentOrphanGraceMs,
  DEFAULT_RELAY_AGENT_ORPHAN_GRACE_MS,
} from "./relay-agent-watchdog.js";

let workDirectory: string;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), "openscout-watchdog-"));
});

afterEach(() => {
  rmSync(workDirectory, { recursive: true, force: true });
});

function launchScript(input: { heartbeatPath: string; graceMs: number; pollSeconds: number }): string {
  const scriptPath = join(workDirectory, "launch.sh");
  writeFileSync(scriptPath, [
    "#!/bin/bash",
    "set -uo pipefail",
    ...buildRelayAgentWatchdogDirectives({
      sessionName: "session-under-test",
      heartbeatPath: input.heartbeatPath,
      graceMs: input.graceMs,
      pollSeconds: input.pollSeconds,
    }),
    // Stand-in for the exec'd harness: same shape as the real launch script.
    "exec sleep 300",
    "",
  ].join("\n"), { mode: 0o755 });
  return scriptPath;
}

async function exitedWithin(proc: { exited: Promise<unknown> }, ms: number): Promise<boolean> {
  const result = await Promise.race([
    proc.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
  return result;
}

describe("resolveRelayAgentOrphanGraceMs", () => {
  test("defaults, clamps, and supports disabling", () => {
    expect(resolveRelayAgentOrphanGraceMs({})).toBe(DEFAULT_RELAY_AGENT_ORPHAN_GRACE_MS);
    expect(resolveRelayAgentOrphanGraceMs({ OPENSCOUT_RELAY_AGENT_ORPHAN_GRACE_MS: "1" })).toBe(60_000);
    expect(resolveRelayAgentOrphanGraceMs({ OPENSCOUT_RELAY_AGENT_ORPHAN_GRACE_MS: "0" })).toBe(0);
    expect(resolveRelayAgentOrphanGraceMs({ OPENSCOUT_RELAY_AGENT_ORPHAN_GRACE_MS: "-5" })).toBe(0);
    expect(resolveRelayAgentOrphanGraceMs({ OPENSCOUT_RELAY_AGENT_ORPHAN_GRACE_MS: "junk" }))
      .toBe(DEFAULT_RELAY_AGENT_ORPHAN_GRACE_MS);
  });

  test("a disabled grace produces no watchdog directives", () => {
    expect(buildRelayAgentWatchdogDirectives({ sessionName: "s", graceMs: 0 })).toEqual([]);
  });
});

describe("relay-agent watchdog script", () => {
  test("kills the harness once the heartbeat goes stale", async () => {
    const heartbeatPath = join(workDirectory, "broker-heartbeat.json");
    // Heartbeat exists but is already stale: the runtime that owned this relay is gone.
    writeFileSync(heartbeatPath, "{}\n");
    const staleSeconds = Math.floor(Date.now() / 1000) - 3_600;
    utimesSync(heartbeatPath, staleSeconds, staleSeconds);

    const proc = Bun.spawn(["bash", launchScript({ heartbeatPath, graceMs: 2_000, pollSeconds: 1 })], {
      stdout: "ignore",
      stderr: "ignore",
    });

    // Poll 1s + stale detection: well within 15s even on a loaded machine.
    expect(await exitedWithin(proc, 15_000)).toBe(true);
  }, 20_000);

  test("a fresh heartbeat keeps the harness alive; losing it kills the harness", async () => {
    const heartbeatPath = join(workDirectory, "broker-heartbeat.json");
    writeFileSync(heartbeatPath, "{}\n");

    const proc = Bun.spawn(["bash", launchScript({ heartbeatPath, graceMs: 3_000, pollSeconds: 1 })], {
      stdout: "ignore",
      stderr: "ignore",
    });

    // Keep the heartbeat fresh for longer than the grace window.
    const refresher = setInterval(() => {
      try {
        const now = Date.now() / 1000;
        utimesSync(heartbeatPath, now, now);
      } catch {
        // File removed at the end of the test.
      }
    }, 500);

    try {
      expect(await exitedWithin(proc, 5_000)).toBe(false);
    } finally {
      clearInterval(refresher);
    }

    // Owner death: the heartbeat stops refreshing and the watchdog reaps.
    expect(await exitedWithin(proc, 20_000)).toBe(true);
  }, 30_000);
});
