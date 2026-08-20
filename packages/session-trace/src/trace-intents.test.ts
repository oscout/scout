import { describe, expect, test } from "bun:test";

import { createTraceDecisionIntent, type TraceApprovalTargetRef } from "./trace-intents.js";

describe("createTraceDecisionIntent", () => {
  test("includes the approval version on the emitted intent", () => {
    const block: TraceApprovalTargetRef = {
      sessionId: "session-1",
      turnId: "turn-1",
      id: "block-1",
      approvalVersion: 7,
    };

    expect(createTraceDecisionIntent(block, "approve")).toEqual({
      type: "decide",
      sessionId: "session-1",
      turnId: "turn-1",
      blockId: "block-1",
      version: 7,
      decision: "approve",
      reason: undefined,
    });
  });
});
