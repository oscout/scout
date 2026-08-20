import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetConversationListCache,
  getConversationListSnapshot,
} from "./conversation-list-cache.ts";

describe("conversation list external-store snapshot", () => {
  beforeEach(() => {
    __resetConversationListCache();
  });

  test("reuses one empty snapshot while the cache has not changed", () => {
    const first = getConversationListSnapshot();
    const second = getConversationListSnapshot();

    expect(first).toEqual([]);
    expect(second).toBe(first);
  });
});
