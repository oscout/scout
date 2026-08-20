import { describe, expect, test } from "bun:test";

import { missionGroupLabel, stateChipColor } from "./mission-control-model.ts";

describe("stateChipColor", () => {
  test("uses the shared color for every normalized agent posture", () => {
    expect(stateChipColor("needs_attention")).toBe("var(--amber)");
    expect(stateChipColor("in_turn")).toBe("var(--green)");
    expect(stateChipColor("in_flight")).toBe("var(--accent)");
    expect(stateChipColor("blocked")).toBe("var(--dim)");
  });
});

describe("missionGroupLabel", () => {
  const subject = {
    activityLabel: "Last 5m",
    workspace: "openscout",
    harness: "codex",
    state: "in_turn",
    source: "scout" as const,
  };

  test("supports each mission-control grouping dimension", () => {
    expect(missionGroupLabel(subject, "activity")).toBe("Last 5m");
    expect(missionGroupLabel(subject, "workspace")).toBe("openscout");
    expect(missionGroupLabel(subject, "harness")).toBe("codex");
    expect(missionGroupLabel(subject, "state")).toBe("In turn");
    expect(missionGroupLabel(subject, "source")).toBe("Scout agents");
  });

  test("keeps missing dimensions in explicit buckets", () => {
    expect(missionGroupLabel({
      ...subject,
      workspace: null,
      harness: null,
      source: "native",
    }, "workspace")).toBe("Unassigned");
    expect(missionGroupLabel({
      ...subject,
      workspace: null,
      harness: null,
      source: "native",
    }, "harness")).toBe("Unknown harness");
    expect(missionGroupLabel({ ...subject, source: "native" }, "source")).toBe("Native sessions");
  });
});
