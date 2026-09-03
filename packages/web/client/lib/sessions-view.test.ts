import { describe, expect, test } from "bun:test";

import {
  dayBucket,
  groupQueueSessions,
  NO_PROJECT_LABEL,
  projectLabelForAgent,
  queueSessionState,
} from "./sessions-view.ts";
import { buildFleetActiveAskIndex } from "./fleet-active-asks.ts";
import type { FleetAsk } from "./types.ts";

const NOW = new Date("2026-08-29T15:00:00").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const agents = new Map([
  ["a-newton", { id: "a-newton", name: "Newton", project: "openscout", projectRoot: "/Users/x/dev/openscout" }],
  ["a-keel", { id: "a-keel", name: "Keel", project: null, projectRoot: "/Users/x/dev/hudson" }],
  ["a-drift", { id: "a-drift", name: "Drift", project: null, projectRoot: null }],
]);

const asks = buildFleetActiveAskIndex([
  {
    invocationId: "inv-newton",
    agentId: "a-newton",
    conversationId: "c1",
    status: "working",
    updatedAt: NOW,
  } as FleetAsk,
  {
    invocationId: "inv-keel",
    agentId: "a-keel",
    conversationId: "c2",
    status: "needs_attention",
    updatedAt: NOW,
  } as FleetAsk,
]);

const sessions = [
  { id: "c1", agentId: "a-newton", agentName: "Newton", lastMessageAt: NOW - 2 * HOUR },
  { id: "c2", agentId: "a-keel", agentName: "Keel", lastMessageAt: NOW - 26 * HOUR },
  { id: "c3", agentId: "a-newton", agentName: "Newton", lastMessageAt: NOW - 30 * HOUR },
  { id: "c4", agentId: "a-drift", agentName: "Drift", lastMessageAt: NOW - 10 * DAY },
  { id: "c5", agentId: null, agentName: null, lastMessageAt: null },
];

describe("sessions view grouping", () => {
  test("project grouping falls back project → repo basename → no-project, bucket last", () => {
    expect(projectLabelForAgent(agents.get("a-newton"))).toBe("openscout");
    expect(projectLabelForAgent(agents.get("a-keel"))).toBe("hudson");
    expect(projectLabelForAgent(agents.get("a-drift"))).toBe(NO_PROJECT_LABEL);

    const groups = groupQueueSessions(sessions, "project", agents, asks, NOW);
    expect(groups.map((g) => g.label)).toEqual(["hudson", "openscout", NO_PROJECT_LABEL]);
    // Agentless sessions land in the no-project bucket with unresolved agents.
    expect(groups[2]!.sessions.map((s) => s.id)).toEqual(["c4", "c5"]);
  });

  test("groups sort by recency inside, whatever the key", () => {
    const groups = groupQueueSessions(sessions, "project", agents, asks, NOW);
    const openscout = groups.find((g) => g.label === "openscout")!;
    expect(openscout.sessions.map((s) => s.id)).toEqual(["c1", "c3"]);
  });

  test("day buckets are local calendar days in ladder order", () => {
    expect(dayBucket(NOW - HOUR, NOW)).toBe("Today");
    expect(dayBucket(NOW - 16 * HOUR, NOW)).toBe("Yesterday"); // 23:00 the day before
    expect(dayBucket(NOW - 3 * DAY, NOW)).toBe("This week");
    expect(dayBucket(NOW - 8 * DAY, NOW)).toBe("Earlier");
    expect(dayBucket(null, NOW)).toBe("Earlier");

    const groups = groupQueueSessions(sessions, "day", agents, asks, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier"]);
  });

  test("state ladder: needs-you outranks working outranks starting outranks quiet", () => {
    expect(queueSessionState({ status: "needs_attention" })).toBe("needs_you");
    expect(queueSessionState({ status: "working" })).toBe("working");
    expect(queueSessionState({ status: "queued" })).toBe("queued");
    expect(queueSessionState({ status: "completed" })).toBe("quiet");
    expect(queueSessionState(undefined)).toBe("quiet");

    const groups = groupQueueSessions(sessions, "state", agents, asks, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Needs you", "Working", "Quiet"]);
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(["c2"]);
    expect(groups[1]!.sessions.map((s) => s.id)).toEqual(["c1"]);
    expect(groups[2]!.sessions.map((s) => s.id)).toEqual(["c3", "c4", "c5"]);
  });

  test("agent grouping is alphabetical with an unknown bucket", () => {
    const groups = groupQueueSessions(sessions, "agent", agents, asks, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Drift", "Keel", "Newton", "Unknown agent"]);
  });
});
