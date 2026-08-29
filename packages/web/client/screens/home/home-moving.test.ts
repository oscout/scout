import { describe, expect, test } from "bun:test";

import type { ObserveCacheEntry } from "../../lib/observe.ts";
import type { Agent, FleetAsk, TailEvent } from "../../lib/types.ts";
import {
  agentHasRecentTailActivity,
  buildHomeNativeMovingLanes,
  compareHomeMovingItems,
  dedupeWorkingAgentsByObservedSession,
  harnessTailSource,
  HOME_MOVING_WINDOW_MS,
  isHomeAgentMoving,
  isHomeObserveCandidate,
  normalizeHomeMovingSort,
  normalizeHomeMovingWindowKey,
  observedSessionKey,
} from "./home-moving.ts";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    definitionId: "agent-1",
    name: "codex.main",
    handle: null,
    agentClass: "general",
    state: "available",
    harness: "codex",
    project: "openscout",
    projectRoot: "/Users/dev/openscout",
    cwd: "/Users/dev/openscout",
    updatedAt: Date.now(),
    createdAt: null,
    transport: null,
    selector: null,
    defaultSelector: null,
    nodeQualifier: null,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    branch: null,
    role: null,
    model: null,
    harnessSessionId: null,
    terminalSurface: null,
    harnessLogPath: null,
    conversationId: null,
    homeNodeId: null,
    homeNodeName: null,
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
    ...overrides,
  };
}

describe("harnessTailSource", () => {
  test("maps grok harness variants to grok tail source", () => {
    expect(harnessTailSource("grok-acp")).toBe("grok");
    expect(harnessTailSource("pi")).toBe("grok");
    expect(harnessTailSource("codex")).toBe("codex");
  });
});

describe("moving settings", () => {
  test("normalizes persisted moving sort values", () => {
    expect(normalizeHomeMovingSort("grouped")).toBe("grouped");
    expect(normalizeHomeMovingSort("recent")).toBe("recent");
    expect(normalizeHomeMovingSort("nonsense")).toBe("recent");
  });

  test("normalizes persisted moving window values", () => {
    expect(normalizeHomeMovingWindowKey("5m")).toBe("5m");
    expect(normalizeHomeMovingWindowKey("4h")).toBe("4h");
    expect(normalizeHomeMovingWindowKey("nonsense")).toBe("30m");
  });

  test("recent sort crosses moving buckets by last activity", () => {
    const items = [
      { id: "managed-old", bucket: "working" as const, lastActivityAt: 10 },
      { id: "native-new", bucket: "native" as const, lastActivityAt: 30 },
      { id: "observed-mid", bucket: "observed" as const, lastActivityAt: 20 },
    ];

    expect([...items].sort((left, right) => compareHomeMovingItems(left, right, "recent")).map((item) => item.id))
      .toEqual(["native-new", "observed-mid", "managed-old"]);
  });

  test("grouped sort preserves bucket order before recency", () => {
    const items = [
      { id: "observed-new", bucket: "observed" as const, lastActivityAt: 30 },
      { id: "native-mid", bucket: "native" as const, lastActivityAt: 20 },
      { id: "managed-old", bucket: "working" as const, lastActivityAt: 10 },
    ];

    expect([...items].sort((left, right) => compareHomeMovingItems(left, right, "grouped")).map((item) => item.id))
      .toEqual(["managed-old", "native-mid", "observed-new"]);
  });
});

