import type { ChannelInviteRecord, ChannelReception } from "@openscout/protocol";

import {
  channelMemberReception,
  type ChannelMemberEndpointSnapshot,
} from "./channel-invites.ts";

/**
 * Turning a channel post into work, or not.
 *
 * The rule this module exists to enforce: **a channel post is an update; only
 * an explicitly addressed agent creates a tracked ask.** Posting to a room must
 * never invoke everyone in it, and mentioning a person must never invoke
 * anything at all. So the decision of what becomes work is made here, in one
 * pure function, rather than being spread across the posting path where it
 * would be easy to widen by accident.
 *
 * The second rule: an ask goes to the session the invitation attached, not to
 * whatever session that agent happens to be running now. The redemption is the
 * only thing that says which session belongs in this room.
 */

export interface ChannelAskCandidate {
  actorId: string;
  /** Present only for actors the broker knows as agents. */
  isAgent: boolean;
  /** Freshest endpoint for this actor, or null. */
  endpoint: ChannelMemberEndpointSnapshot | null;
  label?: string;
  /**
   * True for a member who joined over HTTP with no session behind them.
   *
   * They are an agent and they are in the room, but there is nothing to route
   * an invocation to and there never will be through that path. Saying so is
   * the whole point: the alternative is a request that looks dispatched and is
   * waiting on a reader who may not poll again.
   */
  isApiParticipant?: boolean;
}

export interface PlannedChannelAsk {
  actorId: string;
  label: string;
  /** The exact session the invitation attached. An ask without one cannot route. */
  sessionId: string;
  reception: ChannelReception;
}

export interface SkippedChannelAsk {
  actorId: string;
  label: string;
  /**
   * Why no tracked ask was created. This is surfaced, never swallowed: the
   * person who addressed the agent has to learn that nothing was dispatched.
   */
  reason: "not_a_member" | "not_an_agent" | "no_attached_session" | "api_participant";
  detail: string;
}

export interface ChannelAskPlan {
  asks: PlannedChannelAsk[];
  skipped: SkippedChannelAsk[];
}

export function planChannelAsks(input: {
  /** Actor ids explicitly mentioned in the post. */
  mentionedActorIds: string[];
  /** The channel's current roster. */
  participantIds: string[];
  candidates: ChannelAskCandidate[];
  invites: ChannelInviteRecord[];
  nowMs: number;
}): ChannelAskPlan {
  const asks: PlannedChannelAsk[] = [];
  const skipped: SkippedChannelAsk[] = [];
  const members = new Set(input.participantIds.map((id) => id.trim()));
  const byActorId = new Map(
    input.candidates.map((candidate) => [candidate.actorId.trim(), candidate]),
  );

  // Deduplicate: mentioning the same agent twice in one message is one ask.
  const mentioned = [...new Set(
    input.mentionedActorIds.map((id) => id.trim()).filter(Boolean),
  )];

  for (const actorId of mentioned) {
    const candidate = byActorId.get(actorId);
    const label = candidate?.label?.trim() || actorId;

    if (!members.has(actorId)) {
      skipped.push({
        actorId,
        label,
        reason: "not_a_member",
        detail: `${label} is not in this channel, so nothing was dispatched.`,
      });
      continue;
    }

    // Ahead of both checks below, because both would describe this member
    // wrongly. A lightweight participant is not a person, and it is not an
    // agent that *happens* to have no session attached yet; it is a member who
    // joined through a path that attaches none, and the asker needs to hear
    // the difference -- one is worth waiting for, the other will not change on
    // its own.
    if (candidate?.isApiParticipant) {
      skipped.push({
        actorId,
        label,
        reason: "api_participant",
        detail: `${label} joined this channel over the API and has no session to`
          + ` route work to. Post in the channel instead; they read it when they`
          + ` next poll, and nothing will wake them before that.`,
      });
      continue;
    }

    // Mentioning a person notifies them. It is not an invocation, and it is not
    // a failure either -- so it is simply not an ask and not reported as
    // skipped work.
    if (!candidate?.isAgent) {
      skipped.push({
        actorId,
        label,
        reason: "not_an_agent",
        detail: `${label} is a person. They were mentioned, not asked.`,
      });
      continue;
    }

    const reception = channelMemberReception({
      actorId,
      invites: input.invites,
      endpoint: candidate.endpoint,
      nowMs: input.nowMs,
    });

    if (!reception.attachedSessionId) {
      skipped.push({
        actorId,
        label,
        reason: "no_attached_session",
        detail: `${label} has not redeemed an invitation from a session, so there is no session to route this to.`,
      });
      continue;
    }

    // An unreachable agent still gets a tracked ask. The work is real and owed;
    // the reception reading rides along so the surface can say "queued -- not
    // listening right now" rather than showing a spinner that implies delivery.
    asks.push({
      actorId,
      label,
      sessionId: reception.attachedSessionId,
      reception,
    });
  }

  return { asks, skipped };
}

/**
 * Short, honest status for a tracked ask at the moment it is raised.
 *
 * This describes the *route*, never the outcome. Readiness is not a receipt:
 * a live endpoint means a message can be attempted, not that anything received
 * it. Actual acceptance and delivery come from delivery records and the
 * flight's own lifecycle, and only those may say a request arrived -- so the
 * word "delivered" does not appear here at all.
 */
export function channelAskDispatchNote(reception: ChannelReception, label: string): string {
  if (reception.routeKind === "wake_on_delivery") {
    return `Queued for ${label}. Nothing is listening between messages; delivery resumes that session.`;
  }
  switch (reception.state) {
    case "ready_to_receive":
      return `Queued for ${label}, whose session is attached and watching.`;
    case "waiting_for_agent":
      return `Queued. ${label} has no session attached to this channel yet.`;
    case "connecting":
      return `Queued for ${label}, whose receive route is not confirmed yet.`;
    case "disconnected":
      return `Queued. ${label} is disconnected, so this will not arrive until they reconnect.`;
    case "unavailable":
      return `Queued. ${label} has no usable receive route right now.`;
    default:
      return `Queued for ${label}.`;
  }
}
