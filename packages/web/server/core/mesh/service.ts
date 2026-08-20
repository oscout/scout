/**
 * Mesh status for the web UI.
 *
 * Ported from apps/desktop/src/core/mesh/service.ts — uses the same
 * broker helpers already available in the web server package.
 */

import type { NodeDefinition } from "@openscout/protocol";
import { requestScoutBrokerJson } from "@openscout/runtime/broker-api";
import {
  type TailscalePeerCandidate,
} from "@openscout/runtime/mesh/tailscale";
import { execSystemFile, tailscaleStatusProbe } from "@openscout/runtime/system-probes";

import {
  readScoutBrokerHealth,
  loadScoutBrokerContext,
  resolveScoutBrokerAdvertiseUrl,
  resolveScoutBrokerUrl,
  type ScoutBrokerHealthState,
  type ScoutBrokerNodeRecord,
} from "../broker/service.ts";

/* ── Types ── */

export type TailscaleStatus = {
  available: boolean;
  running: boolean;
  backendState: string | null;
  health: string[];
  peers: TailscalePeerCandidate[];
  onlineCount: number;
};

export type MeshIssueCode =
  | "broker_unreachable"
  | "tailscale_stopped"
  | "local_only"
  | "mesh_loopback"
  | "discovery_unconfigured";

export type MeshIssue = {
  code: MeshIssueCode;
  severity: "warning" | "error";
  title: string;
  summary: string;
  action: string | null;
  actionCommand: string | null;
};

export type MeshIdentitySummary = {
  name: string | null;
  nodeId: string | null;
  meshId: string | null;
  modeLabel: string;
  discoverable: boolean;
  announceUrl: string | null;
  discoveryDetail: string;
};

export type MeshStatusReport = {
  brokerUrl: string;
  health: ScoutBrokerHealthState;
  localNode: ScoutBrokerNodeRecord | null;
  meshId: string | null;
  identity: MeshIdentitySummary;
  nodes: Record<string, NodeDefinition>;
  tailscale: TailscaleStatus;
  issues: MeshIssue[];
  warnings: string[];
};

export type TailscaleControlAction = "open_app";

/* ── Helpers ── */

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "0.0.0.0" || normalized === "::";
}

function isPeerReachableBrokerUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }

  try {
    const hostname = new URL(url).hostname;
    return !isLoopbackHost(hostname) && !isWildcardHost(hostname);
  } catch {
    return false;
  }
}

async function readTailscaleStatus(): Promise<TailscaleStatus> {
  const summary = tailscaleStatusProbe.read().value;
  const peers = summary?.peers ?? [];
  return {
    available: summary !== null,
    running: summary?.running ?? false,
    backendState: summary?.backendState ?? null,
    health: summary?.health ?? [],
    peers,
    onlineCount: peers.filter((p) => p.online).length,
  };
}

function formatIssueWarning(issue: MeshIssue): string {
  return issue.action
    ? `${issue.title} — ${issue.summary} ${issue.action}`
    : `${issue.title} — ${issue.summary}`;
}

function computeIssues(
  health: ScoutBrokerHealthState,
  localNode: ScoutBrokerNodeRecord | null,
  nodes: Record<string, NodeDefinition>,
  tailscale: TailscaleStatus,
): MeshIssue[] {
  const issues: MeshIssue[] = [];

  if (!health.reachable) {
    issues.push({
      code: "broker_unreachable",
      severity: "error",
      title: "Broker not reachable",
      summary: "The mesh page cannot reach the local broker yet, so peer status is incomplete.",
      action: "Start the broker, then reload this page.",
      actionCommand: null,
    });
    return issues;
  }

  if (tailscale.available && !tailscale.running) {
    issues.push({
      code: "tailscale_stopped",
      severity: "warning",
      title: "Tailscale is stopped",
      summary:
        "This machine can still show cached Tailnet peers, but the local Tailscale backend is not running, so the broker cannot reach them.",
      action: "Start Tailscale on this machine, then refresh mesh discovery.",
      actionCommand: null,
    });
  }

  if (localNode?.advertiseScope === "local") {
    issues.push({
      code: "local_only",
      severity: "warning",
      title: "Not announced to peers",
      summary: "This broker is healthy on this machine, but it is still local-only, so peer brokers will not discover it.",
      action: "Use Announce on mesh if this machine should participate in peer discovery.",
      actionCommand: null,
    });
  } else if (localNode?.advertiseScope === "mesh" && !isPeerReachableBrokerUrl(localNode.brokerUrl)) {
    issues.push({
      code: "mesh_loopback",
      severity: "warning",
      title: "Announced with the wrong address",
      summary: "This broker is in mesh mode, but the address it announces is not peer-reachable, so other brokers still cannot connect to it.",
      action: "Announce it again with a peer-reachable address.",
      actionCommand: null,
    });
  }

  const remoteNodes = Object.values(nodes).filter((n) => n.id !== localNode?.id);

  if (!tailscale.available && remoteNodes.length === 0) {
    issues.push({
      code: "discovery_unconfigured",
      severity: "warning",
      title: "No discovery path configured",
      summary: "No Tailscale peers are available and no mesh seeds are configured, so this broker has nowhere to look for peers.",
      action: "Join the machine to Tailscale or configure an explicit seed broker.",
      actionCommand: null,
    });
  }

  return issues;
}

