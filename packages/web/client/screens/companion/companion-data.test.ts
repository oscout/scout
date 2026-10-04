import { describe, expect, test } from "bun:test";

import type { WorkDetail, WorkItem } from "../../lib/types.ts";
import {
  EXPANDED_STORAGE_KEY,
  SUMMARY_BATCH,
  detailIdsFor,
  followQuery,
  followQueryWorkId,
  loadPin,
  loadSummaries,
  mergeSurfaceRows,
  previewPins,
  pruneKeys,
  readExpanded,
  summaryPaths,
  writeExpanded,
  type Fetcher,
} from "./companion-data.ts";

function detail(overrides: Partial<WorkDetail> = {}): WorkDetail {
  return {
    id: "work-1",
    title: "Port the companion",
    ownerId: "agent-1",
    conversationId: "chn-1",
    timeline: [],
    activeFlights: [],
    allFlights: [],
    primaryInvocation: null,
    ...overrides,
  } as unknown as WorkDetail;
}

function row(id: string): WorkItem {
  return { id, title: id } as unknown as WorkItem;
}

/** A fetcher that answers by path prefix and records every call. */
function fakeFetcher(routes: Record<string, (path: string) => unknown>): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (path: string) => {
    calls.push(path);
    const key = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    if (!key) throw new Error(`unexpected ${path}`);
    const value = routes[key]!(path);
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher;
  return { fetcher, calls };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
  };
}

describe("previewPins", () => {
  test("keeps valid ids in order and drops the rest", () => {
    expect(previewPins(" work-1, bad id,<x>,work-2 ,")).toEqual([{ workId: "work-1" }, { workId: "work-2" }]);
    expect(previewPins(undefined)).toEqual([]);
  });
});

describe("summary reads", () => {
  test("batches ids at most SUMMARY_BATCH per request, finished work included, ids encoded", () => {
    const ids = Array.from({ length: SUMMARY_BATCH * 2 + 5 }, (_, index) => `work-${index}`);
    const paths = summaryPaths(ids);
    expect(paths).toHaveLength(3);
    for (const path of paths) expect(path).toStartWith("/api/work?active=false&");
    expect(paths[0]).toContain(`limit=${SUMMARY_BATCH}&`);
    expect(paths[2]).toContain("limit=5&");
    expect(paths[2]!.endsWith("ids=work-200,work-201,work-202,work-203,work-204")).toBe(true);
    expect(summaryPaths(["node:a b"])[0]).toEndWith("ids=node%3Aa%20b");
    expect(summaryPaths([])).toEqual([]);
  });

  test("loadSummaries joins the batches; any failed batch fails the read", async () => {
    const ids = Array.from({ length: SUMMARY_BATCH + 1 }, (_, index) => `work-${index}`);
    const ok = fakeFetcher({ "/api/work?": (path) => (path.includes("limit=1&") ? [row("work-100")] : [row("work-0")]) });
    expect((await loadSummaries(ids, ok.fetcher)).map((item) => item.id)).toEqual(["work-0", "work-100"]);
    expect(ok.calls).toHaveLength(2);
    const broken = fakeFetcher({ "/api/work?": (path) => (path.includes("limit=1&") ? new Error("500") : []) });
    await expect(loadSummaries(ids, broken.fetcher)).rejects.toThrow("500");
  });
});

describe("detailIdsFor", () => {
  const ids = ["a", "b", "c", "d", "e"];
  test("the stack reads its top cards only", () => {
    expect(detailIdsFor(ids, "stack", "e")).toEqual(["a", "b", "c"]);
  });
  test("the edge adds the figure being looked at, once", () => {
    expect(detailIdsFor(ids, "edge", "e")).toEqual(["a", "b", "c", "e"]);
    expect(detailIdsFor(ids, "edge", "b")).toEqual(["a", "b", "c"]);
    expect(detailIdsFor(ids, "edge", "gone")).toEqual(["a", "b", "c"]);
    expect(detailIdsFor(ids, "edge", null)).toEqual(["a", "b", "c"]);
  });
});

describe("followQuery", () => {
  test("a bare work id resolves nothing, so it is skipped", () => {
    expect(followQuery(detail({ conversationId: null, ownerId: null } as Partial<WorkDetail>))).toBeNull();
  });
  test("prefers the invocation's ids and leaves out empty ones", () => {
    const query = followQuery(detail({
      primaryInvocation: {
        flightId: "flt-1",
        invocationId: null,
        conversationId: "chn-2",
        resolvedSessionId: "s-1",
        targetSessionId: "s-0",
        targetAgentId: "agent-2",
      } as unknown as WorkDetail["primaryInvocation"],
    }))!;
    const params = new URLSearchParams(query);
    expect(Object.fromEntries(params)).toEqual({
      workId: "work-1",
      flightId: "flt-1",
      conversationId: "chn-2",
      sessionId: "s-1",
      targetAgentId: "agent-2",
    });
    expect(followQueryWorkId(query)).toBe("work-1");
  });
});