describe("isHomeObserveCandidate", () => {
  test("includes agents with harness sessions", () => {
    expect(
      isHomeObserveCandidate(
        agent({ harnessSessionId: "session-abc.jsonl" }),
        Date.now(),
        false,
      ),
    ).toBe(true);
  });

  test("includes agents with moving asks", () => {
    expect(isHomeObserveCandidate(agent(), Date.now(), true)).toBe(true);
  });

  test("includes grok-acp agents with recent grok tail activity", () => {
    const nowMs = Date.parse("2026-06-30T12:00:00.000Z");
    const tailEvents: TailEvent[] = [{
      id: "tail-grok",
      ts: nowMs - 20_000,
      kind: "tool",
      source: "grok",
      harness: "unattributed",
      project: "openscout",
      cwd: "/Users/dev/openscout",
      sessionId: "sess-grok",
      summary: "Grep · home-moving",
    }];

    expect(
      isHomeObserveCandidate(
        agent({ harness: "grok-acp", harnessSessionId: "sess-grok" }),
        nowMs,
        false,
        tailEvents,
      ),
    ).toBe(true);
  });
});

describe("isHomeAgentMoving", () => {
  const nowMs = Date.parse("2026-06-30T12:00:00.000Z");

  test("shows agents with live observe work even when broker state is callable", () => {
    expect(
      isHomeAgentMoving({
        agent: agent({ state: "available" }),
        observeEntry: {
          source: "live",
          fidelity: "timestamped",
          historyPath: null,
          sessionId: "sess-1",
          updatedAt: nowMs,
          data: {
            live: true,
            events: [{
              id: "evt-1",
              t: 0,
              kind: "tool",
              text: "read file",
              live: true,
            }],
          },
        },
        tailEvents: [],
        nowMs,
      }),
    ).toBe(true);
  });

  test("shows agents with recent tail activity for their session", () => {
    const tailEvents: TailEvent[] = [{
      id: "tail-1",
      ts: nowMs - 60_000,
      kind: "tool-call",
      source: "codex",
      harness: "codex",
      project: "openscout",
      cwd: "/Users/dev/openscout",
      sessionId: "sess-1",
      summary: "grep home-moving",
    }];

    expect(
      isHomeAgentMoving({
        agent: agent({ state: "available", harnessSessionId: "sess-1" }),
        tailEvents,
        nowMs,
      }),
    ).toBe(true);
  });

  test("hides callable agents with only broad workspace tail activity", () => {
    const tailEvents: TailEvent[] = [{
      id: "tail-1",
      ts: nowMs - 60_000,
      kind: "tool-call",
      source: "codex",
      harness: "codex",
      project: "openscout",
      cwd: "/Users/dev/openscout",
      sessionId: "other-session",
      summary: "grep home-moving",
    }];

    expect(
      isHomeAgentMoving({
        agent: agent({ state: "available" }),
        tailEvents,
        nowMs,
      }),
    ).toBe(false);
  });

  test("hides idle callable agents without observe or tail signal", () => {
    expect(
      isHomeAgentMoving({
        agent: agent({
          state: "available",
          updatedAt: nowMs - HOME_MOVING_WINDOW_MS - 1,
        }),
        tailEvents: [],
        nowMs,
      }),
    ).toBe(false);
  });

  test("shows agents with fresh moving asks", () => {
    const movingAsk: FleetAsk = {
      invocationId: "inv-1",
      agentId: "agent-1",
      status: "working",
      updatedAt: nowMs - 5_000,
    };

    expect(
      isHomeAgentMoving({
        agent: agent({ state: "available" }),
        tailEvents: [],
        nowMs,
        movingAsk,
      }),
    ).toBe(true);
  });
});

