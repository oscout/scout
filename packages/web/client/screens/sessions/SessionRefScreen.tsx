import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { useTailEvents } from "../../lib/tail-events.ts";
import type {
  AgentObservePayload,
  ObserveData,
  Route,
  SessionEntry,
} from "../../lib/types.ts";
import type {
  ObserveEvidenceFidelity,
  ObserveEvidenceSource,
} from "../../lib/observe-fidelity.ts";
import { BackToPicker } from "../../scout/slots/BackToPicker.tsx";
import { ConversationScreen } from "../chat/ConversationScreen.tsx";
import { SessionObserve, SessionObserveContextRail } from "./SessionObserve.tsx";
import {
  activeSessionRefLookupState,
  brokerEventMayAffectSessionRef,
  createSessionRefLookupCoordinator,
  sessionRefsMatch,
  type SessionRefLookupState,
} from "./session-ref-lookup-state.ts";
import "../chat/inbox-thread-redesign.css";

export type SessionRefObservePayload =
  | ({
      kind: "agent";
      refId: string;
      agentId: string;
    } & Omit<AgentObservePayload, "agentId">)
  | {
      kind: "broker";
      refId: string;
      agentId: string;
      source: ObserveEvidenceSource;
      fidelity: ObserveEvidenceFidelity;
      historyPath: string | null;
      sessionId: string | null;
      updatedAt: number;
      data: ObserveData;
    }
  | {
      kind: "history";
      refId: string;
      agentId: null;
      source: "history";
      fidelity: "timestamped" | "synthetic";
      historyPath: string;
      sessionId: string;
      updatedAt: number;
      data: ObserveData;
    }
  | {
      kind: "tail";
      refId: string;
      agentId: null;
      source: "tail";
      fidelity: "synthetic";
      historyPath: string;
      sessionId: string;
      updatedAt: number;
      data: ObserveData;
    };

export type SessionRefLookup =
  | {
      kind: "conversation";
      refId: string;
      conversationId: string;
      session: SessionEntry;
    }
  | {
      kind: "observe";
      refId: string;
      session: SessionEntry | null;
      observe: SessionRefObservePayload;
    };

function normalizeSessionRef(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  const leaf = trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? trimmed;
  return leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
}

function isNativeProcessRef(value: string): boolean {
  return value.startsWith("native:process:");
}

function useSessionRefLookup(sessionRef: string) {
  const [state, setState] = useState<SessionRefLookupState<SessionRefLookup>>(() => ({
    sessionRef,
    lookup: null,
    loading: true,
    error: null,
  }));
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coordinatorRef = useRef<ReturnType<typeof createSessionRefLookupCoordinator<SessionRefLookup>> | null>(null);

  if (!coordinatorRef.current) {
    coordinatorRef.current = createSessionRefLookupCoordinator(
      (requestedRef) => api<SessionRefLookup>(
        `/api/session-ref/${encodeURIComponent(requestedRef)}`,
      ),
      ({ sessionRef: completedRef, result }) => {
        if (result.ok) {
          setState({
            sessionRef: completedRef,
            lookup: result.lookup,
            loading: false,
            error: null,
          });
          return;
        }
        setState({
          sessionRef: completedRef,
          lookup: null,
          loading: false,
          error: result.error instanceof Error ? result.error.message : String(result.error),
        });
      },
    );
  }

  const load = useCallback(async () => {
    await coordinatorRef.current!.request(sessionRef);
  }, [sessionRef]);

  useEffect(() => {
    setState({
      sessionRef,
      lookup: null,
      loading: true,
      error: null,
    });
    void load();
    return () => {
      coordinatorRef.current?.invalidate();
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [load, sessionRef]);

  // Effects run after render. Guard by ref here so the previous session cannot
  // remain visible (or writable) for even one paint while the new lookup starts.
  const { lookup, loading, error } = activeSessionRefLookupState(state, sessionRef);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void load();
    }, 1_000);
  }, [load]);

  useBrokerEvents((event) => {
    const refs = [
      sessionRef,
      lookup?.refId,
      lookup?.kind === "conversation" ? lookup.conversationId : null,
      lookup?.session?.agentId,
      lookup?.kind === "observe" ? lookup.observe.agentId : null,
      lookup?.kind === "observe" ? lookup.observe.sessionId : null,
    ];
    if (brokerEventMayAffectSessionRef(event, refs)) scheduleRefresh();
  });

  useTailEvents((event) => {
    const eventRef = normalizeSessionRef(event.sessionId);
    const routeRef = normalizeSessionRef(sessionRef);
    const observeRef = lookup?.kind === "observe"
      ? normalizeSessionRef(lookup.observe.sessionId ?? lookup.observe.refId)
      : "";
    const externalRef = lookup?.kind === "observe"
      ? normalizeSessionRef(lookup.observe.data.metadata?.session?.externalSessionId)
      : "";
    if (
      !sessionRefsMatch(eventRef, routeRef)
      && (!observeRef || !sessionRefsMatch(eventRef, observeRef))
      && (!externalRef || !sessionRefsMatch(eventRef, externalRef))
    ) {
      return;
    }

    scheduleRefresh();
  });

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  return { lookup, loading, error };
}

