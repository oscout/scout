import type { ObservedActivity, ScoutId } from "@openscout/protocol";

/**
 * Activity transition times.
 *
 * `ObservedStatusProjection.transitionAt` is "when the current activity began",
 * and no snapshot projection can compute it: both
 * `projectObservedStatusForAgent` and `projectAgentActivityFromRuntimeSnapshot`
 * are pure functions over one registry snapshot, with no memory of what the
 * agent was doing a moment ago. Time-in-state is state.
 *
 * So the transition log is the small piece of memory that makes the timestamp
 * possible. It lives in broker memory next to the presence map, shares its
 * lifetime, and is handed to the projection as an option — projections without
 * one stay pure and simply leave `transitionAt` undefined.
 *
 * One tracker serves both readers. The fleet surface and chat presence must
 * agree on how long an agent has been blocked; two trackers would drift and the
 * disagreement would be visible on screen.
 */

export interface ActivityTransition {
  activity: ObservedActivity;
  transitionAt: number;
}

export interface ActivityTransitionLog {
  /**
   * Record an observation and return the state-entry time for it.
   *
   * `observedAt` is the projection's `updatedAt`. When the activity is new it
   * seeds `transitionAt`, which recovers real history the broker never saw: a
   * flight whose `startedAt` was nine minutes ago is nine minutes into
   * `working`, and stamping `now` instead would reset every agent's clock to
   * zero on broker restart. Future-dated stamps are clamped to `now`.
   */
  record(agentId: ScoutId, activity: ObservedActivity, observedAt: number, now: number): number;
  peek(agentId: ScoutId): ActivityTransition | undefined;
  forget(agentId: ScoutId): void;
  clear(): void;
  size(): number;
}

export class ActivityTransitionTracker implements ActivityTransitionLog {
  private readonly transitions = new Map<ScoutId, ActivityTransition>();

  record(agentId: ScoutId, activity: ObservedActivity, observedAt: number, now: number): number {
    const previous = this.transitions.get(agentId);
    if (previous && previous.activity === activity) {
      return previous.transitionAt;
    }

    const transitionAt = Number.isFinite(observedAt) ? Math.min(observedAt, now) : now;
    this.transitions.set(agentId, { activity, transitionAt });
    return transitionAt;
  }

  peek(agentId: ScoutId): ActivityTransition | undefined {
    const transition = this.transitions.get(agentId);
    return transition ? { ...transition } : undefined;
  }

  forget(agentId: ScoutId): void {
    this.transitions.delete(agentId);
  }

  clear(): void {
    this.transitions.clear();
  }

  size(): number {
    return this.transitions.size;
  }
}
