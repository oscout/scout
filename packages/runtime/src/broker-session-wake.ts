import { basename } from "node:path";

import type { ActorIdentity, AgentEndpoint, NodeDefinition } from "@openscout/protocol";

import type { ExactSessionWakeInput } from "./broker-delivery-routing.js";
import {
  buildCardlessSessionActor,
  buildCardlessSessionEndpoint,
  resolveCardlessSessionSpawnTarget,
  type CardlessSessionRegistry,
} from "./broker-cardless-session.js";
import { compareLocalEndpointPreference, endpointCandidateState } from "./broker-endpoint-selection.js";
import { findLiveClaudeSession } from "./claude-session-records.js";
import { sessionObservationMetadata, type LocalEndpointSessionObservation } from "./session-observation.js";
import { locateHarnessSession } from "./session-locator.js";

/**
 * Flat session dispatch, local rung (T3) plus mesh rung (T4).
 *
 * T3: locate the native session in this machine's harness store and register a
 * cardless flat-dispatch endpoint for it (extracted from the broker daemon so
 * the mesh wake route can run the identical wake on behalf of a peer).
 *
 * T4: when the local store misses, ask trusted reachable peers to run their own
 * T3 via `POST /v1/mesh/sessions/wake`; the winning peer returns the endpoint
 * it registered (owned by its node id) so the origin broker can adopt it and
 * dispatch through the existing cross-node forwarding path.
 */

export type LocalSessionWakeResult =
  | { ok: true; endpoint: AgentEndpoint; actor?: ActorIdentity }
  | { ok: false; reason: string; detail: string; remediation?: string };

export type LocalSessionWakeDeps = {
  nodeId: string;
  registry: CardlessSessionRegistry;
  snapshotEndpoints: () => Record<string, AgentEndpoint>;
  actorFor?: (actorId: string) => ActorIdentity | undefined;
  /** Whether the harness advertises a resume command (findHarnessEntry(h)?.resume). */
  harnessSupportsResume: (harness: string) => boolean;
  locate?: typeof locateHarnessSession;
  observeEndpointSession?: (endpoint: AgentEndpoint) => Promise<LocalEndpointSessionObservation | null>;
  findLiveClaudeSession?: (nativeSessionId: string) => Promise<{ sessionId: string } | null>;
  log?: (message: string) => void;
};

/** Stable scout session marker for a native id so re-asks hit the same endpoint. */
export function flatDispatchSessionId(harness: string, nativeSessionId: string): string {
  return `flat-${harness}-${nativeSessionId}`;
}

