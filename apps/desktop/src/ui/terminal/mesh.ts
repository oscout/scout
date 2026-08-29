import type {
  MeshStatusReport,
  MeshDoctorReport,
  MeshDiscoverReport,
  MeshJoinReport,
  MeshPingReport,
} from "../../core/mesh/service.ts";
import type { NodeDefinition } from "@openscout/protocol";

import { renderMeshTrustSection } from "./mesh-trust.ts";

/* ── Helpers ── */

function dot(ok: boolean): string {
  return ok ? "●" : "○";
}

function nodeScope(node: NodeDefinition): string {
  return node.advertiseScope === "mesh" ? "mesh" : "local";
}

function ago(ts: number | undefined): string {
  if (!ts) return "unknown";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function renderNodeBlock(node: NodeDefinition, isLocal: boolean): string[] {
  const label = isLocal ? " (local)" : "";
  const lines = [
    `  ${dot(true)} ${node.name ?? node.id}${label}`,
    `    ID: ${node.id}`,
  ];
  if (node.brokerUrl) lines.push(`    Broker: ${node.brokerUrl}`);
  lines.push(`    Scope: ${nodeScope(node)}`);
  if (node.hostName) lines.push(`    Host: ${node.hostName}`);
  if (node.tailnetName) lines.push(`    Tailnet: ${node.tailnetName}`);
  if (node.lastSeenAt) lines.push(`    Last seen: ${ago(node.lastSeenAt)}`);
  return lines;
}

/* ── Renderers ── */

export function renderMeshStatus(report: MeshStatusReport): string {
  const lines: string[] = [];

  lines.push("Mesh");
  lines.push(`  ID: ${report.meshId ?? "unknown"}`);

  if (report.localNode) {
    lines.push(`  Node: ${report.localNode.name} (${report.localNode.hostName ?? "unknown host"})`);
  }
  lines.push(`  Broker: ${report.brokerUrl}`);
  lines.push(`  Scope: ${report.localNode?.advertiseScope === "mesh" ? "mesh-reachable" : "local-only"}`);

  const tsLabel = !report.tailscale.available
    ? "not available"
    : report.tailscale.running
      ? `running (${report.tailscale.onlineCount} peer${report.tailscale.onlineCount === 1 ? "" : "s"} online)`
      : `not running (${report.tailscale.backendState ?? "unknown"})`;
  lines.push(`  Tailscale: ${tsLabel}`);

  const allNodes = Object.values(report.nodes);
  const remoteNodes = allNodes.filter((n) => n.id !== report.localNode?.id);

  lines.push("");
  lines.push(renderMeshTrustSection(report.trust));

  lines.push("");
  lines.push("Nodes");

  if (report.localNode) {
    lines.push(...renderNodeBlock(report.localNode, true));
  }

  if (remoteNodes.length > 0) {
    for (const node of remoteNodes) {
      lines.push(...renderNodeBlock(node, false));
    }
  } else {
    lines.push("  ○ No remote nodes discovered");
  }

  if (report.warnings.length > 0) {
    lines.push("");
    for (const w of report.warnings) {
      lines.push(`Tip: ${w}`);
    }
  }

  return lines.join("\n");
}

export function renderMeshDoctor(report: MeshDoctorReport): string {
  const lines: string[] = [];

  lines.push("Mesh diagnostics");
  lines.push("");

  // Local node
  lines.push("Local node:");
  if (report.localNode) {
    lines.push(`  ID: ${report.localNode.id}`);
    lines.push(`  Name: ${report.localNode.name}`);
    lines.push(`  Mesh: ${report.localNode.meshId}`);
    lines.push(`  Control URL: ${report.brokerUrl}`);
    lines.push(`  Announced URL: ${report.localNode.brokerUrl ?? report.brokerUrl}`);
    lines.push(`  Advertise scope: ${report.localNode.advertiseScope}`);
    if (report.localNode.hostName) {
      lines.push(`  Hostname: ${report.localNode.hostName}`);
    }
  } else {
    lines.push("  Broker not reachable — no local node info available.");
  }

  // Tailscale
  lines.push("");
  lines.push("Tailscale:");
  if (report.tailscale.available) {
    const state = report.tailscale.backendState ?? "unknown";
    lines.push(
      `  Status: ${report.tailscale.running ? `running (${state})` : `not running (${state})`} (${report.tailscale.peers.length} peer${report.tailscale.peers.length === 1 ? "" : "s"})`,
    );
    for (const detail of report.tailscale.health) {
      lines.push(`  ! ${detail}`);
    }
    for (const peer of report.tailscale.peers) {
      const ips = peer.addresses.join(", ");
      const status = peer.online ? "online" : "offline";
      lines.push(`  ${dot(peer.online)} ${peer.name} (${ips}) — ${status}`);
    }
  } else {
    lines.push("  Status: not available (no peers found)");
  }

  // Nodes
  const allNodes = Object.values(report.nodes);
  const remoteNodes = allNodes.filter((n) => n.id !== report.localNode?.id);
  lines.push("");
  lines.push("Remote nodes:");
  if (remoteNodes.length > 0) {
    for (const node of remoteNodes) {
      lines.push(...renderNodeBlock(node, false));
    }
  } else {
    lines.push("  None discovered");
  }

  // Reachability warnings
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of report.warnings) {
      lines.push(`  ! ${w}`);
    }
  }

  // Environment
  lines.push("");
  lines.push("Client environment (this shell):");
  const env = report.envVars;
  lines.push(`  OPENSCOUT_MESH_ID: ${env.meshId ?? "(default: openscout)"}`);
  lines.push(`  OPENSCOUT_MESH_SEEDS: ${env.meshSeeds || "(not set)"}`);
  lines.push(`  OPENSCOUT_BROKER_HOST: ${env.brokerHost ?? "(default: 127.0.0.1)"}`);
  lines.push(`  OPENSCOUT_BROKER_URL: ${env.brokerUrl ?? report.brokerUrl}`);
  lines.push(`  OPENSCOUT_NODE_NAME: ${env.nodeName ?? "(default: hostname)"}`);
  lines.push(`  OPENSCOUT_NODE_ID: ${env.nodeId ?? "(auto-derived)"}`);
  lines.push(`  OPENSCOUT_MESH_DISCOVERY_INTERVAL_MS: ${env.discoveryIntervalMs ?? "0 (disabled)"}`);

  return lines.join("\n");
}