export function SessionRefContextRail({ sessionRef }: { sessionRef: string }) {
  const { lookup, loading, error } = useSessionRefLookup(sessionRef);

  if (lookup?.kind === "observe") {
    return (
      <SessionObserveContextRail
        data={lookup.observe.data}
        agentId={lookup.observe.agentId ?? lookup.session?.agentId ?? undefined}
        sessionId={lookup.observe.sessionId ?? lookup.observe.refId}
        surface="context"
        observeSource={lookup.observe.source}
        observeFidelity={lookup.observe.fidelity}
      />
    );
  }

  return (
    <aside className="s-observe-rail s-observe-rail--context">
      <div>
        <div className="s-observe-rail-label">
          {lookup?.kind === "conversation" ? "Conversation" : "Session context"}
        </div>
        <div className="s-observe-empty">
          {loading ? "Resolving session reference" : error ? "Session context unavailable" : "No observe context captured for this session"}
        </div>
      </div>
    </aside>
  );
}

export function SessionRefScreen({
  sessionRef,
  navigate,
  renderBeforeContent,
  showObserveRail = true,
  onLookup,
}: {
  sessionRef: string;
  navigate: (r: Route) => void;
  renderBeforeContent?: (lookup: SessionRefLookup) => ReactNode;
  showObserveRail?: boolean;
  onLookup?: (lookup: SessionRefLookup) => void;
}) {
  const { lookup, loading, error } = useSessionRefLookup(sessionRef);

  useEffect(() => {
    if (lookup) onLookup?.(lookup);
  }, [lookup, onLookup]);

  if (lookup?.kind === "conversation") {
    return (
      <>
        {renderBeforeContent?.(lookup)}
        <ConversationScreen
          conversationId={lookup.conversationId}
          navigate={navigate}
        />
      </>
    );
  }

  if (lookup?.kind === "observe") {
    return (
      <>
        {renderBeforeContent?.(lookup)}
        <SessionObserve
          data={lookup.observe.data}
          agentId={lookup.observe.agentId ?? lookup.session?.agentId ?? undefined}
          sessionId={lookup.observe.sessionId ?? lookup.observe.refId}
          conversationId={lookup.session?.id ?? null}
          showRail={showObserveRail}
          observeSource={lookup.observe.source}
          observeFidelity={lookup.observe.fidelity}
        />
      </>
    );
  }

  if (loading) {
    return (
      <div className="s-sessions-screen s-inbox-thread-redesign">
        <section className="s-thread-overview">
          <div className="s-thread-overview-copy">
            <div className="s-sessions-header s-thread-overview-heading">
              <h2 className="s-page-title">Session</h2>
              <span className="s-meta s-tabular">{sessionRef.slice(0, 8)}</span>
            </div>
            <p className="s-thread-overview-summary s-session-ref-loading">
              <span className="s-session-ref-loading-dot" />
              <span className="s-session-ref-loading-dot" />
              <span className="s-session-ref-loading-dot" />
              Resolving session reference
            </p>
          </div>
        </section>
      </div>
    );
  }

  const processOnlyRef = isNativeProcessRef(sessionRef);

  return (
    <div className="s-sessions-screen s-inbox-thread-redesign">
      <section className="s-thread-overview">
        <div className="s-thread-overview-copy">
          <div className="s-sessions-header s-thread-overview-heading">
            <h2 className="s-page-title">
              {processOnlyRef ? "Process trace unavailable" : "Session not found"}
            </h2>
            <span className="s-meta s-tabular">{sessionRef.slice(0, 8)}</span>
          </div>
          <p className="s-thread-overview-summary">
            {processOnlyRef
              ? "This is a live process handle, not a transcript session. No replayable session archive is attached yet."
              : "This session may have ended or the archive is not available on this machine."}
          </p>
          {error && (
            <p className="s-session-ref-error-detail">{error}</p>
          )}
          <div className="s-session-ref-nav-hint">
            <BackToPicker
              slot="sessions"
              fallback={{ view: "sessions" }}
              navigate={navigate}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
