import { describe, expect, test } from "bun:test";

import {
  buildMissionLogs,
  computeWallTiling,
  filterMissionLogs,
  missionLogFileLabel,
  missionLogTitle,
  nextWallTiling,
  sortMissionLogs,
  type MissionAgentRef,
} from "./mission-wall.ts";
import type { TailDiscoveredTranscript, TailEvent } from "../../lib/types.ts";

const VIEWPORT = { w: 1440, h: 900 };

function tailEvent(overrides: Partial<TailEvent> & { sessionId: string; ts: number }): TailEvent {
  return {
    id: `${overrides.sessionId}:${overrides.ts}`,
    source: "claude",
    pid: 100,
    parentPid: null,
    project: "openscout",
    cwd: "/Users/art/dev/openscout",
    harness: "unattributed",
    kind: "tool",
    summary: "bash ls",
    ...overrides,
  };
}

function transcript(
  overrides: Partial<TailDiscoveredTranscript> & { sessionId: string },
): TailDiscoveredTranscript {
  return {
    source: "claude",
    transcriptPath: `/logs/${overrides.sessionId}.jsonl`,
    cwd: "/Users/art/dev/openscout",
    project: "openscout",
    harness: "unattributed",
    mtimeMs: 1_000,
    size: 42,
    ...overrides,
  };
}

function agentRef(overrides: Partial<MissionAgentRef> & { id: string }): MissionAgentRef {
  return {
    name: "Opus",
    handle: "opus",
    state: "in_turn",
    project: "openscout",
    branch: "main",
    harness: "claude",
    model: "opus-5",
    sessionIds: [],
    ...overrides,
  };
}

describe("computeWallTiling", () => {
  test("gives a single pane the whole wall", () => {
    const tiling = computeWallTiling(1, VIEWPORT);
    expect(tiling).toMatchObject({ cols: 1, rows: 1, shown: 1, hidden: 0 });
  });

  test("splits side by side before stacking, since log panes read wide", () => {
    expect(computeWallTiling(2, VIEWPORT)).toMatchObject({ cols: 2, rows: 1, shown: 2 });
  });

  test("prefers arrangements that leave no empty cells", () => {
    expect(computeWallTiling(4, VIEWPORT)).toMatchObject({ cols: 2, rows: 2, hidden: 0 });
    expect(computeWallTiling(6, VIEWPORT)).toMatchObject({ cols: 3, rows: 2, hidden: 0 });
    expect(computeWallTiling(12, VIEWPORT)).toMatchObject({ cols: 4, rows: 3, hidden: 0 });
  });

  test("grows the grid as panes are added, up to the max", () => {
    const counts = [1, 2, 4, 9, 16, 40].map((n) => computeWallTiling(n, VIEWPORT));
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i].shown).toBeGreaterThanOrEqual(counts[i - 1].shown);
    }
    const capped = computeWallTiling(40, VIEWPORT);
    expect(capped.shown).toBeLessThanOrEqual(16);
    expect(capped.shown + capped.hidden).toBe(40);
  });

  test("withholds panes rather than shrinking them below legibility", () => {
    const small = computeWallTiling(16, { w: 900, h: 600 });
    expect(small.shown).toBeLessThan(16);
    expect(small.paneW).toBeGreaterThanOrEqual(300);
    expect(small.paneH).toBeGreaterThanOrEqual(180);
    expect(small.shown + small.hidden).toBe(16);
  });

  test("still renders one pane when the viewport is below the legibility floor", () => {
    const tiny = computeWallTiling(5, { w: 200, h: 120 });
    expect(tiny).toMatchObject({ cols: 1, rows: 1, shown: 1, hidden: 4 });
  });

  test("falls back to a sane wall before the viewport is measured", () => {
    expect(computeWallTiling(4, { w: 0, h: 0 }).shown).toBe(4);
  });

  test("is empty for no panes", () => {
    expect(computeWallTiling(0, VIEWPORT)).toMatchObject({ cols: 0, rows: 0, shown: 0 });
  });
});

describe("nextWallTiling", () => {
  test("computes fresh when there is no previous tiling", () => {
    expect(nextWallTiling(null, 4, VIEWPORT)).toMatchObject({ cols: 2, rows: 2, shown: 4 });
  });

  test("keeps the previous tiling by reference while a resize stays inside the same grid", () => {
    const first = nextWallTiling(null, 4, VIEWPORT);
    expect(nextWallTiling(first, 4, { w: 1200, h: 820 })).toBe(first);
  });

  test("retains the reference even though pane pixel sizes drift (CSS tracks own them)", () => {
    const first = nextWallTiling(null, 4, VIEWPORT);
    const drifted = computeWallTiling(4, { w: 1200, h: 820 });
    expect(drifted.paneW).not.toBe(first.paneW);
    expect(nextWallTiling(first, 4, { w: 1200, h: 820 })).toBe(first);
  });

  test("recomputes when the resize crosses a grid breakpoint", () => {
    const first = nextWallTiling(null, 4, VIEWPORT);
    const next = nextWallTiling(first, 4, { w: 500, h: 900 });
    expect(next).not.toBe(first);
    expect(next).toMatchObject({ cols: 1, rows: 4, shown: 4 });
  });

  test("recomputes when the pane count changes in the same viewport", () => {
    const first = nextWallTiling(null, 4, VIEWPORT);
    const next = nextWallTiling(first, 5, VIEWPORT);
    expect(next).not.toBe(first);
    expect(next.shown).toBe(5);
  });

  test("recomputes when withholding changes even if the grid shape does not", () => {
    const first = nextWallTiling(null, 16, { w: 900, h: 600 });
    const next = nextWallTiling(first, 17, { w: 900, h: 600 });
    expect(next).not.toBe(first);
    expect(next.hidden).toBe(first.hidden + 1);
  });
});

