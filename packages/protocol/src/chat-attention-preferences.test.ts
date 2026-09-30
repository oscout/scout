import { describe, expect, test } from "bun:test";
import { applyChatAttentionPreferenceChange as change, readChatAttentionPreferences as read } from "./read-receipts.ts";

describe("personal chat attention preferences", () => {
  test("defaults safely and preserves independent notification and thread changes", () => {
    expect(read(undefined)).toEqual({ notificationMode: "all", followedThreadIds: [] });
    let state = change(undefined, { threadId: "thread-a", following: true });
    state = change(state, { notificationMode: "mentions" });
    state = change(state, { threadId: "thread-b", following: true });
    state = change(state, { threadId: "thread-a", following: true });
    expect(state).toEqual({ notificationMode: "mentions", followedThreadIds: ["thread-a", "thread-b"] });
    expect(change(state, { threadId: "thread-a", following: false })).toEqual({ notificationMode: "mentions", followedThreadIds: ["thread-b"] });
  });
  test("saves private message references with independent, bounded set operations", () => {
    let state = change(undefined, { messageId: "reply-a", saved: true });
    state = change(state, { threadId: "thread-a", following: true });
    state = change(state, { notificationMode: "muted" });
    state = change(state, { messageId: "reply-a", saved: true });
    state = change(state, { messageId: "root-b", saved: true });
    expect(state.savedMessageIds).toEqual(["reply-a", "root-b"]);
    expect(change(state, { messageId: "reply-a", saved: false })).toEqual({
      notificationMode: "muted", followedThreadIds: ["thread-a"], savedMessageIds: ["root-b"],
    });
    for (const input of [{ messageId: " ", saved: true }, { messageId: "a", saved: 1 },
      { messageId: "a", saved: true, actorId: "other" }, { savedMessageIds: ["a"] }]) {
      expect(() => change(state, input)).toThrow();
    }
    const full = { savedMessageIds: Array.from({ length: 500 }, (_, i) => `message-${i}`) };
    expect(() => change(full, { messageId: "another", saved: true })).toThrow("limit");
    expect(change(full, { messageId: "message-0", saved: false }).savedMessageIds).toHaveLength(499);
  });
  test("rejects broad replacements, ambiguous operations, invalid IDs, and unbounded follows", () => {
    for (const input of [null, {}, [], { notificationMode: "loud" }, { followedThreadIds: [] },
      { notificationMode: "all", actorId: "other" }, { threadId: " x ", following: true },
      { threadId: "x", following: "true" }, { threadId: "x", following: true, notificationMode: "muted" }]) {
      expect(() => change(undefined, input)).toThrow();
    }
    const full = { notificationMode: "all", followedThreadIds: Array.from({ length: 500 }, (_, i) => `thread-${i}`) };
    expect(() => change(full, { threadId: "another", following: true })).toThrow("limit");
    expect(change(full, { threadId: "thread-0", following: false }).followedThreadIds).toHaveLength(499);
  });
});
