import { describe, expect, test } from "bun:test";
import { parseChatMentionActorIds } from "./chat-mentions.ts";

describe("explicit chat mention recipients", () => {
  test("omission is plain text and selected IDs are normalized deterministically", () => {
    expect(parseChatMentionActorIds(undefined)).toEqual([]);
    expect(parseChatMentionActorIds([" b ", "a", "b"])).toEqual(["a", "b"]);
  });
  test("malformed and oversized selections are refused, never broadened", () => {
    for (const value of [null, "@all", [""], [false], ["x".repeat(257)], Array(21).fill("a")]) {
      expect(() => parseChatMentionActorIds(value)).toThrow();
    }
  });
});