describe("expanded cards in localStorage", () => {
  test("reads valid ids and drops the rest", () => {
    const storage = memoryStorage({ [EXPANDED_STORAGE_KEY]: JSON.stringify(["work-1", "bad id", 7, "work-2"]) });
    expect([...readExpanded(storage)]).toEqual(["work-1", "work-2"]);
  });
  test("corrupt, non-array or missing storage reads as empty", () => {
    expect(readExpanded(memoryStorage({ [EXPANDED_STORAGE_KEY]: "{not json" })).size).toBe(0);
    expect(readExpanded(memoryStorage({ [EXPANDED_STORAGE_KEY]: "{\"a\":1}" })).size).toBe(0);
    expect(readExpanded(memoryStorage()).size).toBe(0);
    expect(readExpanded(null).size).toBe(0);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readExpanded(throwing).size).toBe(0);
    expect(() => writeExpanded(new Set(["work-1"]), throwing)).not.toThrow();
  });
  test("round-trips", () => {
    const storage = memoryStorage();
    writeExpanded(new Set(["work-1"]), storage);
    expect([...readExpanded(storage)]).toEqual(["work-1"]);
  });
});

describe("loadPin", () => {
  test("a 404 is a missing pin, not a failure", async () => {
    const { fetcher } = fakeFetcher({ "/api/work/": () => new Error("GET /api/work/work-1 failed: 404") });
    expect(await loadPin("work-1", new Map(), fetcher)).toEqual({ status: "missing", reason: "This work item is not on this broker." });
  });

  test("other detail errors are rethrown", async () => {
    const { fetcher } = fakeFetcher({ "/api/work/": () => new Error("503 broker unavailable") });
    await expect(loadPin("work-1", new Map(), fetcher)).rejects.toThrow("503");
  });

  test("only a resolved follow target is cached", async () => {
    const cache = new Map<string, string | null>();
    let session: string | null = null;
    const { fetcher, calls } = fakeFetcher({
      "/api/work/": () => detail(),
      "/api/follow?": () => ({ harnessSessionId: session }),
      "/api/session-ref/": () => ({}),
    });
    const first = await loadPin("work-1", cache, fetcher);
    expect(first).toMatchObject({ status: "ready", harnessSessionId: null, history: [] });
    expect(cache.size).toBe(0);
    session = " s-9 ";
    expect(await loadPin("work-1", cache, fetcher)).toMatchObject({ harnessSessionId: "s-9" });
    expect([...cache.values()]).toEqual(["s-9"]);
    await loadPin("work-1", cache, fetcher);
    expect(calls.filter((path) => path.startsWith("/api/follow?"))).toHaveLength(2);
  });

  test("a failed follow or session read still yields the card", async () => {
    const { fetcher } = fakeFetcher({
      "/api/work/": () => detail(),
      "/api/follow?": () => new Error("500"),
    });
    expect(await loadPin("work-1", new Map(), fetcher)).toMatchObject({ status: "ready", harnessSessionId: null });
  });
});

describe("mergeSurfaceRows", () => {
  test("a failed agent read keeps that agent's last rows, without duplicating them", () => {
    let rows = mergeSurfaceRows(new Map(), [
      { agentId: "a", rows: [row("w-a1")] },
      { agentId: "b", rows: [row("w-b1")] },
    ]);
    for (let round = 0; round < 5; round += 1) {
      rows = mergeSurfaceRows(rows, [
        { agentId: "a", rows: [row("w-a2")] },
        { agentId: "b", rows: null },
      ]);
    }
    expect([...rows.values()].flat().map((item) => item.id)).toEqual(["w-a2", "w-b1"]);
  });

  test("agents no longer read are dropped; a first failure leaves nothing", () => {
    const before = new Map([["a", [row("w-a1")]], ["gone", [row("w-g")]]]);
    const after = mergeSurfaceRows(before, [{ agentId: "a", rows: [] }, { agentId: "new", rows: null }]);
    expect([...after.entries()]).toEqual([["a", []]]);
  });
});

describe("pruneKeys", () => {
  test("drops keys outside the keep set and reports whether anything went", () => {
    const map = new Map([["a", 1], ["b", 2]]);
    expect(pruneKeys(map, new Set(["a"]))).toBe(true);
    expect([...map.keys()]).toEqual(["a"]);
    const set = new Set(["a"]);
    expect(pruneKeys(set, new Set(["a", "b"]))).toBe(false);
  });
});