describe("agentHasRecentTailActivity", () => {
  test("requires a concrete session match for managed agent tail activity", () => {
    const nowMs = Date.parse("2026-06-30T12:00:00.000Z");
    const events: TailEvent[] = [{
      id: "tail-1",
      ts: nowMs - 30_000,
      kind: "message",
      source: "codex",
      harness: "codex",
      project: "openscout",
      cwd: "/Users/dev/openscout",
      sessionId: "other-session",
      summary: "working",
    }];

    expect(
      agentHasRecentTailActivity(
        agent({ harness: "codex", harnessSessionId: "tail-1" }),
        events,
        nowMs,
      ),
    ).toBe(false);
    expect(
      agentHasRecentTailActivity(
        agent({ harness: "codex", harnessSessionId: "other-session" }),
        events,
        nowMs,
      ),
    ).toBe(true);
    expect(
      agentHasRecentTailActivity(agent({ harness: "codex" }), events, nowMs),
    ).toBe(false);
  });

  test("ignores tail events when the agent harness is unknown", () => {
    const nowMs = Date.parse("2026-06-30T12:00:00.000Z");
    const events: TailEvent[] = [{
      id: "tail-grok",
      ts: nowMs - 20_000,
      kind: "tool",
      source: "grok",
      harness: "unattributed",
      project: "openscout",
      cwd: "/Users/dev/openscout",
      sessionId: "sess-grok",
      summary: "Shell · curl",
    }];

    expect(agentHasRecentTailActivity(agent({ harness: null }), events, nowMs)).toBe(false);
  });

  test("does not match unrelated harnesses sharing the same workspace", () => {
    const nowMs = Date.parse("2026-06-30T12:00:00.000Z");
    const events: TailEvent[] = [{
      id: "tail-grok",
      ts: nowMs - 20_000,
      kind: "tool",
      source: "grok",
      harness: "unattributed",
      project: "openscout",
      cwd: "/Users/dev/openscout",
      sessionId: "sess-grok",
      summary: "Shell · curl",
    }];

    expect(
      agentHasRecentTailActivity(agent({ harness: "claude" }), events, nowMs),
    ).toBe(false);
  });

  test("matches grok tail events to grok-acp scout agents by session id", () => {
    const nowMs = Date.parse("2026-06-30T12:00:00.000Z");
    const events: TailEvent[] = [{
      id: "tail-grok",
      ts: nowMs - 15_000,
      kind: "tool",
      source: "grok",
      harness: "scout-managed",
      project: "openscout",
      cwd: "/Users/dev/openscout",
      sessionId: "sess-grok",
      summary: "Read · home-moving.ts",
    }];

    expect(
      agentHasRecentTailActivity(
        agent({ harness: "grok-acp", harnessSessionId: "sess-grok" }),
        events,
        nowMs,
      ),
    ).toBe(true);
  });
});

function observeEntry(overrides: Partial<ObserveCacheEntry> = {}): ObserveCacheEntry {
  return {
    source: "history",
    fidelity: "timestamped",
    historyPath: "/Users/art/.claude/projects/openscout/sess-a.jsonl",
    sessionId: "sess-a",
    updatedAt: Date.now(),
    data: { events: [], files: [] },
    ...overrides,
  };
}

describe("observedSessionKey", () => {
  test("prefers the payload session id, falls back to history path", () => {
    expect(observedSessionKey(observeEntry())).toBe("session:sess-a");
    expect(
      observedSessionKey(observeEntry({ sessionId: null })),
    ).toBe("history:/Users/art/.claude/projects/openscout/sess-a.jsonl");
    expect(observedSessionKey(observeEntry({ sessionId: null, historyPath: null }))).toBeNull();
    expect(observedSessionKey(undefined)).toBeNull();
  });
});

describe("dedupeWorkingAgentsByObservedSession", () => {
  test("collapses agents that resolved to the same discovered session", () => {
    const echoOne = agent({ id: "echo-1", name: "Pages Tail" });
    const echoTwo = agent({ id: "echo-2", name: "Openscout Card M" });
    const owner = agent({ id: "owner", name: "Claude 3e0048e9", harnessSessionId: "sess-a" });
    const cache = {
      "echo-1": observeEntry(),
      "echo-2": observeEntry(),
      owner: observeEntry(),
    };

    expect(
      dedupeWorkingAgentsByObservedSession([echoOne, echoTwo, owner], cache),
    ).toEqual([owner]);
  });

  test("keeps the first (most recent) agent when nobody owns the session", () => {
    const first = agent({ id: "first" });
    const second = agent({ id: "second" });
    const cache = {
      first: observeEntry(),
      second: observeEntry(),
    };

    expect(dedupeWorkingAgentsByObservedSession([first, second], cache)).toEqual([first]);
  });

  test("passes through agents with distinct or missing observed sessions", () => {
    const distinct = agent({ id: "distinct" });
    const unobserved = agent({ id: "unobserved" });
    const other = agent({ id: "other" });
    const cache = {
      distinct: observeEntry(),
      other: observeEntry({
        sessionId: "sess-b",
        historyPath: "/Users/art/.claude/projects/openscout/sess-b.jsonl",
      }),
    };

    expect(
      dedupeWorkingAgentsByObservedSession([distinct, unobserved, other], cache),
    ).toEqual([distinct, unobserved, other]);
  });
});