function computeIdentitySummary(
  health: ScoutBrokerHealthState,
  localNode: ScoutBrokerNodeRecord | null,
  meshId: string | null,
): MeshIdentitySummary {
  const announceUrl = localNode?.brokerUrl ?? null;
  const name = localNode?.name ?? null;
  const nodeId = localNode?.id ?? health.nodeId ?? null;

  if (!health.reachable) {
    return {
      name,
      nodeId,
      meshId,
      modeLabel: "Broker offline",
      discoverable: false,
      announceUrl,
      discoveryDetail:
        "This broker is not running, so peers cannot discover it yet. Other brokers only learn a mesh ID after they reach a broker address and read /v1/node.",
    };
  }

  if (!localNode) {
    return {
      name,
      nodeId,
      meshId,
      modeLabel: "Not registered",
      discoverable: false,
      announceUrl,
      discoveryDetail:
        "This broker is up, but it has not published a local node record yet. Peers only learn a mesh ID after they reach a broker address and read /v1/node.",
    };
  }

  if (localNode.advertiseScope !== "mesh") {
    return {
      name: localNode.name,
      nodeId: localNode.id,
      meshId,
      modeLabel: "Local only",
      discoverable: false,
      announceUrl,
      discoveryDetail:
        "Peers discover candidate broker addresses through Tailscale or manual seed URLs. They only learn a mesh ID after they connect and read /v1/node. Right now this broker is local-only, so peers never reach that step.",
    };
  }

  if (!isPeerReachableBrokerUrl(announceUrl)) {
    return {
      name: localNode.name,
      nodeId: localNode.id,
      meshId,
      modeLabel: "Mesh mode, wrong address",
      discoverable: false,
      announceUrl,
      discoveryDetail:
        `This broker is in mesh mode, but it announces ${announceUrl ?? "an unreachable address"}. Peers only learn the mesh ID after they reach a broker address and read /v1/node.`,
    };
  }

  return {
    name: localNode.name,
    nodeId: localNode.id,
    meshId,
    modeLabel: "Announced to mesh",
    discoverable: true,
    announceUrl,
    discoveryDetail:
      `Peers can probe ${announceUrl} through Tailscale or a manual seed URL. Once they connect, /v1/node tells them this broker belongs to mesh ${meshId ?? "this mesh"}.`,
  };
}

/* ── Public API ── */

const STALE_NODE_MS = 24 * 60 * 60 * 1000; // 24h

function filterCurrentMeshNodes(
  allNodes: Record<string, NodeDefinition>,
  meshId: string | null,
  localNodeId: string | undefined,
  now: number,
): Record<string, NodeDefinition> {
  const filtered: Record<string, NodeDefinition> = {};
  for (const [id, node] of Object.entries(allNodes)) {
    if (id === localNodeId) {
      filtered[id] = node;
      continue;
    }
    if (meshId && node.meshId && node.meshId !== meshId) continue;
    const lastSeen = node.lastSeenAt ?? node.registeredAt ?? 0;
    if (lastSeen > 0 && now - lastSeen > STALE_NODE_MS) continue;
    filtered[id] = node;
  }
  return filtered;
}

export async function loadMeshStatus(): Promise<MeshStatusReport> {
  const controlUrl = resolveScoutBrokerUrl();
  const advertiseUrl = resolveScoutBrokerAdvertiseUrl();
  const [health, context, tailscale] = await Promise.all([
    readScoutBrokerHealth(controlUrl),
    loadScoutBrokerContext(controlUrl),
    readTailscaleStatus(),
  ]);

  const localNode = context?.node ?? null;
  const allNodes = context?.snapshot.nodes ?? {};
  const meshId = health.meshId ?? localNode?.meshId ?? null;
  const identity = computeIdentitySummary(health, localNode, meshId);
  const nodes = filterCurrentMeshNodes(allNodes, meshId, localNode?.id, Date.now());
  const issues = computeIssues(health, localNode, nodes, tailscale);
  const warnings = issues.map(formatIssueWarning);

  return { brokerUrl: advertiseUrl, health, localNode, meshId, identity, nodes, tailscale, issues, warnings };
}

/**
 * P1.5 restart-free announce (§11.5): call the live broker bind controller
 * instead of writing service config and restarting. The broker opens TLS
 * listeners + mDNS without process restart and persists desired scope for
 * reboot restore.
 */
export async function announceMeshVisibility(): Promise<MeshStatusReport> {
  return applyMeshBindScope("mesh");
}

/** Withdraw mesh announcement (TLS/mDNS stand down) without restart. */
export async function withdrawMeshVisibility(): Promise<MeshStatusReport> {
  return applyMeshBindScope("local");
}

async function applyMeshBindScope(scope: "mesh" | "local"): Promise<MeshStatusReport> {
  const controlUrl = resolveScoutBrokerUrl();
  try {
    await requestScoutBrokerJson(controlUrl, "/v1/mesh/bind", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      // requestScoutBrokerJson serializes `body` itself — stringifying here
      // sends a JSON *string*, so the broker reads `scope` as undefined.
      body: { scope },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not flip mesh bind to ${scope}: ${detail}. Is the broker running?`,
    );
  }
  return loadMeshStatus();
}

async function openTailscaleApp(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(
      "Opening Tailscale from Scout is only supported on macOS right now.",
    );
  }

  try {
    await execSystemFile("open", ["-a", "Tailscale"], { timeoutMs: 1_500 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Scout could not open Tailscale.app on this machine. ${detail}`,
    );
  }
}

export async function controlTailscale(
  action: TailscaleControlAction,
): Promise<MeshStatusReport> {
  if (action === "open_app") {
    await openTailscaleApp();
    tailscaleStatusProbe.invalidate("tailscale.start");
    return loadMeshStatus();
  }

  throw new Error(`Unsupported Tailscale action: ${action}`);
}
