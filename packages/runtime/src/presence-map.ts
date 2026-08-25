import type {
  ObservedStatusProjection,
  PresenceBeat,
  PresenceSnapshot,
  ScoutId,
} from "@openscout/protocol";
import {
  PRESENCE_GONE_AFTER_STALE_MS,
  PRESENCE_STALE_AFTER_MS,
  isPresenceGone,
} from "@openscout/protocol";

import { ActivityTransitionTracker, type ActivityTransitionLog } from "./activity-transitions.js";

/**
 * The broker's in-memory presence map.
 *
 * `Map<agentId, PresenceBeat>`, last-writer-wins. No table, no row, no record —
 * a restart clears it and the next observations repopulate it, which is correct
 * behaviour rather than data loss: presence describes what is happening *now*,
 * and a broker that just restarted does not know that yet.
 *
 * Keyed per agent, never per (agent × room). Rooms filter and gate this one
 * map, so chat presence and the fleet surface read the same truth by
 * construction and cannot disagree.
 *
 * The map is also its own backlog. A subscriber that connects gets
 * {@link snapshot}, not a replay — latest-per-key is exactly the state a new
 * viewer needs, and it keeps presence churn out of the shared bounded
 * control-event backlog.
 */

export interface PresenceObservation {
  status: ObservedStatusProjection;
  agentId?: ScoutId;
  displayName?: string;
  /** The durable `scout need` record behind a waiting state, when one exists. */
  needRef?: ScoutId;
  /** The conversation the agent's current work belongs to, when it has one. */
  boundConversationId?: ScoutId;
}

export interface PresenceObserveResult {
  beat: PresenceBeat;
  /**
   * True when this observation changed the agent's activity (or its detail,
   * past the debounce). Only transitions go on the wire; plain heartbeats bump
   * the map in place and emit nothing.
   */
  transitioned: boolean;
  /** Previous activity, when the agent already had an entry. */
  previousActivity?: PresenceBeat["activity"];
}

export interface BrokerPresenceMapOptions {
  staleAfterMs?: number;
  goneAfterStaleMs?: number;
  /**
   * Minimum gap between detail-only transitions for one agent. A detail string
   * that flickers ("running test 3 of 900") must not turn a transition-only
   * stream back into a per-beat stream.
   */
  detailDebounceMs?: number;
  /**
   * Shared transition log. Pass the same instance used for status projections
   * so `transitionAt` is identical everywhere it is read.
   */
  transitions?: ActivityTransitionLog;
}

const DEFAULT_DETAIL_DEBOUNCE_MS = 5_000;

export class BrokerPresenceMap {
  private readonly beats = new Map<ScoutId, PresenceBeat>();
  private readonly lastDetailChangeAt = new Map<ScoutId, number>();
  private readonly staleAfterMs: number;
  private readonly goneAfterStaleMs: number;
  private readonly detailDebounceMs: number;
  readonly transitions: ActivityTransitionLog;

  constructor(options: BrokerPresenceMapOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? PRESENCE_STALE_AFTER_MS;
    this.goneAfterStaleMs = options.goneAfterStaleMs ?? PRESENCE_GONE_AFTER_STALE_MS;
    this.detailDebounceMs = options.detailDebounceMs ?? DEFAULT_DETAIL_DEBOUNCE_MS;
    this.transitions = options.transitions ?? new ActivityTransitionTracker();
  }

