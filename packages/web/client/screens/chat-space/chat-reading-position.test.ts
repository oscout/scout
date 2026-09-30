import { describe, expect, test } from "bun:test";
import { captureChatReadingPosition, isAtChatTail, parseChatReadingPosition, restoreChatReadingPosition } from "./chat-reading-position.ts";

function viewport(heights = [100, 100, 100, 100, 100, 100]) {
  const box = {
    scrollTop: 0,
    scrollHeight: heights.reduce((sum, height) => sum + height, 0),
    clientHeight: 200,
    getBoundingClientRect: () => ({ top: 60 }),
    querySelectorAll: () => heights.map((height, index) => ({
      dataset: { messageId: `message-${index}` },
      getBoundingClientRect: () => {
        const top = 60 + heights.slice(0, index).reduce((sum, value) => sum + value, 0) - box.scrollTop;
        return { top, bottom: top + height };
      },
    })),
  };
  return box as unknown as HTMLElement;
}

describe("chat reading continuity", () => {
  test("restores the same partly visible message when earlier content changes height", () => {
    const before = viewport();
    before.scrollTop = 235;
    const saved = captureChatReadingPosition(before);
    expect(saved).toEqual({ messageId: "message-2", offset: -35, scrollTop: 235, atLatest: false });
    const after = viewport([140, 180, 100, 100, 100, 100]);
    restoreChatReadingPosition(after, saved);
    expect(after.scrollTop).toBe(355);
    expect(captureChatReadingPosition(after).offset).toBe(-35);
    expect(captureChatReadingPosition(after).messageId).toBe("message-2");
  });

  test("new arrivals do not move a reader's stored anchor", () => {
    const before = viewport();
    before.scrollTop = 110;
    const saved = captureChatReadingPosition(before);
    const after = viewport([100, 100, 100, 100, 100, 100, 800]);
    restoreChatReadingPosition(after, saved);
    expect(after.scrollTop).toBe(110);
  });

  test("a tail-following reader lands on the new tail after reopening", () => {
    const before = viewport();
    before.scrollTop = 400;
    const saved = captureChatReadingPosition(before);
    expect(saved.atLatest).toBe(true);
    const after = viewport([100, 100, 100, 100, 100, 100, 800]);
    restoreChatReadingPosition(after, saved);
    // The browser clamps this to scrollHeight - clientHeight.
    expect(after.scrollTop).toBe(after.scrollHeight);
  });

  test("missing anchors use the saved position and invalid records use the latest", () => {
    const node = viewport();
    restoreChatReadingPosition(node, { messageId: "expired", offset: 0, scrollTop: 140, atLatest: false });
    expect(node.scrollTop).toBe(140);
    restoreChatReadingPosition(node, null);
    expect(node.scrollTop).toBe(node.scrollHeight);
    for (const value of [null, {}, { messageId: "x", offset: NaN, scrollTop: 3, atLatest: false },
      { messageId: "x", offset: 0, scrollTop: -2, atLatest: false }]) {
      expect(parseChatReadingPosition(value)).toBeNull();
    }
  });

  test("tail tolerance allows a small offset without swallowing deliberate reading", () => {
    expect(isAtChatTail(380, 600, 200)).toBe(true);
    expect(isAtChatTail(300, 600, 200)).toBe(false);
    expect(isAtChatTail(0, 100, 200)).toBe(true);
  });
});
