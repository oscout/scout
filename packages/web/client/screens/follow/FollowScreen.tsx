import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.ts";
import {
  mergeFollowTargets,
  routeForFollowTarget,
  targetFromFollowRoute,
} from "../../lib/follow-route.ts";
import { setRouteMachineScope } from "../../lib/router.ts";
import type { FollowTarget, Route } from "../../lib/types.ts";
import "../chat/inbox-thread-redesign.css";

type FollowScreenProps = {
  route: Extract<Route, { view: "follow" }>;
  navigate: (r: Route) => void;
};

export function FollowScreen({ route, navigate }: FollowScreenProps) {
  const [error, setError] = useState<string | null>(null);
  const fallbackTarget = useMemo(() => targetFromFollowRoute(route), [route]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (route.flightId) params.set("flightId", route.flightId);
    if (route.invocationId) params.set("invocationId", route.invocationId);
    if (route.conversationId) params.set("conversationId", route.conversationId);
    if (route.workId) params.set("workId", route.workId);
    if (route.sessionId) params.set("sessionId", route.sessionId);
    if (route.targetAgentId) params.set("targetAgentId", route.targetAgentId);

    void (async () => {
      try {
        const query = params.toString();
        const resolved = query
          ? await api<FollowTarget>(`/api/follow?${query}`)
          : fallbackTarget;
        if (cancelled) return;
        navigate(
          setRouteMachineScope(routeForFollowTarget(
            mergeFollowTargets(resolved, fallbackTarget),
            route.preferredView,
          ), route.machineId ?? null),
        );
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        navigate(setRouteMachineScope(
          routeForFollowTarget(fallbackTarget, route.preferredView),
          route.machineId ?? null,
        ));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fallbackTarget, navigate, route]);

  return (
    <div className="s-sessions-screen s-inbox-thread-redesign">
      <section className="s-thread-overview">
        <div className="s-thread-overview-copy">
          <div className="s-sessions-header s-thread-overview-heading">
            <h2 className="s-page-title">Follow</h2>
            <span className="s-meta s-tabular">{route.preferredView ?? "auto"}</span>
          </div>
          <p className="s-thread-overview-summary">
            {error ? "Opening the closest available Scout view." : "Resolving Scout context..."}
          </p>
        </div>
      </section>
    </div>
  );
}
