/**
 * This machine's own node state, without requiring a broker restart.
 *
 * The compact `/v1/mesh/node-state` route ships with the broker, so a web
 * server that has been updated is routinely talking to a broker that has not
 * been restarted yet. Asking it for a route it does not serve and then calling
 * this machine unreachable is the worst possible answer: it is the one node we
 * can always see.
 *
 * So the local fallback reads the registry snapshot the web server already
 * loads for its other surfaces — same cached read, same 30s TTL, no extra
 * traffic, no new route — and projects it with the broker's own scoping rules,
 * so a fallback reading is scoped exactly like a served one.
 *
 * It must be the unscoped read. `scope: "agents"` returns agent cards with no
 * endpoints and no flights, and liveness is computed from those: the projection
 * would come back "507 agents, all offline, no sessions, no work" on a machine
 * with live panes. Attesting idleness from a snapshot that cannot see sessions
 * is the exact failure this lane exists to remove.
 */

import { readMeshNodeState as projectMeshNodeState, type MeshNodeStateReport } from "@openscout/runtime/mesh-node-state";

import { loadScoutBrokerContext, resolveScoutBrokerUrl, type ScoutBrokerSnapshot } from "../broker/service.ts";

function actorDisplayName(snapshot: ScoutBrokerSnapshot, actorId: string): string {
  const agent = snapshot.agents?.[actorId];
  return agent?.displayName
    ?? snapshot.actors?.[actorId]?.displayName
    ?? actorId;
}

/**
 * Read local node state from the registry snapshot.
 *
 * Returns `null` when the broker context cannot be read at all, or when the
 * snapshot's node identity disagrees with the machine we were asked about —
 * an answer about a different node is not this node's state.
 */
export async function readLocalNodeStateFromSnapshot(
  expectedNodeId: string | null,
  options: { signal?: AbortSignal } = {},
): Promise<MeshNodeStateReport | null> {
  const context = await loadScoutBrokerContext(resolveScoutBrokerUrl(), {
    signal: options.signal,
    waitForInitial: true,
  });
  if (!context?.node?.id) return null;
  if (expectedNodeId && context.node.id !== expectedNodeId) return null;

  // The scoped read (`scope: "agents"`) carries agent cards and nothing else.
  // Projecting from it would report every agent offline with no sessions and no
  // work — a machine mid-turn described as idle. A snapshot that cannot speak to
  // liveness is refused here, so the caller reports "cannot say" instead.
  const snapshot = context.snapshot;
  if (!snapshot?.agents || !snapshot.endpoints || !snapshot.flights) return null;

  return projectMeshNodeState({
    snapshot: () => snapshot,
    nodeId: context.node.id,
    meshId: context.node.meshId ?? null,
    actorDisplayName,
  });
}