export function renderMeshDiscover(report: MeshDiscoverReport): string {
  const lines: string[] = [];
  const onlinePeers = report.tailscalePeers.filter((p) => p.online);

  lines.push("Mesh discovery");
  lines.push(`  Tailscale peers: ${onlinePeers.length} online`);
  lines.push(`  Probed: ${report.probes.length} URL${report.probes.length === 1 ? "" : "s"}`);

  if (report.discovered.length > 0) {
    lines.push("");
    lines.push(`Found ${report.discovered.length} node${report.discovered.length === 1 ? "" : "s"}:`);
    for (const node of report.discovered) {
      lines.push(...renderNodeBlock(node, false));
    }
  } else {
    lines.push("");
    lines.push("No remote nodes found.");
    if (report.probes.length > 0) {
      lines.push(`  Probed URLs: ${report.probes.slice(0, 5).join(", ")}${report.probes.length > 5 ? ` (+${report.probes.length - 5} more)` : ""}`);
    }
  }

  return lines.join("\n");
}

export function renderMeshJoin(report: MeshJoinReport): string {
  const lines: string[] = [];
  lines.push("Joined mesh.");
  lines.push(`  Scope: ${report.localNode?.advertiseScope ?? "mesh"}`);
  lines.push(`  Broker URL: ${report.localNode?.brokerUrl ?? report.brokerUrl}`);
  lines.push(`  Discovered: ${report.discovery.discoveredCount} peer node${report.discovery.discoveredCount === 1 ? "" : "s"}`);
  const remoteCount = Object.values(report.nodes).filter((node) => node.id !== report.localNode?.id).length;
  lines.push(`  Known peers: ${remoteCount}`);
  if (report.discovery.error) {
    lines.push(`  Discovery warning: ${report.discovery.error}`);
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return lines.join("\n");
}

export function renderMeshPing(report: MeshPingReport): string {
  const lines: string[] = [];

  lines.push(`Ping ${report.target}`);
  lines.push(`  URL: ${report.url}`);

  if (report.reachable) {
    lines.push(`  Status: reachable (${report.latencyMs}ms)`);
    if (report.node) {
      lines.push(`  Node: ${report.node.name} (${report.node.id})`);
      lines.push(`  Mesh: ${report.node.meshId}`);
      if (report.meshIdMatch) {
        lines.push("  Mesh ID: matches local");
      } else if (report.localMeshId) {
        lines.push(`  Mesh ID: mismatch (local=${report.localMeshId}, remote=${report.node.meshId})`);
      }
      if (report.node.hostName) lines.push(`  Host: ${report.node.hostName}`);
      if (report.node.capabilities?.length) {
        lines.push(`  Capabilities: ${report.node.capabilities.join(", ")}`);
      }
    }
  } else {
    lines.push(`  Status: unreachable (${report.latencyMs}ms)`);
    if (report.error) {
      lines.push(`  Error: ${report.error}`);
    }
  }

  return lines.join("\n");
}

export function renderMeshNodes(input: {
  localNodeId: string | null;
  nodes: Record<string, NodeDefinition>;
}): string {
  const allNodes = Object.values(input.nodes);
  if (allNodes.length === 0) {
    return "No nodes known. Run `scout mesh discover` to probe the mesh.";
  }

  const lines: string[] = [];
  lines.push(`${allNodes.length} node${allNodes.length === 1 ? "" : "s"}`);

  for (const node of allNodes) {
    const isLocal = node.id === input.localNodeId;
    lines.push(...renderNodeBlock(node, isLocal));
  }

  return lines.join("\n");
}
