import { describe, expect, test } from "bun:test";
import { isSearchUnanswered } from "./search-loading.ts";
const pending = { query: "agent", hasIndex: true, filterKey: "agent:all", settledFilterKey: null, failedFilterKey: null };
describe("search loading state", () => {
  test("includes the input debounce before the request starts", () => expect(isSearchUnanswered(pending)).toBe(true));
  test("does not spin before an index exists or for blank input", () => {
    expect(isSearchUnanswered({ ...pending, hasIndex: false })).toBe(false);
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