export async function wakeLocalHarnessSession(
  deps: LocalSessionWakeDeps,
  input: ExactSessionWakeInput,
): Promise<LocalSessionWakeResult> {
  const locate = deps.locate ?? locateHarnessSession;
  const located = locate({
    nativeSessionId: input.nativeSessionId,
    harness: input.harness,
    projectPath: input.projectPath,
  });
  if (!located.ok) {
    return {
      ok: false,
      reason: located.reason,
      detail: located.detail,
      ...(located.remediation ? { remediation: located.remediation } : {}),
    };
  }

  const session = located.session;
  if (!deps.harnessSupportsResume(session.harness)) {
    return {
      ok: false,
      reason: "session_not_resumable",
      detail: `harness "${session.harness}" does not advertise a resume command`,
      remediation: `bring a ${session.harness} worker online first, or use a resumable harness`,
    };
  }

  let spawn: ReturnType<typeof resolveCardlessSessionSpawnTarget>;
  try {
    spawn = resolveCardlessSessionSpawnTarget(session.harness);
  } catch (error) {
    return {
      ok: false,
      reason: "session_not_resumable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const cwd = session.cwd || input.projectPath?.trim();
  if (!cwd) {
    return {
      ok: false,
      reason: "session_not_resumable",
      detail: `session ${session.nativeSessionId} has no cwd; pass --project`,
      remediation: `scout ask --to session:${session.harness}:${session.nativeSessionId} --project <cwd>`,
    };
  }

  const scoutSessionId = flatDispatchSessionId(session.harness, session.nativeSessionId);
  const endpoints = Object.values(deps.snapshotEndpoints()).filter((endpoint) => endpoint.nodeId === deps.nodeId);
  // A tmux endpoint's cached alias is not proof of which Claude process owns
  // its pane. Correlate first so an exact continuation cannot create a second
  // worker merely because the original endpoint lacks its provider id.
  if (session.harness === "claude") {
    try {
      const matches: AgentEndpoint[] = [];
      const physicalOwners = new Set<string>();
      for (const endpoint of endpoints) {
        if (endpoint.transport !== "tmux" || endpoint.harness !== "claude" || endpointCandidateState(endpoint.state) === "offline") continue;
        const observed = await deps.observeEndpointSession?.(endpoint);
        if (observed?.sessionId !== session.nativeSessionId) continue;
        const { pid, tmuxSession, tmuxPane } = observed.evidence;
        // Registry and isolated projections can describe the same live pane.
        // Only concrete process evidence permits collapsing those projections.
        const ownerKey = typeof pid === "number" && Number.isInteger(pid) && pid > 0
          && typeof tmuxSession === "string" && tmuxSession.length > 0
          && typeof tmuxPane === "string" && tmuxPane.length > 0
          ? JSON.stringify([pid, tmuxSession, tmuxPane])
          : `unverified-owner:${endpoint.id}`;
        physicalOwners.add(ownerKey);
        matches.push({ ...endpoint, metadata: { ...endpoint.metadata, ...sessionObservationMetadata(endpoint, observed) } });
      }
      if (physicalOwners.size > 1) {
        return { ok: false, reason: "session_ambiguous", detail: `session ${session.nativeSessionId} has multiple live tmux process owners` };
      }
      matches.sort((left, right) => compareLocalEndpointPreference(left, right) || left.id.localeCompare(right.id));
      if (matches[0]) {
        const endpoint = matches[0];
        await deps.registry.upsertEndpoint(endpoint);
        return { ok: true, endpoint, ...(deps.actorFor?.(endpoint.agentId) ? { actor: deps.actorFor(endpoint.agentId) } : {}) };
      }

    } catch (error) {
      return { ok: false, reason: "session_runtime_unobserved", detail: `cannot verify live ownership of session ${session.nativeSessionId}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const existing = endpoints.find((endpoint) => {
    if (session.harness === "claude" && endpoint.transport === "tmux") return false;
    if (typeof endpoint.metadata?.externalSessionAdoptedAt === "number") return false;
    const aliases = [endpoint.sessionId, endpoint.metadata?.externalSessionId, endpoint.metadata?.threadId, endpoint.metadata?.nativeSessionId]
      .map((value) => typeof value === "string" ? value.trim() : "");
    return aliases.includes(session.nativeSessionId) || endpoint.agentId === scoutSessionId;
  });
  if (existing && existing.state !== "offline" && existing.state !== "failed" && existing.state !== "stopped") {
    return { ok: true, endpoint: existing, ...(deps.actorFor?.(existing.agentId) ? { actor: deps.actorFor(existing.agentId) } : {}) };
  }

  if (session.harness === "claude") {
    try {
      const live = await (deps.findLiveClaudeSession ?? findLiveClaudeSession)(session.nativeSessionId);
      if (live) {
        return { ok: false, reason: "session_live_unbound", detail: `session ${session.nativeSessionId} is already running without a verified Scout endpoint`, remediation: "attach the existing session before retrying its exact continuation" };
      }
    } catch (error) {
      return { ok: false, reason: "session_runtime_unobserved", detail: `cannot verify live ownership of session ${session.nativeSessionId}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const cardlessInput = {
    sessionId: scoutSessionId,
    handle: scoutSessionId,
    transport: spawn.transport,
    harness: spawn.harness,
    cwd,
    projectRoot: cwd,
    nodeId: deps.nodeId,
    externalSessionId: session.nativeSessionId,
    nativeSessionId: session.nativeSessionId,
    flatDispatch: true,
    displayName: `${basename(cwd)}:${session.nativeSessionId.slice(0, 8)}`,
  };
  try {
    const actor = buildCardlessSessionActor(cardlessInput);
    const endpoint = buildCardlessSessionEndpoint(cardlessInput);
    await deps.registry.upsertActor(actor);
    await deps.registry.upsertEndpoint(endpoint);
    deps.log?.(
      `[openscout-runtime] flat-dispatch wake ${session.harness}:${session.nativeSessionId} via ${spawn.transport} cwd=${cwd}`,
    );
    return { ok: true, endpoint, actor };
  } catch (error) {
    return {
      ok: false,
      reason: "session_wake_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export type PeerSessionWakeResponse = {
  ok: boolean;
  reason?: string;
  detail?: string;
  remediation?: string;
  endpoint?: AgentEndpoint;
  actor?: ActorIdentity;
};

export type PeerSessionWakeDeps = {
  localNodeId: string;
  /** Candidate peers, already filtered to reachable trusted nodes. */
  peers: NodeDefinition[];
  postJson: <TResponse>(brokerBaseUrl: string, path: string, payload: unknown) => Promise<TResponse>;
  registry: CardlessSessionRegistry;
  log?: (message: string) => void;
};

export type PeerSessionWakeResult =
  | { ok: true; peerNodeId: string; endpoint: AgentEndpoint }
  | { ok: false; peersTried: number };

export const MESH_SESSION_WAKE_PATH = "/v1/mesh/sessions/wake";

/**
 * T4: ask each candidate peer to locate + wake the session in its own harness
 * store. On the first hit, adopt the peer-owned endpoint (and session actor)
 * into the local registry — the same rows mesh agent sync would deliver — so
 * the caller can re-resolve and dispatch through peer forwarding.
 */
export async function wakeSessionOnPeers(
  deps: PeerSessionWakeDeps,
  input: ExactSessionWakeInput,
): Promise<PeerSessionWakeResult> {
  let tried = 0;
  for (const peer of deps.peers) {
    if (!peer.brokerUrl || peer.id === deps.localNodeId) continue;
    tried += 1;
    let response: PeerSessionWakeResponse;
    try {
      response = await deps.postJson<PeerSessionWakeResponse>(peer.brokerUrl, MESH_SESSION_WAKE_PATH, {
        nativeSessionId: input.nativeSessionId,
        ...(input.harness ? { harness: input.harness } : {}),
        ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      });
    } catch (error) {
      deps.log?.(
        `[openscout-runtime] mesh session wake failed on ${peer.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!response?.ok || !response.endpoint) continue;
    // Endpoint authority stays with the peer: adopt it verbatim, node id and all.
    if (response.endpoint.nodeId !== peer.id) {
      deps.log?.(
        `[openscout-runtime] mesh session wake on ${peer.id} returned endpoint owned by ${response.endpoint.nodeId}; ignoring`,
      );
      continue;
    }
    if (response.actor) {
      await deps.registry.upsertActor(response.actor);
    }
    await deps.registry.upsertEndpoint(response.endpoint);
    deps.log?.(
      `[openscout-runtime] mesh session wake: ${input.nativeSessionId} lives on ${peer.id}; adopted endpoint ${response.endpoint.id}`,
    );
    return { ok: true, peerNodeId: peer.id, endpoint: response.endpoint };
  }
  return { ok: false, peersTried: tried };
}
