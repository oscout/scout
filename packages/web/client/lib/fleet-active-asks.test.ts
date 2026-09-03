import { describe, expect, test } from "bun:test";

import type { FleetAsk } from "./types.ts";
import {
  bestFleetAskForAgentIds,
  buildFleetActiveAskIndex,
  fleetAskForSession,
} from "./fleet-active-asks.ts";

function ask(
  invocationId: string,
  agentId: string,
  conversationId: string | null,
  status: FleetAsk["status"],
  updatedAt: number,
): FleetAsk {
  return {
    invocationId,
    flightId: `flight-${invocationId}`,
    agentId,
    agentName: agentId,
    conversationId,
    collaborationRecordId: null,
    task: invocationId,
    status,
    statusLabel: status,
    acknowledgedAt: null,
    attention: status === "needs_attention" ? "badge" : "silent",
    agentState: "available",
    harness: null,
    transport: null,
    summary: null,
    startedAt: null,
    completedAt: null,
    updatedAt,
  };
}

describe("fleet active ask index", () => {
  test("keeps concurrent asks for one agent scoped to their conversations", () => {
    const index = buildFleetActiveAskIndex([
      ask("inv-a", "agent-1", "conv-a", "working", 10),
      ask("inv-b", "agent-1", "conv-b", "needs_attention", 20),
    ]);

    expect(fleetAskForSession(index, {
      id: "conv-a",
      agentId: "agent-1",
    })?.invocationId).toBe("inv-a");
    expect(fleetAskForSession(index, {
      id: "conv-b",
      agentId: "agent-1",
    })?.invocationId).toBe("inv-b");
    expect(fleetAskForSession(index, {
      id: "conv-c",
      agentId: "agent-1",
    })).toBeUndefined();
  });

  test("matches a coalesced session through equivalent conversation ids", () => {
    const index = buildFleetActiveAskIndex([
      ask("inv-legacy", "agent-1", "conv-legacy", "working", 10),
    ]);

    expect(fleetAskForSession(index, {
      id: "conv-canonical",
      equivalentConversationIds: ["conv-canonical", "conv-legacy"],
      agentId: "agent-1",
    })?.invocationId).toBe("inv-legacy");
  });

  test("uses an agent fallback only when the ask has no conversation id", () => {
    const conversationScoped = buildFleetActiveAskIndex([
      ask("inv-scoped", "agent-1", "conv-a", "working", 10),
    ]);
    expect(fleetAskForSession(conversationScoped, {
      id: "conv-b",
      agentId: "agent-1",
    })).toBeUndefined();

    const agentScoped = buildFleetActiveAskIndex([
      ask("inv-agent", "agent-1", null, "queued", 20),
    ]);
    expect(fleetAskForSession(agentScoped, {
      id: "conv-b",
      agentId: "agent-1",
    })?.invocationId).toBe("inv-agent");
  });

  test("chooses one deterministic state for concurrent asks in one conversation", () => {
    const index = buildFleetActiveAskIndex([
      ask("inv-new-working", "agent-1", "conv-a", "working", 30),
      ask("inv-needs", "agent-1", "conv-a", "needs_attention", 20),
      ask("inv-old-working", "agent-1", "conv-a", "working", 10),
    ]);

    expect(fleetAskForSession(index, {
      id: "conv-a",
      agentId: "agent-1",
    })?.invocationId).toBe("inv-needs");
    expect(bestFleetAskForAgentIds(index, ["agent-1"])?.invocationId).toBe("inv-needs");
  });
});
