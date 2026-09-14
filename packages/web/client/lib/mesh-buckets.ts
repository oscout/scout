import type { Agent, MeshStatus } from "./types.ts";
import { filterMeshRosterAgents } from "./mesh-roster.ts";

export type HostFacts = NonNullable<MeshStatus["nodes"][string]["host"]>;

/** Where a row came from. Node rows exist whether or not any agent is on them. */
export type MachineKind = "this" | "node" | "tailnet";

/**
 * Pre-probe presence, from the inventory alone.
 *
 * `unknown` is the honest answer for a registered peer we have no live signal
 * for: the Network page layers real reachability on top (see mesh-node-state),
 * and a row must never claim "offline" just because nothing has probed it yet.
 */
export type MachinePresence = "self" | "reachable" | "unreachable" | "unknown";

/** Identity of the registered broker node behind a row, when there is one. */
export type MachineNodeFacts = {
  nodeId: string;
  brokerUrl: string | null;
  advertiseScope: string | null;
  lastSeenAt: number | null;
  capabilities: readonly string[];
};

/** Identity of the tailnet peer behind a row, when there is one. */
export type MachineTailnetFacts = {
  peerId: string;
  address: string | null;
  os: string | null;
  online: boolean;
};

export type MachineBucket = {
  machineId: string;
  machineLabel: string;
  kind: MachineKind;
  reachability: "this" | "peer" | "tailnet" | "unknown";
  /** Presence evidence from the snapshot. Absent evidence reads `unknown`. */
  presence: MachinePresence;
  /** True unless we hold positive evidence the machine is down. */
  online: boolean;
  host?: HostFacts;
  node?: MachineNodeFacts;
  tailnet?: MachineTailnetFacts;
  agents: Agent[];
};

function shortHost(s?: string | null): string {
  if (!s) return "";
  return s.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].split(".")[0] || s.slice(0, 8);
}

function machineLabelFor(node: { name?: string; hostName?: string } | undefined | null): string {
  if (!node) return "this host";
  const host = node.hostName ? shortHost(node.hostName) : null;
  return host || node.name || "this host";
}

export function localMachineLabel(mesh: MeshStatus | null | undefined): string {
  if (!mesh) return "Host";
  const label = machineLabelFor(mesh.localNode);
  return label === "this host" ? "Host" : label;
}

/** Hostnames a tailnet peer can carry that identify the tailnet, not the device. */
const GENERIC_PEER_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "127.0.0.1", "::1"]);

function isGenericPeerHostName(host: string | null | undefined): boolean {
  const normalized = (host ?? "").trim().toLowerCase();
  return normalized.length === 0 || GENERIC_PEER_HOSTNAMES.has(normalized);
}

/**
 * A tailnet peer's display name.
 *
 * iOS devices report `hostName: "localhost"` while their MagicDNS name is the
 * distinguishing one ("ipad-air-5th-gen-wifi"), so the dnsName wins whenever
 * the hostname is generic. Naming these rows is what stops them being dropped
 * as loopback and leaving the Tailnet group looking empty.
 */
function tailnetPeerLabel(peer: { hostName?: string | null; dnsName?: string | null; name?: string | null }): string {
  if (!isGenericPeerHostName(peer.hostName)) {
    const host = shortHost(peer.hostName);
    if (host) return host;
  }
  const dns = shortHost(peer.dnsName);
  if (dns && !GENERIC_PEER_HOSTNAMES.has(dns.toLowerCase())) return dns;
  const name = (peer.name ?? "").trim();
  if (name && !GENERIC_PEER_HOSTNAMES.has(name.toLowerCase())) return name;
  return "tailnet peer";
}

/** Stable host key for dedup across registered node + tailscale peer rows.
 *  Tailscale's display name ("Art's Mac mini") and the node's hostname
 *  ("Arts-Mac-mini.local") differ; both reduce via shortHost on the dnsName
 *  ("arts-mac-mini.tailnet-1234.ts.net") to the same short form. */
function tailnetPeerHostKey(peer: { dnsName?: string | null; hostName?: string | null; name?: string | null }): string {
  const dns = shortHost(peer.dnsName);
  if (dns && !GENERIC_PEER_HOSTNAMES.has(dns.toLowerCase())) return dns.toLowerCase();
  if (!isGenericPeerHostName(peer.hostName)) {
    const host = shortHost(peer.hostName);
    if (host) return host.toLowerCase();
  }
  return (peer.name ?? "").trim().toLowerCase();
}

function nodeHostKey(node: { hostName?: string; name?: string }): string {
  return (shortHost(node.hostName) || (node.name ? shortHost(node.name) : "")).toLowerCase();
}

/**
 * True loopback only. A peer whose hostname is "localhost" but whose MagicDNS
 * name identifies a real device is a real tailnet row, not a loopback echo.
 */
function isLoopbackTailnetPeer(peer: { hostName?: string | null; dnsName?: string | null; name?: string | null }): boolean {
  return tailnetPeerHostKey(peer).length === 0;
}

function nodeFacts(node: MeshStatus["nodes"][string] | null | undefined): MachineNodeFacts | undefined {
  if (!node) return undefined;
  return {
    nodeId: node.id,
    brokerUrl: node.brokerUrl ?? null,
    advertiseScope: node.advertiseScope ?? null,
    lastSeenAt: typeof node.lastSeenAt === "number" ? node.lastSeenAt : null,
    capabilities: node.capabilities ?? [],
  };
}

