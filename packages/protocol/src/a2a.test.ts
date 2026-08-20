import { describe, expect, test } from "bun:test";

import {
  a2aAgentCardFromScoutCard,
  a2aTaskFromFlight,
  a2aTextFromMessage,
  type FlightRecord,
  type InvocationRequest,
  type ScoutAgentCard,
} from "./index";

describe("A2A protocol mapping", () => {
  test("maps Scout flights to A2A tasks with text artifacts", () => {
    const invocation: InvocationRequest = {
      id: "inv-a2a-1",
      requesterId: "operator",
      requesterNodeId: "node.local",
      targetAgentId: "agent.local",
      action: "consult",
      task: "Summarize this.",
      conversationId: "ctx-a2a",
      ensureAwake: true,
      stream: false,
      createdAt: 1,
    };
    const flight: FlightRecord = {
      id: "flt-a2a-1",
      invocationId: invocation.id,
      requesterId: invocation.requesterId,
      targetAgentId: invocation.targetAgentId,
      state: "completed",
      output: "Done.",
      startedAt: 2,
      completedAt: 3,
    };

    const task = a2aTaskFromFlight(flight, invocation, { includeHistory: true });

    expect(task).toMatchObject({
      id: "flt-a2a-1",
      contextId: "ctx-a2a",
      status: {
        state: "TASK_STATE_COMPLETED",
      },
      artifacts: [
        {
          artifactId: "flt-a2a-1:output",
          parts: [{ text: "Done." }],
        },
      ],
    });
    expect(task.history?.map((message) => message.role)).toEqual(["ROLE_USER", "ROLE_AGENT"]);
  });

  test("projects Scout cards as A2A v1 agent cards", () => {
    const card: ScoutAgentCard = {
      id: "agent.local",
      agentId: "agent.local",
      definitionId: "agent",
      displayName: "Agent Local",
      description: "A local test agent.",
      provider: { organization: "OpenScout" },
      skills: [{ id: "review", name: "Review", description: "Review code." }],
      handle: "agent",
      projectRoot: "/tmp/agent",
      currentDirectory: "/tmp/agent",
      harness: "http",
      transport: "http",
      createdAt: 1,
      brokerRegistered: true,
      returnAddress: {
        actorId: "agent.local",
        handle: "agent",
      },
    };

    const a2aCard = a2aAgentCardFromScoutCard(card, {
      url: "http://127.0.0.1:38001/v1/a2a/agents/agent.local/rpc",
    });

    expect(a2aCard.protocolVersion).toBe("1.0");
    expect(a2aCard.supportedInterfaces?.[0]).toMatchObject({
      protocolBinding: "JSONRPC",
      tenant: "agent.local",
    });
    expect(a2aCard.skills[0]?.id).toBe("review");
    expect(a2aTextFromMessage({ parts: [{ text: "hello" }] })).toBe("hello");
  });
});
