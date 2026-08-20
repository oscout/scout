// Canonical client-side paths for the broker HTTP API. The routes defined here
// are served by the broker runtime; a route-inventory test ensures every entry
// in this map matches a live implementation.

export const scoutBrokerPaths = {
  health: "/health",
  v1: {
    home: "/v1/home",
    node: "/v1/node",
    snapshot: "/v1/snapshot",
    capabilities: "/v1/capabilities",
    runtimeCatalog: "/v1/runtime-catalog",
    topologySnapshot: "/v1/topology/snapshot",
    tailDiscover: "/v1/tail/discover",
    tailRecent: "/v1/tail/recent",
    repoWatchSnapshot: "/v1/repo-watch/snapshot",
    messages: "/v1/messages",
    brokerMessages: "/v1/broker/messages",
    eventsStream: "/v1/events/stream",
    actors: "/v1/actors",
    agents: "/v1/agents",
    endpoints: "/v1/endpoints",
    conversations: "/v1/conversations",
    invocations: "/v1/invocations",
    flights: "/v1/flights",
    deliver: "/v1/deliver",
    rendezvousMatch: "/v1/rendezvous/match",
    aliases: "/v1/aliases",
    aliasesResolve: "/v1/aliases/resolve",
    activity: "/v1/activity",
    collaborationRecords: "/v1/collaboration/records",
    collaborationEvents: "/v1/collaboration/events",
    pairingAttach: "/v1/pairing/attach",
    pairingDetach: "/v1/pairing/detach",
    localSessionsAttach: "/v1/local-sessions/attach",
    localSessionsDetach: "/v1/local-sessions/detach",
  },
} as const;

export function scoutBrokerMessagesListPath(search: URLSearchParams): string {
  const q = search.toString();
  return q ? `${scoutBrokerPaths.v1.messages}?${q}` : scoutBrokerPaths.v1.messages;
}

export function scoutBrokerMessagesPath(search: URLSearchParams): string {
  const q = search.toString();
  return q
    ? `${scoutBrokerPaths.v1.brokerMessages}?${q}`
    : scoutBrokerPaths.v1.brokerMessages;
}

export function scoutBrokerInvocationPath(invocationId: string): string {
  return `${scoutBrokerPaths.v1.invocations}/${encodeURIComponent(invocationId)}`;
}

export function scoutBrokerInvocationStreamPath(invocationId: string): string {
  return `${scoutBrokerInvocationPath(invocationId)}/stream`;
}

export function scoutBrokerInvocationLifecyclePath(invocationId: string): string {
  return `${scoutBrokerInvocationPath(invocationId)}/lifecycle`;
}
