import type { ScoutId } from "./common.js";
import type { ObservedActivity, ObservedStatusPhase } from "./observed-status.js";

/**
 * Agent presence — the shared staleness primitive behind chat presence and the
 * spatial fleet surface.
 *
 * The framing that makes both surfaces work from one implementation: presence
 * is not a pulse, it is a *timestamped fact*.
 *
 *   "Agent A has been in activity S, about D, since `transitionAt` — this claim
 *    is fresh until `staleAt`."
 *
 * A pulse has to keep arriving to stay true. A timestamped fact keeps rendering
 * live without another byte on the wire, because every renderer derives the
 * changing part (age, decay) from the static payload. That is why decay is
 * never signalled: see {@link presenceLifecycle}.
 */

/**
 * How long a beat stays fresh after its last observation.
 *
 * Sized at three missed observations on the ~15s broker cadence: one dropped
 * beat must never flap an agent out of freshness.
 */
export const PRESENCE_STALE_AFTER_MS = 45_000;

/**
 * How long a stale beat lingers before it is dropped entirely.
 *
 * This window is load-bearing, not a grace period. "The observer went quiet —
 * busy in a long tool call, or dead, cannot yet tell" is a real state, and
 * dropping cleanly at first expiry would erase exactly the ambiguity the
 * operator needs to see.
 */
export const PRESENCE_GONE_AFTER_STALE_MS = 60_000;

/**
 * Transport freshness of a beat. Derived from timestamps, never transmitted.
 *
 * IMPORTANT — this is not the agent's activity, and the two must never be
 * conflated. `stale` means *no beats are arriving*: the observer went quiet.
 * `activity === "stalled"` means beats **are** arriving and inference says the
 * agent is stuck. They carry opposite information and must render oppositely:
 * stalled is loud and fresh, stale is faded and dated.
 */
export type PresenceLifecycle = "fresh" | "stale" | "gone";

/**
 * One agent's current presence. Keyed per agent, never per (agent × room):
 * the activity is a fact about the agent's single runtime, so a
 * per-conversation "what am I doing in *this* room" would be fiction for any
 * agent doing one thing at a time. Rooms filter and gate this one entry.
 */
export interface PresenceBeat {
  agentId: ScoutId;
  displayName?: string;
  /** Existing 16-value vocabulary, verbatim — presence adds no second enum. */
  activity: ObservedActivity;
  /** Carried for non-running edge rendering (error, stopped, unconfigured…). */
  phase: ObservedStatusPhase;
  /** `ObservedStatusDetail.title` — room-gated by `conversationBound`. */
  detail?: string;
  /** When the current activity began. The load-bearing timestamp. */
  transitionAt: number;
  /** Last observation. Freshness input only. */
  updatedAt: number;
  /** Decay boundary. Required here even though it is optional upstream. */
  staleAt: number;
  confidence: number;
  /**
   * When waiting: the durable `scout need` record behind this state.
   *
   * Presence is never the carrier of a question — an ephemeral ask is a lost
   * ask. This is a reference to the durable record, so the loud chat chip can
   * link to the actual question. The invariant is directional: every declared
   * ask produces a presence state; not every presence-waiting has a declared
   * ask (a harness can observe a permission prompt with no need record); and no
   * ask ever exists *only* in presence.
   */
  needRef?: ScoutId;
  /**
   * The conversation the agent's current work is bound to, when it is bound to
   * one.
   *
   * A per-agent beat cannot carry "is this bound to *your* room" as a boolean —
   * one global entry is read by every room at once, so the boolean would have
   * to be true and false simultaneously. It carries the conversation id
   * instead, and each room derives the answer with
   * {@link isPresenceBoundToConversation}: full `activity + detail` when the
   * work is this room's, bare activity otherwise, so the detail string does not
   * announce what the agent is doing elsewhere.
   */
  boundConversationId?: ScoutId;
}

/** A full presence map, as handed to a subscriber on connect. */
export interface PresenceSnapshot {
  /** When the snapshot was taken — the "as of" for every beat in it. */
  at: number;
  beats: PresenceBeat[];
}

export interface PresenceLifecycleOptions {
  /** Override the linger window after `staleAt`. */
  goneAfterStaleMs?: number;
}

/**
 * Classify a beat's transport freshness at `now`.
 *
 * Every renderer computes this locally and continuously. The broker never
 * emits a "now stale" event — a presence-expired signal is the
 * indicator-outlives-process bug wearing a different hat, since it can only
 * arrive over the same transport that just went quiet.
 */
export function presenceLifecycle(
  beat: Pick<PresenceBeat, "staleAt">,
  now: number,
  options: PresenceLifecycleOptions = {},
): PresenceLifecycle {
  if (now < beat.staleAt) return "fresh";
  const goneAfterStaleMs = options.goneAfterStaleMs ?? PRESENCE_GONE_AFTER_STALE_MS;
  if (now < beat.staleAt + goneAfterStaleMs) return "stale";
  return "gone";
}

/** Age of the current activity — the number an operator actually reads. */
export function presenceAgeMs(beat: Pick<PresenceBeat, "transitionAt">, now: number): number {
  return Math.max(0, now - beat.transitionAt);
}

/** How long the claim itself has gone unrefreshed. Only meaningful once stale. */
export function presenceSilenceMs(beat: Pick<PresenceBeat, "updatedAt">, now: number): number {
  return Math.max(0, now - beat.updatedAt);
}

/**
 * Whether a room may render this beat's `detail`.
 *
 * Room-gating is a rendering rule over one global map, not a second map: the
 * activity is a fact about the agent's single runtime, and a per-conversation
 * "what am I doing in *this* room" would be fiction for any agent doing one
 * thing at a time.
 */
export function isPresenceBoundToConversation(
  beat: Pick<PresenceBeat, "boundConversationId">,
  conversationId: ScoutId,
): boolean {
  return beat.boundConversationId !== undefined && beat.boundConversationId === conversationId;
}

/** True once the beat has decayed past the stale window and should be dropped. */
export function isPresenceGone(
  beat: Pick<PresenceBeat, "staleAt">,
  now: number,
  options: PresenceLifecycleOptions = {},
): boolean {
  return presenceLifecycle(beat, now, options) === "gone";
}
