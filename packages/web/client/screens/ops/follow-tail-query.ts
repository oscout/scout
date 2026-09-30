import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import type { FollowTarget, Route } from "../../lib/types.ts";

type TailFollowTarget = FollowTarget & { harnessSessionId?: string | null };

/** Public brokers return the resolved harness id as sessionId; newer ones name it explicitly. */
export function resolvedFollowTailQuery(target: TailFollowTarget): string | undefined {
  return target.harnessSessionId?.trim() || target.sessionId?.trim() || undefined;
}

/**
 * A follow link lands on the tail with Scout ids (flight, invocation, session,
 * chat) in the URL. Tail events carry the harness's own session id instead,
 * so a `q` built from Scout ids matches nothing. When those ids are present,
 * ask the broker which harness session they point at and filter on that.
 */
export function useFollowTailQuery(route: Route, tailQuery: string | undefined): string | undefined {
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
  const [resolved, setResolved] = useState<{ key: string; query: string } | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    api<TailFollowTarget>(`/api/follow?${key}`)
      .then((target) => {
        const harnessSessionId = resolvedFollowTailQuery(target);
        if (!cancelled && harnessSessionId) setResolved({ key, query: harnessSessionId });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key]);

  return resolved && resolved.key === key ? resolved.query : tailQuery;
}
