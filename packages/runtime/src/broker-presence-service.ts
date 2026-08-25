import type {
  ObservedStatusProjection,
  PresenceSnapshot,
  PresenceUpdatedEvent,
  ScoutId,
} from "@openscout/protocol";
import { PRESENCE_REFRESH_INTERVAL_MS } from "@openscout/protocol";

import type { RuntimeRegistrySnapshot } from "./registry.js";
import { projectObservedStatusesFromRuntimeSnapshot } from "./observed-status-projection.js";
import { BrokerPresenceMap, type BrokerPresenceMapOptions } from "./presence-map.js";

export type PresenceProjectionSnapshot = Pick<
  RuntimeRegistrySnapshot,
  "agents" | "endpoints" | "invocations" | "flights" | "collaborationRecords"
>;

export interface BrokerPresenceServiceDeps {
  snapshot: () => PresenceProjectionSnapshot;
  /**
   * Fan-out for a transition. Must route to the ephemeral path — nothing here
   * may create a durable record.
   */
  publish: (event: PresenceUpdatedEvent) => void;
  createId: (prefix: string) => string;
  actorId: ScoutId;
  nodeId?: ScoutId;
  now?: () => number;
  map?: BrokerPresenceMapOptions;
  /** Maximum gap between emitted beats while fresh evidence keeps arriving. */
  refreshIntervalMs?: number;
}

/**
 * Samples observed agent status into the presence map and emits transitions.
 *
 * The sampling loop is the whole emission mechanism: agents never publish
 * presence, so they cannot forget to. What the broker already observes becomes
 * presence for free, and an agent's only influence is enriching the `detail`
 * string on the status it already reports.
 */
export class BrokerPresenceService {
  readonly presence: BrokerPresenceMap;
  private readonly lastPublished = new Map<ScoutId, { at: number; updatedAt: number }>();
  private readonly refreshIntervalMs: number;

  constructor(private readonly deps: BrokerPresenceServiceDeps) {
    this.presence = new BrokerPresenceMap(deps.map);
    this.refreshIntervalMs = Math.max(1, deps.refreshIntervalMs ?? PRESENCE_REFRESH_INTERVAL_MS);
  }

  /** Current live map, for handing to a subscriber on connect. */
  snapshot(now = this.now()): PresenceSnapshot {
    return this.presence.snapshot(now);
  }

  /**
   * Synthesize the map as `presence.updated` events.
   *
   * A new subscriber gets state, not history: latest-per-agent replayed as if
   * each had just transitioned. These events are ephemeral like every other
   * presence event and are never backlogged.
   */
  snapshotEvents(now = this.now()): PresenceUpdatedEvent[] {
    return this.snapshot(now).beats.map((beat) => this.presenceEvent(beat, undefined, now));
  }

  /**
   * Project every known agent, fold it into the map, publish transitions.
   *
   * Returns the number of updates published. Activity/detail transitions are
   * immediate. Otherwise a freshness refresh is emitted at a bounded cadence
   * while newer liveness evidence keeps arriving; without that refresh a
   * connected client would eventually classify its last `staleAt` as stale
   * even though the broker's private map kept receiving heartbeats.
   */
  sample(now = this.now()): number {
    const snapshot = this.deps.snapshot();
    const statuses = projectObservedStatusesFromRuntimeSnapshot(snapshot, {
      now,
      transitions: this.presence.transitions,
    });

    let published = 0;
    for (const status of statuses) {
      const agentId = status.agentId ?? status.subjectId;
      const result = this.presence.observe({
        status,
        agentId,
        displayName: snapshot.agents[agentId]?.displayName,
        needRef: needRefForStatus(status),
        boundConversationId: boundConversationIdForStatus(status, snapshot),
      }, now);
      if (!result) continue;
      const lastPublished = this.lastPublished.get(agentId);
      const refreshDue = !result.transitioned
        && lastPublished !== undefined
        && result.beat.updatedAt > lastPublished.updatedAt
        && now - lastPublished.at >= this.refreshIntervalMs;
      if (!result.transitioned && !refreshDue) continue;
      this.deps.publish(this.presenceEvent(
        result.beat,
        result.transitioned ? result.previousActivity : undefined,
        now,
      ));
      this.lastPublished.set(agentId, { at: now, updatedAt: result.beat.updatedAt });
      published += 1;
    }

    this.forgetPublished(this.presence.prune(now));
    return published;
  }

  /**
   * Drop decayed entries without emitting anything.
   *
   * Expiry is deliberately silent. A killed agent disappears from every surface
   * within the TTL because each renderer is already computing decay from
   * `staleAt`; an "expired" event would have to travel the same transport that
   * just went quiet, which is exactly why it cannot be trusted to arrive.
   */
  sweep(now = this.now()): ScoutId[] {
    const dropped = this.presence.prune(now);
    this.forgetPublished(dropped);
    return dropped;
  }

  private presenceEvent(
    beat: PresenceUpdatedEvent["payload"]["beat"],
    previousActivity: PresenceUpdatedEvent["payload"]["previousActivity"],
    now: number,
  ): PresenceUpdatedEvent {
    return {
      id: this.deps.createId("evt"),
      kind: "presence.updated",
      ts: now,
      actorId: this.deps.actorId,
      nodeId: this.deps.nodeId,
      payload: { beat, previousActivity },
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private forgetPublished(agentIds: ScoutId[]): void {
    for (const agentId of agentIds) this.lastPublished.delete(agentId);
  }
}

/**
 * Link a waiting state back to the durable ask that caused it.
 *
 * Presence never carries the question itself — an ephemeral ask is a lost ask.
 * It carries a reference, so a chat chip can link to the real record while the
 * beat behind it expires normally. When the harness observes waiting with no
 * declared question (a permission prompt, an idle input), there is simply no
 * ref: a true state without a durable question attached, which is honest.
 */
function needRefForStatus(status: ObservedStatusProjection): ScoutId | undefined {
  if (status.subjectKind !== "question") return undefined;
  if (status.activity !== "waiting_for_input" && status.activity !== "waiting_on_actor") {
    return undefined;
  }
  return status.subjectId;
}

/**
 * Which conversation the agent's current work belongs to, if any.
 *
 * Rooms use this to decide whether they may show the `detail` string: work
 * bound elsewhere renders as bare activity, so a room never narrates what the
 * agent is doing somewhere else.
 */
function boundConversationIdForStatus(
  status: ObservedStatusProjection,
  snapshot: PresenceProjectionSnapshot,
): ScoutId | undefined {
  switch (status.subjectKind) {
    case "work_item":
    case "question":
      return snapshot.collaborationRecords[status.subjectId]?.conversationId;
    case "flight": {
      const flight = snapshot.flights[status.subjectId];
      return flight ? snapshot.invocations[flight.invocationId]?.conversationId : undefined;
    }
    default:
      return undefined;
  }
}
