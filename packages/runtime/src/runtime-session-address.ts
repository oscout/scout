import {
  formatScoutSessionHostAddress,
  isScoutSessionHandle,
  normalizeScoutSessionHost,
  parseScoutSessionHostAddress,
  scoutNodeMatchesSessionHost,
  scoutSessionHostForNode,
  type AgentEndpoint,
  type NodeDefinition,
} from "@openscout/protocol";

import {
  endpointCandidateState,
  endpointLifecycleAt,
  endpointMatchesTargetSession,
  isStaleLocalEndpoint,
} from "./broker-endpoint-selection.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import { runtimeSessionHandleForEndpoint } from "./runtime-session-handle.js";

/** The slice of the runtime snapshot session addressing reads. */
export interface SessionAddressSnapshot {
  nodes: Record<string, NodeDefinition>;
  endpoints: Record<string, AgentEndpoint>;
}

/**
 * Host label for a node id. A node this broker has never registered still
 * gets a label derived from its id, so an address is always copyable.
 */
export function sessionHostForNodeId(snapshot: Pick<SessionAddressSnapshot, "nodes">, nodeId: string): string {
  const node = snapshot.nodes[nodeId];
  return node ? scoutSessionHostForNode(node) : normalizeScoutSessionHost(nodeId);
}

/** Node ids a host label names. More than one is possible (e.g. legacy `-local` node records). */
export function sessionHostNodeIds(snapshot: Pick<SessionAddressSnapshot, "nodes">, host: string): string[] {
  return Object.values(snapshot.nodes)
    .filter((node) => scoutNodeMatchesSessionHost(node, host))
    .map((node) => node.id)
    .sort((left, right) => left.localeCompare(right));
}

/** `sess.<token>@<host>` for the endpoint's current harness context. */
export function runtimeSessionAddressForEndpoint(
  snapshot: Pick<SessionAddressSnapshot, "nodes">,
  endpoint: AgentEndpoint,
): string | null {
  const handle = runtimeSessionHandleForEndpoint(endpoint);
  const host = sessionHostForNodeId(snapshot, endpoint.nodeId);
  return handle && host ? formatScoutSessionHostAddress({ handle, host }) : null;
}

/**
 * True when `selector` names this endpoint's session: a `sess.<token>@<host>`
 * address (handle and host must both match) or any selector the broker
 * already accepts for exact sessions.
 */
export function endpointMatchesTargetSessionAddress(
  snapshot: Pick<SessionAddressSnapshot, "nodes">,
  endpoint: AgentEndpoint,
  selector: string,
): boolean {
  const address = parseScoutSessionHostAddress(selector);
  if (!address) return endpointMatchesTargetSession(endpoint, selector.replace(/^session:/, ""));
  const node = snapshot.nodes[endpoint.nodeId];
  const onHost = node
    ? scoutNodeMatchesSessionHost(node, address.host)
    : normalizeScoutSessionHost(endpoint.nodeId) === address.host;
  return onHost && endpointMatchesTargetSession(endpoint, address.handle);
}

/**
 * Address for any session selector the broker accepts (canonical handle,
 * native id, endpoint id). Returns null unless the selector names exactly one
 * canonical session, so a receipt never advertises a guessed address.
 */
export function runtimeSessionAddressForSessionId(
  snapshot: SessionAddressSnapshot,
  sessionId: string | null | undefined,
): string | null {
  const selector = sessionId?.trim();
  if (!selector) return null;
  const addresses = new Set(
    Object.values(snapshot.endpoints)
      .filter((endpoint) => endpointMatchesTargetSession(endpoint, selector))
      .map((endpoint) => runtimeSessionAddressForEndpoint(snapshot, endpoint))
      .filter((address): address is string => Boolean(address)),
  );
  if (addresses.size === 1) return [...addresses][0]!;
  if (addresses.size > 1 && isScoutSessionHandle(selector)) {
    // Several endpoints project one canonical handle: keep the matching address.
    const exact = [...addresses].filter((address) => address.startsWith(`${selector}@`));
    return exact.length === 1 ? exact[0]! : null;
  }
  return null;
}

/**
 * What a sender can expect from an address right now. Addressability never
 * implies reachability:
 * - `live`: an attached endpoint is online; an ask dispatches directly.
 * - `resumable`: offline but carries a harness-native session id, so an ask
 *   makes Scout try the exact-session wake. The wake can still fail (for
 *   example a folder-trust prompt); Scout then reports it, never a fresh session.
 * - `unavailable`: ended, superseded, or with nothing to resume. Asks fail closed.
 */
export type RuntimeSessionReachability = "live" | "resumable" | "unavailable";

export interface RuntimeSessionAddressEntry {
  address: string;
  host: string;
  nodeId: string;
  reachability: RuntimeSessionReachability;
  endpointState: AgentEndpoint["state"];
  harness: AgentEndpoint["harness"];
  actorId: string;
  endpointId: string;
  projectRoot: string | null;
  lastSeenAt: number | null;
}

const RESUMABLE_NATIVE_ID_KEYS = ["nativeSessionId", "externalSessionId", "threadId"] as const;

export function runtimeSessionReachability(
  snapshot: RuntimeRegistrySnapshot,
  endpoint: AgentEndpoint,
): RuntimeSessionReachability {
  if (isStaleLocalEndpoint(snapshot, endpoint)) return "unavailable";
  if (endpointCandidateState(endpoint.state) === "online") return "live";
  const hasNativeId = RESUMABLE_NATIVE_ID_KEYS.some((key) => {
    const value = endpoint.metadata?.[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  return hasNativeId ? "resumable" : "unavailable";
}

const REACHABILITY_RANK: Record<RuntimeSessionReachability, number> = { live: 0, resumable: 1, unavailable: 2 };

/**
 * One entry per address for the given endpoints. Several endpoints can
 * project the same session (transports, relays); the most reachable wins.
 */
export function runtimeSessionAddressEntries(
  snapshot: RuntimeRegistrySnapshot,
  endpoints: Iterable<AgentEndpoint>,
): RuntimeSessionAddressEntry[] {
  const byAddress = new Map<string, RuntimeSessionAddressEntry>();
  for (const endpoint of endpoints) {
    const address = runtimeSessionAddressForEndpoint(snapshot, endpoint);
    if (!address) continue;
    const lifecycleAt = endpointLifecycleAt(endpoint);
    const entry: RuntimeSessionAddressEntry = {
      address,
      host: sessionHostForNodeId(snapshot, endpoint.nodeId),
      nodeId: endpoint.nodeId,
      reachability: runtimeSessionReachability(snapshot, endpoint),
      endpointState: endpoint.state,
      harness: endpoint.harness,
      actorId: endpoint.agentId,
      endpointId: endpoint.id,
      projectRoot: endpoint.projectRoot ?? endpoint.cwd ?? null,
      lastSeenAt: lifecycleAt > 0 ? lifecycleAt : null,
    };
    const existing = byAddress.get(address);
    if (
      !existing
      || REACHABILITY_RANK[entry.reachability] < REACHABILITY_RANK[existing.reachability]
      || (entry.reachability === existing.reachability && (entry.lastSeenAt ?? 0) > (existing.lastSeenAt ?? 0))
    ) {
      byAddress.set(address, entry);
    }
  }
  return [...byAddress.values()].sort((left, right) =>
    REACHABILITY_RANK[left.reachability] - REACHABILITY_RANK[right.reachability]
    || (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0)
    || left.address.localeCompare(right.address)
  );
}
