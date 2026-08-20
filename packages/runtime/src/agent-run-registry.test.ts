import { describe, expect, test } from "bun:test";

import { createInMemoryControlRuntime } from "./broker.js";
import { projectAgentRunsFromRuntimeSnapshot } from "./agent-run-registry.js";

describe("agent run registry projection", () => {
  test("projects runs from runtime snapshot invocations and flights", async () => {
    const runtime = createInMemoryControlRuntime();

    await runtime.upsertNode({
      id: "node-1",
      meshId: "mesh-1",
      name: "Node 1",
      advertiseScope: "local",
      registeredAt: 1,
    });
    await runtime.upsertActor({
      id: "operator",
      kind: "person",
      displayName: "Operator",
    });
    await runtime.upsertActor({
      id: "agent-1",
      kind: "agent",
      displayName: "Agent One",
    });
    await runtime.upsertAgent({
      id: "agent-1",
      kind: "agent",
      definitionId: "agent-1",
      displayName: "Agent One",
      agentClass: "operator",
      capabilities: [],
      wakePolicy: "on_demand",
      homeNodeId: "node-1",
      authorityNodeId: "node-1",
      advertiseScope: "local",
    });

    const flight = await runtime.invokeAgent({
      id: "inv-1",
      requesterId: "operator",
      requesterNodeId: "node-1",
      targetAgentId: "agent-1",
      action: "execute",
      task: "Implement the runtime slice.",
      collaborationRecordId: "work-1",
      context: {
        issueRunner: {
          bindingKey: "issue-binding:profile:github::24",
        },
      },
      execution: {
        permissionProfile: "workspace_write",
      },
      ensureAwake: false,
      stream: false,
      createdAt: 100,
      metadata: {
        source: "external_issue",
        workId: "work-1",
      },
    });
    await runtime.upsertFlight({
      ...flight,
      state: "completed",
      output: "Done",
      completedAt: 200,
    });

    const runs = projectAgentRunsFromRuntimeSnapshot(runtime.snapshot());

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: `run:flight:${flight.id}`,
      source: "external_issue",
      state: "completed",
      requesterId: "operator",
      agentId: "agent-1",
      workId: "work-1",
      collaborationRecordId: "work-1",
      invocationId: "inv-1",
      flightIds: [flight.id],
      permissionProfile: "workspace_write",
      output: {
        text: "Done",
      },
    });
  });
});
