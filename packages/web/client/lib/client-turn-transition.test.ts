import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearPendingConversationTurns,
  pendingConversationFlight,
  stageAcceptedConversationTurn,
} from "./client-turn-transition.ts";
import {
  clearConversationTailCache,
  readCachedConversationTail,
} from "./chat-cache.ts";

describe("new Chat turn transition", () => {
  beforeEach(() => {
    clearConversationTailCache();
    clearPendingConversationTurns();
  });

  test("carries the canonical bubble and queued flight across navigation", () => {
    stageAcceptedConversationTurn({
      conversationId: "c.agent-1",
      messageId: "msg-1",
      clientMessageId: "web-1",
      body: "Please review this.",
      agentId: "agent-1",
      flightId: "flt-1",
      invocationId: "inv-1",
      createdAt: 1_700_000_000_000,
    });

    expect(readCachedConversationTail("c.agent-1")).toEqual([
      expect.objectContaining({
        id: "msg-1",
        body: "Please review this.",
        metadata: { clientMessageId: "web-1" },
      }),
    ]);
    expect(pendingConversationFlight("c.agent-1", 1_700_000_000_001)).toEqual(
      expect.objectContaining({ id: "flt-1", invocationId: "inv-1", state: "queued" }),
    );
  });
});