function cleanAddress(address: string | null | undefined): string | null {
  const value = (address ?? "").split("/")[0]?.trim();
  return value ? value : null;
}

/**
 * Machine rows for the Network page.
 *
 * Inventory first: every node the broker currently lists gets a row whether or
 * not a single agent survived the `/api/agents` cap or the roster filter, then
 * agents are attached to the row they belong to. Deriving rows from agents is
 * what made remote Scout machines disappear behind a capped roster (#906) and
 * reappear as anonymous, empty Tailnet entries.
 */
export function bucketAgentsByMachine(agents: Agent[], mesh: MeshStatus): MachineBucket[] {
  const rosterAgents = filterMeshRosterAgents(agents);
  const buckets = new Map<string, MachineBucket>();
  const localId = mesh.localNode?.id ?? "local";
  const localLabel = machineLabelFor(mesh.localNode);
  const localNode = (mesh.localNode && mesh.nodes?.[mesh.localNode.id]) ?? mesh.nodes?.[localId];

  buckets.set(localId, {
    machineId: localId,
    machineLabel: localLabel,
    kind: "this",
    reachability: "this",
    presence: "self",
    online: true,
    host: localNode?.host,
    node: nodeFacts(localNode) ?? {
      nodeId: localId,
      brokerUrl: mesh.localNode?.brokerUrl ?? null,
      advertiseScope: mesh.localNode?.advertiseScope ?? null,
      lastSeenAt: null,
      capabilities: mesh.localNode?.capabilities ?? [],
    },
    agents: [],
  });

  // Tailnet peers indexed by host key so a registered node can adopt the
  // reachability its tailnet twin reports without producing a duplicate row.
  const tailnetRunning = Boolean(mesh.tailscale?.running);
  const peersByHostKey = new Map<string, MeshStatus["tailscale"]["peers"][number]>();
  for (const peer of mesh.tailscale?.peers ?? []) {
    const key = tailnetPeerHostKey(peer);
    if (!key) continue;
    if (!peersByHostKey.has(key)) peersByHostKey.set(key, peer);
  }

  // Known inventory — one row per current mesh node, agents or not.
  for (const node of Object.values(mesh.nodes ?? {})) {
    if (!node?.id || node.id === localId) continue;
    const twin = peersByHostKey.get(nodeHostKey(node));
    const presence: MachinePresence = !twin || !tailnetRunning
      ? "unknown"
      : twin.online
        ? "reachable"
        : "unreachable";
    buckets.set(node.id, {
      machineId: node.id,
      machineLabel: machineLabelFor(node) || node.id,
      kind: "node",
      reachability: "peer",
      presence,
      online: presence !== "unreachable",
      host: node.host,
      node: nodeFacts(node),
      ...(twin
        ? {
            tailnet: {
              peerId: twin.id,
              address: cleanAddress(twin.addresses?.[0]),
              os: twin.os ?? null,
              online: Boolean(twin.online && tailnetRunning),
            },
          }
        : {}),
      agents: [],
    });
  }

  for (const agent of rosterAgents) {
    const id = agent.authorityNodeId ?? agent.homeNodeId ?? localId;
    const bucket = buckets.get(id);
    // A node the mesh snapshot no longer lists is stale history, not a machine.
    if (!bucket) continue;
    bucket.agents.push(agent);
  }

  const knownHosts = new Set<string>();
  for (const b of buckets.values()) {
    knownHosts.add(b.machineLabel.toLowerCase());
    const node = mesh.nodes?.[b.machineId];
    if (node) {
      const hostKey = nodeHostKey(node);
      if (hostKey) knownHosts.add(hostKey);
    }
  }
  const localHostKey = mesh.localNode ? nodeHostKey(mesh.localNode) : "";
  if (localHostKey) knownHosts.add(localHostKey);

  // Tailnet-only peers — devices on the tailnet with no Scout node record.
  for (const peer of mesh.tailscale?.peers ?? []) {
    if (isLoopbackTailnetPeer(peer)) continue;
    const label = tailnetPeerLabel(peer);
    const hostKey = tailnetPeerHostKey(peer);
    if (hostKey && knownHosts.has(hostKey)) continue;
    if (knownHosts.has(label.toLowerCase())) continue;
    const peerId = `tailnet:${peer.id}`;
    if (buckets.has(peerId)) continue;
    const online = Boolean(peer.online && tailnetRunning);
    buckets.set(peerId, {
      machineId: peerId,
      machineLabel: label,
      kind: "tailnet",
      reachability: "tailnet",
      presence: !tailnetRunning ? "unknown" : online ? "reachable" : "unreachable",
      online,
      tailnet: {
        peerId: peer.id,
        address: cleanAddress(peer.addresses?.[0]),
        os: peer.os ?? null,
        online,
      },
      agents: [],
    });
    if (hostKey) knownHosts.add(hostKey);
    knownHosts.add(label.toLowerCase());
  }

  const groupRank = (b: MachineBucket): number =>
    b.reachability === "this" ? 0 : b.reachability === "peer" ? 1 : 2;
  return Array.from(buckets.values()).sort((a, b) => {
    const gr = groupRank(a) - groupRank(b);
    if (gr !== 0) return gr;
    return a.machineLabel.localeCompare(b.machineLabel);
  });
}
