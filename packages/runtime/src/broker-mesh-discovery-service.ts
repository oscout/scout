import type { AgentDefinition, NodeDefinition } from "@openscout/protocol";

import {
  discoverMeshNodes,
  type MeshDiscoveryOptions,
  type MeshDiscoveryResult,
} from "./mesh-discovery.js";
import { fetchPeerAgents } from "./mesh-forwarding.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

export type BrokerMeshDiscoveryRuntime = {
  snapshot(): RuntimeRegistrySnapshot;
  agent(agentId: string): AgentDefinition | undefined;
};

export type BrokerMeshDiscoveryServiceDeps = {
  nodeId: string;
  brokerUrl: string;
  defaultPort: number;
  meshId: string;
  seedUrls: string[];
  nodeLocalProductAgentIds: Set<string>;
  runtime: BrokerMeshDiscoveryRuntime;
  upsertNode: (node: NodeDefinition) => Promise<void>;
  upsertAgent: (agent: AgentDefinition) => Promise<void>;
  notifyPeerOnline: (nodeId: string) => void;
  discoverNodes?: (options: MeshDiscoveryOptions) => Promise<MeshDiscoveryResult>;
  fetchPeerAgents?: (brokerUrl: string) => Promise<AgentDefinition[]>;
  log?: (message: string) => void;
};

export function isNodeLocalProductAgentId(agentId: string, productAgentIds: Set<string>): boolean {
  return productAgentIds.has(agentId.trim().toLowerCase());
}

export function isLocalAgentAuthority(agent: AgentDefinition, localNodeId: string): boolean {
  return agent.homeNodeId === localNodeId || agent.authorityNodeId === localNodeId;
}

export function remotePeerAgentForNode(input: {
  agent: AgentDefinition;
  node: NodeDefinition;
  nodeId: string;
  existingAgent?: AgentDefinition;
  nodeLocalProductAgentIds: Set<string>;
}): AgentDefinition | null {
  if (input.agent.id === input.nodeId) return null;
  if (input.agent.homeNodeId === input.nodeId) return null;
  if (isNodeLocalProductAgentId(input.agent.id, input.nodeLocalProductAgentIds)) return null;
  if (input.existingAgent && isLocalAgentAuthority(input.existingAgent, input.nodeId)) return null;

  const agentHome = input.agent.homeNodeId || input.node.id;
  if (agentHome !== input.node.id) return null;

  return {
    ...input.agent,
    homeNodeId: agentHome,
    authorityNodeId: input.agent.authorityNodeId || input.node.id,
    advertiseScope: "mesh",
  };
}

export class BrokerMeshDiscoveryService {
  private readonly discoverNodes: (options: MeshDiscoveryOptions) => Promise<MeshDiscoveryResult>;
  private readonly fetchPeerAgents: (brokerUrl: string) => Promise<AgentDefinition[]>;

  constructor(private readonly deps: BrokerMeshDiscoveryServiceDeps) {
    this.discoverNodes = deps.discoverNodes ?? discoverMeshNodes;
    this.fetchPeerAgents = deps.fetchPeerAgents ?? fetchPeerAgents;
  }

  async discoverPeers(seeds: string[] = []): Promise<MeshDiscoveryResult> {
    const result = await this.discoverNodes({
      localNodeId: this.deps.nodeId,
      localBrokerUrl: this.deps.brokerUrl,
      defaultPort: this.deps.defaultPort,
      meshId: this.deps.meshId,
      seeds: [...this.deps.seedUrls, ...seeds],
    });

    for (const node of result.discovered) {
      await this.deps.upsertNode(node);
      // A previously-unreachable peer may have come back; flush deferred outbox
      // entries targeting it without waiting for the next backoff window.
      this.deps.notifyPeerOnline(node.id);
    }

    await this.syncPeerAgents(result.discovered);

    return {
      discovered: result.discovered,
      probes: result.probes,
    };
  }

  private async syncPeerAgents(discovered: NodeDefinition[]): Promise<void> {
    const peersToSync = new Map<string, NodeDefinition>();
    for (const node of discovered) peersToSync.set(node.id, node);
    for (const node of Object.values(this.deps.runtime.snapshot().nodes)) {
      if (node.id === this.deps.nodeId || !node.brokerUrl) continue;
      peersToSync.set(node.id, node);
    }

    for (const node of peersToSync.values()) {
      if (!node.brokerUrl) continue;
      try {
        const peerAgents = await this.fetchPeerAgents(node.brokerUrl);
        let syncedCount = 0;
        for (const agent of peerAgents) {
          const remoteAgent = remotePeerAgentForNode({
            agent,
            node,
            nodeId: this.deps.nodeId,
            existingAgent: this.deps.runtime.agent(agent.id),
            nodeLocalProductAgentIds: this.deps.nodeLocalProductAgentIds,
          });
          if (!remoteAgent) continue;

          await this.deps.upsertAgent(remoteAgent);
          syncedCount++;
        }
        if (syncedCount > 0) {
          this.deps.log?.(`[openscout-runtime] synced ${syncedCount} agent(s) from peer ${node.name || node.id}`);
        }
      } catch {
        // Best-effort: peer may be temporarily unreachable.
      }
    }
  }
}