describe("buildMissionLogs", () => {
  const now = 10_000;

  test("splits the firehose into one log per session, oldest line first", () => {
    const logs = buildMissionLogs({
      events: [
        tailEvent({ sessionId: "a", ts: 1, summary: "a1" }),
        tailEvent({ sessionId: "b", ts: 2, summary: "b1" }),
        tailEvent({ sessionId: "a", ts: 3, summary: "a2" }),
      ],
      transcripts: [],
      agents: [],
      now,
      liveWindowMs: 60_000,
    });
    expect(logs).toHaveLength(2);
    const a = logs.find((log) => log.sessionId === "a")!;
    expect(a.lines.map((line) => line.summary)).toEqual(["a1", "a2"]);
    expect(a.lastActiveAt).toBe(3);
  });

  test("seeds a pane from a discovered transcript that has not emitted yet", () => {
    const logs = buildMissionLogs({
      events: [],
      transcripts: [transcript({ sessionId: "quiet", mtimeMs: 900 })],
      agents: [],
      now,
      liveWindowMs: 60_000,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      sessionId: "quiet",
      logPath: "/logs/quiet.jsonl",
      lastActiveAt: 900,
    });
    expect(logs[0].lines).toHaveLength(0);
  });

  test("keeps the transcript path when the firehose fills in the same log", () => {
    const logs = buildMissionLogs({
      events: [tailEvent({ sessionId: "s1", ts: 5, source: "codex" })],
      transcripts: [transcript({ sessionId: "s1" })],
      agents: [],
      now,
      liveWindowMs: 60_000,
    });
    expect(logs[0].logPath).toBe("/logs/s1.jsonl");
    // Live events win over the discovery snapshot for identity.
    expect(logs[0].source).toBe("codex");
  });

  test("attaches a Scout agent by any of its session ids", () => {
    const logs = buildMissionLogs({
      events: [tailEvent({ sessionId: "obs-1", ts: 5 })],
      transcripts: [],
      agents: [agentRef({ id: "agent-1", sessionIds: ["registered-1", "obs-1"] })],
      now,
      liveWindowMs: 60_000,
    });
    expect(logs[0].agent?.id).toBe("agent-1");
  });

  test("marks a log live only inside the live window", () => {
    const logs = buildMissionLogs({
      events: [
        tailEvent({ sessionId: "hot", ts: now - 1_000 }),
        tailEvent({ sessionId: "cold", ts: now - 600_000 }),
      ],
      transcripts: [],
      agents: [],
      now,
      liveWindowMs: 60_000,
    });
    expect(logs.find((log) => log.sessionId === "hot")!.live).toBe(true);
    expect(logs.find((log) => log.sessionId === "cold")!.live).toBe(false);
  });

  test("drops replayed lines so a pane never shows the same event twice", () => {
    const replayed = tailEvent({ sessionId: "a", ts: 1, summary: "once" });
    const logs = buildMissionLogs({
      events: [replayed, tailEvent({ sessionId: "a", ts: 2, summary: "then" }), { ...replayed }],
      transcripts: [],
      agents: [],
      now,
      liveWindowMs: 60_000,
    });
    expect(logs[0].lines.map((line) => line.summary)).toEqual(["once", "then"]);
  });

  test("keeps a genuinely repeated command with its own id", () => {
    const logs = buildMissionLogs({
      events: [
        tailEvent({ sessionId: "a", ts: 1, id: "e1", summary: "bun test" }),
        tailEvent({ sessionId: "a", ts: 2, id: "e2", summary: "bun test" }),
      ],
      transcripts: [],
      agents: [],
      now,
      liveWindowMs: 60_000,
    });
    expect(logs[0].lines).toHaveLength(2);
  });

  test("caps retained lines per log at the buffer", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      tailEvent({ sessionId: "loud", ts: i + 1, summary: `line-${i}` }));
    const logs = buildMissionLogs({
      events,
      transcripts: [],
      agents: [],
      now,
      liveWindowMs: 60_000,
      bufferPerLog: 4,
    });
    expect(logs[0].lines.map((line) => line.summary)).toEqual([
      "line-6",
      "line-7",
      "line-8",
      "line-9",
    ]);
  });
});

