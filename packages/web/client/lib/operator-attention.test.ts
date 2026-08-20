import { describe, expect, test } from "bun:test";
import {
  routeForFleetAsk,
  routeForOperatorAttention,
} from "./operator-attention.ts";

describe("direct operator resolution routes", () => {
  test("opens the exact conversation when one is known", () => {
    expect(routeForOperatorAttention({
      kind: "work_item",
      recordId: "work-1",
      title: "Review result",
      summary: null,
      agentId: "agent-1",
      agentName: "Agent One",
      conversationId: "conv-1",
      state: "review",
      acceptanceState: "pending",
      updatedAt: 1,
    })).toEqual({ view: "conversation", conversationId: "conv-1" });
  });

  test("resolves a work record through follow instead of a work page", () => {
    expect(routeForFleetAsk({
      invocationId: "inv-1",
      flightId: null,
      agentId: "agent-1",
      agentName: "Agent One",
      conversationId: null,
      collaborationRecordId: "work-1",
      task: "Review result",
      status: "needs_attention",
      statusLabel: "Needs attention",
      acknowledgedAt: null,
      attention: "interrupt",
      agentState: "working",
      harness: "codex",
      transport: null,
      summary: null,
      startedAt: 1,
      completedAt: null,
      updatedAt: 1,
    })).toEqual({
      view: "follow",
      workId: "work-1",
      preferredView: "chat",
      targetAgentId: "agent-1",
    });
  });

  test("sends an unthreaded question straight to the asking agent", () => {
    expect(routeForOperatorAttention({
      kind: "question",
      recordId: "question-1",
      title: "Choose an option",
      summary: null,
      agentId: "agent-1",
      agentName: "Agent One",
      conversationId: null,
      state: "open",
      acceptanceState: "pending",
      updatedAt: 1,
    })).toEqual({ view: "agents-v2", agentId: "agent-1", tab: "message" });
  });
});
