import { describe, expect, test } from "bun:test";

import type {
  AgentDefinition,
  AgentEndpoint,
  NodeDefinition,
  ScoutDispatchUnavailableTarget,
} from "@openscout/protocol";

import { BrokerUnavailableTargetService } from "./broker-unavailable-target-service.js";
import { createRuntimeRegistrySnapshot } from "./registry.js";

function agent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-one",
    selector: "@agent-one",
    defaultSelector: "@agent-one",
    labels: [],
    metadata: {},
    agentClass: "general",
    capabilities: ["chat", "invoke", "deliver"],
    wakePolicy: "manual",
    homeNodeId: "node-local",
    authorityNodeId: "node-local",
    advertiseScope: "local",
    ...input,
  };
}

function endpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint-1",
    agentId: "agent-1",
    nodeId: "node-local",
    harness: "codex",
    transport: "tmux",
    state: "offline",
    sessionId: "session-1",
    projectRoot: "/repo",
    metadata: {},
    ...input,
  };
}

function node(input: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: "node-peer",
    meshId: "openscout",
    name: "Peer",
    hostName: "peer.local",
    advertiseScope: "mesh",
    brokerUrl: "http://peer.local:41411",
    capabilities: ["broker"],
    registeredAt: 1_000,
    lastSeenAt: 2_000,
    ...input,
  };
}

function createService(input: {
  remoteIssue?: ScoutDispatchUnavailableTarget | null;
  now?: number;
} = {}) {
  const remoteCalls: Array<{
    agent: AgentDefinition;
    authorityNode: NodeDefinition | undefined;
  }> = [];
  const service = new BrokerUnavailableTargetService({
    nodeId: "node-local",
    describeRemoteAuthorityIssue: (targetAgent, authorityNode) => {
      remoteCalls.push({ agent: targetAgent, authorityNode });
      return input.remoteIssue ?? null;
    },
    now: () => input.now ?? 10_000,
  });
  return { service, remoteCalls };
}

describe("broker unavailable target service", () => {
  test("reports superseded local session references as not attachable", () => {
    const target = agent();
    const staleEndpoint = endpoint({
      state: "idle",
      metadata: {
        staleLocalRegistration: true,
        replacedByAgentId: "agent-new",
      },
    });
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { [target.id]: target },
      endpoints: { [staleEndpoint.id]: staleEndpoint },
    });
    const { service } = createService();

    const issue = service.describe(snapshot, target, "session-old");

    expect(issue).toEqual(expect.objectContaining({
      agentId: "agent-1",
      reason: "session_reference_not_attachable",
      endpointState: "online",
      transport: "tmux",
      projectRoot: "/repo",
    }));
    expect(issue?.detail).toContain("superseded local registration");
    expect(issue?.detail).toContain("agent-new");
  });

  test("reports retired agents and manual-wake offline agents", () => {
    const retired = agent({
      id: "retired",
      displayName: "Retired Agent",
      metadata: { retiredFromFleet: true },
    });
    const manual = agent({ id: "manual", displayName: "Manual Agent" });
    const manualEndpoint = endpoint({
      id: "manual-endpoint",
      agentId: "manual",
      state: "offline",
      projectRoot: "/manual",
    });
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        retired,
        manual,
      },
      endpoints: {
        [manualEndpoint.id]: manualEndpoint,
      },
    });
    const { service } = createService();

    expect(service.describe(snapshot, retired)).toEqual(expect.objectContaining({
      agentId: "retired",
      reason: "retired",
      endpointState: "unknown",
    }));
    expect(service.describe(snapshot, manual)).toEqual(expect.objectContaining({
      agentId: "manual",
      reason: "manual_wake_required",
      endpointState: "offline",
      projectRoot: "/manual",
    }));
  });

  test("does not report manual-wake issues for online or direct managed sessions", () => {
    const online = agent({ id: "online" });
    const managed = agent({ id: "managed" });
    const snapshot = createRuntimeRegistrySnapshot({
      agents: {
        online,
        managed,
      },
      endpoints: {
        online: endpoint({
          id: "online",
          agentId: "online",
          state: "waiting",
        }),
        managed: endpoint({
          id: "managed",
          agentId: "managed",
          transport: "codex_app_server",
          state: "offline",
          metadata: {
            source: "local-session",
            managedByScout: true,
          },
        }),
      },
    });
    const { service } = createService();

    expect(service.describe(snapshot, online)).toBeNull();
    expect(service.describe(snapshot, managed)).toBeNull();
  });

  test("delegates remote authority issues and builds unavailable envelopes", () => {
    const remote = agent({
      id: "remote",
      displayName: "Remote Agent",
      authorityNodeId: "node-peer",
    });
    const remoteIssue: ScoutDispatchUnavailableTarget = {
      agentId: "remote",
      displayName: "Remote Agent",
      reason: "unknown",
      detail: "peer unavailable",
      wakePolicy: "manual",
      endpointState: "unknown",
      transport: null,
      projectRoot: null,
    };
    const snapshot = createRuntimeRegistrySnapshot({
      agents: { remote },
      nodes: { "node-peer": node() },
    });
    const { service, remoteCalls } = createService({ remoteIssue, now: 12_345 });

    expect(service.describe(snapshot, remote)).toBe(remoteIssue);
    expect(remoteCalls).toEqual([{ agent: remote, authorityNode: snapshot.nodes["node-peer"] }]);
    expect(service.buildEnvelope("@remote", remoteIssue)).toEqual({
      kind: "unavailable",
      askedLabel: "@remote",
      detail: "peer unavailable",
      candidates: [],
      target: remoteIssue,
      dispatchedAt: 12_345,
      dispatcherNodeId: "node-local",
    });
  });
});
