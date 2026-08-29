import { ScrollText } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useScout } from "../../scout/Provider.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { api } from "../../lib/api.ts";
import { useBrokerEvents } from "../../lib/sse.ts";
import { useTailEvents } from "../../lib/tail-events.ts";
import { agentStateLabel, isAgentBusy, normalizeAgentState } from "../../lib/agent-state.ts";
import { stateColor } from "../../lib/colors.ts";
import { AgentLiveActions } from "../../components/AgentLiveActions.tsx";
import {
  conversationFailureNotice,
  conversationalMessagePreview,
  isNoisyConversationStatusMessage,
} from "../../lib/message-visibility.ts";
import {
  compactAgentId,
  minimalAgentDisplayName,
  minimalAgentHandle,
} from "../../lib/agent-labels.ts";
import {
  compareTimestampsAsc,
  formatAbsoluteTimestamp,
  timeAgo,
} from "../../lib/time.ts";
import { isActiveConversationFlight } from "../../lib/conversations.ts";
import { routeMachineId } from "../../lib/router.ts";
import {
  conversationIdentityRoute,
  directConversationSessionId,
} from "./conversation-model.ts";
import {
  buildTailRouteQuery,
  buildTailPreviewContext,
  compactSessionId,
  mergeTailPreviewEvents,
  tailEventMatchesContext,
  tailKindLabel,
  tailSummary,
} from "../../lib/tail-preview.ts";
import { TmuxPeekPanel } from "../../scout/inspector/TmuxPeek.tsx";
import type {
  Flight,
  Message,
  SessionCatalogWithResume,
  SessionEntry,
  TailEvent,
} from "../../lib/types.ts";

const KIND_LABELS: Record<string, string> = {
  direct: "Conversation",
  channel: "Conversation",
  group_direct: "Conversation",
  thread: "Thread",
};

const INSPECTOR_REFRESH_ACCUMULATE_MS = 1_800;
const INSPECTOR_REFRESH_MAX_WAIT_MS = 4_800;
const TAIL_PREVIEW_PLAYBACK_BATCH_SIZE = 2;
const TAIL_PREVIEW_PLAYBACK_MS = 120;
const TAIL_PREVIEW_INITIAL_ACCUMULATE_MS = 650;
const TAIL_PREVIEW_BURST_ACCUMULATE_MS = 1_800;

type EventConversationRecord = {
  id?: string | null;
};

type EventFlightRecord = {
  id: string;
  invocationId: string;
  targetAgentId?: string | null;
};

type EventInvocationRecord = {
  id: string;
  targetAgentId?: string | null;
  conversationId?: string | null;
};

function keepPreviousIfJsonEqual<T>(previous: T, next: T): T {
  try {
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  } catch {
    return next;
  }
}

function pathLeaf(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/[\\/]+$/, "");
  if (!normalized) return null;
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

function compactPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/[\\/]+$/, "");
  if (!normalized) return null;
  return normalized.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

function flightStateLabel(state: string): string {
  switch (state) {
    case "queued": return "Queued";
    case "waking": return "Waking";
    case "waiting": return "Thinking";
    case "running": return "Working";
    default: return state.replace(/_/g, " ");
  }
}

