import type { TrackedRequest } from "./chat-api.ts";

/** A feed read begun before a response must not undo its acknowledged version. */
export function mergeChatRequestResponsibilities(previous: TrackedRequest[], incoming: TrackedRequest[]): TrackedRequest[] {
  const known = new Map(previous.map(request => [request.flightId, request.responsibility]));
  return incoming.map(request => {
    const prior = known.get(request.flightId);
    const next = request.responsibility;
    return prior && next && prior.recordId === next.recordId && prior.updatedAt != null && next.updatedAt != null && prior.updatedAt > next.updatedAt
      ? { ...request, responsibility: prior } : request;
  });
}