describe("buildHomeNativeMovingLanes", () => {
  const nowMs = Date.parse("2026-06-30T12:00:00.000Z");

  test("includes native grok sessions with substantive tool activity", () => {
    const lanes = buildHomeNativeMovingLanes({
      agents: [],
      tailEvents: [{
        id: "tail-grok",
        ts: nowMs - 10_000,
        kind: "tool",
        source: "grok",
        harness: "unattributed",
        project: "openscout",
        cwd: "/Users/dev/openscout",
        sessionId: "sess-grok",
        summary: "Grep · pattern",
      }],
      transcripts: [{
        source: "grok",
        transcriptPath: "/Users/art/.grok/sessions/openscout/sess-grok/events.jsonl",
        sessionId: "sess-grok",
        cwd: "/Users/dev/openscout",
        project: "openscout",
        harness: "unattributed",
        mtimeMs: nowMs - 20_000,
        size: 1200,
      }],
      nowMs,
    });

    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.agent.harness).toBe("grok");
    expect(lanes[0]?.source).toBe("native");
  });

  test("respects the selected moving horizon", () => {
    const tailEvents: TailEvent[] = [{
      id: "tail-grok",
      ts: nowMs - 10 * 60_000,
      kind: "tool",
      source: "grok",
      harness: "unattributed",
      project: "openscout",
      cwd: "/Users/dev/openscout",
      sessionId: "sess-grok",
      summary: "Grep · pattern",
    }];
    const transcripts = [{
      source: "grok",
      transcriptPath: "/Users/art/.grok/sessions/openscout/sess-grok/events.jsonl",
      sessionId: "sess-grok",
      cwd: "/Users/dev/openscout",
      project: "openscout",
      harness: "unattributed",
      mtimeMs: nowMs - 10 * 60_000,
      size: 1200,
    }] as const;

    expect(buildHomeNativeMovingLanes({
      agents: [],
      tailEvents,
      transcripts: [...transcripts],
      nowMs,
      horizon: "5m",
    })).toHaveLength(0);
    expect(buildHomeNativeMovingLanes({
      agents: [],
      tailEvents,
      transcripts: [...transcripts],
      nowMs,
      horizon: "30m",
    })).toHaveLength(1);
  });

  test("excludes native grok sessions with only streaming phase noise", () => {
    const lanes = buildHomeNativeMovingLanes({
      agents: [],
      tailEvents: [{
        id: "tail-grok-noise",
        ts: nowMs - 10_000,
        kind: "system",
        source: "grok",
        harness: "unattributed",
        project: "openscout",
        cwd: "/Users/dev/openscout",
        sessionId: "sess-grok",
        summary: "phase · streaming_reasoning",
      }],
      transcripts: [{
        source: "grok",
        transcriptPath: "/Users/art/.grok/sessions/openscout/sess-grok/events.jsonl",
        sessionId: "sess-grok",
        cwd: "/Users/dev/openscout",
        project: "openscout",
        harness: "unattributed",
        mtimeMs: nowMs - 20_000,
        size: 1200,
      }],
      nowMs,
    });

    expect(lanes).toHaveLength(0);
  });
});
