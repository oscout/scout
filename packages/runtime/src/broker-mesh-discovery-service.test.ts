import { describe, expect, test } from "bun:test";

import type { AgentDefinition, NodeDefinition } from "@openscout/protocol";

import { createRuntimeRegistrySnapshot, type RuntimeRegistrySnapshot } from "./registry.js";
import {
  BrokerMeshDiscoveryService,
  clearStaleMeshRegistrationMetadata,
  isInactiveAgentRegistration,
  isLocalAgentAuthority,
  isNodeLocalProductAgentId,
  OVERSIZED_PEER_SNAPSHOT_BACKOFF_MS,
  remotePeerAgentForNode,
  shouldSoftRetractImportedPeerAgent,
  staleMeshRegistrationMetadata,
} from "./broker-mesh-discovery-service.js";
import { PeerAgentSnapshotTooLargeError, type PeerAgentRoster } from "./mesh-forwarding.js";

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

function peerRoster(agents: AgentDefinition[], authoritative = true): PeerAgentRoster {
  return { authoritative, agents };
}

function createHarness(input: {
  snapshot?: RuntimeRegistrySnapshot;
  discovered?: NodeDefinition[];
  peerAgents?: Record<string, AgentDefinition[]>;
  peerRosters?: Record<string, PeerAgentRoster>;
  fetchFailures?: string[];
  fetchErrors?: Record<string, Error>;
  trustedNodeIds?: string[];
  now?: () => number;
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
    trustedPeerNodeIds: input.trustedNodeIds
      ? () => new Set(input.trustedNodeIds)
      : undefined,
    async discoverNodes(options) {
      discoverCalls.push({ seeds: options.seeds });
      return {
        discovered: input.discovered ?? [],
        probes: ["http://seed-a.test"],
      };
    },
    async fetchPeerAgents(brokerUrl) {
      fetchCalls.push(brokerUrl);
      const fetchError = input.fetchErrors?.[brokerUrl];
      if (fetchError) throw fetchError;
      if (input.fetchFailures?.includes(brokerUrl)) {
        throw new Error("offline");
      }
      return input.peerRosters?.[brokerUrl]
        ?? peerRoster(input.peerAgents?.[brokerUrl] ?? []);
    },
    log: (message) => logs.push(message),
    now: input.now,
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

  test("soft-retracts only active imported agents for one peer", () => {
    const imported = agent({ id: "agent-peer", homeNodeId: "node-peer", authorityNodeId: "node-peer" });
    expect(shouldSoftRetractImportedPeerAgent({
      agent: imported,
      peerNodeId: "node-peer",
      localNodeId: "node-local",
      nodeLocalProductAgentIds: new Set(["scoutbot"]),
    })).toBe(true);
    expect(shouldSoftRetractImportedPeerAgent({
      agent: agent({ id: "agent-other", homeNodeId: "node-other", authorityNodeId: "node-other" }),
      peerNodeId: "node-peer",
      localNodeId: "node-local",
      nodeLocalProductAgentIds: new Set(["scoutbot"]),
    })).toBe(false);
    expect(shouldSoftRetractImportedPeerAgent({
      agent: agent({ id: "agent-local", homeNodeId: "node-peer", authorityNodeId: "node-local" }),
      peerNodeId: "node-peer",
      localNodeId: "node-local",
      nodeLocalProductAgentIds: new Set(["scoutbot"]),
    })).toBe(false);
    expect(shouldSoftRetractImportedPeerAgent({
      agent: agent({ id: "scoutbot", homeNodeId: "node-peer", authorityNodeId: "node-peer" }),
      peerNodeId: "node-peer",
      localNodeId: "node-local",
      nodeLocalProductAgentIds: new Set(["scoutbot"]),
    })).toBe(false);
    expect(shouldSoftRetractImportedPeerAgent({
      agent: {
        ...imported,
        metadata: staleMeshRegistrationMetadata(imported.metadata, 10, "node-peer"),
      },
      peerNodeId: "node-peer",
      localNodeId: "node-local",
      nodeLocalProductAgentIds: new Set(["scoutbot"]),
    })).toBe(false);
    expect(isInactiveAgentRegistration({
      ...imported,
      metadata: { retiredFromFleet: true },
    })).toBe(true);
    expect(clearStaleMeshRegistrationMetadata(
      staleMeshRegistrationMetadata({ source: "mesh" }, 10, "node-peer"),
    )).toEqual({ source: "mesh" });
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

  test("coalesces overlapping discovery and peer-agent sync passes", async () => {
    const peerNode = node({ id: "node-peer", brokerUrl: "http://peer.test" });
    const snapshot = createRuntimeRegistrySnapshot();
    const discoverCalls: string[][] = [];
    const fetchCalls: string[] = [];
    const upsertedAgents: AgentDefinition[] = [];
    let releaseDiscovery: (() => void) | undefined;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const service = new BrokerMeshDiscoveryService({
      nodeId: "node-local",
      brokerUrl: "http://local.test",
      defaultPort: 3900,
      meshId: "openscout",
      seedUrls: [],
      nodeLocalProductAgentIds: new Set(),
      runtime: {
        snapshot: () => snapshot,
        agent: (agentId) => snapshot.agents[agentId],
      },
      async upsertNode(nextNode) {
        snapshot.nodes[nextNode.id] = nextNode;
      },
      async upsertAgent(nextAgent) {
        upsertedAgents.push(nextAgent);
        snapshot.agents[nextAgent.id] = nextAgent;
      },
      notifyPeerOnline() {},
      async discoverNodes(options) {
        discoverCalls.push(options.seeds);
        await discoveryGate;
        return { discovered: [peerNode], probes: [] };
      },
      async fetchPeerAgents(brokerUrl) {
        fetchCalls.push(brokerUrl);
        return peerRoster([agent({ id: "agent-peer" })]);
      },
    });

    const first = service.discoverPeers();
    const second = service.discoverPeers();
    expect(discoverCalls).toEqual([[]]);

    releaseDiscovery?.();
    await Promise.all([first, second]);

    expect(fetchCalls).toEqual(["http://peer.test"]);
    expect(upsertedAgents.map((nextAgent) => nextAgent.id)).toEqual(["agent-peer"]);
  });

  test("keeps unenrolled nodes discoverable without requesting their protected agent snapshots", async () => {
    const trusted = node({ id: "node-trusted", brokerUrl: "http://trusted.test" });
    const untrusted = node({ id: "node-untrusted", brokerUrl: "http://untrusted.test" });
    const duplicateTrustedUrl = node({ id: "node-trusted-alias", brokerUrl: "http://trusted.test/" });
    const harness = createHarness({
      discovered: [trusted, untrusted, duplicateTrustedUrl],
      trustedNodeIds: [trusted.id, duplicateTrustedUrl.id],
      peerAgents: {
        "http://trusted.test": [agent({
          id: "agent-trusted",
          homeNodeId: trusted.id,
          authorityNodeId: trusted.id,
        })],
      },
    });

    await harness.service.discoverPeers();

    expect(harness.upsertedNodes).toEqual([trusted, untrusted, duplicateTrustedUrl]);
    expect(harness.notifiedPeers).toEqual([trusted.id, untrusted.id, duplicateTrustedUrl.id]);
    expect(harness.fetchCalls).toEqual(["http://trusted.test"]);
    expect(harness.upsertedAgents.map((entry) => entry.id)).toEqual(["agent-trusted"]);
  });

  test("does not upsert an unchanged peer agent on later discovery passes", async () => {
    const peerNode = node({ id: "node-peer", brokerUrl: "http://peer.test" });
    const snapshot = createRuntimeRegistrySnapshot();
    const upsertedAgents: AgentDefinition[] = [];
    const service = new BrokerMeshDiscoveryService({
      nodeId: "node-local",
      brokerUrl: "http://local.test",
      defaultPort: 3900,
      meshId: "openscout",
      seedUrls: [],
      nodeLocalProductAgentIds: new Set(),
      runtime: {
        snapshot: () => snapshot,
        agent: (agentId) => snapshot.agents[agentId],
      },
      async upsertNode(nextNode) {
        snapshot.nodes[nextNode.id] = nextNode;
      },
      async upsertAgent(nextAgent) {
        upsertedAgents.push(nextAgent);
        snapshot.agents[nextAgent.id] = nextAgent;
      },
      notifyPeerOnline() {},
      async discoverNodes() {
        return { discovered: [peerNode], probes: [] };
      },
      async fetchPeerAgents() {
        return peerRoster([agent({ id: "agent-peer" })]);
      },
    });

    await service.discoverPeers();
    await service.discoverPeers();

    expect(upsertedAgents.map((nextAgent) => nextAgent.id)).toEqual(["agent-peer"]);
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
    await expect(harness.service.discoverPeers()).resolves.toEqual({
      discovered: [peerNode],
      probes: ["http://seed-a.test"],
    });
    expect(harness.fetchCalls).toEqual(["http://peer.test", "http://peer.test"]);
    expect(harness.upsertedNodes).toEqual([peerNode, peerNode]);
    expect(harness.upsertedAgents).toEqual([]);
  });

  test("backs off only oversized peer snapshots for fifteen minutes", async () => {
    let now = 1_000;
    const oversizedNode = node({ id: "node-oversized", name: "Legacy", brokerUrl: "http://oversized.test" });
    const compliantNode = node({ id: "node-compliant", name: "Current", brokerUrl: "http://compliant.test" });
    const harness = createHarness({
      discovered: [oversizedNode, compliantNode],
      fetchErrors: {
        "http://oversized.test": new PeerAgentSnapshotTooLargeError(
          "http://oversized.test",
          3 * 1024 * 1024,
        ),
      },
      peerAgents: {
        "http://compliant.test": [],
      },
      now: () => now,
    });

    expect(OVERSIZED_PEER_SNAPSHOT_BACKOFF_MS).toBe(15 * 60 * 1_000);
    await harness.service.discoverPeers();
    now += 60_000;
    await harness.service.discoverPeers();
    now = 1_000 + OVERSIZED_PEER_SNAPSHOT_BACKOFF_MS - 1;
    await harness.service.discoverPeers();

    expect(harness.fetchCalls).toEqual([
      "http://oversized.test",
      "http://compliant.test",
      "http://compliant.test",
      "http://compliant.test",
    ]);

    now += 1;
    await harness.service.discoverPeers();
    expect(harness.fetchCalls.slice(-2)).toEqual([
      "http://oversized.test",
      "http://compliant.test",
    ]);
    expect(harness.logs).toHaveLength(2);
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

  test("authoritative empty roster soft-retracts previously imported active peer agents", async () => {
    const peerNode = node({ id: "node-peer", brokerUrl: "http://peer.test" });
    const imported = agent({
      id: "agent-peer",
      homeNodeId: "node-peer",
      authorityNodeId: "node-peer",
    });
    const localAuthority = agent({
      id: "agent-local-authority",
      homeNodeId: "node-peer",
      authorityNodeId: "node-local",
    });
    const otherNode = agent({
      id: "agent-other",
      homeNodeId: "node-other",
      authorityNodeId: "node-other",
    });
    const product = agent({
      id: "scoutbot",
      homeNodeId: "node-peer",
      authorityNodeId: "node-peer",
    });
    const alreadyInactive = agent({
      id: "agent-inactive",
      homeNodeId: "node-peer",
      authorityNodeId: "node-peer",
      metadata: { staleLocalRegistration: true, staleAt: 1 },
    });
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        agents: {
          [imported.id]: imported,
          [localAuthority.id]: localAuthority,
          [otherNode.id]: otherNode,
          [product.id]: product,
          [alreadyInactive.id]: alreadyInactive,
        },
      }),
      discovered: [peerNode],
      peerAgents: {
        "http://peer.test": [],
      },
      now: () => 50_000,
    });

    await harness.service.discoverPeers();

    expect(harness.upsertedAgents).toEqual([
      expect.objectContaining({
        id: "agent-peer",
        homeNodeId: "node-peer",
        metadata: expect.objectContaining({
          staleLocalRegistration: true,
          staleMeshRegistration: true,
          staleAt: 50_000,
          staleFromPeerNodeId: "node-peer",
        }),
      }),
    ]);
    expect(harness.snapshot.agents["agent-local-authority"]).toEqual(localAuthority);
    expect(harness.snapshot.agents["agent-other"]).toEqual(otherNode);
    expect(harness.snapshot.agents.scoutbot).toEqual(product);
    expect(harness.snapshot.agents["agent-inactive"]).toEqual(alreadyInactive);
    expect(harness.logs).toEqual([
      "[openscout-runtime] retracted 1 stale agent(s) from peer Peer",
    ]);
  });

  test("reappearance on an authoritative roster clears mesh stale metadata", async () => {
    const peerNode = node({ id: "node-peer", brokerUrl: "http://peer.test" });
    const live = agent({
      id: "agent-peer",
      homeNodeId: "node-peer",
      authorityNodeId: "node-peer",
    });
    const stale = {
      ...live,
      metadata: staleMeshRegistrationMetadata(live.metadata, 10, "node-peer"),
    };
    const harness = createHarness({
      snapshot: createRuntimeRegistrySnapshot({
        agents: { [stale.id]: stale },
      }),
      discovered: [peerNode],
      peerAgents: {
        "http://peer.test": [live],
      },
    });

    await harness.service.discoverPeers();

    expect(harness.upsertedAgents).toEqual([
      expect.objectContaining({
        id: "agent-peer",
        metadata: {},
      }),
    ]);
    expect(harness.snapshot.agents["agent-peer"]?.metadata?.staleMeshRegistration).toBeUndefined();
    expect(harness.snapshot.agents["agent-peer"]?.metadata?.staleLocalRegistration).toBeUndefined();
  });

  test("non-authoritative, failed, and oversized fetches never retract imported agents", async () => {
    const imported = agent({
      id: "agent-peer",
      homeNodeId: "node-peer",
      authorityNodeId: "node-peer",
    });
    const cases = [
      {
        discovered: [node({ id: "node-peer", brokerUrl: "http://missing.test" })],
        peerRosters: {
          "http://missing.test": peerRoster([], false),
        },
      },
      {
        discovered: [node({ id: "node-peer", brokerUrl: "http://offline.test" })],
        fetchFailures: ["http://offline.test"],
      },
      {
        discovered: [node({ id: "node-peer", brokerUrl: "http://oversized.test" })],
        fetchErrors: {
          "http://oversized.test": new PeerAgentSnapshotTooLargeError(
            "http://oversized.test",
            3 * 1024 * 1024,
          ),
        },
      },
    ] as const;

    for (const testCase of cases) {
      const harness = createHarness({
        snapshot: createRuntimeRegistrySnapshot({
          agents: { [imported.id]: imported },
        }),
        ...testCase,
      });
      await harness.service.discoverPeers();
      expect(harness.upsertedAgents).toEqual([]);
      expect(harness.snapshot.agents["agent-peer"]).toEqual(imported);
    }
  });
});
