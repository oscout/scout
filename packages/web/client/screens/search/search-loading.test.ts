import { describe, expect, test } from "bun:test";
import { isSearchUnanswered, latestIndexFailure } from "./search-loading.ts";
const pending = { query: "agent", filterKey: "agent:all", settledFilterKey: null, failedFilterKey: null };
describe("search loading state", () => {
  test("includes the input debounce before the request starts", () => expect(isSearchUnanswered(pending)).toBe(true));
  test("does not spin for blank input", () => {
    expect(isSearchUnanswered({ ...pending, query: "  " })).toBe(false);
  });
  test("stops pending after success and after failure", () => {
    expect(isSearchUnanswered({ ...pending, settledFilterKey: pending.filterKey })).toBe(false);
    expect(isSearchUnanswered({ ...pending, failedFilterKey: pending.filterKey })).toBe(false);
  });
  test("same query with changed filters awaits its own result", () => {
    expect(isSearchUnanswered({ ...pending, settledFilterKey: "agent:codex" })).toBe(true);
  });
  test("an older failed filter set cannot suppress a new request", () => {
    expect(isSearchUnanswered({ ...pending, failedFilterKey: "agent:codex" })).toBe(true);
  });
});

describe("latest index failure", () => {
  test("shows a requested run that fails before any in-progress status was observed", () => {
    expect(latestIndexFailure({ indexing: null, lastIndex: { finishedAt: 101, ok: false, error: "child missing" } }, 100))
      .toBe("Indexing failed: child missing");
  });
  test("ignores an older failure, an active run and a successful completion", () => {
    const lastIndex = { finishedAt: 99, ok: false, error: "old" };
    expect(latestIndexFailure({ lastIndex }, 100)).toBeNull();
    expect(latestIndexFailure({ lastIndex }, null)).toBeNull();
    expect(latestIndexFailure({ indexing: { startedAt: 100 }, lastIndex: { ...lastIndex, finishedAt: 101 } }, 100)).toBeNull();
    expect(latestIndexFailure({ lastIndex: { finishedAt: 101, ok: true } }, 100)).toBeNull();
  });
});
