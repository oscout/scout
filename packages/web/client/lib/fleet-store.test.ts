import { describe, expect, test } from "bun:test";

import { createFleetStore } from "./fleet-store-core.ts";

function harness() {
  let now = 1_000_000;
  const fetched: string[] = [];
  let fail = false;
  const store = createFleetStore<{ path: string; n: number }>({
    fetch: async (path) => {
      fetched.push(path);
      if (fail) throw new Error("down");
      return { path, n: fetched.length };
    },
    maxAgeMs: 2_500,
    clock: { now: () => now },
  });
  return {
    store,
    fetched,
    advance: (ms: number) => {
      now += ms;
    },
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}

describe("fleet store", () => {
  test("readers after one event share one fetch across their debounces", async () => {
    const { store, fetched, advance } = harness();
    store.invalidate();
    advance(250);
    const first = await store.load("/api/fleet");
    advance(750);
    const second = await store.load("/api/fleet");
    advance(500);
    const third = await store.load("/api/fleet");
    expect(fetched).toEqual(["/api/fleet"]);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("a fleet event makes the next read fetch again", async () => {
    const { store, fetched, advance } = harness();
    await store.load("/api/fleet");
    advance(100);
    store.invalidate();
    await store.load("/api/fleet");
    expect(fetched.length).toBe(2);
  });

  test("a read older than the max age is refetched with no event", async () => {
    const { store, fetched, advance } = harness();
    await store.load("/api/fleet");
    advance(2_500);
    await store.load("/api/fleet");
    expect(fetched.length).toBe(2);
  });

  test("different queries are separate reads", async () => {
    const { store, fetched } = harness();
    await store.load("/api/fleet");
    await store.load("/api/fleet?limit=24");
    expect(fetched).toEqual(["/api/fleet", "/api/fleet?limit=24"]);
  });

  test("a failed read is not reused", async () => {
    const { store, fetched, setFail } = harness();
    setFail(true);
    await expect(store.load("/api/fleet")).rejects.toThrow("down");
    setFail(false);
    const result = await store.load("/api/fleet");
    expect(result.n).toBe(2);
    expect(fetched.length).toBe(2);
  });

  test("a request started before an event is not handed out after it", async () => {
    const { store, fetched } = harness();
    const before = store.load("/api/fleet");
    store.invalidate();
    const after = store.load("/api/fleet");
    expect(after).not.toBe(before);
    await Promise.all([before, after]);
    expect(fetched.length).toBe(2);
  });
});
