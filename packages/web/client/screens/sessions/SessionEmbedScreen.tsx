/**
 * Session Embed (tail "load session") — the standalone, chrome-free route.
 *
 * Hosted by the macOS app in a WKWebView (a bottom sheet) when you open a tail
 * row's full session. Reads the tail event's `sessionId` from the query string
 * (`/embed/session?ref=<sessionId>&theme=<dark|light>`) and resolves it through
 * the same `/api/session-ref/:id` endpoint the web Sessions view uses.
 *
 * Renders ONLY the resolved session full-bleed — no app shell, no nav, no
 * toolbar:
 *   - `observe`      → SessionObserve (history/live trace; rail hidden)
 *   - `conversation` → ConversationScreen (embedded, no back nav)
 *
 * Wrapped in `scoutApp.Provider` upstream in main.tsx (supplies the
 * `[data-scout-theme]` token scope, theme honored via `?theme=`). Mirrors
 * ObserveEmbedScreen + RepoDiffEmbedScreen.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../lib/api.ts";
import { describeObserveEvidence } from "../../lib/observe-fidelity.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { useTailEvents } from "../../lib/tail-events.ts";
import { ConversationScreen } from "../chat/ConversationScreen.tsx";
import { SessionObserve } from "./SessionObserve.tsx";
import { SessionObserveEmbedStatus } from "./SessionObserveEvidence.tsx";
import type { SessionRefLookup } from "./SessionRefScreen.tsx";
import {
  brokerEventMayAffectSessionRef,
  sessionRefRefreshDelayMs,
  sessionRefsMatch,
} from "./session-ref-lookup-state.ts";

const EMBED_REFRESH_INTERVAL_MS = 60_000;
const EMBED_EVENT_REFRESH_DEBOUNCE_MS = 1_000;
const EMBED_EVENT_REFRESH_MIN_INTERVAL_MS = 10_000;

function EmbedShell({ children }: { children: React.ReactNode }) {
  return <div className="s-observe-embed-page">{children}</div>;
}

function EmbedNotice({ title, detail }: { title: string; detail?: string }) {
  return (
    <EmbedShell>
      <div className="s-observe-embed-empty">
        <div className="s-observe-embed-empty-title">{title}</div>
        {detail && <div className="s-observe-embed-empty-detail">{detail}</div>}
      </div>
    </EmbedShell>
  );
}

type SessionRefObserveLookup = Extract<SessionRefLookup, { kind: "observe" }>;

/** Pure resolved-observe branch so the embed's fidelity propagation is testable. */
export function SessionEmbedObserveContent({
  lookup,
}: {
  lookup: SessionRefObserveLookup;
}) {
  const evidence = describeObserveEvidence({
    source: lookup.observe.source,
    fidelity: lookup.observe.fidelity,
    live: lookup.observe.data.live,
    eventCount: lookup.observe.data.events.length,
  });

  return (
    <EmbedShell>
      <SessionObserveEmbedStatus
        source={lookup.observe.source}
        fidelity={lookup.observe.fidelity}
        sessionId={lookup.observe.sessionId ?? lookup.observe.refId}
        evidence={evidence}
      />
      <SessionObserve
        data={lookup.observe.data}
        agentId={lookup.observe.agentId ?? lookup.session?.agentId ?? undefined}
        sessionId={lookup.observe.sessionId ?? lookup.observe.refId}
        showRail={false}
        observeSource={lookup.observe.source}
        observeFidelity={lookup.observe.fidelity}
      />
    </EmbedShell>
  );
}

export function SessionEmbedScreen() {
  const ref =
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).get("ref")?.trim() ?? "";

  const [lookup, setLookup] = useState<SessionRefLookup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshAtRef = useRef<number | null>(null);

  const load = useCallback(
    async (background = false) => {
      if (!ref) {
        setLoading(false);
        return;
      }
      lastRefreshAtRef.current = Date.now();
      if (!background) setLoading(true);
      setError(null);
      try {
        const result = await api<SessionRefLookup>(
          `/api/session-ref/${encodeURIComponent(ref)}`,
        );
        setLookup(result);
      } catch (err) {
        if (!background) setLookup(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [ref],
  );

  useEffect(() => {
    lastRefreshAtRef.current = null;
    void load();
    const interval = window.setInterval(() => {
      void load(true);
    }, EMBED_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [load]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) return;
    const delayMs = sessionRefRefreshDelayMs({
      nowMs: Date.now(),
      lastRefreshAtMs: lastRefreshAtRef.current,
      debounceMs: EMBED_EVENT_REFRESH_DEBOUNCE_MS,
      minimumIntervalMs: EMBED_EVENT_REFRESH_MIN_INTERVAL_MS,
    });
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void load(true);
    }, delayMs);
  }, [load]);

  useBrokerEvents((event) => {
    const refs = [
      ref,
      lookup?.refId,
      lookup?.kind === "conversation" ? lookup.conversationId : null,
      lookup?.session?.agentId,
      lookup?.kind === "observe" ? lookup.observe.agentId : null,
      lookup?.kind === "observe" ? lookup.observe.sessionId : null,
    ];
    if (brokerEventMayAffectSessionRef(event, refs)) scheduleRefresh();
  });

  useTailEvents((event) => {
    const refs = [
      ref,
      lookup?.refId,
      lookup?.kind === "observe" ? lookup.observe.sessionId : null,
      lookup?.kind === "observe" ? lookup.observe.data.metadata?.session?.externalSessionId : null,
    ];
    if (refs.some((candidate) => sessionRefsMatch(event.sessionId, candidate))) {
      scheduleRefresh();
    }
  });

  if (!ref) {
    return (
      <EmbedNotice
        title="No session reference"
        detail="This embed needs a ?ref=<sessionId> query parameter."
      />
    );
  }

  if (error && !lookup) {
    return <EmbedNotice title="Session unavailable" detail={error} />;
  }

  if (loading && !lookup) {
    return <EmbedNotice title="Resolving session" detail={ref} />;
  }

  if (!lookup) {
    return (
      <EmbedNotice
        title="Session not found"
        detail="This session may have ended or its archive is not on this machine."
      />
    );
  }

  if (lookup.kind === "conversation") {
    return (
      <EmbedShell>
        <ConversationScreen
          conversationId={lookup.conversationId}
          navigate={() => {}}
          embedded
          showBackNav={false}
        />
      </EmbedShell>
    );
  }

  return <SessionEmbedObserveContent lookup={lookup} />;
}

export default SessionEmbedScreen;
