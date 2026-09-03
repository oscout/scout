import type { AgentDefinition, NodeDefinition } from "@openscout/protocol";
import { isDeepStrictEqual } from "node:util";

import {
  discoverMeshNodes,
  type MeshDiscoveryOptions,
  type MeshDiscoveryResult,
} from "./mesh-discovery.js";
import {
  fetchPeerAgents,
  PeerAgentSnapshotTooLargeError,
  type PeerAgentRoster,
} from "./mesh-forwarding.js";
import { collectCurrentMeshPeerNodes } from "./mesh-peer-filter.js";
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
  /** Unenrolled nodes remain discoverable for pairing, but expose no agent snapshot. */
  trustedPeerNodeIds?: () => ReadonlySet<string>;
  discoverNodes?: (options: MeshDiscoveryOptions) => Promise<MeshDiscoveryResult>;
  fetchPeerAgents?: (brokerUrl: string) => Promise<PeerAgentRoster>;
  log?: (message: string) => void;
  now?: () => number;
};

export const OVERSIZED_PEER_SNAPSHOT_BACKOFF_MS = 15 * 60 * 1_000;

export function isNodeLocalProductAgentId(agentId: string, productAgentIds: Set<string>): boolean {
  return productAgentIds.has(agentId.trim().toLowerCase());
}

export function isLocalAgentAuthority(agent: AgentDefinition, localNodeId: string): boolean {
  return agent.homeNodeId === localNodeId || agent.authorityNodeId === localNodeId;
}

function metadataFlag(metadata: AgentDefinition["metadata"], key: string): boolean {
  return metadata?.[key] === true;
}

export function isInactiveAgentRegistration(agent: AgentDefinition): boolean {
  return metadataFlag(agent.metadata, "staleLocalRegistration")
    || metadataFlag(agent.metadata, "staleMeshRegistration")
    || metadataFlag(agent.metadata, "retiredFromFleet");
}

export function staleMeshRegistrationMetadata(
  metadata: AgentDefinition["metadata"],
  staleAt: number,
  peerNodeId: string,
): NonNullable<AgentDefinition["metadata"]> {
  return {
    ...(metadata ?? {}),
    staleLocalRegistration: true,
    staleMeshRegistration: true,
    staleAt,
    staleFromPeerNodeId: peerNodeId,
  };
}

export function clearStaleMeshRegistrationMetadata(
  metadata: AgentDefinition["metadata"],
): AgentDefinition["metadata"] {
  if (!metadata) return metadata;
  const {
    staleLocalRegistration,
    staleMeshRegistration,
    staleAt,
    staleFromPeerNodeId,
    ...rest
  } = metadata;
  void staleLocalRegistration;
  void staleMeshRegistration;
  void staleAt;
  void staleFromPeerNodeId;
  return rest;
}

