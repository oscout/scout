import { describe, expect, test } from "bun:test";
import type { ObserveData } from "../../lib/types.ts";
import { formatRetrospectiveTime, retrospectiveParticipants, retrospectiveTimelineEvents } from "./retrospective.ts";

const base: ObserveData = {
  events: [],
  files: [],
  live: false,
  metadata: { session: { adapterType: "Codex", model: "gpt-6-sol" } },
};

describe("session retrospective derivation", () => {
  test("shows observed topology participants and only lifecycle timeline events", () => {
    const data: ObserveData = {
      ...base,
      events: [
        { id: "1", t: 1, at: 1_700_000_000_000, kind: "boot", text: "Session started" },
        { id: "2", t: 2, at: 1_700_000_000_100, kind: "tool", text: "read file" },
        { id: "3", t: 3, at: 1_700_000_000_200, kind: "ask", text: "Delegated task" },
      ],
      metadata: {
        ...base.metadata,
        topology: {
          schemaVersion: "openscout.observed-harness-topology.v1",
          ownership: "harness_observed",
          source: "codex",
          observedAt: "2026-09-22T00:00:00Z",
          groups: [],
          tasks: [],
          relationships: [],
          agents: [{ id: "a2", name: "worker", model: "gpt-mini" }],
        },
      },
    };
    expect(retrospectiveParticipants(data)).toHaveLength(2);
    expect(retrospectiveTimelineEvents(data).map((event) => event.id)).toEqual(["1", "3"]);
  });

  test("returns no participants or timeline when evidence is absent", () => {
    expect(retrospectiveParticipants({ events: [], files: [] })).toEqual([]);
    expect(retrospectiveTimelineEvents({ events: [], files: [] })).toEqual([]);
  });

  test("uses wall time or a session-relative offset, never epoch-formats the offset", () => {
    expect(formatRetrospectiveTime({ id: "wall", t: 42, at: 1_700_000_000_000, kind: "boot", text: "" }))
      .toBe(new Date(1_700_000_000_000).toLocaleTimeString());
    expect(formatRetrospectiveTime({ id: "relative", t: 125, kind: "boot", text: "" })).toBe("+2m 5s");
    expect(formatRetrospectiveTime({ id: "unknown", t: Number.NaN, kind: "boot", text: "" })).toBe("Time unavailable");
  });
});
