import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import type { FollowTarget, Route } from "../../lib/types.ts";

/**
 * A follow link lands on the tail with Scout ids (flight, invocation, session,
 * chat) in the URL. Tail events carry the harness's own session id instead,
 * so a `q` built from Scout ids matches nothing. When those ids are present,
 * ask the broker which harness session they point at and filter on that.
 * Keep resolving while mounted: a queued flight may not have a session yet,
 * and a retry may later move it to another session.
 */
export function useFollowTailQuery(route: Route, tailQuery: string | undefined): {
  query: string | undefined;
  sessionId: string | undefined;
} {
  const params = new URLSearchParams();
  if (route.view === "ops" && route.mode === "tail") {
    if (route.flightId) params.set("flightId", route.flightId);
    if (route.invocationId) params.set("invocationId", route.invocationId);
    if (route.conversationId) params.set("conversationId", route.conversationId);
    if (route.workId) params.set("workId", route.workId);
    if (route.sessionId) params.set("sessionId", route.sessionId);
    if (route.targetAgentId) params.set("targetAgentId", route.targetAgentId);
  }
  const key = params.toString();
  const [resolved, setResolved] = useState<{ key: string; query: string | undefined } | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let pending = false;
    const resolve = async () => {
      if (pending) return;
      pending = true;
      try {
        const target = await api<FollowTarget>(`/api/follow?${key}`);
        if (!cancelled) setResolved({ key, query: target.harnessSessionId?.trim() || undefined });
      } catch {
        // Keep the scoped fallback on transient failure and retry next tick.
      } finally {
        pending = false;
      }
    };
    void resolve();
    const timer = setInterval(() => void resolve(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key]);

  const sessionId = resolved?.key === key ? resolved.query : undefined;
  // Never show the whole fleet while waiting for a typed task to resolve.
  const fallback = tailQuery || [...params.values()].join("|") || undefined;
  return { query: sessionId ?? fallback, sessionId };
}
