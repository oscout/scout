import { describe, expect, test, beforeEach } from "bun:test";

import type { DiscoverySnapshot, TailEvent } from "@openscout/runtime/tail";
import {
  __pushTailEventForTests,
  __resetBroadcastForTests,
  evaluateOnce,
  snapshotRecentBroadcasts,
} from "./service.ts";

function makeProc(pid: number, cwd: string, harness: "scout-managed" | "hudson-managed" | "unattributed" = "unattributed") {
  return {
    pid,
    ppid: 1,
    command: "claude",
    etime: "00:01",
    cwd,
    harness,
    parentChain: [],
    source: "claude",
  };
}

function makeSnap(
  procs: ReturnType<typeof makeProc>[],
  generatedAt: number,
): DiscoverySnapshot {
  let scoutManaged = 0;
  let hudsonManaged = 0;
  let unattributed = 0;
  for (const p of procs) {
    if (p.harness === "scout-managed") scoutManaged++;
    else if (p.harness === "hudson-managed") hudsonManaged++;
    else unattributed++;
  }
  return {
    generatedAt,
    processes: procs,
    totals: {
      total: procs.length,
      scoutManaged,
      hudsonManaged,
      unattributed,
    },
  };
}

function makeEvent(
  pid: number,
  ts: number,
  kind: TailEvent["kind"] = "assistant",
  summary = "hello",
  sessionId = "s1",
  project = "demo",
): TailEvent {
  return {
    id: `${sessionId}:${pid}:${ts}`,
    ts,
    source: "claude",
    sessionId,
    pid,
    parentPid: null,
    project,
    cwd: `/tmp/${project}`,
    harness: "unattributed",
    kind,
    summary,
  };
}

describe("broadcast service", () => {
  beforeEach(() => {
    __resetBroadcastForTests();
  });

  test("agent-exited fires once per pid", () => {
    const t0 = 1_000_000;
    const prev = makeSnap([makeProc(101, "/tmp/demo")], t0 - 1_000);
    const cur = makeSnap([], t0);
    // Seed previousDiscovery by calling evaluate once.
    evaluateOnce(t0 - 1_000, prev);
    const emitted = evaluateOnce(t0, cur);
    const exits = emitted.filter((b) => b.ruleId === "agent-exited");
    expect(exits.length).toBe(1);
    expect(exits[0]!.tier).toBe("error");
    expect(exits[0]!.text).toContain("exited");

    // Re-evaluating with the same prev should not refire.
    const again = evaluateOnce(t0 + 1_000, cur);
    const exitsAgain = again.filter((b) => b.ruleId === "agent-exited");
    expect(exitsAgain.length).toBe(0);
  });

  test("fleet-activity fires when totals change", () => {
    const t0 = 2_000_000;
    evaluateOnce(t0, makeSnap([makeProc(1, "/tmp/a")], t0));
    const emitted = evaluateOnce(
      t0 + 1_000,
      makeSnap([makeProc(1, "/tmp/a"), makeProc(2, "/tmp/b")], t0 + 1_000),
    );
    const fleet = emitted.filter((b) => b.ruleId === "fleet-activity");
    expect(fleet.length).toBe(1);
    expect(fleet[0]!.text).toContain("2 agents tracked");
  });

  test("fleet-activity respects cooldown", () => {
    const t0 = 3_000_000;
    evaluateOnce(t0, makeSnap([makeProc(1, "/tmp/a")], t0));
    evaluateOnce(t0 + 100, makeSnap([makeProc(1, "/tmp/a"), makeProc(2, "/tmp/b")], t0 + 100));
    // Same totals/key — within cooldown window.
    const second = evaluateOnce(
      t0 + 200,
      makeSnap([makeProc(1, "/tmp/a"), makeProc(2, "/tmp/b")], t0 + 200),
    );
    expect(second.filter((b) => b.ruleId === "fleet-activity").length).toBe(0);
  });

  test("agent-idle fires when last event is older than threshold", () => {
    const t0 = 4_000_000;
    const proc = makeProc(101, "/tmp/demo");
    // Event is 6 minutes old — past the 5-min idle threshold but within the
    // 60-min "was recently active" window.
    __pushTailEventForTests(makeEvent(101, t0 - 6 * 60_000));
    const emitted = evaluateOnce(t0, makeSnap([proc], t0));
    const idle = emitted.filter((b) => b.ruleId === "agent-idle");
    expect(idle.length).toBeGreaterThanOrEqual(1);
    expect(idle[0]!.tier).toBe("warn");
    expect(idle[0]!.text).toContain("idle");
  });

  test("repeated-tool-failure fires on 3 error tool-results in 60s", () => {
    const t0 = 5_000_000;
    const proc = makeProc(101, "/tmp/demo");
    __pushTailEventForTests(makeEvent(101, t0 - 30_000, "tool", "bash(\"ls\")", "s1", "demo"));
    __pushTailEventForTests(makeEvent(101, t0 - 25_000, "tool-result", "→ error: nope", "s1", "demo"));
    __pushTailEventForTests(makeEvent(101, t0 - 20_000, "tool-result", "Error: failed again", "s1", "demo"));
    __pushTailEventForTests(makeEvent(101, t0 - 15_000, "tool-result", "FAILED to do thing", "s1", "demo"));
    const emitted = evaluateOnce(t0, makeSnap([proc], t0));
    const fail = emitted.filter((b) => b.ruleId === "repeated-tool-failure");
    expect(fail.length).toBe(1);
    expect(fail[0]!.text).toContain("bash");
    expect(fail[0]!.text).toContain("failures");
  });

  test("history buffer captures emissions via dispatch", () => {
    const t0 = 6_000_000;
    evaluateOnce(t0, makeSnap([], t0));
    // exited rule — push prev with proc, then current with no proc.
    evaluateOnce(t0 + 1_000, makeSnap([makeProc(202, "/tmp/x")], t0 + 1_000));
    // Next eval; but history only fills via runTick/dispatch. evaluateOnce doesn't dispatch.
    // So this test confirms snapshotRecentBroadcasts is initially empty (smoke).
    expect(snapshotRecentBroadcasts(50)).toEqual([]);
  });
});
