import { describe, expect, test } from "bun:test";
import { projectChatReadLane, summarizeChatReadState } from "./chat-read-state.ts";
import type { ConversationReadCursor } from "@openscout/protocol";

const cursor = (extra: Partial<ConversationReadCursor> = {}): ConversationReadCursor => ({
  conversationId: "room", actorId: "maya", lastReadAt: 500, updatedAt: 500, ...extra,
});
const messages = [
  { id: "a", actorId: "alex", createdAt: 100, class: "agent" },
  { id: "b", actorId: "alex", createdAt: 100, class: "agent", mentions: [{ actorId: "maya" }] },
  { id: "c", actorId: "maya", createdAt: 200, class: "agent" },
  { id: "d", actorId: "agent", createdAt: 300, class: "status" },
  { id: "e", actorId: "alex", createdAt: 400, class: "agent" },
];
const lane = (read?: ConversationReadCursor, rows = messages, pageLimit = 100) => projectChatReadLane({ actorId: "maya", rootMessageId: null, messages: rows, cursor: read, pageLimit });

describe("chat read projection", () => {
  test("uses message order, not acknowledgement time, and excludes own messages and progress", () => {
    const state = lane(cursor({ lastReadMessageId: "a" }));
    expect(state.unreadMessageIds).toEqual(["b", "e"]);
    expect(state.mentionMessageIds).toEqual(["b"]);
    expect(state.incomplete).toBe(false);
  });
  test("a canonical boundary remains valid after its anchor leaves the page", () => {
    expect(lane(cursor({ lastReadMessageId: "expired", metadata: { scoutReadBoundary: { id: "expired", createdAt: 250 } } })).unreadMessageIds).toEqual(["e"]);
  });
  test("a boundary for the wrong anchor is never used to claim messages read", () => {
    const state = lane(cursor({ lastReadMessageId: "expired", metadata: { scoutReadBoundary: { id: "different", createdAt: 999 } } }));
    expect(state.incomplete).toBe(true);
    expect(state.unreadMessageIds).toEqual([]);
  });
  test("a full retained page is a lower bound until the cursor is covered", () => {
    expect(lane(undefined, messages, 5).incomplete).toBe(true);
    expect(lane(cursor({ lastReadMessageId: "a" }), messages, 5).incomplete).toBe(false);
  });
  test("channel and thread summaries keep reply attention distinct", () => {
    const root = lane(cursor({ lastReadMessageId: "e" }));
    const replies = { ...lane(), rootMessageId: "a" };
    expect(summarizeChatReadState({ channelId: "room", actorId: "maya", lanes: [root, replies] }))
      .toEqual({ unread: 3, mentions: 1, replies: 3, incomplete: false });
  });
});
