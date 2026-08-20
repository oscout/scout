import type { NodeDefinition } from "@openscout/protocol";

import { meshPeerFetch, type MeshPeerFetch } from "./mesh-peer-client.js";
import { readTailscalePeers } from "./tailscale.js";

export interface MeshDiscoveryOptions {
  localNodeId: string;
  localBrokerUrl?: string;
  defaultPort: number;
  meshId: string;
  seeds?: string[];
  timeoutMs?: number;
  peerFetch?: MeshPeerFetch;
  readTailscalePeers?: typeof readTailscalePeers;
}

export interface MeshDiscoveryResult {
  discovered: NodeDefinition[];
  probes: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeSeedUrl(seed: string, defaultPort: number, scheme = "http"): string {
  try {
    const url = new URL(seed.includes("://") ? seed : `${scheme}://${seed}`);
    if (!url.port) {
      url.port = String(defaultPort);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

/**
 * A node card can advertise multiple private routes, and the card's preferred
 * route is not necessarily reachable from every observer. The URL that
 * successfully served /v1/node is the only route discovery has proved from
 * this client, so promote it for subsequent node-id routing. The signed card
 * still retains the peer's complete endpoint list.
 */
export function resolveDiscoveredBrokerUrl(
  _advertisedBrokerUrl: string | undefined,
  observedBrokerUrl: string,
): string {
  return observedBrokerUrl.replace(/\/$/, "");
}

export function buildPeerSeeds(
  peerName: string,
  addresses: string[],
  dnsName: string | undefined,
  defaultPort: number,
): string[] {
  const hosts = [dnsName, peerName, ...addresses]
    .filter((value): value is string => Boolean(value));
  return unique([
    ...hosts.map((value) => normalizeSeedUrl(value, defaultPort, "https")),
    ...hosts.map((value) => normalizeSeedUrl(value, defaultPort, "http")),
  ]);
}

async function probeNode(
  baseUrl: string,
  timeoutMs: number,
  peerFetch: MeshPeerFetch,
): Promise<NodeDefinition | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await peerFetch(baseUrl, "/v1/node", {
      signal: controller.signal,
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const node = await response.json() as NodeDefinition;
    return {
      ...node,
      brokerUrl: resolveDiscoveredBrokerUrl(node.brokerUrl, baseUrl),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverMeshNodes(
  options: MeshDiscoveryOptions,
): Promise<MeshDiscoveryResult> {
  const peerSeeds = options.seeds
    ? options.seeds.map((seed) => normalizeSeedUrl(seed, options.defaultPort))
    : [];
  const tailscalePeers = await (options.readTailscalePeers ?? readTailscalePeers)();
  const tailscaleSeeds = tailscalePeers
    .filter((peer) => peer.online)
    .flatMap((peer) => buildPeerSeeds(peer.name, peer.addresses, peer.dnsName, options.defaultPort));
  const candidates = unique([...peerSeeds, ...tailscaleSeeds])
    .filter((seed) => seed && seed !== options.localBrokerUrl);

  const discovered: NodeDefinition[] = [];
  const seen = new Set<string>();
  const peerFetch = options.peerFetch ?? meshPeerFetch;

  for (const seed of candidates) {
    const node = await probeNode(seed, options.timeoutMs ?? 1500, peerFetch);
    if (!node) continue;
    if (node.id === options.localNodeId) continue;
    if (node.meshId !== options.meshId) continue;
    if (seen.has(node.id)) continue;
    seen.add(node.id);

    discovered.push({
      ...node,
      brokerUrl: resolveDiscoveredBrokerUrl(node.brokerUrl, seed),
      advertiseScope: "mesh",
      lastSeenAt: Date.now(),
      registeredAt: node.registeredAt ?? Date.now(),
    });
  }

  return {
    discovered,
    probes: candidates,
  };
}