export function ConversationInspector() {
  const { route, agents, navigate, apiConnection, reload } = useScout();
  const machineId = routeMachineId(route);
  // One conversation route: /messages/<id> is how the rail opens everything
  // (channels included, whose dedicated right pane died with the channels
  // route), so the inspector reads the id from both conversation views.
  const conversationId =
    route.view === "conversation" || route.view === "messages"
      ? route.conversationId ?? null
      : null;

  const [meta, setMeta] = useState<SessionEntry | null>(null);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [latestMessage, setLatestMessage] = useState<Message | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!conversationId) {
      setMeta(null);
      setFlights([]);
      setLatestMessage(null);
      setLoaded(true);
      return;
    }
    try {
      const [sessionMeta, activeFlights, recentMessages] = await Promise.all([
        api<SessionEntry>(
          `/api/session/${encodeURIComponent(conversationId)}`,
        ).catch(() => null),
        api<Flight[]>(
          `/api/flights?conversationId=${encodeURIComponent(conversationId)}`,
        ).catch(() => [] as Flight[]),
        api<Message[]>(
          `/api/messages?conversationId=${encodeURIComponent(conversationId)}&limit=8`,
        ).catch(() => [] as Message[]),
      ]);
      setMeta((previous) => keepPreviousIfJsonEqual(previous, sessionMeta));
      setFlights((previous) =>
        keepPreviousIfJsonEqual(previous, activeFlights ?? []),
      );
      setLatestMessage((previous) =>
        keepPreviousIfJsonEqual(
          previous,
          recentMessages
            ?.filter((message) => !isNoisyConversationStatusMessage(message))
            .sort((left, right) =>
              compareTimestampsAsc(left.createdAt, right.createdAt),
            )
            .at(-1) ?? null,
        ),
      );
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [conversationId]);

  useEffect(() => {
    setLoaded(false);
    void load();
  }, [load]);

  const agentId = meta?.agentId ?? null;
  const agent = useMemo(
    () => (agentId ? agents.find((a) => a.id === agentId) ?? null : null),
    [agents, agentId],
  );
  const resolvedAgentId = agent?.id ?? null;
  const conversationSessionId = directConversationSessionId(meta);
  const identityRoute = conversationIdentityRoute({
    resolvedAgentId,
    sessionId: conversationSessionId,
    machineId,
  });
  const [catalog, setCatalog] = useState<SessionCatalogWithResume | null>(null);
  const [tailPreviewEvents, setTailPreviewEvents] = useState<TailEvent[]>([]);
  const [visibleTailPreviewEvents, setVisibleTailPreviewEvents] = useState<TailEvent[]>([]);
  const visibleTailPreviewEventsRef = useRef<TailEvent[]>([]);
  const loadAccumulationTimerRef = useRef<number | null>(null);
  const loadAccumulationStartedAtRef = useRef<number | null>(null);
  const tailPlaybackPendingRef = useRef<TailEvent[]>([]);
  const tailPlaybackStartTimerRef = useRef<number | null>(null);
  const tailPlaybackTimerRef = useRef<number | null>(null);
  const trackedInvocationIdsRef = useRef<Set<string>>(new Set());

  const clearScheduledLoad = useCallback(() => {
    if (loadAccumulationTimerRef.current !== null) {
      window.clearTimeout(loadAccumulationTimerRef.current);
      loadAccumulationTimerRef.current = null;
    }
    loadAccumulationStartedAtRef.current = null;
  }, []);

  const scheduleLoad = useCallback(() => {
    if (!conversationId) return;
    const now = Date.now();
    const startedAt = loadAccumulationStartedAtRef.current ?? now;
    loadAccumulationStartedAtRef.current = startedAt;
    const hasWaited = now - startedAt >= INSPECTOR_REFRESH_MAX_WAIT_MS;
    const delay = hasWaited ? 0 : INSPECTOR_REFRESH_ACCUMULATE_MS;

    if (loadAccumulationTimerRef.current !== null) {
      window.clearTimeout(loadAccumulationTimerRef.current);
    }
    loadAccumulationTimerRef.current = window.setTimeout(() => {
      loadAccumulationTimerRef.current = null;
      loadAccumulationStartedAtRef.current = null;
      void load();
    }, delay);
  }, [conversationId, load]);

  useEffect(() => clearScheduledLoad, [clearScheduledLoad]);

  useEffect(() => {
    setCatalog(null);
    if (!resolvedAgentId) return;
    let cancelled = false;
    api<SessionCatalogWithResume>(`/api/agents/${encodeURIComponent(resolvedAgentId)}/session-catalog`)
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [resolvedAgentId]);

  const agentName = minimalAgentDisplayName({
    name: agent?.name,
    agentName: meta?.agentName,
    id: agentId,
    title: meta?.title,
  });
  const agentHandle = agent
    ? minimalAgentHandle(agent) ?? compactAgentId(agent.id) ?? agent.id
    : agentId
      ? compactAgentId(agentId) ?? agentId
      : null;
  const activeFlight = useMemo(
    () =>
      flights
        .filter(isActiveConversationFlight)
        .sort((l, r) => (r.startedAt ?? 0) - (l.startedAt ?? 0))[0] ?? null,
    [flights],
  );

  useEffect(() => {
    trackedInvocationIdsRef.current = new Set(
      flights.map((flight) => flight.invocationId),
    );
  }, [flights]);

  useEffect(() => {
    clearScheduledLoad();
    trackedInvocationIdsRef.current.clear();
  }, [clearScheduledLoad, conversationId]);

  useBrokerEvents((event) => {
    if (!conversationId) return;
    if (event.kind === "message.posted") {
      const payload = event.payload as
        | { message?: { conversationId?: string | null } }
        | undefined;
      if (payload?.message?.conversationId === conversationId) scheduleLoad();
      return;
    }
    if (event.kind === "conversation.upserted") {
      const conversation = (
        event.payload as { conversation?: EventConversationRecord } | undefined
      )?.conversation;
      if (conversation?.id === conversationId) scheduleLoad();
      return;
    }
    if (event.kind === "invocation.requested") {
      const invocation = (
        event.payload as { invocation?: EventInvocationRecord } | undefined
      )?.invocation;
      if (invocation?.conversationId === conversationId) {
        trackedInvocationIdsRef.current.add(invocation.id);
        scheduleLoad();
        return;
      }
      if (
        !invocation?.conversationId &&
        agentId &&
        invocation?.targetAgentId === agentId
      ) {
        trackedInvocationIdsRef.current.add(invocation.id);
        scheduleLoad();
      }
      return;
    }
    if (event.kind === "flight.updated") {
      const flight = (
        event.payload as { flight?: EventFlightRecord } | undefined
      )?.flight;
      if (!flight) return;
      const matchesLoadedFlight =
        activeFlight?.id === flight.id ||
        activeFlight?.invocationId === flight.invocationId ||
        trackedInvocationIdsRef.current.has(flight.invocationId) ||
        flights.some(
          (candidate) =>
            candidate.id === flight.id ||
            candidate.invocationId === flight.invocationId,
        );
      if (matchesLoadedFlight) {
        scheduleLoad();
      }
    }
  });

  const activeSessionId = catalog?.activeSessionId
    ?? agent?.harnessSessionId
    ?? conversationSessionId
    ?? meta?.harnessSessionId
    ?? null;
  const harnessSessionId = agent?.harnessSessionId ?? meta?.harnessSessionId ?? null;
  const harnessLogPath = agent?.harnessLogPath ?? null;
  const tailPreviewContext = useMemo(
    () => buildTailPreviewContext({ activeSessionId, agent, sessionMeta: meta }),
    [activeSessionId, agent, meta],
  );
  const tailPreviewScopeKey = JSON.stringify({
    sessionIds: tailPreviewContext.sessionIds,
    paths: tailPreviewContext.paths,
    projects: tailPreviewContext.projects,
  });
  const hasTailPreviewScope =
    tailPreviewContext.sessionIds.length > 0 ||
    tailPreviewContext.paths.length > 0 ||
    tailPreviewContext.projects.length > 0;

  const clearTailPlaybackTimers = useCallback(() => {
    if (tailPlaybackStartTimerRef.current !== null) {
      window.clearTimeout(tailPlaybackStartTimerRef.current);
      tailPlaybackStartTimerRef.current = null;
    }
    if (tailPlaybackTimerRef.current !== null) {
      window.clearInterval(tailPlaybackTimerRef.current);
      tailPlaybackTimerRef.current = null;
    }
    tailPlaybackPendingRef.current = [];
  }, []);

  const stopTailPlayback = useCallback(() => {
    clearTailPlaybackTimers();
  }, [clearTailPlaybackTimers]);

  const releaseTailPlayback = useCallback(() => {
    if (tailPlaybackTimerRef.current !== null) return;
    if (tailPlaybackStartTimerRef.current !== null) {
      window.clearTimeout(tailPlaybackStartTimerRef.current);
      tailPlaybackStartTimerRef.current = null;
    }

    const releaseCount = tailPlaybackPendingRef.current.length;
    if (releaseCount === 0) return;

    const emitNextBatch = () => {
      const nextBatch = tailPlaybackPendingRef.current.slice(
        0,
        TAIL_PREVIEW_PLAYBACK_BATCH_SIZE,
      );
      tailPlaybackPendingRef.current = tailPlaybackPendingRef.current.slice(
        TAIL_PREVIEW_PLAYBACK_BATCH_SIZE,
      );
      if (nextBatch.length > 0) {
        setVisibleTailPreviewEvents((previous) =>
          mergeTailPreviewEvents(previous, nextBatch),
        );
      }
      if (tailPlaybackPendingRef.current.length > 0) return;
      if (tailPlaybackTimerRef.current !== null) {
        window.clearInterval(tailPlaybackTimerRef.current);
        tailPlaybackTimerRef.current = null;
      }
    };

    emitNextBatch();
    if (tailPlaybackPendingRef.current.length > 0) {
      tailPlaybackTimerRef.current = window.setInterval(
        emitNextBatch,
        TAIL_PREVIEW_PLAYBACK_MS,
      );
    }
  }, []);

  const scheduleTailPlayback = useCallback((delayMs: number) => {
    if (tailPlaybackTimerRef.current !== null) return;
    if (tailPlaybackStartTimerRef.current !== null) return;
    tailPlaybackStartTimerRef.current = window.setTimeout(() => {
      tailPlaybackStartTimerRef.current = null;
      releaseTailPlayback();
    }, delayMs);
  }, [releaseTailPlayback]);

  useEffect(() => {
    visibleTailPreviewEventsRef.current = visibleTailPreviewEvents;
  }, [visibleTailPreviewEvents]);

  useEffect(() => clearTailPlaybackTimers, [clearTailPlaybackTimers]);

  useEffect(() => {
    stopTailPlayback();
    setTailPreviewEvents([]);
    setVisibleTailPreviewEvents([]);
  }, [stopTailPlayback, tailPreviewScopeKey]);

  useEffect(() => {
    if (!hasTailPreviewScope) return;
    let cancelled = false;
    const params = new URLSearchParams({ limit: "180", transcripts: "true" });
    api<{ events: TailEvent[] }>(`/api/tail/recent?${params.toString()}`)
      .then((result) => {
        if (cancelled) return;
        const matched = (result.events ?? []).filter((event) =>
          tailEventMatchesContext(event, tailPreviewContext),
        );
        setTailPreviewEvents(mergeTailPreviewEvents([], matched));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasTailPreviewScope, tailPreviewScopeKey]);

  useTailEvents(
    useCallback(
      (event) => {
        if (!hasTailPreviewScope) return;
        if (!tailEventMatchesContext(event, tailPreviewContext)) return;
        setTailPreviewEvents((previous) => mergeTailPreviewEvents(previous, [event]));
      },
      [hasTailPreviewScope, tailPreviewScopeKey],
    ),
  );

  useEffect(() => {
    if (tailPreviewEvents.length === 0) {
      stopTailPlayback();
      setVisibleTailPreviewEvents([]);
      return;
    }

    const visible = visibleTailPreviewEventsRef.current;
    const knownIds = new Set([
      ...visible.map((event) => event.id),
      ...tailPlaybackPendingRef.current.map((event) => event.id),
    ]);
    const incoming = tailPreviewEvents.filter((event) => !knownIds.has(event.id));
    if (incoming.length === 0) return;

    tailPlaybackPendingRef.current = mergeTailPreviewEvents(
      tailPlaybackPendingRef.current,
      incoming,
    );

    if (tailPlaybackPendingRef.current.length > 0) {
      scheduleTailPlayback(
        visible.length === 0
          ? TAIL_PREVIEW_INITIAL_ACCUMULATE_MS
          : TAIL_PREVIEW_BURST_ACCUMULATE_MS,
      );
    }
  }, [scheduleTailPlayback, stopTailPlayback, tailPreviewEvents]);

  const liveFileTouches = useMemo(
    () => visibleTailPreviewEvents.flatMap(fileTouchesFromTailEvent).slice(0, 5),
    [visibleTailPreviewEvents],
  );

  if (!conversationId) {
    return (
      <ChatInspectorEmpty
        apiOffline={apiConnection.status === "offline"}
        onRetry={() => void reload()}
      />
    );
  }

  if (!loaded) {
    return (
      <div className="ctx-panel ctx-panel--conversation">
        <div className="ctx-panel-empty-state">
          <div className="ctx-panel-empty-hint">Loading conversation…</div>
        </div>
      </div>
    );
  }

  const kindLabel = meta?.kind ? KIND_LABELS[meta.kind] ?? meta.kind : "Conversation";
  const workspaceRoot = meta?.workspaceRoot ?? null;
  const workspaceName = pathLeaf(workspaceRoot);
  const workspacePath = compactPath(workspaceRoot);
  const branch = meta?.currentBranch ?? null;
  const harness = agent?.harness ?? meta?.harness ?? null;
  const lastAt = meta?.lastMessageAt ?? latestMessage?.createdAt ?? null;
  const messageCount = meta?.messageCount ?? null;
  const participantCount = meta
    ? meta.participantCount
      ?? meta.participantIds.filter((id) => id !== "operator").length + 1
    : null;
  const agentState = agent?.state ?? null;
  const agentStateNormalized = normalizeAgentState(agentState);
  const latestFailureNotice = latestMessage
    ? conversationFailureNotice(latestMessage)
    : null;
  const previewSource = latestMessage?.body?.trim() || meta?.preview?.trim() || null;
  const preview = previewSource
    ? conversationalMessagePreview(previewSource)
    : null;
  const previewActor = latestFailureNotice ? null : latestMessage?.actorName ?? null;
  const liveSessionLabel = compactSessionId(activeSessionId);
  const primarySessionId = activeSessionId ?? harnessSessionId;
  const primarySessionLabel = compactSessionId(primarySessionId);
  const harnessSessionLabel = compactSessionId(harnessSessionId);
  const showHarnessSessionDetail = Boolean(
    harnessSessionId &&
    harnessSessionId !== primarySessionId,
  );
  const sessionKindLabel = [
    harness,
    agent?.transport,
  ].filter(Boolean).join(" · ");
  const showSessionContext = Boolean(activeSessionId || harnessSessionId || harnessLogPath);
  const showTmuxPeek = Boolean(
    agent?.terminalSurface?.backend === "tmux"
    || (agent?.transport === "tmux" && agent.harnessSessionId),
  );
  const workInMotion = Boolean(activeFlight || isAgentBusy(agentState, agent));
  const activityTitle = workInMotion
    ? activeFlight
      ? flightStateLabel(activeFlight.state)
      : "In motion"
    : "At rest";
  const activitySubtitle = activeFlight?.summary?.trim()
    ?? (lastAt
      ? `Last update ${timeAgo(lastAt) ?? "recently"}`
      : "No recent activity recorded");
  const workspaceMeta = [
    branch ? `branch ${branch}` : null,
    harness,
    agent?.transport,
  ].filter(Boolean);
  const hasWorkspaceContext = Boolean(
    workspaceName ||
    workspacePath ||
    workspaceMeta.length > 0,
  );
  const liveSectionLabel = workInMotion
    ? "Live activity"
    : showTmuxPeek
      ? "Terminal"
      : "Activity";
  const liveSummary = activeFlight?.summary?.trim()
    ?? (activeSessionId && !showTmuxPeek
      ? "Terminal session is live."
      : visibleTailPreviewEvents.length > 0 && !showTmuxPeek
        ? "Streaming matching Tail events."
        : null);
  const tailRouteQuery = buildTailRouteQuery(tailPreviewContext, tailPreviewEvents);
  const showLiveActivity = Boolean(agent && (activeFlight || activeSessionId || tailPreviewEvents.length > 0 || showTmuxPeek));
  const showTailStream = !showTmuxPeek;
  const liveSessionTitle = activeSessionId
    ? showTmuxPeek
      ? "Terminal session"
      : "Trace session"
    : activeFlight
      ? "Session starting"
      : "Session context";
  const liveSessionDetail = activeSessionId
    ? primarySessionLabel ?? activeSessionId
    : activeFlight
      ? flightStateLabel(activeFlight.state)
      : "Waiting for a session id";
  const liveSessionSub = activeSessionId
    ? [harness, agent?.transport, activeFlight ? flightStateLabel(activeFlight.state) : null]
      .filter(Boolean)
      .join(" · ")
    : activeFlight?.summary?.trim() ?? liveSummary ?? null;
  const goToIdentity = () => {
    if (!identityRoute) return;
    openContent(
      navigate,
      identityRoute,
      { returnTo: route },
    );
  };

  const goToTail = () => {
    openContent(
      navigate,
      {
        view: "ops",
        mode: "tail",
        ...(tailRouteQuery ? { tailQuery: tailRouteQuery } : {}),
      },
      { returnTo: route },
    );
  };

  return (
    <div className="ctx-panel ctx-panel--conversation">
      <section className="ctx-panel-section ctx-panel-conversation-summary">
        <div className="ctx-panel-section-label">{kindLabel}</div>
        <div className="ctx-panel-conversation-card">
          <div className="ctx-panel-conversation-title">
            {agentName}
          </div>
          {agentHandle && (
            <div className="ctx-panel-conversation-handle">@{agentHandle}</div>
          )}
          <div className="ctx-panel-conversation-state">
            <span
              className="ctx-panel-conversation-state-dot"
              style={{ background: stateColor(agentState) }}
            />
            <span>{agentStateLabel(agentState)}</span>
          </div>
        </div>
      </section>

      {activeFlight && (
        <section className="ctx-panel-section">
          <div className="ctx-panel-section-label">Now</div>
          <div className="ctx-panel-conversation-flight">
            <div className="ctx-panel-conversation-flight-row">
              <span className="ctx-panel-conversation-flight-label">
                {flightStateLabel(activeFlight.state)}
              </span>
              {activeFlight.startedAt && (
                <span className="ctx-panel-conversation-flight-time">
                  {timeAgo(activeFlight.startedAt)}
                </span>
              )}
            </div>
            {activeFlight.summary && (
              <div className="ctx-panel-conversation-flight-summary">
                {activeFlight.summary}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">Workspace</div>
        {hasWorkspaceContext ? (
          <div className="ctx-panel-workspace-card">
            <div className="ctx-panel-workspace-head">
              <div className="ctx-panel-workspace-kicker">Project</div>
              <div
                className="ctx-panel-workspace-title"
                title={workspaceRoot ?? workspaceName ?? undefined}
              >
                {workspaceName ?? "Unscoped workspace"}
              </div>
            </div>
            {workspacePath && (
              <div className="ctx-panel-workspace-path" title={workspaceRoot ?? workspacePath}>
                {workspacePath}
              </div>
            )}
            {workspaceMeta.length > 0 && (
              <div className="ctx-panel-workspace-strip">
                {workspaceMeta.map((item) => (
                  <span key={item} className="ctx-panel-workspace-chip">
                    {item}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="ctx-panel-empty">No workspace metadata yet</div>
        )}
      </section>

      {showSessionContext && (
        <section className="ctx-panel-section">
          <div className="ctx-panel-section-label">Session</div>
          <div className="ctx-panel-session-card">
            <div className="ctx-panel-session-head">
              <div className="ctx-panel-session-primary">
                {sessionKindLabel && (
                  <div className="ctx-panel-session-kind">{sessionKindLabel}</div>
                )}
                {primarySessionId && (
                  <div className="ctx-panel-session-id" title={primarySessionId}>
                    {primarySessionLabel ?? primarySessionId}
                  </div>
                )}
              </div>
            </div>
            {(showHarnessSessionDetail || harnessLogPath) && (
              <div className="ctx-panel-session-meta">
                {showHarnessSessionDetail && harnessSessionId && (
                  <div className="ctx-panel-session-meta-item">
                    <span>Harness session</span>
                    <strong title={harnessSessionId}>
                      {harnessSessionLabel ?? harnessSessionId}
                    </strong>
                  </div>
                )}
                {harnessLogPath && (
                  <div className="ctx-panel-session-meta-item">
                    <span>Harness log</span>
                    <strong title={harnessLogPath}>
                      {pathLeaf(harnessLogPath) ?? harnessLogPath}
                    </strong>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="ctx-panel-section">
        <div className="ctx-panel-section-label">Activity</div>
        <div className={`ctx-panel-activity-card${workInMotion ? " ctx-panel-activity-card--active" : ""}`}>
          <div className="ctx-panel-activity-head">
            <span
              className="ctx-panel-activity-dot"
              style={{ background: workInMotion ? "var(--green)" : stateColor(agentState) }}
            />
            <div className="ctx-panel-activity-main">
              <div className="ctx-panel-activity-title">{activityTitle}</div>
              <div
                className="ctx-panel-activity-sub"
                title={lastAt ? formatAbsoluteTimestamp(lastAt) : undefined}
              >
                {activitySubtitle}
              </div>
            </div>
          </div>
          {activeFlight && (
            <div className="ctx-panel-activity-ledger">
              <span className="ctx-panel-activity-ledger-label">
                {flightStateLabel(activeFlight.state)}
              </span>
              {activeFlight.startedAt && (
                <span
                  className="ctx-panel-activity-ledger-time"
                  title={formatAbsoluteTimestamp(activeFlight.startedAt)}
                >
                  {timeAgo(activeFlight.startedAt)}
                </span>
              )}
            </div>
          )}
          <div className="ctx-panel-activity-facts">
            {typeof messageCount === "number" && (
              <Fact label="Messages" value={`${messageCount}`} />
            )}
            {typeof participantCount === "number" && (
              <Fact label="People" value={`${participantCount}`} />
            )}
            {agentStateNormalized && (
              <Fact label="Agent" value={agentStateLabel(agentState)} />
            )}
          </div>
        </div>
      </section>

      {preview && (
        <section className="ctx-panel-section ctx-panel-conversation-preview">
          <div className="ctx-panel-section-label">
            {previewActor ? `Latest · ${previewActor}` : "Latest"}
          </div>
          <div className="ctx-panel-conversation-preview-body">{preview}</div>
        </section>
      )}

      {showLiveActivity && agent && (
        <section className="ctx-panel-section ctx-panel-conversation-live-section">
          <div className="ctx-panel-section-label">
            <span>{liveSectionLabel}</span>
            {liveSessionLabel && (
              <span className="ctx-panel-live-session" title={activeSessionId ?? undefined}>
                {liveSessionLabel}
              </span>
            )}
          </div>
          <div className={`ctx-panel-live-card${workInMotion ? " ctx-panel-live-card--active" : ""}`}>
            <div className={`ctx-panel-live-session-card${workInMotion ? " ctx-panel-live-session-card--active" : ""}`}>
              <div className="ctx-panel-live-session-copy">
                <span>{liveSessionTitle}</span>
                <strong title={activeSessionId ?? undefined}>
                  {liveSessionDetail}
                </strong>
                {liveSessionSub && <small>{liveSessionSub}</small>}
              </div>
              <div className="ctx-panel-live-session-pulse" aria-hidden="true">
                <span />
              </div>
            </div>
            <AgentLiveActions
              agent={agent}
              catalog={catalog}
              navigate={navigate}
              returnTo={route}
              variant="compact"
              className="ctx-panel-live-actions"
            />
            {liveSummary && (
              <div className="ctx-panel-live-summary">{liveSummary}</div>
            )}
            {showTmuxPeek && (
              <TmuxPeekPanel
                agentId={agent.id}
                lines={24}
                columns={132}
                className="ctx-panel-tmux-peek--conversation"
              />
            )}
            {liveFileTouches.length > 0 && (
              <div className="ctx-panel-live-files" aria-live="polite">
                <div className="ctx-panel-live-files-label">
                  <span>Files</span>
                  <strong>{liveFileTouches.length}</strong>
                </div>
                <ol className="ctx-panel-live-file-list">
                  {liveFileTouches.map((file) => (
                    <li
                      key={`${file.eventId}:${file.path}`}
                      className={`ctx-panel-live-file ctx-panel-live-file--${file.tone}`}
                      title={`${file.path} · ${file.verb}`}
                    >
                      <span className="ctx-panel-live-file-mark">
                        {file.mark}
                      </span>
                      <span className="ctx-panel-live-file-path">
                        {compactFilePath(file.path)}
                      </span>
                      <span className="ctx-panel-live-file-time">
                        {timeAgo(file.ts)}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {showTailStream && (
              <div className="ctx-panel-live-stream" aria-live="polite">
                {visibleTailPreviewEvents.length > 0 ? (
                  <ol className="ctx-panel-live-events">
                    {visibleTailPreviewEvents.map((event) => (
                      <li key={event.id} className="ctx-panel-live-event">
                        <span className="ctx-panel-live-event-kind">
                          {tailKindLabel(event.kind)}
                        </span>
                        <span className="ctx-panel-live-event-summary">
                          {tailSummary(event.summary)}
                        </span>
                        <span
                          className="ctx-panel-live-event-time"
                          title={formatAbsoluteTimestamp(event.ts)}
                        >
                          {timeAgo(event.ts)}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="ctx-panel-live-stream-empty">
                    Waiting for matching Tail events
                  </div>
                )}
              </div>
            )}
            {hasTailPreviewScope && (
              <button
                type="button"
                className="ctx-panel-live-tail-button"
                onClick={goToTail}
                title={tailRouteQuery ? `Tail filter: ${tailRouteQuery}` : "Open Tail"}
              >
                <ScrollText size={13} strokeWidth={1.9} aria-hidden="true" />
                <span>Tail</span>
              </button>
            )}
          </div>
        </section>
      )}

      {identityRoute && (
        <section className="ctx-panel-section ctx-panel-conversation-profile-section">
          <button
            type="button"
            className="ctx-panel-roster-button ctx-panel-conversation-profile-button"
            onClick={goToIdentity}
          >
            <span className="ctx-panel-roster-label">
              {agent ? "Open agent profile" : "Open session trace"}
            </span>
            <span className="ctx-panel-roster-count">
              <span>→</span>
            </span>
          </button>
        </section>
      )}
    </div>
  );
}

function ChatInspectorEmpty({
  apiOffline,
  onRetry,
}: {
  apiOffline: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="ctx-panel ctx-panel--conversation">
      <div className="ctx-panel-empty-state">
        <div className="ctx-panel-empty-card" data-tone={apiOffline ? "error" : "neutral"}>
          <div className="ctx-panel-empty-card-title">
            {apiOffline ? "Context unavailable" : "No conversation selected"}
          </div>
          <div className="ctx-panel-empty-card-detail">
            {apiOffline
              ? "Scout context will load after the server reconnects."
              : "Select a chat to inspect participants, sessions, and recent activity."}
          </div>
          {apiOffline && (
            <button
              type="button"
              className="ctx-panel-empty-card-action"
              onClick={onRetry}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="ctx-panel-fact">
      <span className="ctx-panel-fact-value">{value}</span>
      <span className="ctx-panel-fact-label">{label}</span>
    </div>
  );
}

type LiveFileTouch = {
  eventId: string;
  path: string;
  verb: string;
  mark: string;
  tone: "changed" | "read" | "touched";
  ts: number;
};

const FILE_TOUCH_PATTERN =
  /(?:["'`])?((?:~|\/|\.{1,2}\/|[A-Za-z0-9_.-]+\/)[^\s"'`),;]+?\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|swift|md|json|jsonc|yml|yaml|toml|sql|py|rs|go|sh|html|m|mm))(?:["'`])?/gi;

function fileTouchesFromTailEvent(event: TailEvent): LiveFileTouch[] {
  const seen = new Set<string>();
  const touches: LiveFileTouch[] = [];
  const verb = fileTouchVerb(event.summary);
  for (const match of event.summary.matchAll(FILE_TOUCH_PATTERN)) {
    const path = match[1]?.trim();
    if (!path) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    touches.push({
      eventId: event.id,
      path,
      verb,
      mark: fileTouchMark(verb),
      tone: fileTouchTone(verb),
      ts: event.ts,
    });
  }
  return touches;
}

function fileTouchVerb(summary: string): string {
  if (/\b(created|create|wrote|write|edited|edit|modified|modify|updated|update|changed|change|patched|patch)\b/i.test(summary)) {
    return "changed";
  }
  if (/\b(read|opened|viewed|cat|sed)\b/i.test(summary)) {
    return "read";
  }
  return "touched";
}

function fileTouchTone(verb: string): LiveFileTouch["tone"] {
  if (verb === "changed") return "changed";
  if (verb === "read") return "read";
  return "touched";
}

function fileTouchMark(verb: string): string {
  if (verb === "changed") return "+";
  if (verb === "read") return "r";
  return "·";
}

function compactFilePath(path: string): string {
  const normalized = path.replace(/[\\/]+$/g, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return normalized;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}
