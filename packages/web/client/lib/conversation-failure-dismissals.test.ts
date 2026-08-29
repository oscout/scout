import { afterEach, describe, expect, test } from "bun:test";

import {
  __test,
  dismissConversationFailure,
  loadDismissedConversationFailureIds,
} from "./conversation-failure-dismissals.ts";

afterEach(() => {
  try {
    localStorage.removeItem(__test.STORAGE_KEY);
  } catch {
    // ignore
  }
  __test.reset();
});

describe("conversation failure dismissals", () => {
  test("persists cleared failures per conversation", () => {
    dismissConversationFailure("c-1", "msg-failed-1");

    expect(loadDismissedConversationFailureIds("c-1")).toEqual(new Set(["msg-failed-1"]));
    expect(loadDismissedConversationFailureIds("c-2")).toEqual(new Set());
  });

  test("deduplicates repeated dismissal", () => {
    dismissConversationFailure("c-1", "msg-failed-1");
    const ids = dismissConversationFailure("c-1", "msg-failed-1");

    expect([...ids]).toEqual(["msg-failed-1"]);
  });
});
