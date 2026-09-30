import type { ControlEvent } from "@openscout/protocol";

import type { BrokerRefreshPolicy } from "./broker-refresh-controller.ts";
import type { BrokerEvent } from "./sse.ts";

type ControlEventKind = ControlEvent["kind"];

// Which broker events change which payloads. Typed against the ControlEvent
// union, so a kind the broker never emits (there is no "agent.updated") fails
// to compile instead of silently never matching.

/** `/api/agents`: who is registered and where they can be reached. */
export const AGENT_ROSTER_EVENT_KINDS: readonly ControlEventKind[] = [
  "node.upserted",
  "actor.registered",
  "agent.registered",
  "agent.endpoint.upserted",
  "agent.endpoint.deleted",
  "invocation.requested",
  "flight.updated",
  "delivery.state.changed",
  "scout.dispatched",
];

/** `/api/fleet`: asks, flights, activity, and each agent's live state. */
export const FLEET_EVENT_KINDS: readonly ControlEventKind[] = [
  "agent.registered",
  "agent.endpoint.upserted",
  "agent.endpoint.deleted",
  "message.posted",
  "invocation.requested",
  "flight.updated",
  "delivery.state.changed",
  "collaboration.upserted",
  "collaboration.event.appended",
  "scout.dispatched",
  // Agent working/idle transitions arrive only as presence.
  "presence.updated",
];

/** `/api/conversations`: the thread list and its unread state. */
export const CONVERSATION_EVENT_KINDS: readonly ControlEventKind[] = [
  "conversation.upserted",
  "binding.upserted",
  "message.posted",
  "message.corrected",
  "conversation.read_cursor.updated",
];

export function matchesKinds(
  ...groups: ReadonlyArray<readonly ControlEventKind[]>
): (event: BrokerEvent) => boolean {
  const kinds = new Set<string>(groups.flat());
  return (event) => kinds.has(event.kind);
}

// Shared policies for payloads more than one screen loads. The live rate is
// the net for what no event describes, not the refresh rate: events drive it.

/** `/api/fleet` alone. */
export const FLEET_REFRESH_POLICY: BrokerRefreshPolicy = {
  matches: matchesKinds(FLEET_EVENT_KINDS),
  fallbackPollMs: 10_000,
  livePollMs: 60_000,
};

/**
 * Conversations + fleet + `/api/tail/discover`. Local process discovery has no
 * broker event, so the live net stays short enough for a new session to show.
 */
export const AGENT_DIRECTORY_REFRESH_POLICY: BrokerRefreshPolicy = {
  matches: matchesKinds(FLEET_EVENT_KINDS, CONVERSATION_EVENT_KINDS),
  fallbackPollMs: 10_000,
  livePollMs: 30_000,
};
