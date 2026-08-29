import { describe, expect, test } from "bun:test";

import type { AgentDefinition, NodeDefinition } from "@openscout/protocol";

import { createRuntimeRegistrySnapshot, type RuntimeRegistrySnapshot } from "./registry.js";
import {
  BrokerMeshDiscoveryService,
  isLocalAgentAuthority,
  isNodeLocalProductAgentId,
  remotePeerAgentForNode,
} from "./broker-mesh-discovery-service.js";

function node(input: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: "node-peer",
    meshId: "openscout",
    name: "Peer",
    advertiseScope: "mesh",
    brokerUrl: "http://peer.test",
    capabilities: ["broker"],
    registeredAt: Date.now(),
    lastSeenAt: Date.now(),
    ...input,
  };
}

function agent(input: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "agent-1",
    kind: "agent",
    definitionId: "agent-1",
    displayName: "Agent One",
    handle: "agent-1",
    selector: "@agent-1",
    defaultSelector: "@agent-1",
    labels: [],
    metadata: {},
    agentClass: "general",
    capabilities: ["chat"],
    wakePolicy: "manual",
    homeNodeId: "node-peer",
    authorityNodeId: "node-peer",
    advertiseScope: "mesh",
    ...input,
  };
}

function createHarness(input: {
  snapshot?: RuntimeRegistrySnapshot;
  discovered?: NodeDefinition[];
  peerAgents?: Record<string, AgentDefinition[]>;
  fetchFailures?: string[];
} = {}) {
  const snapshot = input.snapshot ?? createRuntimeRegistrySnapshot();
  const upsertedNodes: NodeDefinition[] = [];
  const upsertedAgents: AgentDefinition[] = [];
  const notifiedPeers: string[] = [];
  const logs: string[] = [];
  const discoverCalls: Array<{ seeds?: string[] }> = [];
  const fetchCalls: string[] = [];
  const service = new BrokerMeshDiscoveryService({
    nodeId: "node-local",
    brokerUrl: "http://local.test",
    defaultPort: 3900,
    meshId: "openscout",
    seedUrls: ["http://seed-a.test"],
    nodeLocalProductAgentIds: new Set(["scoutbot", "scout.dispatcher"]),
    runtime: {
      snapshot: () => snapshot,
      agent: (agentId) => snapshot.agents[agentId],
    },
    async upsertNode(nextNode) {
      upsertedNodes.push(nextNode);
      snapshot.nodes[nextNode.id] = nextNode;
    },
    async upsertAgent(nextAgent) {
      upsertedAgents.push(nextAgent);
      snapshot.agents[nextAgent.id] = nextAgent;
    },
    notifyPeerOnline: (nodeId) => {
      notifiedPeers.push(nodeId);
    },
    async discoverNodes(options) {
      discoverCalls.push({ seeds: options.seeds });
      return {
        discovered: input.discovered ?? [],
        probes: ["http://seed-a.test"],
      };
    },
    async fetchPeerAgents(brokerUrl) {
      fetchCalls.push(brokerUrl);
      if (input.fetchFailures?.includes(brokerUrl)) {
        throw new Error("offline");
      }
      return input.peerAgents?.[brokerUrl] ?? [];
    },
    log: (message) => logs.push(message),
  });

  return {
    discoverCalls,
    fetchCalls,
    logs,
    notifiedPeers,
    service,
    snapshot,
    upsertedAgents,
    upsertedNodes,
  };
}

