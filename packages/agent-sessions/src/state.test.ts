import { describe, expect, test } from "bun:test";

import { StateTracker } from "./state.ts";

describe("StateTracker", () => {
  test("preserves answered question blocks in session snapshots", () => {
    const tracker = new StateTracker();
    const sessionId = "session-1";
    const turnId = "turn-1";
    const blockId = "block-1";

    tracker.createSession(sessionId, {
      id: sessionId,
      name: "Scout Pairing",
      adapterType: "echo",
      status: "active",
    });

    tracker.trackEvent(sessionId, {
      event: "turn:start",
      sessionId,
      turn: {
        id: turnId,
        sessionId,
        status: "started",
        startedAt: new Date(0).toISOString(),
        blocks: [],
      },
    });

    tracker.trackEvent(sessionId, {
      event: "block:start",
      sessionId,
      turnId,
      block: {
        id: blockId,
        turnId,
        type: "question",
        status: "streaming",
        index: 0,
        header: "Next step",
        question: "Should I continue?",
        options: [{ label: "Yes" }],
        multiSelect: false,
        questionStatus: "awaiting_answer",
      },
    });

    tracker.trackEvent(sessionId, {
      event: "block:question:answer",
      sessionId,
      turnId,
      blockId,
      questionStatus: "answered",
      answer: ["Yes"],
    });

    const snapshot = tracker.getSessionState(sessionId);

    expect(snapshot?.turns).toHaveLength(1);
    expect(snapshot?.turns[0]?.blocks).toHaveLength(1);
    expect(snapshot?.turns[0]?.blocks[0]?.block).toEqual({
      id: blockId,
      turnId,
      type: "question",
      status: "streaming",
      index: 0,
      header: "Next step",
      question: "Should I continue?",
      options: [{ label: "Yes" }],
      multiSelect: false,
      questionStatus: "answered",
      answer: ["Yes"],
    });
  });
});
