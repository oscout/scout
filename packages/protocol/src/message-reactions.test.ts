import { describe, expect, test } from "bun:test";

import {
  isAllowedReactionEmoji,
  projectMessageReactionChips,
  REACTION_EMOJI_ALLOWLIST,
} from "./message-reactions.ts";

describe("reaction allowlist", () => {
  test("accepts the quick strip and the extra set, and nothing else", () => {
    expect(isAllowedReactionEmoji("👍")).toBe(true);
    expect(isAllowedReactionEmoji("🔥")).toBe(true);
    expect(isAllowedReactionEmoji("🤔")).toBe(true);
    expect(isAllowedReactionEmoji("🍆")).toBe(false);
    expect(isAllowedReactionEmoji("")).toBe(false);
  });
});

describe("projectMessageReactionChips", () => {
  test("orders by first appearance, then allowlist, and marks me", () => {
    const chips = projectMessageReactionChips(
      [
        { messageId: "m1", actorId: "a", emoji: "🎉", createdAt: 30 },
        { messageId: "m1", actorId: "b", emoji: "👍", createdAt: 10 },
        { messageId: "m1", actorId: "a", emoji: "👍", createdAt: 20 },
        { messageId: "m1", actorId: "c", emoji: "❤️", createdAt: 15 },
      ],
      "a",
    );
    expect(chips).toEqual([
      { emoji: "👍", count: 2, me: true },
      { emoji: "❤️", count: 1, me: false },
      { emoji: "🎉", count: 1, me: true },
    ]);
  });

  test("an empty row set is an empty array, not omitted", () => {
    expect(projectMessageReactionChips([], "a")).toEqual([]);
  });
});
