/**
 * Compact node state — the observe-tier answer to "what is running on you?".
 *
 * Mesh trust cone §4: `GET /v1/home` is a local-tier route and must never be
 * widened, so a peer cannot read it even with a signed request. This is the
 * narrow remote-tier twin: node identity, plus bounded views of the three
 * things a Network viewer actually asks about a machine — who is registered
 * there, which sessions are live, and what work is in flight.
 *
 * What it deliberately does not carry: conversation and message bodies, flight
 * output, endpoint addresses, panes and working directories. Enough to see
 * what a machine is doing; not enough to mirror its registry or read its
 * traffic. Summaries are truncated, and every list is capped with the true
 * total reported alongside.
 *
 * A peer that predates this route refuses it — 404 where the route is simply
 * absent, 403 where a deny-by-default route matrix rejects a name it does not
 * know. Either way that is an honest `unsupported` reading, and callers must
 * render it as such rather than as an idle machine with zero agents.
 */

import type { AgentEndpoint, FlightRecord } from "@openscout/protocol";
import type { RuntimeRegistrySnapshot } from "./registry.js";
import { projectHomeAgents } from "./broker-home-service.js";
import { isWorkingFlightState } from "./broker-local-invocation-helpers.js";
import { isStaleLocalEndpoint } from "./broker-endpoint-selection.js";

/** Bounded roster: enough to show what a machine is doing, never its whole registry. */
export const MESH_NODE_STATE_ROSTER_LIMIT = 24;
/** Sessions and work are shorter lists; a machine with more is summarised. */
export const MESH_NODE_STATE_SESSION_LIMIT = 16;
export const MESH_NODE_STATE_WORK_LIMIT = 16;
/** Free text crossing the mesh is clipped; this is a status line, not a log. */
const SUMMARY_MAX = 160;

export type MeshNodeStateAgent = {
  id: string;
  title: string;
  role: string | null;
  projectRoot: string | null;
  state: "offline" | "available" | "working";
  statusLabel: string;
  lastSeenAt: number | null;
};

export type MeshNodeStateSession = {
  id: string;
  agentId: string;
  /** Harness running the session, e.g. claude/codex. */
  harness: string | null;
  transport: string | null;
  state: string;
  /** The harness session handle, when there is one; never an address. */
  sessionId: string | null;
  projectRoot: string | null;
};

