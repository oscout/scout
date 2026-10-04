import { describe, expect, test } from "bun:test";

import { MAX_WORK_LIST_IDS, workListOptions } from "./work-list-query.ts";

function options(query: Record<string, string>) {
  return workListOptions((name) => query[name]);
}

describe("GET /api/work query", () => {
  test("no filters: active work, default limit", () => {
    expect(options({})).toEqual({
      agentId: undefined,
      conversationId: undefined,
      ids: undefined,
      activeOnly: true,
      limit: undefined,
    });
  });

  test("ids given but none valid answers empty instead of dropping the filter", () => {
    expect(options({ ids: "bad id,<x>,../etc" })).toBeNull();
    expect(options({ ids: "bad id", active: "true" })).toBeNull();
  });

  test("an empty ids parameter is no filter at all", () => {
    expect(options({ ids: " , " })?.ids).toBeUndefined();
    expect(options({ ids: "" })?.activeOnly).toBe(true);
  });

  test("invalid ids are dropped, valid ones kept", () => {
    expect(options({ ids: "work-1, bad id ,work-2" })?.ids).toEqual(["work-1", "work-2"]);
  });

  test("more than the cap is truncated", () => {
    const ids = Array.from({ length: MAX_WORK_LIST_IDS + 30 }, (_, index) => `work-${index}`);
    const result = options({ ids: ids.join(",") })!;
    expect(result.ids).toHaveLength(MAX_WORK_LIST_IDS);
    expect(result.ids?.at(-1)).toBe(`work-${MAX_WORK_LIST_IDS - 1}`);
    expect(result.limit).toBe(MAX_WORK_LIST_IDS);
  });

  test("limit defaults to the number of ids; an explicit one is clamped", () => {
    expect(options({ ids: "work-1,work-2,work-3" })?.limit).toBe(3);
    expect(options({ ids: "work-1,work-2", limit: "1" })?.limit).toBe(1);
    expect(options({ limit: "9999" })?.limit).toBe(MAX_WORK_LIST_IDS);
    expect(options({ limit: "0" })?.limit).toBe(1);
    expect(options({ limit: "" })?.limit).toBeUndefined();
    expect(options({ limit: "many" })?.limit).toBeUndefined();
  });

  test("ids without `active` include finished work; an explicit `active` wins", () => {
    expect(options({ ids: "work-1" })?.activeOnly).toBe(false);
    expect(options({ ids: "work-1", active: "true" })?.activeOnly).toBe(true);
    expect(options({ ids: "work-1", active: "false" })?.activeOnly).toBe(false);
    expect(options({ agentId: "agent-1" })?.activeOnly).toBe(true);
    expect(options({ agentId: "agent-1", active: "false" })?.activeOnly).toBe(false);
  });

  test("agent and conversation filters pass through", () => {
    expect(options({ agentId: "agent-1", conversationId: "chn-1" })).toMatchObject({ agentId: "agent-1", conversationId: "chn-1" });
    expect(options({ agentId: "" })?.agentId).toBeUndefined();
  });
});