describe("filterMissionLogs", () => {
  const now = 100_000;
  const base = buildMissionLogs({
    events: [
      tailEvent({ sessionId: "scout-1", ts: now - 1_000, harness: "scout-managed", project: "openscout" }),
      tailEvent({ sessionId: "native-1", ts: now - 1_000, harness: "unattributed", project: "hudson" }),
      tailEvent({ sessionId: "stale-1", ts: now - 5 * 60 * 60_000, harness: "unattributed", project: "openscout" }),
    ],
    transcripts: [],
    agents: [],
    now,
    liveWindowMs: 60_000,
  });

  const filters = {
    sourceFilter: "all" as const,
    activityFilter: "all" as const,
    query: "",
    now,
    activeWindowMs: 24 * 60 * 60_000,
  };

  test("drops known logs that have nothing to tail", () => {
    const withSilent = [
      ...base,
      ...buildMissionLogs({
        events: [],
        transcripts: [transcript({ sessionId: "silent", mtimeMs: now - 500 })],
        agents: [],
        now,
        liveWindowMs: 60_000,
      }),
    ];
    expect(filterMissionLogs(withSilent, filters).map((l) => l.sessionId)).not.toContain("silent");
    expect(
      filterMissionLogs(withSilent, { ...filters, requireOutput: false }).map((l) => l.sessionId),
    ).toContain("silent");
  });

  test("splits scout-managed from native logs", () => {
    expect(filterMissionLogs(base, { ...filters, sourceFilter: "scout" }).map((l) => l.sessionId))
      .toEqual(["scout-1"]);
    expect(filterMissionLogs(base, { ...filters, sourceFilter: "native" }).map((l) => l.sessionId).sort())
      .toEqual(["native-1", "stale-1"]);
  });

  test("live keeps only logs still emitting", () => {
    expect(filterMissionLogs(base, { ...filters, activityFilter: "live" }).map((l) => l.sessionId).sort())
      .toEqual(["native-1", "scout-1"]);
  });

  test("active honours the selected window", () => {
    const recent = filterMissionLogs(base, {
      ...filters,
      activityFilter: "active",
      activeWindowMs: 30 * 60_000,
    });
    expect(recent.map((l) => l.sessionId).sort()).toEqual(["native-1", "scout-1"]);
  });

  test("query matches project, session and harness", () => {
    expect(filterMissionLogs(base, { ...filters, query: "hudson" }).map((l) => l.sessionId))
      .toEqual(["native-1"]);
    expect(filterMissionLogs(base, { ...filters, query: "stale" }).map((l) => l.sessionId))
      .toEqual(["stale-1"]);
  });
});

describe("sortMissionLogs", () => {
  const now = 100_000;
  const logs = buildMissionLogs({
    events: [
      tailEvent({ sessionId: "a", ts: 30, project: "alpha" }),
      tailEvent({ sessionId: "b", ts: 10, project: "beta" }),
      tailEvent({ sessionId: "c", ts: 20, project: "alpha" }),
    ],
    transcripts: [],
    agents: [],
    now,
    liveWindowMs: 60_000,
  });

  test("activity order is pure recency", () => {
    expect(sortMissionLogs(logs, "activity").map((l) => l.sessionId)).toEqual(["a", "c", "b"]);
  });

  test("workspace order keeps a project's logs adjacent", () => {
    expect(sortMissionLogs(logs, "workspace").map((l) => l.sessionId)).toEqual(["a", "c", "b"]);
  });

  test("a busier group sorts ahead of a quieter one", () => {
    const quietFirst = buildMissionLogs({
      events: [
        tailEvent({ sessionId: "x", ts: 5, project: "quiet" }),
        tailEvent({ sessionId: "y", ts: 99, project: "busy" }),
        tailEvent({ sessionId: "z", ts: 98, project: "busy" }),
      ],
      transcripts: [],
      agents: [],
      now,
      liveWindowMs: 60_000,
    });
    expect(sortMissionLogs(quietFirst, "workspace").map((l) => l.sessionId)).toEqual(["y", "z", "x"]);
  });
});

describe("log labels", () => {
  const [log] = buildMissionLogs({
    events: [tailEvent({ sessionId: "abcdef123456789", ts: 1 })],
    transcripts: [transcript({ sessionId: "abcdef123456789", transcriptPath: "/a/b/session.jsonl" })],
    agents: [],
    now: 2,
    liveWindowMs: 60_000,
  });

  test("names the log by its file", () => {
    expect(missionLogFileLabel(log)).toBe("session.jsonl");
  });

  test("falls back to the session when there is no agent", () => {
    expect(missionLogTitle(log)).toBe("claude:abcdef1234567");
  });

  test("prefers the agent handle", () => {
    const [withAgent] = buildMissionLogs({
      events: [tailEvent({ sessionId: "s", ts: 1 })],
      transcripts: [],
      agents: [agentRef({ id: "a1", handle: "scoutbot", sessionIds: ["s"] })],
      now: 2,
      liveWindowMs: 60_000,
    });
    expect(missionLogTitle(withAgent)).toBe("@scoutbot");
  });
});
