import { describe, expect, test } from "bun:test";

import {
  compareConversationProjectionItems,
  observedSessionFeedId,
  scoutConversationFeedId,
} from "./conversation-projection.js";

describe("conversation projection identity", () => {
  test("derives stable source-owned feed ids", () => {
    expect(scoutConversationFeedId("chn-123")).toBe("conv:chn-123");
    expect(observedSessionFeedId("codex", "01abc")).toBe("obs:codex:01abc");
  });

  test("orders recent items deterministically", () => {
    const items = [
      { feedId: "conv:b", lastActivityAt: 20 },
      { feedId: "conv:c", lastActivityAt: 30 },
      { feedId: "conv:a", lastActivityAt: 20 },
    ];

    expect(items.sort(compareConversationProjectionItems).map((item) => item.feedId)).toEqual([
      "conv:c",
      "conv:a",
      "conv:b",
    ]);
  });
});
