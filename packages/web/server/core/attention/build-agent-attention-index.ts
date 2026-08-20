/**
 * Shared sourcing for the per-agent needs-attention index.
 *
 * Both the web `/api/agents` path and the mobile `mobile/agents` RPC need the
 * exact same "which agent is waiting on the operator" join, so the sourcing
 * lives here as the single source of truth. It gathers the two surviving
 * attention sources — session attention (question / approval / blocked-status
 * items projected from pairing-session snapshots) and operator collaboration
 * rows — and joins them to fleet agent ids, using the live broker snapshot as
 * the authority on which agent currently holds each session.
 *
 * See `agent-attention.ts` for the pure join (`buildAgentAttentionIndex`) and
 * how the resulting index is applied (`applyAgentAttention`).
 */

import { projectSessionsAttention } from "@openscout/runtime";

import { getScoutWebPairingSessionSnapshots } from "../../pairing.ts";
import { queryAgentIdsByEndpointSessionId } from "../../db/agents.ts";
import { queryOperatorAttentionRows } from "../../db/fleet.ts";
import { selectPreferredAgentEndpoint } from "../agent-endpoints.ts";
import type { ScoutBrokerContext } from "../broker/service.ts";
import { buildAgentAttentionIndex, type AgentAttentionEntry } from "./agent-attention.ts";

/** How long a built index stays fresh. The web endpoint is polled every ~2.5s
 *  per client and each rebuild opens a bridge socket via the pairing read, so a
 *  short shared TTL keeps concurrent post-TTL polls from stampeding it. */
export const AGENT_ATTENTION_TTL_MS = 2_000;

/**
 * Build the per-agent attention index from live sources. Never throws:
 * attention is a decoration on the agent list, never a reason to fail it, so a
 * broken source yields an empty index instead of an error.
 */
export async function buildAgentAttentionIndexSnapshot(
  broker: ScoutBrokerContext | null,
): Promise<Map<string, AgentAttentionEntry>> {
  try {
    const snapshots = await getScoutWebPairingSessionSnapshots().catch(() => []);
    const sessionItems = snapshots.length > 0 ? projectSessionsAttention(snapshots) : [];
    const agentIdBySessionId = queryAgentIdsByEndpointSessionId();
    // The broker snapshot is the live authority on which agent currently holds a
    // session — it overrides any stale endpoint row in the db.
    for (const agent of Object.values(broker?.snapshot.agents ?? {})) {
      const sessionId = broker
        ? selectPreferredAgentEndpoint(broker.snapshot, agent.id)?.sessionId?.trim()
        : null;
      if (sessionId) {
        agentIdBySessionId.set(sessionId, agent.id);
      }
    }
    return buildAgentAttentionIndex({
      sessionItems,
      agentIdBySessionId,
      collaborationRows: queryOperatorAttentionRows(),
    });
  } catch {
    return new Map<string, AgentAttentionEntry>();
  }
}

type AgentAttentionCache = { at: number; index: Map<string, AgentAttentionEntry> };

/**
 * Wrap a snapshot builder with a short TTL cache and single-flight coalescing,
 * so concurrent callers past the TTL share one rebuild rather than each opening
 * a pairing bridge socket. Returns a function with the same signature.
 */
export function createAgentAttentionIndexReader(options: {
  ttlMs?: number;
} = {}): (broker: ScoutBrokerContext | null) => Promise<Map<string, AgentAttentionEntry>> {
  const ttlMs = options.ttlMs ?? AGENT_ATTENTION_TTL_MS;
  let cache: AgentAttentionCache | null = null;
  let inFlight: Promise<Map<string, AgentAttentionEntry>> | null = null;

  return (broker) => {
    const cached = cache;
    if (cached && Date.now() - cached.at < ttlMs) {
      return Promise.resolve(cached.index);
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = buildAgentAttentionIndexSnapshot(broker)
      .then((index) => {
        cache = { at: Date.now(), index };
        return index;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
