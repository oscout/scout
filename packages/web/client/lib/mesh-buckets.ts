import type { Agent, MeshStatus } from "./types.ts";
import { filterMeshRosterAgents } from "./mesh-roster.ts";

export type HostFacts = NonNullable<MeshStatus["nodes"][string]["host"]>;

export type MachineBucket = {
  machineId: string;
  machineLabel: string;
  reachability: "this" | "peer" | "tailnet" | "unknown";
  /** True when the machine is reachable; tailnet-only peers we can't reach are false. */
  online: boolean;
  host?: HostFacts;
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

function tailnetPeerLabel(peer: { hostName?: string | null; name?: string | null }): string {
  return shortHost(peer.hostName) || peer.name || "tailnet peer";
}

/** Stable host key for dedup across registered node + tailscale peer rows.
 *  Tailscale's display name ("Art's Mac mini") and the node's hostname
 *  ("Arts-Mac-mini.local") differ; both reduce via shortHost on the dnsName
 *  ("arts-mac-mini.tailnet-1234.ts.net") to the same short form. */
function tailnetPeerHostKey(peer: { dnsName?: string | null; hostName?: string | null; name?: string | null }): string {
  return shortHost(peer.dnsName) || shortHost(peer.hostName) || (peer.name ?? "").toLowerCase();
}

function nodeHostKey(node: { hostName?: string; name?: string }): string {
  return shortHost(node.hostName) || (node.name ? shortHost(node.name) : "");
}

function isLoopbackTailnetPeer(peer: { hostName?: string | null; dnsName?: string | null; name?: string | null }): boolean {
  const host = (peer.hostName ?? peer.dnsName ?? peer.name ?? "").trim().toLowerCase();
  if (!host) return false;
  const short = shortHost(host).toLowerCase();
  return short === "localhost" || host === "127.0.0.1" || host.startsWith("localhost.");
}

export function bucketAgentsByMachine(agents: Agent[], mesh: MeshStatus): MachineBucket[] {
  const rosterAgents = filterMeshRosterAgents(agents);
  const buckets = new Map<string, MachineBucket>();
  const localId = mesh.localNode?.id ?? "local";
  const localLabel = machineLabelFor(mesh.localNode);
  const localHost = (mesh.localNode && mesh.nodes?.[mesh.localNode.id]?.host) ?? mesh.nodes?.[localId]?.host;

  buckets.set(localId, {
    machineId: localId,
    machineLabel: localLabel,
    reachability: "this",
    online: true,
    host: localHost,
    agents: [],
  });

  for (const agent of rosterAgents) {
    const id = agent.authorityNodeId ?? agent.homeNodeId ?? localId;
    if (id !== localId && !mesh.nodes?.[id]) continue;
    let bucket = buckets.get(id);
    if (!bucket) {
      const remote = mesh.nodes?.[id];
      bucket = {
        machineId: id,
        machineLabel: machineLabelFor(remote) || agent.authorityNodeName || agent.homeNodeName || id,
        reachability: "peer",
        online: true,
        host: remote?.host,
        agents: [],
      };
      buckets.set(id, bucket);
    }
    bucket.agents.push(agent);
  }

  const knownHosts = new Set<string>();
  for (const b of buckets.values()) {
    knownHosts.add(b.machineLabel.toLowerCase());
    const node = mesh.nodes?.[b.machineId];
    if (node) {
      const hostKey = nodeHostKey(node);
      if (hostKey) knownHosts.add(hostKey.toLowerCase());
    }
  }
  for (const peer of mesh.tailscale?.peers ?? []) {
    if (isLoopbackTailnetPeer(peer)) continue;
    const label = tailnetPeerLabel(peer);
    const hostKey = tailnetPeerHostKey(peer).toLowerCase();
    if (hostKey && knownHosts.has(hostKey)) continue;
    if (knownHosts.has(label.toLowerCase())) continue;
    const peerId = `tailnet:${peer.id}`;
    if (buckets.has(peerId)) continue;
    buckets.set(peerId, {
      machineId: peerId,
      machineLabel: label,
      reachability: "tailnet",
      online: Boolean(peer.online && mesh.tailscale?.running),
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