export function shouldSoftRetractImportedPeerAgent(input: {
  agent: AgentDefinition;
  peerNodeId: string;
  localNodeId: string;
  nodeLocalProductAgentIds: Set<string>;
}): boolean {
  if (input.agent.homeNodeId !== input.peerNodeId) return false;
  if (input.agent.id === input.localNodeId) return false;
  if (isLocalAgentAuthority(input.agent, input.localNodeId)) return false;
  if (isNodeLocalProductAgentId(input.agent.id, input.nodeLocalProductAgentIds)) return false;
  if (isInactiveAgentRegistration(input.agent)) return false;
  return true;
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
  private readonly fetchPeerAgents: (brokerUrl: string) => Promise<PeerAgentRoster>;
  private readonly oversizedPeerSnapshotBackoffUntil = new Map<string, number>();
  private discoveryInFlight: Promise<MeshDiscoveryResult> | null = null;

  constructor(private readonly deps: BrokerMeshDiscoveryServiceDeps) {
    this.discoverNodes = deps.discoverNodes ?? discoverMeshNodes;
    this.fetchPeerAgents = deps.fetchPeerAgents ?? fetchPeerAgents;
  }

  discoverPeers(seeds: string[] = []): Promise<MeshDiscoveryResult> {
    if (this.discoveryInFlight) {
      if (seeds.length === 0) {
        return this.discoveryInFlight;
      }
      const current = this.discoveryInFlight;
      return current.then(
        () => this.discoverPeers(seeds),
        () => this.discoverPeers(seeds),
      );
    }

    const request = this.runDiscovery(seeds);
    this.discoveryInFlight = request;
    void request.finally(() => {
      if (this.discoveryInFlight === request) {
        this.discoveryInFlight = null;
      }
    }).catch(() => {});
    return request;
  }

  private async runDiscovery(seeds: string[]): Promise<MeshDiscoveryResult> {
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
    for (const node of collectCurrentMeshPeerNodes({
      nodes: this.deps.runtime.snapshot().nodes,
      localNodeId: this.deps.nodeId,
      meshId: this.deps.meshId,
    })) {
      peersToSync.set(node.id, node);
    }

    const trustedPeerNodeIds = this.deps.trustedPeerNodeIds?.();
    const syncedBrokerUrls = new Set<string>();
    const now = this.deps.now?.() ?? Date.now();
    for (const [brokerUrl, retryAt] of this.oversizedPeerSnapshotBackoffUntil) {
      if (retryAt <= now) this.oversizedPeerSnapshotBackoffUntil.delete(brokerUrl);
    }
    for (const node of peersToSync.values()) {
      if (!node.brokerUrl || (trustedPeerNodeIds && !trustedPeerNodeIds.has(node.id))) continue;
      const normalizedBrokerUrl = node.brokerUrl.replace(/\/$/u, "");
      if (syncedBrokerUrls.has(normalizedBrokerUrl)) continue;
      syncedBrokerUrls.add(normalizedBrokerUrl);
      if ((this.oversizedPeerSnapshotBackoffUntil.get(normalizedBrokerUrl) ?? 0) > now) continue;
      try {
        const roster = await this.fetchPeerAgents(normalizedBrokerUrl);
        this.oversizedPeerSnapshotBackoffUntil.delete(normalizedBrokerUrl);
        const presentIds = new Set<string>();
        let syncedCount = 0;
        for (const agent of roster.agents) {
          presentIds.add(agent.id);
          const existingAgent = this.deps.runtime.agent(agent.id);
          const remoteAgent = remotePeerAgentForNode({
            agent,
            node,
            nodeId: this.deps.nodeId,
            existingAgent,
            nodeLocalProductAgentIds: this.deps.nodeLocalProductAgentIds,
          });
          if (!remoteAgent) continue;
          const nextAgent = {
            ...remoteAgent,
            metadata: clearStaleMeshRegistrationMetadata(remoteAgent.metadata),
          };
          if (existingAgent && isDeepStrictEqual(existingAgent, nextAgent)) continue;

          await this.deps.upsertAgent(nextAgent);
          syncedCount++;
        }
        if (syncedCount > 0) {
          this.deps.log?.(`[openscout-runtime] synced ${syncedCount} agent(s) from peer ${node.name || node.id}`);
        }
        if (roster.authoritative) {
          await this.retractMissingPeerAgents(node, presentIds);
        }
      } catch (error) {
        if (error instanceof PeerAgentSnapshotTooLargeError) {
          const retryAt = (this.deps.now?.() ?? Date.now()) + OVERSIZED_PEER_SNAPSHOT_BACKOFF_MS;
          this.oversizedPeerSnapshotBackoffUntil.set(normalizedBrokerUrl, retryAt);
          this.deps.log?.(
            `[openscout-runtime] peer ${node.name || node.id} agent snapshot exceeded ${error.maxBytes} bytes; retrying after ${new Date(retryAt).toISOString()}`,
          );
        }
        // Best-effort: peer may be temporarily unreachable.
      }
    }
  }

  private async retractMissingPeerAgents(
    node: NodeDefinition,
    presentIds: ReadonlySet<string>,
  ): Promise<void> {
    const staleAt = this.deps.now?.() ?? Date.now();
    let retractedCount = 0;
    for (const existing of Object.values(this.deps.runtime.snapshot().agents)) {
      if (presentIds.has(existing.id)) continue;
      if (!shouldSoftRetractImportedPeerAgent({
        agent: existing,
        peerNodeId: node.id,
        localNodeId: this.deps.nodeId,
        nodeLocalProductAgentIds: this.deps.nodeLocalProductAgentIds,
      })) continue;

      const nextAgent: AgentDefinition = {
        ...existing,
        metadata: staleMeshRegistrationMetadata(existing.metadata, staleAt, node.id),
      };
      if (isDeepStrictEqual(existing, nextAgent)) continue;
      await this.deps.upsertAgent(nextAgent);
      retractedCount++;
    }
    if (retractedCount > 0) {
      this.deps.log?.(
        `[openscout-runtime] retracted ${retractedCount} stale agent(s) from peer ${node.name || node.id}`,
      );
    }
  }
}