describe("broker mesh discovery helpers", () => {
  test("classifies product and local-authority agents", () => {
    expect(isNodeLocalProductAgentId(" ScoutBot ", new Set(["scoutbot"]))).toBe(true);
    expect(isNodeLocalProductAgentId("agent-1", new Set(["scoutbot"]))).toBe(false);
    expect(isLocalAgentAuthority(agent({ homeNodeId: "node-local" }), "node-local")).toBe(true);
    expect(isLocalAgentAuthority(agent({ authorityNodeId: "node-local" }), "node-local")).toBe(true);
    expect(isLocalAgentAuthority(agent({ homeNodeId: "node-peer", authorityNodeId: "node-peer" }), "node-local")).toBe(false);
  });

  test("normalizes peer agents conservatively for a discovered node", () => {
    const peerNode = node({ id: "node-peer" });
    expect(remotePeerAgentForNode({
      agent: agent({ id: "agent-1", homeNodeId: "", authorityNodeId: "" }),
      node: peerNode,
      nodeId: "node-local",
      nodeLocalProductAgentIds: new Set(),
    })).toEqual(expect.objectContaining({
      id: "agent-1",
      homeNodeId: "node-peer",
      authorityNodeId: "node-peer",
      advertiseScope: "mesh",
    }));
    expect(remotePeerAgentForNode({
      agent: agent({ id: "agent-local", homeNodeId: "node-local" }),
      node: peerNode,
      nodeId: "node-local",
      nodeLocalProductAgentIds: new Set(),
    })).toBeNull();
    expect(remotePeerAgentForNode({
      agent: agent({ id: "scoutbot" }),
      node: peerNode,
      nodeId: "node-local",
      nodeLocalProductAgentIds: new Set(["scoutbot"]),
    })).toBeNull();
    expect(remotePeerAgentForNode({
      agent: agent({ id: "agent-1", homeNodeId: "other-node" }),
      node: peerNode,
      nodeId: "node-local",
      nodeLocalProductAgentIds: new Set(),
    })).toBeNull();
  });

  test("discovers peers, notifies the outbox, and syncs eligible peer agents", async () => {
    const peerNode = node({ id: "node-peer", brokerUrl: "http://peer.test" });
    const existingNode = node({ id: "node-existing", brokerUrl: "http://existing.test" });
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        nodes: {
          "node-local": node({ id: "node-local", brokerUrl: "http://local.test" }),
          [existingNode.id]: existingNode,
        },
      }),
      discovered: [peerNode],
      peerAgents: {
        "http://peer.test": [
          agent({ id: "agent-peer", homeNodeId: "node-peer", authorityNodeId: "" }),
          agent({ id: "scoutbot", homeNodeId: "node-peer", authorityNodeId: "node-peer" }),
          agent({ id: "agent-local-home", homeNodeId: "node-local", authorityNodeId: "node-local" }),
          agent({ id: "agent-other-home", homeNodeId: "node-other", authorityNodeId: "node-other" }),
        ],
        "http://existing.test": [
          agent({ id: "agent-existing", homeNodeId: "node-existing", authorityNodeId: "node-existing" }),
        ],
      },
    });

    await expect(harness.service.discoverPeers(["http://manual.test"])).resolves.toEqual({
      discovered: [peerNode],
      probes: ["http://seed-a.test"],
    });

    expect(harness.discoverCalls).toEqual([{ seeds: ["http://seed-a.test", "http://manual.test"] }]);
    expect(harness.upsertedNodes).toEqual([peerNode]);
    expect(harness.notifiedPeers).toEqual(["node-peer"]);
    expect(harness.fetchCalls).toEqual(["http://peer.test", "http://existing.test"]);
    expect(harness.upsertedAgents.map((nextAgent) => nextAgent.id)).toEqual([
      "agent-peer",
      "agent-existing",
    ]);
    expect(harness.upsertedAgents[0]).toEqual(expect.objectContaining({
      id: "agent-peer",
      homeNodeId: "node-peer",
      authorityNodeId: "node-peer",
    }));
    expect(harness.logs).toEqual([
      "[openscout-runtime] synced 1 agent(s) from peer Peer",
      "[openscout-runtime] synced 1 agent(s) from peer Peer",
    ]);
  });

  test("does not let unreachable peer-agent fetches fail discovery", async () => {
    const peerNode = node({ id: "node-peer", brokerUrl: "http://peer.test" });
    const harness = createHarness({
      discovered: [peerNode],
      fetchFailures: ["http://peer.test"],
    });

    await expect(harness.service.discoverPeers()).resolves.toEqual({
      discovered: [peerNode],
      probes: ["http://seed-a.test"],
    });
    expect(harness.upsertedNodes).toEqual([peerNode]);
    expect(harness.upsertedAgents).toEqual([]);
  });

  test("skips stale snapshot peers when syncing agents", async () => {
    const peerNode = node({ id: "node-peer", brokerUrl: "http://peer.test" });
    const staleNode = node({
      id: "node-stale",
      brokerUrl: "http://stale.test",
      lastSeenAt: 1,
      registeredAt: 1,
    });
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        nodes: {
          "node-local": node({ id: "node-local", brokerUrl: "http://local.test" }),
          [staleNode.id]: staleNode,
        },
      }),
      discovered: [peerNode],
      peerAgents: {
        "http://peer.test": [
          agent({ id: "agent-peer", homeNodeId: "node-peer", authorityNodeId: "node-peer" }),
        ],
        "http://stale.test": [
          agent({ id: "agent-stale", homeNodeId: "node-stale", authorityNodeId: "node-stale" }),
        ],
      },
    });

    await harness.service.discoverPeers();

    expect(harness.fetchCalls).toEqual(["http://peer.test"]);
    expect(harness.upsertedAgents.map((nextAgent) => nextAgent.id)).toEqual(["agent-peer"]);
  });
});
