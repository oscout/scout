import type { AgentEndpoint, CollaborationRecord, FlightRecord } from "@openscout/protocol";

import { isTerminalFlightState } from "./broker-local-invocation-helpers.js";
import type { RuntimeRegistrySnapshot } from "./registry.js";

/**
 * Relay-agent tmux session reaper.
 *
 * Registered relay agents run inside detached tmux sessions whose server is
 * parented to launchd, so a relay that nobody stops explicitly lives forever.
 * The wake path (`ensureLocalAgentBindingOnline`) already treats a missing
 * tmux session as a sleeping agent and recreates it on demand, which makes
 * "kill the tmux session" a safe, reversible sleep — this reaper supplies the
 * sleep trigger that was never built.
 *
 * Reaping is attribution-first: a tmux session is only ever a candidate when
 * the relay registry (or a process lease) positively claims it. Arbitrary
 * operator tmux sessions are untouchable by construction. Note this reaps
 * relay *processes*, never their registrations — registration GC is a
 * separate, eligibility-constrained problem.
 */

export const DEFAULT_RELAY_AGENT_SESSION_IDLE_TTL_MS = 4 * 60 * 60 * 1_000;

export type RelayAgentTmuxSession = {
  name: string;
  /** Number of attached tmux clients; attached sessions are never reaped. */
  attached: number;
  createdAtMs: number | null;
  activityAtMs: number | null;
};

/** tmux session name -> relay agent id that owns it. */
export type RelayAgentSessionOwnership = ReadonlyMap<string, string>;

export type RelayAgentSessionExpiryCandidate = {
  session: RelayAgentTmuxSession;
  agentId: string;
  idleMs: number;
};

/**
 * Broker-side records may carry either the bare registry agent id or its
 * instance-qualified form (`<agentId>.<workspace>.<node>`). Vetoes match both
 * spellings in both directions so a busy relay is never reaped because of an
 * id-qualification mismatch.
 */
function matchesAgentId(candidate: string | undefined, agentId: string): boolean {
  if (!candidate) return false;
  return candidate === agentId
    || candidate.startsWith(`${agentId}.`)
    || agentId.startsWith(`${candidate}.`);
}

function activeFlightForAgent(flight: FlightRecord, agentId: string): boolean {
  return matchesAgentId(flight.targetAgentId, agentId) && !isTerminalFlightState(flight.state);
}

function activeCollaborationForAgent(record: CollaborationRecord, agentId: string): boolean {
  const addressed = matchesAgentId(record.ownerId, agentId) || matchesAgentId(record.nextMoveOwnerId, agentId);
  if (!addressed) return false;
  if (record.kind === "work_item") {
    return record.state !== "done" && record.state !== "cancelled";
  }
  return record.state !== "closed" && record.state !== "declined";
}

