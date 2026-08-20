import { describe, expect, it } from "bun:test";

import {
  addFilterLane,
  createDefaultLaneDeck,
  pinSessionLane,
  resolveLaneWidthPx,
  setLaneWidthOverride,
  snapLaneWidthPx,
} from "./lane-deck.ts";
import {
  laneMatchesHarness,
  laneNeedsAttention,
  resolveLaneDeckLayout,
} from "./lane-deck-layout.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

function lane(id: string, harness = "codex", current = false): AgentLane {
  return {
    id,
    agent: {
      id,
      name: id,
      harness,
      harnessSessionId: `session-${id}`,
      project: "/Users/example/dev/openscout",
      projectRoot: "/Users/example/dev/openscout",
      cwd: "/Users/example/dev/openscout",
      definitionId: id,
    } as AgentLane["agent"],
    source: "native",
    observe: null,
    lastActiveAt: Date.now(),
    current,
  };
}

describe("lane deck width", () => {
  it("resolves tier widths", () => {
    expect(resolveLaneWidthPx("sm", "lg")).toBe(408);
    expect(resolveLaneWidthPx(420, "md")).toBe(420);
  });

  it("snaps near tier boundaries", () => {
    expect(snapLaneWidthPx(410).tier).toBe("sm");
    expect(snapLaneWidthPx(600).tier).toBe("lg");
  });
});

describe("resolveLaneDeckLayout", () => {
  it("places pinned session lanes before auto lanes", () => {
    const autoLanes = [lane("alpha"), lane("beta", "claude")];
    let deck = createDefaultLaneDeck("web.ops");
    deck = pinSessionLane(deck, { laneId: "beta", title: "Beta", zone: "pinned_left", width: "lg" });
    deck = setLaneWidthOverride(deck, "alpha", "sm");

    const layout = resolveLaneDeckLayout({ autoLanes, deck, defaultWidthTier: "md" });
    expect(layout.pinnedLeft.map((entry) => entry.lane.id)).toEqual(["beta"]);
    expect(layout.main.map((entry) => entry.lane.id)).toEqual(["alpha"]);
    expect(layout.pinnedLeft[0]?.widthPx).toBe(616);
    expect(layout.main[0]?.widthPx).toBe(408);
  });

  it("creates harness filter lanes in pinned zone", () => {
    const autoLanes = [lane("alpha"), lane("beta", "claude")];
    let deck = createDefaultLaneDeck("web.ops");
    deck = addFilterLane(deck, {
      kind: "harness",
      title: "Codex",
      harness: "codex",
      zone: "pinned_left",
      width: "md",
    });

    const layout = resolveLaneDeckLayout({ autoLanes, deck, defaultWidthTier: "lg" });
    expect(layout.pinnedLeft.map((entry) => entry.lane.id)).toEqual(["alpha"]);
    expect(layout.main.map((entry) => entry.lane.id)).toEqual(["beta"]);
  });

  it("hides auto lanes when profile disables them", () => {
    const autoLanes = [lane("alpha"), lane("beta", "claude")];
    const deck = { ...createDefaultLaneDeck("hud.tail"), showAutoLanes: false };
    const layout = resolveLaneDeckLayout({ autoLanes, deck, defaultWidthTier: "sm" });
    expect(layout.flat).toHaveLength(0);
  });
});

describe("lane filters", () => {
  it("matches harness and attention", () => {
    expect(laneMatchesHarness(lane("alpha", "codex"), "codex")).toBe(true);
    expect(laneMatchesHarness(lane("beta", "claude"), "codex")).toBe(false);
    expect(laneNeedsAttention({ ...lane("gamma"), current: true })).toBe(true);
  });
});