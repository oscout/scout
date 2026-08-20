import { describe, expect, it } from "bun:test";

import {
  agentLanesLayoutOptions,
  normalizeAgentLanesGridColumns,
  normalizeAgentLanesLayoutMode,
} from "./agent-lanes-layout.ts";

describe("agent lanes layout", () => {
  it("keeps grid available in embedded surfaces while excluding floor", () => {
    expect(agentLanesLayoutOptions(true).map((option) => option.key)).toEqual(["lanes", "grid"]);
    expect(agentLanesLayoutOptions(false).map((option) => option.key)).toEqual(["lanes", "grid", "floor"]);
  });

  it("normalizes persisted layout modes safely", () => {
    expect(normalizeAgentLanesLayoutMode("grid")).toBe("grid");
    expect(normalizeAgentLanesLayoutMode("floor", true)).toBe("lanes");
    expect(normalizeAgentLanesLayoutMode("unknown")).toBe("lanes");
  });

  it("normalizes grid column choices", () => {
    expect(normalizeAgentLanesGridColumns("4")).toBe("4");
    expect(normalizeAgentLanesGridColumns("5")).toBe("auto");
    expect(normalizeAgentLanesGridColumns(null)).toBe("auto");
  });
});
