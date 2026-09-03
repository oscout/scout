import { describe, expect, it } from "bun:test";

import {
  loadTailHistoryProgressively,
  shouldRetryTailHistoryAfterDiscovery,
  tailHistoryHydrationKey,
  tailReadyEventLimit,
  tailFeedFailure,
  type TailFeedLoadState,
} from "./tail-feed-state.ts";

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

describe("loadTailHistoryProgressively", () => {
  it("marks the live tail ready without waiting for transcript replay", async () => {
    const replay = Promise.withResolvers<string[]>();
    const loads: boolean[] = [];
    const published: string[][] = [];
    const phases: string[] = [];
    let ready = false;

    const hydration = loadTailHistoryProgressively({
      includeTranscriptReplay: true,
      load: (includeTranscriptReplay) => {
        loads.push(includeTranscriptReplay);
        return includeTranscriptReplay ? replay.promise : Promise.resolve(["live"]);
      },
      publish: (items, phase) => {
        published.push(items);
        phases.push(phase);
      },
      markReady: () => { ready = true; },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(ready).toBe(true);
    expect(loads).toEqual([false, true]);
    expect(published).toEqual([["live"]]);

    replay.resolve(["history"]);
    await expect(hydration).resolves.toEqual({ replay: "loaded" });
    expect(published).toEqual([["live"], ["history"]]);
    expect(phases).toEqual(["live", "replay"]);
  });

  it("keeps the live tail ready when transcript replay fails", async () => {
    const published: string[][] = [];
    let ready = false;

    await expect(loadTailHistoryProgressively({
      includeTranscriptReplay: true,
      load: (includeTranscriptReplay) => includeTranscriptReplay
        ? Promise.reject(new Error("cold replay unavailable"))
        : Promise.resolve(["live"]),
      publish: (items) => published.push(items),
      markReady: () => { ready = true; },
    })).resolves.toEqual({ replay: "failed" });

    expect(ready).toBe(true);
    expect(published).toEqual([["live"]]);
  });

  it("still reports a live-channel failure", async () => {
    let ready = false;

    await expect(loadTailHistoryProgressively({
      includeTranscriptReplay: true,
      load: () => Promise.reject(new Error("broker unavailable")),
      publish: () => {},
      markReady: () => { ready = true; },
    })).rejects.toThrow("broker unavailable");

    expect(ready).toBe(false);
  });
});

describe("tailHistoryHydrationKey", () => {
  const baseline = {
    recentLimit: 500,
    includeTranscriptReplay: true,
    recentWindowMs: 5 * 60_000,
    discoveryScope: "hot",
    discoveryLimit: 100,
  };

  it("stays stable across discovery ticks", () => {
    expect(tailHistoryHydrationKey(baseline)).toBe(tailHistoryHydrationKey({ ...baseline }));
  });

  it("changes when the history horizon or discovery scope changes", () => {
    const key = tailHistoryHydrationKey(baseline);

    expect(tailHistoryHydrationKey({ ...baseline, recentWindowMs: 30 * 60_000 })).not.toBe(key);
    expect(tailHistoryHydrationKey({ ...baseline, recentLimit: 2_000 })).not.toBe(key);
    expect(tailHistoryHydrationKey({ ...baseline, discoveryScope: "deep" })).not.toBe(key);
    expect(tailHistoryHydrationKey({ ...baseline, discoveryLimit: 500 })).not.toBe(key);
  });
});

describe("shouldRetryTailHistoryAfterDiscovery", () => {
  it("does not replay history after successful discovery ticks", () => {
    expect(shouldRetryTailHistoryAfterDiscovery("ready", "ready")).toBe(false);
    expect(shouldRetryTailHistoryAfterDiscovery("loading", "loading")).toBe(false);
  });

  it("preserves retries for live-tail and archival failures", () => {
    expect(shouldRetryTailHistoryAfterDiscovery("error", "ready")).toBe(true);
    expect(shouldRetryTailHistoryAfterDiscovery("ready", "error")).toBe(true);
  });
});

describe("tailReadyEventLimit", () => {
  it("caps the readiness payload when a deeper replay follows", () => {
    expect(tailReadyEventLimit(2_000, true)).toBe(500);
    expect(tailReadyEventLimit(200, true)).toBe(200);
  });

  it("preserves the requested limit when there is no replay", () => {
    expect(tailReadyEventLimit(2_000, false)).toBe(2_000);
  });
});
