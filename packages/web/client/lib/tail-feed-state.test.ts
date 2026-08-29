import { describe, expect, it } from "bun:test";

import { tailFeedFailure, type TailFeedLoadState } from "./tail-feed-state.ts";

function loadState(overrides: Partial<TailFeedLoadState> = {}): TailFeedLoadState {
  return {
    discovery: "ready",
    recent: "ready",
    discoveryLoaded: true,
    recentLoaded: true,
    ...overrides,
  };
}

describe("tailFeedFailure", () => {
  it("reports no failure while both channels are loading", () => {
    expect(tailFeedFailure(loadState({
      discovery: "loading",
      recent: "loading",
      discoveryLoaded: false,
      recentLoaded: false,
    }))).toBe("none");
  });

  it("reports no failure once both channels are ready", () => {
    expect(tailFeedFailure(loadState())).toBe("none");
  });

  it("reports blank when a channel fails before it ever answered", () => {
    expect(tailFeedFailure(loadState({
      discovery: "error",
      recent: "loading",
      discoveryLoaded: false,
      recentLoaded: false,
    }))).toBe("blank");
  });

  it("reports blank when one channel answered and the other never has", () => {
    expect(tailFeedFailure(loadState({
      recent: "error",
      recentLoaded: false,
    }))).toBe("blank");
  });

  it("reports degraded when a refresh fails on top of two good loads", () => {
    expect(tailFeedFailure(loadState({ recent: "error" }))).toBe("degraded");
    expect(tailFeedFailure(loadState({ discovery: "error" }))).toBe("degraded");
  });

  it("keeps reporting degraded when both channels blip after loading", () => {
    expect(tailFeedFailure(loadState({
      discovery: "error",
      recent: "error",
    }))).toBe("degraded");
  });
});
