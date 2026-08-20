import "./scope-views.css";

import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import type { Route, TailDiscoverySnapshot } from "../../lib/types.ts";
import { RawSessionsTable } from "../../screens/sessions/RawSessionsTable.tsx";
import { SessionRefScreen } from "../../screens/sessions/SessionRefScreen.tsx";
import { useScopePresentationAttrs } from "../hooks.ts";

const DISCOVERY_INTERVAL_MS = 10_000;

export function ScopeSessionsView({
  route,
  navigate,
}: {
  route: Extract<Route, { view: "sessions" }>;
  navigate: (r: Route) => void;
}) {
  const scopeAttrs = useScopePresentationAttrs();
  const [discovery, setDiscovery] = useState<TailDiscoverySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDiscovery = useCallback(async () => {
    setError(null);
    try {
      setDiscovery(await api<TailDiscoverySnapshot>("/api/tail/discover"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadDiscovery();
    const id = setInterval(() => void loadDiscovery(), DISCOVERY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [loadDiscovery]);

  const totalSessions = discovery?.transcripts?.length ?? 0;
  const activeCount = discovery?.processes?.length ?? 0;

  if (route.sessionId) {
    return (
      <div className="scope-sessions-route" data-scope-view="sessions" {...scopeAttrs}>
        <SessionRefScreen sessionRef={route.sessionId} navigate={navigate} />
      </div>
    );
  }

  return (
    <div className="scope-sessions-route" data-scope-view="sessions" {...scopeAttrs}>
      <div className="scope-sessions">
        <header className="scope-sessions__bar">
          <div className="scope-sessions__summary">
            <span className="scope-sessions__count">
              {totalSessions} session{totalSessions === 1 ? "" : "s"}
            </span>
            {activeCount > 0 ? (
              <span className="scope-sessions__live">{activeCount} active</span>
            ) : null}
            {error ? <span className="scope-sessions__warn">discovery error</span> : null}
          </div>
        </header>
        <div className="scope-sessions__body">
          <div className="scope-sessions__atop">
            <RawSessionsTable navigate={navigate} />
          </div>
        </div>
      </div>
    </div>
  );
}