export type MeshNodeStateWork = {
  id: string;
  targetAgentId: string;
  state: string;
  /** Clipped one-liner; flight output is never carried. */
  summary: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

export type MeshNodeStateReport = {
  /** Wire-shape version, so a client can tell an old twin from a new one. */
  kind: "mesh-node-state";
  version: 1;
  nodeId: string;
  meshId: string | null;
  name: string | null;
  hostName: string | null;
  capabilities: readonly string[];
  /** When this broker computed the report, by its own clock. */
  observedAt: number;
  workload: {
    total: number;
    working: number;
    available: number;
    offline: number;
    /** True when the roster below was cut; totals stay exact. */
    truncated: boolean;
  };
  roster: MeshNodeStateAgent[];
  /** Live harness sessions on this node. */
  sessions: {
    total: number;
    truncated: boolean;
    items: MeshNodeStateSession[];
  };
  /** Work in flight against this node's agents. */
  work: {
    total: number;
    running: number;
    truncated: boolean;
    items: MeshNodeStateWork[];
  };
};

export type MeshNodeStateDeps = {
  snapshot: () => RuntimeRegistrySnapshot;
  nodeId: string;
  meshId: string | null;
  actorDisplayName: (snapshot: RuntimeRegistrySnapshot, actorId: string) => string;
  now?: () => number;
  rosterLimit?: number;
  sessionLimit?: number;
  workLimit?: number;
};

/**
 * Project this broker's own workloads.
 *
 * Scoped to agents homed here: a peer asking what runs on this machine must
 * not receive this broker's second-hand view of a third machine, which would
 * make one stale mirror look like live evidence on the asking node.
 */
export function readMeshNodeState(deps: MeshNodeStateDeps): MeshNodeStateReport {
  const snapshot = deps.snapshot();
  const node = snapshot.nodes?.[deps.nodeId] ?? null;
  const limit = deps.rosterLimit ?? MESH_NODE_STATE_ROSTER_LIMIT;

  const own = projectHomeAgents(snapshot, deps.actorDisplayName)
    .filter((agent) => agent.homeNodeId === deps.nodeId);

  const workload = { total: own.length, working: 0, available: 0, offline: 0 };
  for (const agent of own) {
    if (agent.state === "working") workload.working += 1;
    else if (agent.state === "available") workload.available += 1;
    else workload.offline += 1;
  }

  const ownAgentIds = new Set(own.map((agent) => agent.id));
  const sessionLimit = deps.sessionLimit ?? MESH_NODE_STATE_SESSION_LIMIT;
  const workLimit = deps.workLimit ?? MESH_NODE_STATE_WORK_LIMIT;

  // Sessions name their own node, so they are scoped directly rather than
  // inferred from the agent they serve.
  // Both lists are capped, so order decides what an operator actually sees.
  // Registry order is insertion order, which on a long-lived machine means the
  // oldest records — a live session or a running flight would fall off the end
  // behind a window of finished work. Rank before the cap: live first, then
  // most recent.
  const sessions = Object.values(snapshot.endpoints ?? {})
    .filter((endpoint) => endpoint.nodeId === deps.nodeId && ownAgentIds.has(endpoint.agentId))
    .sort((a, b) => sessionRank(snapshot, b) - sessionRank(snapshot, a));
  const work = Object.values(snapshot.flights ?? {})
    .filter((flight) => ownAgentIds.has(flight.targetAgentId))
    .sort((a, b) => flightRank(b) - flightRank(a));

  return {
    kind: "mesh-node-state",
    version: 1,
    nodeId: deps.nodeId,
    meshId: deps.meshId ?? node?.meshId ?? null,
    name: node?.name ?? null,
    hostName: node?.hostName ?? null,
    capabilities: node?.capabilities ?? [],
    observedAt: deps.now?.() ?? Date.now(),
    workload: { ...workload, truncated: own.length > limit },
    roster: own.slice(0, limit).map((agent) => ({
      id: agent.id,
      title: agent.title,
      role: agent.role,
      // The repo an agent belongs to, never a pane's working directory: the
      // home projection falls back to `endpoint.cwd`, and this route promises
      // not to carry that.
      projectRoot: repoRoot(snapshot, agent.id, sessions),
      state: agent.state,
      statusLabel: agent.statusLabel,
      lastSeenAt: agent.lastSeenAt,
    })),
    sessions: {
      total: sessions.length,
      truncated: sessions.length > sessionLimit,
      items: sessions.slice(0, sessionLimit).map((endpoint) => ({
        id: endpoint.id,
        agentId: endpoint.agentId,
        harness: endpoint.harness ?? null,
        transport: endpoint.transport ?? null,
        state: endpoint.state,
        sessionId: endpoint.sessionId ?? null,
        // `projectRoot` only — `cwd` is a pane detail and stays home.
        projectRoot: endpoint.projectRoot ?? null,
      })),
    },
    work: {
      total: work.length,
      running: work.filter((flight) => isWorkingFlightState(flight.state)).length,
      truncated: work.length > workLimit,
      items: work.slice(0, workLimit).map((flight) => ({
        id: flight.id,
        targetAgentId: flight.targetAgentId,
        state: flight.state,
        summary: clip(flight.summary),
        startedAt: flight.startedAt ?? null,
        completedAt: flight.completedAt ?? null,
      })),
    },
  };
}

/**
 * Timestamps sit on the record on some shapes and in `metadata` on others, so
 * recency is the newest of whichever are present rather than one named field.
 */
const RECENCY_KEYS = ["completedAt", "updatedAt", "startedAt", "lastSeenAt", "createdAt"] as const;

function recency(record: { metadata?: Record<string, unknown> }): number {
  const bag = record as unknown as Record<string, unknown>;
  let latest = 0;
  for (const key of RECENCY_KEYS) {
    const own = bag[key];
    const meta = record.metadata?.[key];
    if (typeof own === "number" && Number.isFinite(own)) latest = Math.max(latest, own);
    if (typeof meta === "number" && Number.isFinite(meta)) latest = Math.max(latest, meta);
  }
  return latest;
}

/** A session still attached outranks one that has ended; then most recent. */
function sessionRank(snapshot: RuntimeRegistrySnapshot, endpoint: AgentEndpoint): number {
  return (isStaleLocalEndpoint(snapshot, endpoint) ? 0 : 1e15) + recency(endpoint);
}

/** Work in flight outranks finished work; then most recent. */
function flightRank(flight: FlightRecord): number {
  return (isWorkingFlightState(flight.state) ? 1e15 : 0) + recency(flight);
}

/**
 * The repo an agent is registered against: its own card first, then a session's
 * declared `projectRoot`. Never `cwd` — a pane's working directory is a local
 * detail, and this route promises not to carry it.
 */
function repoRoot(
  snapshot: RuntimeRegistrySnapshot,
  agentId: string,
  sessions: readonly AgentEndpoint[],
): string | null {
  const declared = snapshot.agents?.[agentId]?.metadata?.projectRoot;
  if (typeof declared === "string" && declared.trim()) return declared;
  const session = sessions.find((endpoint) => endpoint.agentId === agentId && endpoint.projectRoot);
  return session?.projectRoot ?? null;
}

/** Status lines cross the mesh; logs and transcripts do not. */
function clip(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}
