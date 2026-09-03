import { describe, expect, test } from "bun:test";

import type { Agent, SessionEntry } from "../../lib/types.ts";
import { buildAgentMasterModel } from "./agent-master-model.ts";

function agent(input: Partial<Agent> & { id: string; definitionId: string }): Agent {
  const { id, definitionId, ...overrides } = input;
  return {
    id,
    definitionId,
    name: overrides.name ?? id,
    project: overrides.project ?? "openscout",
    projectRoot: overrides.projectRoot ?? "/repo/openscout",
    authorityNodeId: overrides.authorityNodeId ?? "node-a",
    homeNodeId: overrides.homeNodeId ?? overrides.authorityNodeId ?? "node-a",
    conversationId: overrides.conversationId ?? null,
    ...overrides,
  } as Agent;
}

function session(input: Partial<SessionEntry> & { id: string; agentId: string }): SessionEntry {
  const { id, agentId, ...overrides } = input;
  return {
    id,
    kind: "direct",
    title: id,
    participantIds: [agentId, "operator"],
    agentId,
    agentName: agentId,
    harness: null,
    harnessSessionId: null,
    harnessLogPath: null,
    currentBranch: null,
    preview: null,
    messageCount: 0,
    lastMessageAt: null,
    workspaceRoot: null,
    ...overrides,
  };
}

describe("agent master identity model", () => {
  test("groups by definition, project, and machine instead of display name", () => {
    const agents = [
      agent({ id: "worker", definitionId: "worker", name: "Primary", conversationId: "conv-master" }),
      agent({ id: "worker.session", definitionId: "worker", name: "Different label", conversationId: "conv-thread" }),
      agent({ id: "other-definition", definitionId: "other", name: "Primary" }),
      agent({ id: "other-project", definitionId: "worker", project: "talkie" }),
      agent({ id: "other-machine", definitionId: "worker", authorityNodeId: "node-b" }),
    ];
    const sessions = agents.map((item) =>
      session({
        id: item.conversationId ?? `conv-${item.id}`,
        agentId: item.id,
        authorityNodeId: item.authorityNodeId,
      }),
    );

    const model = buildAgentMasterModel({
      agentId: "worker.session",
      agents: [...agents].reverse(),
      sessions: [...sessions].reverse(),
    });

    expect(model.memberAgentIds).toEqual(["worker", "worker.session"]);
    expect(model.sessions.map((item) => item.id).sort()).toEqual([
      "conv-master",
      "conv-thread",
    ]);
    expect(model.master?.id).toBe("conv-master");
    expect(model.agent?.id).toBe("worker");
  });

  test("keeps the canonical master stable across sibling routes and input order", () => {
    const agents = [
      agent({ id: "worker", definitionId: "worker", conversationId: "conv-master" }),
      agent({ id: "worker.z", definitionId: "worker", conversationId: "conv-z" }),
    ];
    const sessions = [
      session({ id: "conv-z", agentId: "worker.z", lastMessageAt: 200 }),
      session({ id: "conv-master", agentId: "worker", lastMessageAt: 100 }),
    ];

    const first = buildAgentMasterModel({
      agentId: "worker",
      agents,
      sessions,
    });
    const second = buildAgentMasterModel({
      agentId: "worker.z",
      agents: [...agents].reverse(),
      sessions: [...sessions].reverse(),
    });
    expect(first.master?.id).toBe("conv-master");
    expect(second.master?.id).toBe("conv-master");
  });

  test("falls back to the exact agent id when discovery has no definition", () => {
    const model = buildAgentMasterModel({
      agentId: "missing-agent",
      agents: [agent({ id: "same-name", definitionId: "other", name: "missing-agent" })],
      sessions: [
        session({ id: "conv-exact", agentId: "missing-agent" }),
        session({ id: "conv-name-match", agentId: "same-name" }),
      ],
    });

    expect(model.memberAgentIds).toEqual(["missing-agent"]);
    expect(model.sessions.map((item) => item.id)).toEqual(["conv-exact"]);
  });

  test("honors machine scope and rejects foreign thread ids", () => {
    const agents = [
      agent({ id: "worker", definitionId: "worker", conversationId: "conv-master" }),
      agent({ id: "worker.peer", definitionId: "worker", authorityNodeId: "node-b", conversationId: "conv-peer" }),
      agent({ id: "foreign", definitionId: "foreign", conversationId: "conv-foreign" }),
    ];
    const sessions = [
      session({ id: "conv-master", agentId: "worker", authorityNodeId: "node-a" }),
      session({ id: "conv-peer", agentId: "worker.peer", authorityNodeId: "node-b" }),
      session({ id: "conv-foreign", agentId: "foreign", authorityNodeId: "node-a" }),
    ];

    const foreignThread = buildAgentMasterModel({
      agentId: "worker",
      threadId: "conv-foreign",
      machineId: "node-a",
      agents,
      sessions,
    });
    expect(foreignThread.sessions.map((item) => item.id)).toEqual(["conv-master"]);
    expect(foreignThread.thread).toBeUndefined();

    const peerRoute = buildAgentMasterModel({
      agentId: "worker.peer",
      machineId: "node-b",
      agents,
      sessions,
    });
    expect(peerRoute.sessions.map((item) => item.id)).toEqual(["conv-peer"]);
  });
});
