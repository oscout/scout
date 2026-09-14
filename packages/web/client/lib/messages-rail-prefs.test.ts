import { afterEach, describe, expect, test } from "bun:test";

import { loadMessagesRailPrefs, saveMessagesRailPrefs } from "./messages-rail-prefs.ts";

const V1_KEY = "scout:messages:rail:v1";
const V2_KEY = "scout:messages:rail:v2";

// The module reads window.localStorage; bun test has no DOM. Without a real
// store every case would silently fall through the try/catch to DEFAULTS and
// the migration assertion below would pass for the wrong reason.
const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

afterEach(() => {
  store.clear();
});

describe("messages rail prefs", () => {
  test("a fresh reader lands on the flat recency queue", () => {
    expect(loadMessagesRailPrefs()).toEqual({ view: "sessions", groupBy: "recent" });
  });

  test("a v1 choice does not pin an existing reader to the old default", () => {
    // The whole point of the key bump: someone who used the rail before this
    // change has `{view:"agents"}` stored and would otherwise never see it.
    store.set(V1_KEY, JSON.stringify({ view: "agents", groupBy: "project" }));
    expect(loadMessagesRailPrefs()).toEqual({ view: "sessions", groupBy: "recent" });
  });

  test("an explicit choice still wins and round-trips", () => {
    saveMessagesRailPrefs({ view: "agents", groupBy: "day" });
    expect(loadMessagesRailPrefs()).toEqual({ view: "agents", groupBy: "day" });
  });

  test("an unrecognised group key falls back to recent, not to project", () => {
    store.set(V2_KEY, JSON.stringify({ view: "sessions", groupBy: "nonsense" }));
    expect(loadMessagesRailPrefs().groupBy).toBe("recent");
  });
});
