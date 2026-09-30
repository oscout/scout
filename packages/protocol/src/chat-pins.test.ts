import { expect, test } from "bun:test";
import { applyChatPinChange as change, parseChatPinChange, readChatPins } from "./chat-pins.ts";

test("shared pin set operations preserve original attribution and bound channel state", () => {
  const first = change(undefined, { messageId: "a", pinned: true }, "maya", 10);
  expect(change(first, { messageId: "a", pinned: true }, "alex", 20)).toEqual(first);
  const second = change(first, { messageId: "b", pinned: true }, "alex", 20);
  expect(change(second, { messageId: "a", pinned: false }, "alex", 30)).toEqual([{ messageId: "b", pinnedBy: "alex", pinnedAt: 20 }]);
  const full = Array.from({ length: 50 }, (_, i) => ({ messageId: `${i}`, pinnedBy: "maya", pinnedAt: 1 }));
  expect(() => change(full, { messageId: "more", pinned: true }, "alex", 3)).toThrow("limit");
  expect(change(full, { messageId: "0", pinned: true }, "alex", 3)).toEqual(full);
  expect(change(full, { messageId: "0", pinned: false }, "alex", 3)).toHaveLength(49);
});

test("pin changes reject forged attribution, malformed operations, and broad replacement", () => {
  for (const value of [null, [], {}, { messageId: " a ", pinned: true }, { messageId: "a", pinned: 1 },
    { messageId: "a", pinned: true, pinnedBy: "other" }, { pins: [] }]) expect(() => parseChatPinChange(value)).toThrow();
  expect(readChatPins([null, { messageId: "a" }, { messageId: "b", pinnedBy: "maya", pinnedAt: Infinity }])).toEqual([]);
});