  /**
   * Fold one observed status into the map.
   *
   * Emission is broker-side by design: this is fed from what the broker already
   * observes, so agents cannot forget to emit what they never emit. An agent may
   * enrich `detail`; it is never the source of the state.
   */
  observe(observation: PresenceObservation, now: number): PresenceObserveResult | undefined {
    const agentId = observation.agentId ?? observation.status.agentId ?? observation.status.subjectId;
    if (!agentId) return undefined;

    const status = observation.status;

    // The status projection infers `activity: "stalled"` from an endpoint that
    // stopped heartbeating. That is transport silence wearing the name of a
    // semantic state, and presence must not repeat the conflation: `stalled`
    // means beats are arriving and the agent looks stuck (loud and fresh),
    // while silence means the observer went quiet (faded and dated). Silence is
    // already expressed by the beat's own decay, so drop the inference and let
    // the last real activity age honestly — "last seen executing · 2m ago".
    if (isTransportInferredStall(status)) return undefined;

    const updatedAt = Math.min(status.updatedAt, now);
    const staleAt = Math.max(status.staleAt ?? 0, updatedAt + this.staleAfterMs);

    // Evidence that has already decayed past the stale window is not an
    // observation, it is the same silence seen again. Folding it back in would
    // resurrect a gone agent on every sample and republish it forever — the
    // indicator-outlives-process bug, arrived at by a flap loop.
    if (isPresenceGone({ staleAt }, now, { goneAfterStaleMs: this.goneAfterStaleMs })) {
      this.forget(agentId);
      return undefined;
    }

    const previous = this.beats.get(agentId);
    const detail = status.detail?.title ?? undefined;

    // `transitionAt` comes from the shared log, so the map and any status
    // projection reading the same log report identical time-in-state.
    //
    // Seeded from the projection's own state-entry stamp when it carries one.
    // `updatedAt` answers "when was this last confirmed", not "when did this
    // begin" — seeding from it reports a nine-minute turn as brand new.
    const transitionAt = this.transitions.record(
      agentId,
      status.activity,
      status.transitionAt ?? status.updatedAt,
      now,
    );

    const activityChanged = previous?.activity !== status.activity;
    const detailChanged = previous !== undefined && previous.detail !== detail;
    const debounceElapsed = now - (this.lastDetailChangeAt.get(agentId) ?? 0) >= this.detailDebounceMs;
    const transitioned = previous === undefined || activityChanged || (detailChanged && debounceElapsed);

    if (activityChanged || (detailChanged && debounceElapsed)) {
      this.lastDetailChangeAt.set(agentId, now);
    }

    const beat: PresenceBeat = {
      agentId,
      displayName: observation.displayName ?? previous?.displayName,
      activity: status.activity,
      phase: status.phase,
      detail,
      transitionAt,
      updatedAt,
      staleAt,
      confidence: status.confidence,
      needRef: observation.needRef,
      boundConversationId: observation.boundConversationId,
    };

    this.beats.set(agentId, beat);
    return { beat, transitioned, previousActivity: previous?.activity };
  }

  /**
   * Live beats as of `now`, gone entries dropped.
   *
   * Stale-but-not-gone beats are deliberately included: "the observer went
   * quiet — long tool call, or dead, cannot yet tell" is the honest state, and
   * hiding it at first expiry would erase the ambiguity the operator needs.
   * Renderers classify with `presenceLifecycle` and fade accordingly.
   */
  snapshot(now: number): PresenceSnapshot {
    this.prune(now);
    return { at: now, beats: [...this.beats.values()] };
  }

  get(agentId: ScoutId): PresenceBeat | undefined {
    return this.beats.get(agentId);
  }

  /**
   * Drop decayed entries. Called on read and on a sweep interval — never
   * announced. A "presence expired" event would be the indicator-outlives-
   * process bug wearing a different hat, since it can only travel over the
   * transport that just went quiet. Every renderer computes decay from
   * `staleAt` itself.
   */
  prune(now: number): ScoutId[] {
    const dropped: ScoutId[] = [];
    for (const [agentId, beat] of this.beats) {
      if (!isPresenceGone(beat, now, { goneAfterStaleMs: this.goneAfterStaleMs })) continue;
      this.beats.delete(agentId);
      this.lastDetailChangeAt.delete(agentId);
      this.transitions.forget(agentId);
      dropped.push(agentId);
    }
    return dropped;
  }

  forget(agentId: ScoutId): void {
    this.beats.delete(agentId);
    this.lastDetailChangeAt.delete(agentId);
    this.transitions.forget(agentId);
  }

  clear(): void {
    this.beats.clear();
    this.lastDetailChangeAt.clear();
    this.transitions.clear();
  }

  size(): number {
    return this.beats.size;
  }
}

/**
 * True when `stalled` was inferred from missing observations rather than
 * observed from a running agent.
 *
 * Distinguished by provenance: a `staleness_inference` entry means the
 * projection reached that activity because nothing arrived, not because
 * something did.
 */
function isTransportInferredStall(status: ObservedStatusProjection): boolean {
  if (status.activity !== "stalled") return false;
  return status.provenance.some((entry) => entry.source === "staleness_inference");
}