function metadataTimestamp(endpoint: AgentEndpoint, key: string): number {
  const raw = endpoint.metadata?.[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function endpointMatchesSession(endpoint: AgentEndpoint, agentId: string, sessionName: string): boolean {
  if (!matchesAgentId(endpoint.agentId, agentId)) return false;
  const sessionId = endpoint.sessionId
    ?? (typeof endpoint.metadata?.tmuxSession === "string" ? endpoint.metadata.tmuxSession : null);
  return !sessionId || sessionId === sessionName;
}

function lastBrokerActivity(
  snapshot: RuntimeRegistrySnapshot,
  agentId: string,
  sessionName: string,
): number {
  let latest = 0;
  for (const endpoint of Object.values(snapshot.endpoints)) {
    if (!endpointMatchesSession(endpoint, agentId, sessionName)) continue;
    latest = Math.max(
      latest,
      metadataTimestamp(endpoint, "startedAt"),
      metadataTimestamp(endpoint, "lastResumedAt"),
      metadataTimestamp(endpoint, "lastCompletedAt"),
      metadataTimestamp(endpoint, "lastFailedAt"),
    );
  }
  for (const flight of Object.values(snapshot.flights)) {
    if (!matchesAgentId(flight.targetAgentId, agentId)) continue;
    latest = Math.max(latest, flight.completedAt ?? flight.startedAt ?? 0);
  }
  for (const record of Object.values(snapshot.collaborationRecords)) {
    if (matchesAgentId(record.ownerId, agentId) || matchesAgentId(record.nextMoveOwnerId, agentId)) {
      latest = Math.max(latest, record.updatedAt);
    }
  }
  return latest;
}

export function idleRelayAgentSessionCandidates(input: {
  sessions: RelayAgentTmuxSession[];
  owners: RelayAgentSessionOwnership;
  snapshot: RuntimeRegistrySnapshot;
  now?: number;
  idleTtlMs?: number;
}): RelayAgentSessionExpiryCandidate[] {
  const now = input.now ?? Date.now();
  const idleTtlMs = Math.max(60_000, input.idleTtlMs ?? DEFAULT_RELAY_AGENT_SESSION_IDLE_TTL_MS);
  const candidates: RelayAgentSessionExpiryCandidate[] = [];

  for (const session of input.sessions) {
    // Positive attribution is the reap license; unknown sessions are not ours.
    const agentId = input.owners.get(session.name);
    if (!agentId) continue;

    // A human attached to the pane is using it, whatever the broker thinks.
    if (session.attached > 0) continue;

    if (Object.values(input.snapshot.endpoints).some((endpoint) =>
      endpointMatchesSession(endpoint, agentId, session.name) && endpoint.state === "active",
    )) {
      continue;
    }
    if (Object.values(input.snapshot.flights).some((flight) => activeFlightForAgent(flight, agentId))) {
      continue;
    }
    if (Object.values(input.snapshot.collaborationRecords).some((record) =>
      activeCollaborationForAgent(record, agentId),
    )) {
      continue;
    }

    // tmux's own activity clock is ground truth for the pane: a relay doing
    // broker-invisible work still produces terminal output. Broker-side
    // activity extends it so a freshly dispatched-to relay is never clipped.
    const lastActivity = Math.max(
      session.activityAtMs ?? 0,
      session.createdAtMs ?? 0,
      lastBrokerActivity(input.snapshot, agentId, session.name),
    );
    if (lastActivity <= 0 || lastActivity + idleTtlMs > now) {
      continue;
    }

    candidates.push({ session, agentId, idleMs: now - lastActivity });
  }

  return candidates;
}

export type RelayAgentSessionReaperOptions = {
  snapshot: () => RuntimeRegistrySnapshot;
  listTmuxSessions: () => Promise<RelayAgentTmuxSession[]>;
  listSessionOwners: () => Promise<RelayAgentSessionOwnership>;
  killSession: (sessionName: string) => Promise<void>;
  reconcileLeases?: (input: {
    liveSessionNames: ReadonlySet<string>;
    owners: RelayAgentSessionOwnership;
  }) => void;
  idleTtlMs?: number;
  now?: () => number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

export class RelayAgentSessionReaper {
  constructor(private readonly options: RelayAgentSessionReaperOptions) {}

  /**
   * One pass: enumerate live tmux sessions, put expired relays to sleep, and
   * reconcile ownership leases with what is actually alive. Run at startup
   * (previous-run orphans carry a stale tmux activity clock, so the same pass
   * reaps them) and on an interval.
   */
  async sweep(reason: "startup" | "periodic"): Promise<number> {
    const [sessions, owners] = await Promise.all([
      this.options.listTmuxSessions(),
      this.options.listSessionOwners(),
    ]);

    const initialCandidates = idleRelayAgentSessionCandidates({
      sessions,
      owners,
      snapshot: this.options.snapshot(),
      now: this.now(),
      idleTtlMs: this.options.idleTtlMs,
    });

    let reaped = 0;
    const reapedNames = new Set<string>();
    for (const initialCandidate of initialCandidates) {
      // Re-evaluate against a fresh snapshot immediately before the kill so a
      // just-dispatched flight wins the race against the reaper.
      const candidate = idleRelayAgentSessionCandidates({
        sessions: [initialCandidate.session],
        owners,
        snapshot: this.options.snapshot(),
        now: this.now(),
        idleTtlMs: this.options.idleTtlMs,
      })[0];
      if (!candidate) continue;

      try {
        await this.options.killSession(candidate.session.name);
      } catch (error) {
        this.options.warn?.(
          `[openscout-runtime] failed to put relay agent ${candidate.agentId} to sleep (session ${candidate.session.name}): ${error instanceof Error ? error.message : error}`,
        );
        continue;
      }
      reaped += 1;
      reapedNames.add(candidate.session.name);
      this.options.log?.(
        `[openscout-runtime] put idle relay agent ${candidate.agentId} to sleep (session ${candidate.session.name}, idle ${Math.round(candidate.idleMs / 60_000)}m, ${reason} sweep)`,
      );
    }

    try {
      this.options.reconcileLeases?.({
        liveSessionNames: new Set(
          sessions.map((session) => session.name).filter((name) => !reapedNames.has(name)),
        ),
        owners,
      });
    } catch (error) {
      this.options.warn?.(
        `[openscout-runtime] relay-agent lease reconcile failed: ${error instanceof Error ? error.message : error}`,
      );
    }

    return reaped;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
