import { Columns2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { formatClockTimestamp, timeAgo } from "../../lib/time.ts";
import type { Flight, FlightSessionTrace, Route } from "../../lib/types.ts";
import { resolveFlightSessionId, uniqueFlightSessions } from "./flight-observe.ts";
import { SessionRefScreen } from "./SessionRefScreen.tsx";

import "./flight-observe.css";

type FlightObserveRoute = Extract<Route, { view: "sessions" }> & { flightId: string };

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 34) return sessionId;
  return `${sessionId.slice(0, 15)}…${sessionId.slice(-14)}`;
}

function strategyLabel(session: FlightSessionTrace, index: number): string {
  if (index === 0) return session.strategy || "dispatch";
  return session.strategy ? `switched via ${session.strategy}` : "session changed";
}

function SessionSelect({
  label,
  sessions,
  value,
  onChange,
}: {
  label: string;
  sessions: FlightSessionTrace[];
  value: string;
  onChange: (sessionId: string) => void;
}) {
  return (
    <label className="s-flight-observe-select-wrap">
      <span>{label}</span>
      <select
        className="s-flight-observe-select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {sessions.map((session) => (
          <option key={session.sessionId} value={session.sessionId}>
            {session.harness ? `${session.harness} · ` : ""}{session.sessionId}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FlightObserveScreen({
  route,
  navigate,
}: {
  route: FlightObserveRoute;
  navigate: (route: Route) => void;
}) {
  const [flight, setFlight] = useState<Flight | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const flights = await api<Flight[]>(
        `/api/flights?active=false&flightId=${encodeURIComponent(route.flightId)}`,
      );
      setFlight(flights[0] ?? null);
      setError(flights.length === 0 ? "This flight is not available on the connected broker." : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [route.flightId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);
  useBrokerEvents(() => {
    void load();
  });

  const trace = flight?.sessions ?? [];
  const sessions = useMemo(() => uniqueFlightSessions(trace), [trace]);
  const selectedSessionId = resolveFlightSessionId(trace, route.sessionId);
  const selected = sessions.find((session) => session.sessionId === selectedSessionId) ?? null;
  const compared = sessions.find((session) => session.sessionId === route.compareSessionId) ?? null;
  const split = Boolean(selected && compared && selected.sessionId !== compared.sessionId);

  const updateSelection = useCallback((sessionId: string, compareSessionId?: string) => {
    navigate({
      ...route,
      sessionId,
      ...(compareSessionId ? { compareSessionId } : { compareSessionId: undefined }),
    });
  }, [navigate, route]);

  const startSplit = useCallback(() => {
    if (!selected || sessions.length < 2) return;
    const other = [...sessions].reverse().find((session) => session.sessionId !== selected.sessionId);
    if (!other) return;
    updateSelection(selected.sessionId, other.sessionId);
  }, [selected, sessions, updateSelection]);

  const selectTraceSession = useCallback((sessionId: string) => {
    if (!split || !selected || !compared) {
      updateSelection(sessionId);
      return;
    }
    updateSelection(
      sessionId,
      sessionId === compared.sessionId ? selected.sessionId : compared.sessionId,
    );
  }, [compared, selected, split, updateSelection]);

  return (
    <div className="s-flight-observe">
      <header className="s-flight-observe-header">
        <div className="s-flight-observe-heading">
          <div className="s-flight-observe-eyebrow">Flight observe</div>
          <div className="s-flight-observe-title-row">
            <h2>{flight?.agentName || flight?.agentId || "Flight"}</h2>
            <span className={`s-flight-observe-state s-flight-observe-state--${flight?.state ?? "loading"}`}>
              {flight?.state ?? (loading ? "loading" : "unknown")}
            </span>
          </div>
          <div className="s-flight-observe-id" title={route.flightId}>{route.flightId}</div>
          {flight?.summary && <p>{flight.summary}</p>}
        </div>

        <div className="s-flight-observe-actions">
          {sessions.length > 1 && !split && (
            <button type="button" onClick={startSplit}>
              <Columns2 size={13} /> Split view
            </button>
          )}
          {split && selected && (
            <button type="button" onClick={() => updateSelection(selected.sessionId)}>
              <X size={13} /> Close split
            </button>
          )}
        </div>
      </header>

      {trace.length > 0 && (
        <nav className="s-flight-observe-trace" aria-label="Flight session history">
          {trace.map((session, index) => {
            const isSelected = selected?.sessionId === session.sessionId;
            const isCompared = compared?.sessionId === session.sessionId;
            return (
              <div className="s-flight-observe-trace-step" key={`${session.sessionId}:${session.startedAt}:${index}`}>
                {index > 0 && <span className="s-flight-observe-trace-arrow" aria-hidden="true">→</span>}
                <button
                  type="button"
                  className="s-flight-observe-session-chip"
                  data-selected={isSelected || isCompared}
                  data-observe-role={isSelected ? "primary" : isCompared ? "compare" : "idle"}
                  aria-pressed={isSelected || isCompared}
                  title={session.sessionId}
                  onClick={() => selectTraceSession(session.sessionId)}
                >
                  <span className="s-flight-observe-session-chip-top">
                    <span>{session.harness || session.transport || "session"}</span>
                    <time title={new Date(session.startedAt).toLocaleString()}>
                      {formatClockTimestamp(session.startedAt) || timeAgo(session.startedAt)}
                    </time>
                  </span>
                  <strong>{shortSessionId(session.sessionId)}</strong>
                  <small>{strategyLabel(session, index)}</small>
                </button>
              </div>
            );
          })}
        </nav>
      )}

      {error && !selectedSessionId && (
        <div className="s-flight-observe-message s-flight-observe-message--error">{error}</div>
      )}
      {error && selectedSessionId && (
        <div className="s-flight-observe-message">
          <strong>Flight record unavailable</strong>
          <span>Showing the concrete session captured by this link.</span>
        </div>
      )}
      {!error && loading && <div className="s-flight-observe-message">Resolving the flight’s session trace…</div>}
      {!error && !loading && sessions.length === 0 && !selectedSessionId && (
        <div className="s-flight-observe-message">
          <strong>Waiting for a session</strong>
          <span>The flight is stable here; its trace will appear as soon as a harness acknowledges dispatch.</span>
        </div>
      )}

      {selectedSessionId && !split && (
        <main className="s-flight-observe-single">
          <SessionRefScreen
            sessionRef={selectedSessionId}
            navigate={navigate}
          />
        </main>
      )}

      {!error && selected && compared && split && (
        <main className="s-flight-observe-split">
          <section className="s-flight-observe-pane">
            <SessionSelect
              label="Primary session"
              sessions={sessions}
              value={selected.sessionId}
              onChange={(sessionId) => updateSelection(
                sessionId,
                sessionId === compared.sessionId ? selected.sessionId : compared.sessionId,
              )}
            />
            <div className="s-flight-observe-pane-content">
              <SessionRefScreen
                sessionRef={selected.sessionId}
                navigate={navigate}
                showObserveRail={false}
              />
            </div>
          </section>
          <section className="s-flight-observe-pane">
            <SessionSelect
              label="Compare session"
              sessions={sessions.filter((session) => session.sessionId !== selected.sessionId)}
              value={compared.sessionId}
              onChange={(sessionId) => updateSelection(selected.sessionId, sessionId)}
            />
            <div className="s-flight-observe-pane-content">
              <SessionRefScreen
                sessionRef={compared.sessionId}
                navigate={navigate}
                showObserveRail={false}
              />
            </div>
          </section>
        </main>
      )}
    </div>
  );
}
