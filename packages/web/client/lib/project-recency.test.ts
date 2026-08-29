import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readRecentProjectRoots, rememberProjectRoot } from "./project-recency.ts";

const STORAGE_KEY = "openscout.project-recency.v1";
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    },
  });
});

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("project recency", () => {
  test("normalizes, deduplicates, and bounds persisted roots", () => {
    store.set(STORAGE_KEY, JSON.stringify([
      "/work/one/",
      "/work/two",
      "/work/one",
      "  ",
      42,
      ...Array.from({ length: 20 }, (_, index) => `/work/${index + 3}`),
    ]));

    const roots = readRecentProjectRoots();
    expect(roots).toHaveLength(12);
    expect(roots.slice(0, 3)).toEqual(["/work/one", "/work/two", "/work/3"]);
  });

  test("moves an explicit pick to the front and persists it", () => {
    store.set(STORAGE_KEY, JSON.stringify(["/work/one", "/work/two"]));

    expect(rememberProjectRoot(" /work/two/ ")).toEqual(["/work/two", "/work/one"]);
    expect(JSON.parse(store.get(STORAGE_KEY) ?? "null")).toEqual(["/work/two", "/work/one"]);
  });

  test("treats malformed storage as an empty working set", () => {
    store.set(STORAGE_KEY, "not-json");
    expect(readRecentProjectRoots()).toEqual([]);

    store.set(STORAGE_KEY, JSON.stringify({ root: "/work/one" }));
    expect(readRecentProjectRoots()).toEqual([]);
  });
});
