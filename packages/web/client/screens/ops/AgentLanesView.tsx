import "./agent-lanes.css";

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
} from "react";
import { useTailFeed } from "../../lib/use-tail-feed.ts";
import type { TailFeedLoadState } from "../../lib/use-tail-feed.ts";
import { useObservePolling } from "../../lib/observe.ts";
import type { ObserveCache } from "../../lib/observe.ts";
import { fetchTerminalSessions } from "../../lib/terminal-sessions.ts";
import { normalizeAgentState } from "../../lib/agent-state.ts";
import { isScoutSurfaceActive, onScoutSurfaceActivated } from "../../lib/surface-activity.ts";
import type {
  Agent,
  ObserveEvent,
  Route,
  TailDiscoveredTranscript,
  TailDiscoverySnapshot,
  TailEvent,
} from "../../lib/types.ts";
import { ScoutContext } from "../../scout/Provider.tsx";
import { defineSurface } from "../../surfaces/types.ts";
import type { TerminalSessionRecord } from "@openscout/protocol";
import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { SessionObserve } from "../sessions/SessionObserve.tsx";
import { type AgentLaneSize, readAgentLaneSize } from "./agent-lane-size.ts";
import { AgentFloorView } from "./AgentFloorView.tsx";
import {
  AgentLanesLoadingSheet,
  AgentLanesPreflightDeck,
  LANE_BOOT_EXIT_MS,
  useLaneBootVisibility,
} from "./AgentLanesPreflight.tsx";
import { AgentLaneChrome } from "./AgentLaneChrome.tsx";
import { AgentLaneCard } from "./AgentLaneCard.tsx";
import { agentLaneToCardModel } from "./agent-lane-card-model.ts";
import { AgentLaneDetailSheet } from "./AgentLaneDetailSheet.tsx";
import {
  LaneTraceDetailSheet,
  type LaneTraceSheetTarget,
} from "./LaneTraceDetailSheet.tsx";
import {
  AgentLaneSummaryResizeHandle,
  readStoredLaneSummaryHeight,
  useLaneSummaryResize,
} from "./AgentLaneSummaryResize.tsx";
import { useAgentLanesKeyboard } from "./useAgentLanesKeyboard.ts";
import {
  AGENT_LANE_HORIZON_OPTIONS,
  agentLaneHorizonLabel,
  agentLaneHorizonWindowMs,
  agentLaneTailRecentLimit,
  buildAgentLanes,
  createStableLaneOrder,
  DEFAULT_AGENT_LANE_HORIZON,
  isAgentLaneLive,
  lanePrimaryLabel,
  laneStatusLabel,
  rosterIssuesFromTailDiscovery,
  shouldPollAgentForLaneObserve,
  sortLanesWithStableOrder,
  type AgentLane,
  type AgentLaneHorizonKey,
  type AgentLaneRosterIssue,
} from "./agent-lanes-model.ts";
import {
  hasAttentionLane,
  hasHarnessLane,
  type ResolvedLaneColumn,
} from "./lane-deck-layout.ts";
import {
  readLaneDeckProfileId,
  resolveLaneWidthPx,
  snapLaneWidthPx,
  type AgentLaneWidthTier,
  type LaneDeckProfileId,
} from "./lane-deck.ts";
import { useLaneDeck } from "./useLaneDeck.ts";
import { useLaneWidthResize } from "./useLaneWidthResize.ts";
import { isLaneSyntheticAgent } from "./agent-lane-navigation.ts";
import { publishLaneRoster, type LaneRosterEntry } from "./lane-roster-store.ts";
import {
  AGENT_LANES_GRID_COLUMN_OPTIONS,
  agentLanesLayoutOptions,
  normalizeAgentLanesGridColumns,
  normalizeAgentLanesLayoutMode,
  type AgentLanesGridColumns,
  type AgentLanesLayoutMode,
} from "./agent-lanes-layout.ts";

const LANE_HORIZON_STORAGE_KEY = "openscout:agent-lanes-horizon";
const LANE_LAYOUT_STORAGE_KEY = "openscout:agent-lanes-layout";
const LANE_GRID_COLUMNS_STORAGE_KEY = "openscout:agent-lanes-grid-columns";
const LANE_TECHNICAL_ROLLUP_STORAGE_KEY = "openscout:agent-lanes-technical-rollup";
const LANE_TECHNICAL_ROLLUP_LANE_STORAGE_PREFIX = `${LANE_TECHNICAL_ROLLUP_STORAGE_KEY}:lane:`;
const LANE_SCROLL_STORAGE_PREFIX = "openscout:agent-lanes-scroll";
const EMBEDDED_TAIL_DISCOVERY_LIMIT = 96;
const EMBEDDED_TAIL_DISCOVERY_INTERVAL_MS = 30_000;
const EMBEDDED_CLOCK_INTERVAL_MS = 30_000;
const EMBEDDED_TERMINAL_POLL_INTERVAL_MS = 30_000;
const EMBEDDED_OBSERVE_ACTIVE_INTERVAL_MS = 30_000;
const EMBEDDED_OBSERVE_IDLE_INTERVAL_MS = 120_000;

type LaneScrollZone = "pinned-left" | "main" | "pinned-right";
const LANE_SCROLL_ZONES: LaneScrollZone[] = ["pinned-left", "main", "pinned-right"];

function documentIsHidden(): boolean {
  return !isScoutSurfaceActive();
}

function laneScrollStorageKey(profileId: string, zone: LaneScrollZone): string {
  return `${LANE_SCROLL_STORAGE_PREFIX}:${profileId}:${zone}`;
}

function readStoredLaneScrollLeft(profileId: string, zone: LaneScrollZone): number {
  try {
    const stored = sessionStorage.getItem(laneScrollStorageKey(profileId, zone));
    const value = stored ? Number.parseFloat(stored) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeStoredLaneScrollLeft(profileId: string, zone: LaneScrollZone, value: number): void {
  try {
    sessionStorage.setItem(laneScrollStorageKey(profileId, zone), String(Math.max(0, Math.round(value))));
  } catch {
    // ignore storage failures
  }
}

function readStoredHorizon(): AgentLaneHorizonKey {
  try {
    const stored = sessionStorage.getItem(LANE_HORIZON_STORAGE_KEY);
    if (stored && AGENT_LANE_HORIZON_OPTIONS.some((option) => option.key === stored)) {
      return stored as AgentLaneHorizonKey;
    }
  } catch {
    // ignore storage failures
  }
  return DEFAULT_AGENT_LANE_HORIZON;
}

function readStoredLaneLayout(embedded: boolean): AgentLanesLayoutMode {
  try {
    const stored = sessionStorage.getItem(LANE_LAYOUT_STORAGE_KEY);
    return normalizeAgentLanesLayoutMode(stored, embedded);
  } catch {
    // ignore storage failures
  }
  return "lanes";
}

function readStoredLaneGridColumns(): AgentLanesGridColumns {
  try {
    return normalizeAgentLanesGridColumns(sessionStorage.getItem(LANE_GRID_COLUMNS_STORAGE_KEY));
  } catch {
    return "auto";
  }
}

function readStoredLegacyTechnicalRollup(): boolean | null {
  try {
    const stored = sessionStorage.getItem(LANE_TECHNICAL_ROLLUP_STORAGE_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    // ignore storage failures
  }
  return null;
}

function laneTechnicalRollupStorageKey(laneId: string): string {
  return `${LANE_TECHNICAL_ROLLUP_LANE_STORAGE_PREFIX}${encodeURIComponent(laneId)}`;
}

function readStoredLaneTechnicalRollup(laneId: string): boolean {
  try {
    const stored = sessionStorage.getItem(laneTechnicalRollupStorageKey(laneId));
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    // ignore storage failures
  }
  return readStoredLegacyTechnicalRollup() ?? false;
}

function writeStoredLaneTechnicalRollup(laneId: string, enabled: boolean): void {
  try {
    sessionStorage.setItem(laneTechnicalRollupStorageKey(laneId), enabled ? "1" : "0");
  } catch {
    // ignore storage failures
  }
}

function useLaneScrollMemory(profileId: string, restoreSignature: string) {
  const nodesRef = useRef(new Map<LaneScrollZone, HTMLDivElement>());
  const scrollLeftRef = useRef<Partial<Record<LaneScrollZone, number>>>({});

  const restoreZone = useCallback((zone: LaneScrollZone, node = nodesRef.current.get(zone)) => {
    if (!node) return;
    const remembered = scrollLeftRef.current[zone] ?? readStoredLaneScrollLeft(profileId, zone);
    if (remembered <= 0) return;
    const max = Math.max(0, node.scrollWidth - node.clientWidth);
    const next = Math.min(remembered, max);
    if (Math.abs(node.scrollLeft - next) > 1) {
      node.scrollLeft = next;
    }
  }, [profileId]);

  const restoreAll = useCallback(() => {
    for (const zone of LANE_SCROLL_ZONES) restoreZone(zone);
  }, [restoreZone]);

  useLayoutEffect(() => {
    restoreAll();
    const frame = window.requestAnimationFrame(restoreAll);
    return () => window.cancelAnimationFrame(frame);
  }, [profileId, restoreAll, restoreSignature]);

  const setLaneScrollNode = useCallback((zone: LaneScrollZone, node: HTMLDivElement | null) => {
    if (!node) {
      nodesRef.current.delete(zone);
      return;
    }
    nodesRef.current.set(zone, node);
    restoreZone(zone, node);
  }, [restoreZone]);

  const handleLaneScroll = useCallback((
    zone: LaneScrollZone,
    event: ReactUIEvent<HTMLDivElement>,
  ) => {
    const value = event.currentTarget.scrollLeft;
    scrollLeftRef.current[zone] = value;
    writeStoredLaneScrollLeft(profileId, zone, value);
  }, [profileId]);

  return { handleLaneScroll, setLaneScrollNode };
}

function AgentLaneIssueRow({ issue }: { issue: AgentLaneRosterIssue }) {
  const agents = issue.agentNames?.length
    ? issue.agentNames.join(", ")
    : issue.agentIds?.join(", ");
  const paths = issue.transcriptPaths?.join(" · ");
  const detail = [agents, paths].filter(Boolean).join(" · ");
  return (
    <li className="s-agent-lanes-issues-item">
      <span className="s-agent-lanes-issues-kind">{issue.kind.replaceAll("_", " ")}</span>
      <span className="s-agent-lanes-issues-message">{issue.message}</span>
      {detail ? <span className="s-agent-lanes-issues-detail">{detail}</span> : null}
    </li>
  );
}

function AgentLanesUnavailableState({
  loadState,
  onRetry,
}: {
  loadState: TailFeedLoadState;
  onRetry: () => void;
}) {
  const failures = [
    loadState.discovery === "error" ? "session discovery" : "",
    loadState.recent === "error" ? "recent history" : "",
  ].filter(Boolean).join(" and ");
  return (
    <div className="s-agent-lanes-empty s-agent-lanes-empty--degraded" role="alert">
      <div className="s-agent-lanes-empty-card">
        <div className="s-agent-lanes-empty-rail" aria-hidden="true"><span /><span /><span /></div>
        <div className="s-agent-lanes-empty-copy">
          <span className="s-agent-lanes-empty-kicker">Tail incomplete</span>
          <h2>Recent activity could not be loaded</h2>
          <p>Scout could not finish {failures || "the tail scan"}, so this is not being treated as a quiet interval.</p>
          <p className="s-agent-lanes-empty-secondary">Live events can still arrive while Scout retries.</p>
        </div>
        <div className="s-agent-lanes-empty-actions">
          <button type="button" onClick={onRetry}>Retry tail scan</button>
        </div>
      </div>
    </div>
  );
}

function AgentLanesEmptyState({
  activeFilterLabel,
  horizon,
  horizonLabel,
  showAutoLanes,
  onHorizonChange,
  onAddAttentionLane,
  onAddCodexLane,
  sourceCount,
  eventCount,
}: {
  activeFilterLabel: string;
  horizon: AgentLaneHorizonKey;
  horizonLabel: string;
  showAutoLanes: boolean;
  onHorizonChange: (horizon: AgentLaneHorizonKey) => void;
  onAddAttentionLane: () => void;
  onAddCodexLane: () => void;
  sourceCount: number;
  eventCount: number;
}) {
  const filtered = Boolean(activeFilterLabel);
  const title = filtered
    ? "No matching lanes"
    : showAutoLanes
      ? `No activity in the last ${horizonLabel}`
      : "No pinned lanes";
  const detail = filtered
    ? `${activeFilterLabel} has no activity in the last ${horizonLabel}.`
    : showAutoLanes
      ? `Scout checked ${sourceCount.toLocaleString()} session source${sourceCount === 1 ? "" : "s"} and ${eventCount.toLocaleString()} recent tail event${eventCount === 1 ? "" : "s"}; nothing is active in this interval.`
      : "Automatic lanes are off, and this deck has no pinned sessions.";
  const secondary = showAutoLanes
    ? "Scout will keep listening. New turns and tool output will appear here automatically."
    : "Pin a session lane or turn automatic lanes back on to populate the deck.";
  const nextHorizon: AgentLaneHorizonKey | null = horizon === "5m"
    ? "30m"
    : horizon === "24h"
      ? null
      : "24h";

  return (
    <div className="s-agent-lanes-empty" role="status" aria-live="polite">
      <div className="s-agent-lanes-empty-card">
        <div className="s-agent-lanes-empty-rail" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="s-agent-lanes-empty-copy">
          <span className="s-agent-lanes-empty-kicker">{filtered ? "Filter checked" : showAutoLanes ? "Tail scanned" : "Lane deck ready"}</span>
          <h2>{title}</h2>
          <p>{detail}</p>
          <p className="s-agent-lanes-empty-secondary">{secondary}</p>
        </div>
        <div className="s-agent-lanes-empty-actions">
          {nextHorizon ? (
            <button type="button" onClick={() => onHorizonChange(nextHorizon)}>
              Look back {agentLaneHorizonLabel(nextHorizon)}
            </button>
          ) : null}
          <button type="button" onClick={onAddAttentionLane}>
            Show attention
          </button>
          <button type="button" onClick={onAddCodexLane}>
            Pin Codex sessions
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentLaneColumn({
  lane,
  widthPx,
  laneTitle,
  pinned,
  laneWidth,
  defaultWidth,
  isNew,
  nowMs,
  traceWindowMs,
  traceWindowLabel,
  summaryHeight,
  onSummaryResizeStart,
  onSummaryResizeReset,
  summaryResizing,
  onInspect,
  onTraceEventSelect,
  onTogglePin,
  onWidthChange,
  onWidthResizeStart,
  widthResizing,
  focusProps,
  operatorName,
  grid = false,
}: {
  lane: AgentLane;
  widthPx: number;
  laneTitle: string;
  pinned: boolean;
  laneWidth: AgentLaneWidthTier | number | undefined;
  defaultWidth: AgentLaneWidthTier;
  isNew?: boolean;
  nowMs: number;
  traceWindowMs: number;
  traceWindowLabel: string;
  summaryHeight: number | null;
  onSummaryResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onSummaryResizeReset: () => void;
  summaryResizing?: boolean;
  onInspect: (lane: AgentLane) => void;
  onTraceEventSelect: (lane: AgentLane, event: ObserveEvent) => void;
  onTogglePin: () => void;
  onWidthChange: (width: AgentLaneWidthTier) => void;
  onWidthResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  widthResizing?: boolean;
  focusProps?: {
    "data-cursor"?: boolean;
    tabIndex: 0 | -1;
    ref: (node: HTMLElement | null) => void;
    onFocus: () => void;
  };
  /** Operator display name for the chat-style user-request head in the trace. */
  operatorName?: string;
  grid?: boolean;
}) {
  const { agent, observe, source } = lane;
  const isLive = isAgentLaneLive(observe);
  const hasTrace = Boolean(observe);
  const liveClass = isLive ? " s-agent-lane--live" : "";
  const newClass = isNew ? " s-agent-lane--new" : "";
  // Calm by default: the cockpit overlay starts collapsed (header + status
  // stay; the resizable pane and its handle reveal on expand), rather than
  // opening expanded.
  const [collapsed, setCollapsed] = useState(true);
  const [collapseTechnicalEvents, setCollapseTechnicalEvents] = useState(() => (
    readStoredLaneTechnicalRollup(lane.id)
  ));
  const technicalRollupLaneIdRef = useRef(lane.id);

  useEffect(() => {
    if (technicalRollupLaneIdRef.current !== lane.id) {
      technicalRollupLaneIdRef.current = lane.id;
      setCollapseTechnicalEvents(readStoredLaneTechnicalRollup(lane.id));
      return;
    }
    writeStoredLaneTechnicalRollup(lane.id, collapseTechnicalEvents);
  }, [collapseTechnicalEvents, lane.id]);

  // The proven lane trace (distinguished per-kind rows, enter animations,
  // auto-scroll, hidden scrollbars). Rendered fresh per call so it can sit in
  // both the current column and the new card without sharing an element.
  const laneRef = focusProps?.ref;
  const laneFocusRest = focusProps
    ? {
        "data-cursor": focusProps["data-cursor"],
        tabIndex: focusProps.tabIndex,
        onFocus: focusProps.onFocus,
      }
    : undefined;

  const renderTrace = () => (
    <section className="s-agent-lane-trace" aria-label={`${lanePrimaryLabel(agent, source)} trace`}>
      <div className="s-agent-lane-body">
        {hasTrace ? (
          <SessionObserve
            data={observe ?? undefined}
            agentId={lane.source === "scout" ? agent.id : undefined}
            sessionId={agent.harnessSessionId}
            showRail={false}
            variant="lane"
            nowMs={nowMs}
            traceWindowMs={traceWindowMs}
            traceWindowLabel={traceWindowLabel}
            laneCollapseTechnicalEvents={collapseTechnicalEvents}
            onLaneCollapseTechnicalEventsChange={setCollapseTechnicalEvents}
            laneOperatorName={operatorName}
            onLaneEventSelect={(event) => onTraceEventSelect(lane, event)}
          />
        ) : (
          <div className="s-agent-lane-empty">Waiting for trace activity…</div>
        )}
      </div>
    </section>
  );

  // The agent lane: the studio-design card (identity header + resizable cockpit
  // overlay) above the live SessionObserve trace.
  return (
    <article
      ref={laneRef}
      data-lane-id={lane.id}
      className={`s-agent-lane${grid ? " s-agent-lane--grid" : ""}${liveClass}${newClass}${pinned ? " s-agent-lane--pinned" : ""}${focusProps?.["data-cursor"] ? " s-agent-lane--cursor" : ""}`}
      style={grid ? undefined : ({ "--lane-width": `${widthPx}px` } as CSSProperties)}
      {...laneFocusRest}
    >
      <AgentLaneChrome
        title={laneTitle}
        width={laneWidth}
        defaultWidth={defaultWidth}
        pinned={pinned}
        onTogglePin={onTogglePin}
        onWidthChange={onWidthChange}
        onResizeStart={onWidthResizeStart}
        resizing={widthResizing}
        statusLabel={laneStatusLabel(agent, source)}
        live={isLive}
        widthControls={!grid}
      />
      <AgentLaneCard
        model={agentLaneToCardModel(lane, { isLive, nowMs })}
        avatar={(
          <AgentAvatar agent={agent} placement="row" size={44} presence={false} tile={false} />
        )}
        collapsed={collapsed}
        cockpitHeight={collapsed ? undefined : summaryHeight}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        onOpen={() => onInspect(lane)}
      />
      {!collapsed && (
        <AgentLaneSummaryResizeHandle
          onResizeStart={onSummaryResizeStart}
          onReset={onSummaryResizeReset}
          active={summaryResizing}
        />
      )}
      {renderTrace()}
    </article>
  );
}

export type AgentLanesData = {
  agents: Agent[];
  discovery: TailDiscoverySnapshot | null;
  tailEvents: TailEvent[];
  loadState: TailFeedLoadState;
  retryInitialLoad: () => Promise<void>;
  observeCache: ObserveCache;
  terminalSessions?: TerminalSessionRecord[];
  operatorName?: string;
};

export function AgentLanesView({
  navigate,
  agents: agentsProp,
  data,
  embedded = false,
  laneSize = "lg",
  profileId: profileIdProp,
  harnessFilter,
  projectFilter,
}: {
  navigate: (route: Route) => void;
  agents?: Agent[];
  data?: AgentLanesData;
  embedded?: boolean;
  laneSize?: AgentLaneSize;
  profileId?: LaneDeckProfileId;
  harnessFilter?: string | null;
  projectFilter?: string | null;
}) {
  const scoutContext = useContext(ScoutContext);
  const scoutAgents = data?.agents ?? agentsProp ?? scoutContext?.agents ?? [];
  const laneOperatorName = data?.operatorName?.trim()
    || scoutContext?.onboarding?.operatorName?.trim()
    || undefined;
  const profileId = profileIdProp ?? readLaneDeckProfileId();
  const defaultWidthTier = laneSize ?? readAgentLaneSize();
  const [now, setNow] = useState(Date.now());
  const [horizon, setHorizon] = useState<AgentLaneHorizonKey>(readStoredHorizon);
  const [laneLayout, setLaneLayout] = useState<AgentLanesLayoutMode>(() => readStoredLaneLayout(embedded));
  const [gridColumns, setGridColumns] = useState<AgentLanesGridColumns>(readStoredLaneGridColumns);
  const floorMode = !embedded && laneLayout === "floor";
  const gridMode = laneLayout === "grid";
  // The floor's recency bands span up to 4h; admission follows the bands while
  // the user's stored horizon choice stays untouched for the lanes layout.
  const effectiveHorizon: AgentLaneHorizonKey = floorMode ? "4h" : horizon;
  const [summaryHeight, setSummaryHeight] = useState<number | null>(readStoredLaneSummaryHeight);
  const [browserTerminalSessions, setBrowserTerminalSessions] = useState<TerminalSessionRecord[]>([]);
  const { beginResize, resetSummaryHeight, resizing: summaryResizing } = useLaneSummaryResize(setSummaryHeight);
  const handleSummaryResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => beginResize(event, summaryHeight),
    [beginResize, summaryHeight],
  );
  const tailRecentLimit = agentLaneTailRecentLimit(effectiveHorizon);
  const traceWindowMs = agentLaneHorizonWindowMs(effectiveHorizon);
  const browserTail = useTailFeed({
    enabled: !data,
    includeTranscriptReplay: true,
    hydrateOnDiscovery: true,
    discoveryIntervalMs: embedded ? EMBEDDED_TAIL_DISCOVERY_INTERVAL_MS : 5_000,
    recentLimit: tailRecentLimit,
    discoveryLimit: embedded ? EMBEDDED_TAIL_DISCOVERY_LIMIT : undefined,
    pauseWhenHidden: true,
  });
  const discovery = data?.discovery ?? browserTail.discovery;
  const tailEvents = data?.tailEvents ?? browserTail.events;
  const loadState = data?.loadState ?? browserTail.loadState;
  const retryInitialLoad = data?.retryInitialLoad ?? browserTail.retryInitialLoad;
  const terminalSessions = data?.terminalSessions ?? browserTerminalSessions;
  const returnRoute: Route = { view: "ops", mode: "lanes" };
  const horizonLabel = agentLaneHorizonLabel(effectiveHorizon);
  const clockIntervalMs = embedded ? EMBEDDED_CLOCK_INTERVAL_MS : 10_000;
  const terminalPollIntervalMs = embedded ? EMBEDDED_TERMINAL_POLL_INTERVAL_MS : 10_000;

  useEffect(() => {
    const timer = setInterval(() => {
      if (!documentIsHidden()) setNow(Date.now());
    }, clockIntervalMs);
    return () => clearInterval(timer);
  }, [clockIntervalMs]);

  useEffect(() => {
    if (data) return;
    let cancelled = false;
    const load = async () => {
      if (documentIsHidden()) return;
      try {
        const sessions = await fetchTerminalSessions({ includeDiscovered: false });
        if (!cancelled) setBrowserTerminalSessions(sessions);
      } catch {
        if (!cancelled) setBrowserTerminalSessions([]);
      }
    };
    void load();
    const timer = setInterval(() => void load(), terminalPollIntervalMs);
    const stopActivationListener = onScoutSurfaceActivated(() => void load());
    return () => {
      cancelled = true;
      clearInterval(timer);
      stopActivationListener();
    };
  }, [data, terminalPollIntervalMs]);

  useEffect(() => {
    try {
      sessionStorage.setItem(LANE_HORIZON_STORAGE_KEY, horizon);
    } catch {
      // ignore storage failures
    }
  }, [horizon]);

  useEffect(() => {
    try {
      sessionStorage.setItem(LANE_LAYOUT_STORAGE_KEY, laneLayout);
    } catch {
      // ignore storage failures
    }
  }, [laneLayout]);

  useEffect(() => {
    try {
      sessionStorage.setItem(LANE_GRID_COLUMNS_STORAGE_KEY, gridColumns);
    } catch {
      // ignore storage failures
    }
  }, [gridColumns]);

  const laneOrderRef = useRef(createStableLaneOrder());
  const rosterIssueLogSignatureRef = useRef("");
  const [newLaneIds, setNewLaneIds] = useState<Set<string>>(() => new Set());
  const [inspectedLaneId, setInspectedLaneId] = useState<string | null>(null);
  const observeAgents = useMemo(
    () => scoutAgents.filter((agent) => shouldPollAgentForLaneObserve(agent, now, effectiveHorizon)),
    [scoutAgents, now, effectiveHorizon],
  );
  const browserObserveCache = useObservePolling(observeAgents, {
    enabled: !data,
    activeIntervalMs: embedded ? EMBEDDED_OBSERVE_ACTIVE_INTERVAL_MS : undefined,
    idleIntervalMs: embedded ? EMBEDDED_OBSERVE_IDLE_INTERVAL_MS : undefined,
    pauseWhenHidden: true,
  });
  const observeCache = data?.observeCache ?? browserObserveCache;
  const tailLoading = loadState.discovery === "loading" || loadState.recent === "loading";
  const tailUnavailable = loadState.discovery === "error" || loadState.recent === "error";
  const tailSourceCount = discovery?.totals.transcripts ?? discovery?.transcripts?.length ?? 0;
  // The status sheet outlives the load by its retract, so the exit plays over
  // the finished deck instead of vanishing on unmount. A failed scan gets no
  // exit animation — the unavailable card should take the region immediately.
  const laneBoot = useLaneBootVisibility(tailLoading, tailUnavailable ? 0 : LANE_BOOT_EXIT_MS);

  useEffect(() => {
    if (newLaneIds.size === 0) return;
    const timer = setTimeout(() => setNewLaneIds(new Set()), 900);
    return () => clearTimeout(timer);
  }, [newLaneIds]);

  const { lanes, issues, freshLaneIds } = useMemo(() => {
    const built = buildAgentLanes({
      transcripts: discovery?.transcripts ?? [],
      tailEvents,
      processes: discovery?.processes ?? [],
      scoutAgents,
      terminalSessions,
      observeCache,
      now,
      workingOnly: true,
      horizon: effectiveHorizon,
    });
    const result = sortLanesWithStableOrder(built.lanes, laneOrderRef.current);
    const rosterIssues = [
      ...rosterIssuesFromTailDiscovery(discovery),
      ...built.issues,
    ];
    return {
      lanes: result.lanes,
      issues: rosterIssues,
      freshLaneIds: result.newLaneIds,
    };
  }, [discovery, tailEvents, scoutAgents, terminalSessions, observeCache, now, effectiveHorizon]);

  useEffect(() => {
    const signature = issues.map((issue) => `${issue.id}\0${issue.message}`).join("\n");
    if (signature === rosterIssueLogSignatureRef.current) return;
    rosterIssueLogSignatureRef.current = signature;
    if (issues.length === 0) return;
    console.warn(
      `[agent-lanes] ${issues.length} roster issue${issues.length === 1 ? "" : "s"}`,
      issues,
    );
  }, [issues]);

  useEffect(() => {
    if (freshLaneIds.length === 0) return;
    setNewLaneIds((previous) => {
      const next = new Set(previous);
      for (const id of freshLaneIds) next.add(id);
      return next;
    });
  }, [freshLaneIds.join("\0")]);

  const inspectedLane = useMemo(
    () => lanes.find((lane) => lane.id === inspectedLaneId) ?? null,
    [inspectedLaneId, lanes],
  );
  const filteredLanes = useMemo(
    () => lanes.filter((lane) => laneMatchesEmbedFilters(lane, { harnessFilter, projectFilter })),
    [lanes, harnessFilter, projectFilter],
  );
  // The pre-flight deck has to be scoped the same way, or a single-project embed
  // pre-draws a cell for every project on the machine and then hands over one
  // lane. Matched on the transcript fields that survive into the lane.
  const matchPreflightTranscript = useCallback(
    (transcript: TailDiscoveredTranscript) =>
      transcriptMatchesEmbedFilters(transcript, { harnessFilter, projectFilter }),
    [harnessFilter, projectFilter],
  );
  const {
    deck,
    layout,
    pinLane,
    unpinLane,
    setLaneWidth,
    addHarnessLane,
    addAttentionLane,
    clearPins,
    isPinned,
  } = useLaneDeck(profileId, defaultWidthTier, filteredLanes);
  const { beginResize: beginWidthResize, resizingLaneId } = useLaneWidthResize(setLaneWidth);
  const activeFilterLabel = useMemo(
    () => embedFilterLabel({ harnessFilter, projectFilter }),
    [harnessFilter, projectFilter],
  );
  const visibleColumns = layout.flat;
  const pinnedCount = layout.pinnedLeft.length + layout.pinnedRight.length;
  const laneScrollRestoreSignature = useMemo(() => (
    [
      layout.pinnedLeft,
      layout.main,
      layout.pinnedRight,
    ].map((columns) => columns.map((column) => `${column.key}:${column.widthPx}`).join(",")).join("/")
  ), [layout.main, layout.pinnedLeft, layout.pinnedRight]);
  const { handleLaneScroll, setLaneScrollNode } = useLaneScrollMemory(profileId, laneScrollRestoreSignature);
  const setPinnedLeftScrollNode = useCallback((node: HTMLDivElement | null) => {
    setLaneScrollNode("pinned-left", node);
  }, [setLaneScrollNode]);
  const setMainScrollNode = useCallback((node: HTMLDivElement | null) => {
    setLaneScrollNode("main", node);
  }, [setLaneScrollNode]);
  const setPinnedRightScrollNode = useCallback((node: HTMLDivElement | null) => {
    setLaneScrollNode("pinned-right", node);
  }, [setLaneScrollNode]);
  const handlePinnedLeftScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    handleLaneScroll("pinned-left", event);
  }, [handleLaneScroll]);
  const handleMainScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    handleLaneScroll("main", event);
  }, [handleLaneScroll]);
  const handlePinnedRightScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    handleLaneScroll("pinned-right", event);
  }, [handleLaneScroll]);

  // Publish the roster the deck actually rendered — `layout.flat` is exactly the
  // column order on screen (pinned-left → main → pinned-right, with hidden auto
  // lanes and stable ordering already applied) — so the lanes-mode left rail can
  // mirror the strip 1:1 instead of re-deriving a roster that drifts from it.
  useEffect(() => {
    // In floor mode the floor publishes its own rich ledger — stay out of the way.
    if (floorMode) return;
    const entries: LaneRosterEntry[] = visibleColumns.map((column) => {
      const { lane } = column;
      return {
        id: lane.id,
        label: lanePrimaryLabel(lane.agent, lane.source),
        statusLabel: laneStatusLabel(lane.agent, lane.source),
        tone: normalizeAgentState(lane.agent.state, lane.agent),
        agentId: isLaneSyntheticAgent(lane.agent) ? undefined : lane.agent.id,
        updatedAt: lane.lastActiveAt > 0 ? lane.lastActiveAt : undefined,
      };
    });
    publishLaneRoster(entries);
  }, [visibleColumns, floorMode]);

  // Clear on unmount so a stale roster doesn't linger for a rail that outlives
  // the deck (or a next mount before the first publish).
  useEffect(() => () => publishLaneRoster(null), []);
  const [traceSheetTarget, setTraceSheetTarget] = useState<LaneTraceSheetTarget | null>(null);
  const inspectLane = useCallback((lane: AgentLane) => {
    setInspectedLaneId(lane.id);
  }, []);
  const openTraceSheet = useCallback((lane: AgentLane, event: ObserveEvent) => {
    setTraceSheetTarget({ lane, event });
  }, []);
  const openFloorTrace = useCallback((lane: AgentLane) => {
    const event = lane.observe?.events.at(-1);
    if (event) setTraceSheetTarget({ lane, event });
  }, []);
  const { getLaneFocusProps } = useAgentLanesKeyboard({
    lanes: visibleColumns.map((column) => column.lane),
    inspectedLaneId,
    onInspect: inspectLane,
    onHorizonChange: setHorizon,
  });
  const [deckMenuOpen, setDeckMenuOpen] = useState(false);
  const deckMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!deckMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!deckMenuRef.current?.contains(event.target as Node)) {
        setDeckMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [deckMenuOpen]);

  const renderLaneColumn = useCallback((column: ResolvedLaneColumn, index: number, grid = false) => {
    const { lane } = column;
    const laneTitle = lanePrimaryLabel(lane.agent, lane.source);
    const laneWidth = deck.laneWidths[lane.id] ?? snapLaneWidthPx(column.widthPx).tier ?? column.widthPx;
    return (
      <AgentLaneColumn
        key={column.key}
        lane={lane}
        widthPx={column.widthPx}
        laneTitle={laneTitle}
        pinned={column.isPinned}
        laneWidth={laneWidth}
        defaultWidth={deck.defaultLaneWidth}
        isNew={newLaneIds.has(lane.id)}
        nowMs={now}
        traceWindowMs={traceWindowMs}
        traceWindowLabel={horizonLabel}
        summaryHeight={summaryHeight}
        onSummaryResizeStart={handleSummaryResizeStart}
        onSummaryResizeReset={resetSummaryHeight}
        summaryResizing={summaryResizing}
        onInspect={inspectLane}
        onTraceEventSelect={openTraceSheet}
        onTogglePin={() => {
          if (isPinned(lane.id)) unpinLane(lane.id);
          else pinLane(lane);
        }}
        onWidthChange={(width) => setLaneWidth(lane.id, width)}
        onWidthResizeStart={(event) => beginWidthResize(lane.id, event, column.widthPx)}
        widthResizing={resizingLaneId === lane.id}
        focusProps={getLaneFocusProps(index, lane.id)}
        operatorName={laneOperatorName}
        grid={grid}
      />
    );
  }, [
    beginWidthResize,
    deck.defaultLaneWidth,
    deck.laneWidths,
    getLaneFocusProps,
    handleSummaryResizeStart,
    horizonLabel,
    inspectLane,
    openTraceSheet,
    isPinned,
    laneOperatorName,
    newLaneIds,
    now,
    pinLane,
    resetSummaryHeight,
    resizingLaneId,
    setLaneWidth,
    summaryHeight,
    summaryResizing,
    traceWindowMs,
    unpinLane,
  ]);

  return (
    <div
      className={`s-agent-lanes${embedded ? " s-agent-lanes--embedded s-agent-lanes--low-motion" : ""}`}
      data-lane-profile={profileId}
      data-lane-layout={floorMode ? "floor" : laneLayout}
      data-lanes-deck-version="1"
    >
      <div className="s-agent-lanes-bar">
        <div className="s-agent-lanes-bar-leading">
          <div className="s-agent-lanes-title">Agent Lanes</div>
          <div className="s-agent-lanes-meta" aria-label="Lane deck status">
            <span className="s-agent-lanes-meta-stat">
              {floorMode ? filteredLanes.length : visibleColumns.length} live
            </span>
            {!floorMode && pinnedCount > 0 ? (
              <span className="s-agent-lanes-meta-stat">{pinnedCount} pinned</span>
            ) : null}
            <span className="s-agent-lanes-meta-stat">
              {floorMode ? "past 30m · lanes 4h" : `trace ${horizonLabel}`}
            </span>
            {activeFilterLabel ? (
              <span className="s-agent-lanes-meta-filter">{activeFilterLabel}</span>
            ) : null}
            <span className="s-agent-lanes-meta-detail">
              deck v1 · {profileId}
            </span>
          </div>
        </div>
        <div className="s-agent-lanes-bar-controls">
          <div className="s-agent-lanes-layouts" role="group" aria-label="Lane layout">
            {agentLanesLayoutOptions(embedded).map((option) => (
              <button
                key={option.key}
                type="button"
                className={`s-agent-lanes-horizon${laneLayout === option.key ? " s-agent-lanes-horizon--on" : ""}`}
                aria-pressed={laneLayout === option.key}
                onClick={() => setLaneLayout(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {gridMode ? (
            <div className="s-agent-lanes-grid-density" role="group" aria-label="Grid columns">
              {AGENT_LANES_GRID_COLUMN_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={`s-agent-lanes-horizon${gridColumns === option.key ? " s-agent-lanes-horizon--on" : ""}`}
                  aria-pressed={gridColumns === option.key}
                  title={option.key === "auto" ? "Fit columns to the available width" : `${option.key} columns`}
                  onClick={() => setGridColumns(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="s-agent-lanes-deck-menu" ref={deckMenuRef} hidden={floorMode}>
            <button
              type="button"
              className="s-agent-lanes-deck-btn"
              aria-expanded={deckMenuOpen}
              onClick={() => setDeckMenuOpen((open) => !open)}
            >
              + Lane
            </button>
            {deckMenuOpen ? (
              <div className="s-agent-lanes-deck-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="s-agent-lanes-deck-item"
                  onClick={() => {
                    addAttentionLane();
                    setDeckMenuOpen(false);
                  }}
                  disabled={hasAttentionLane(deck)}
                >
                  Needs attention
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="s-agent-lanes-deck-item"
                  onClick={() => {
                    addHarnessLane("codex", "Codex sessions");
                    setDeckMenuOpen(false);
                  }}
                  disabled={hasHarnessLane(deck, "codex")}
                >
                  Codex sessions
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="s-agent-lanes-deck-item"
                  onClick={() => {
                    addHarnessLane("claude", "Claude sessions");
                    setDeckMenuOpen(false);
                  }}
                  disabled={hasHarnessLane(deck, "claude")}
                >
                  Claude sessions
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="s-agent-lanes-deck-item"
                  onClick={() => {
                    addHarnessLane("grok", "Grok sessions");
                    setDeckMenuOpen(false);
                  }}
                  disabled={hasHarnessLane(deck, "grok")}
                >
                  Grok sessions
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="s-agent-lanes-deck-item"
                  onClick={() => {
                    addHarnessLane("kimi", "Kimi sessions");
                    setDeckMenuOpen(false);
                  }}
                  disabled={hasHarnessLane(deck, "kimi")}
                >
                  Kimi sessions
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="s-agent-lanes-deck-item s-agent-lanes-deck-item--danger"
                  onClick={() => {
                    clearPins();
                    setDeckMenuOpen(false);
                  }}
                  disabled={pinnedCount === 0}
                >
                  Clear pinned lanes
                </button>
              </div>
            ) : null}
          </div>
          {!floorMode ? (
            <div className="s-agent-lanes-horizons" role="group" aria-label="Activity window">
              {AGENT_LANE_HORIZON_OPTIONS.map((option, index) => (
                <button
                  key={option.key}
                  type="button"
                  className={`s-agent-lanes-horizon${horizon === option.key ? " s-agent-lanes-horizon--on" : ""}`}
                  aria-pressed={horizon === option.key}
                  title={`${option.label} window (${index + 1})`}
                  onClick={() => setHorizon(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {data == null && issues.length > 0 ? (
        <div className="s-agent-lanes-issues" role="status" aria-live="polite">
          <div className="s-agent-lanes-issues-head">
            <span className="s-agent-lanes-issues-badge">Roster issues</span>
            <span className="s-agent-lanes-issues-meta">
              {issues.length} fleet/transcript warning{issues.length === 1 ? "" : "s"} — lanes follow tail, not agent registry
            </span>
          </div>
          <ul className="s-agent-lanes-issues-list">
            {issues.map((issue) => (
              <AgentLaneIssueRow key={issue.id} issue={issue} />
            ))}
          </ul>
        </div>
      ) : null}
      {(floorMode ? filteredLanes.length : visibleColumns.length) === 0 ? (
        laneBoot.visible ? (
          <AgentLanesPreflightDeck
            discovery={discovery}
            discoveryPhase={loadState.discovery}
            windowMs={traceWindowMs}
            nowMs={now}
            layout={floorMode ? "none" : gridMode ? "grid" : "scroll"}
            gridColumns={gridColumns}
            laneWidthPx={resolveLaneWidthPx(deck.defaultLaneWidth, deck.defaultLaneWidth)}
            matchTranscript={matchPreflightTranscript}
          />
        ) : tailUnavailable ? (
          <AgentLanesUnavailableState
            loadState={loadState}
            onRetry={() => void retryInitialLoad()}
          />
        ) : (
          <AgentLanesEmptyState
            activeFilterLabel={activeFilterLabel}
            horizon={horizon}
            horizonLabel={horizonLabel}
            showAutoLanes={deck.showAutoLanes}
            onHorizonChange={setHorizon}
            onAddAttentionLane={addAttentionLane}
            onAddCodexLane={() => addHarnessLane("codex", "Codex sessions")}
            sourceCount={tailSourceCount}
            eventCount={tailEvents.length}
          />
        )
      ) : floorMode ? (
        <AgentFloorView lanes={filteredLanes} now={now} onOpenTrace={openFloorTrace} railLedger operatorName={laneOperatorName} />
      ) : gridMode ? (
        <div
          className="s-agent-lanes-grid"
          data-grid-columns={gridColumns}
          role="listbox"
          aria-label="Agent lane grid"
        >
          {visibleColumns.map((column, index) => renderLaneColumn(column, index, true))}
        </div>
      ) : (
        <div className="s-agent-lanes-body">
          {layout.pinnedLeft.length > 0 ? (
            <section className="s-agent-lanes-zone s-agent-lanes-zone--pinned-left" aria-label="Pinned lanes">
              <div className="s-agent-lanes-zone-label">Pinned</div>
              <div
                ref={setPinnedLeftScrollNode}
                className="s-agent-lanes-scroll"
                role="listbox"
                aria-label="Pinned agent lanes"
                onScroll={handlePinnedLeftScroll}
              >
                {layout.pinnedLeft.map((column, index) => renderLaneColumn(column, index))}
              </div>
            </section>
          ) : null}
          {layout.main.length > 0 ? (
            <section className="s-agent-lanes-zone s-agent-lanes-zone--main" aria-label="Active lanes">
              {layout.pinnedLeft.length > 0 ? <div className="s-agent-lanes-zone-label">Live</div> : null}
              <div
                ref={setMainScrollNode}
                className="s-agent-lanes-scroll"
                role="listbox"
                aria-label="Active agent lanes"
                onScroll={handleMainScroll}
              >
                {layout.main.map((column, index) => renderLaneColumn(column, layout.pinnedLeft.length + index))}
              </div>
            </section>
          ) : null}
          {layout.pinnedRight.length > 0 ? (
            <section className="s-agent-lanes-zone s-agent-lanes-zone--pinned-right" aria-label="Pinned right lanes">
              <div className="s-agent-lanes-zone-label">Pinned</div>
              <div
                ref={setPinnedRightScrollNode}
                className="s-agent-lanes-scroll"
                role="listbox"
                aria-label="Pinned right agent lanes"
                onScroll={handlePinnedRightScroll}
              >
                {layout.pinnedRight.map((column, index) => renderLaneColumn(
                  column,
                  layout.pinnedLeft.length + layout.main.length + index,
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
      {laneBoot.visible ? (
        <AgentLanesLoadingSheet
          loadState={loadState}
          sourceCount={tailSourceCount}
          processCount={discovery?.processes.length ?? 0}
          eventCount={tailEvents.length}
          laneCount={floorMode ? filteredLanes.length : visibleColumns.length}
          horizonLabel={horizonLabel}
          handedOff={laneBoot.exiting}
          exiting={laneBoot.exiting}
        />
      ) : null}
      {inspectedLane && (
        <AgentLaneDetailSheet
          lane={inspectedLane}
          navigate={navigate}
          returnRoute={returnRoute}
          // Adapter-backed embeds have no browser routes, so hide route-jumping
          // controls rather than rendering inert buttons.
          navigationEnabled={data == null}
          onClose={() => setInspectedLaneId(null)}
        />
      )}
      {traceSheetTarget && (
        <LaneTraceDetailSheet
          target={traceSheetTarget}
          onClose={() => setTraceSheetTarget(null)}
        />
      )}
    </div>
  );
}

type AgentLaneEmbedFilters = {
  harnessFilter?: string | null;
  projectFilter?: string | null;
};

function normalizeEmbedFilter(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function slugValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function pathLeaf(value: string): string | null {
  const leaf = value.trim().replace(/\/+$/u, "").split(/[\\/]/u).filter(Boolean).pop();
  return leaf?.trim() || null;
}

function matchesAnyFilter(candidates: Array<string | null | undefined>, filter: string | null): boolean {
  if (!filter) return true;
  const filterSlug = slugValue(filter);
  return candidates.some((candidate) => {
    const raw = candidate?.trim();
    if (!raw) return false;
    const normalized = raw.toLowerCase();
    const leaf = pathLeaf(raw);
    return normalized === filter
      || slugValue(raw) === filterSlug
      || Boolean(leaf && (leaf.toLowerCase() === filter || slugValue(leaf) === filterSlug));
  });
}

function laneMatchesEmbedFilters(lane: AgentLane, filters: AgentLaneEmbedFilters): boolean {
  const harnessFilter = normalizeEmbedFilter(filters.harnessFilter);
  const projectFilter = normalizeEmbedFilter(filters.projectFilter);
  const { agent, facts, source } = lane;
  return matchesAnyFilter(
    [
      agent.harness,
      agent.definitionId,
      facts?.attribution,
      source,
    ],
    harnessFilter,
  ) && matchesAnyFilter(
    [
      agent.project,
      agent.projectRoot,
      agent.cwd,
      facts?.cwd,
      lanePrimaryLabel(agent, source),
    ],
    projectFilter,
  );
}

/**
 * The same scoping applied to a discovery transcript, for the pre-flight deck.
 * Only the fields a transcript actually carries are matched — a lane's richer
 * attribution does not exist yet at discovery, so this is deliberately the
 * subset, which can admit a cell the lane filter later rejects but never the
 * reverse.
 */
function transcriptMatchesEmbedFilters(
  transcript: TailDiscoveredTranscript,
  filters: AgentLaneEmbedFilters,
): boolean {
  return matchesAnyFilter(
    [transcript.harness, transcript.source],
    normalizeEmbedFilter(filters.harnessFilter),
  ) && matchesAnyFilter(
    [transcript.project, transcript.cwd],
    normalizeEmbedFilter(filters.projectFilter),
  );
}

function embedFilterLabel(filters: AgentLaneEmbedFilters): string {
  const parts = [
    filters.harnessFilter?.trim() ? `harness ${filters.harnessFilter.trim()}` : "",
    filters.projectFilter?.trim() ? `project ${filters.projectFilter.trim()}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

export const scoutSurface = defineSurface({
  id: "lanes",
  label: "Agent Lanes",
  route: { view: "ops", mode: "lanes" },
  webPath: "/ops/lanes",
  screen: "AgentLanesView",
  embed: {
    path: "/embed/agent-lanes",
    aliases: ["/ops/lanes/embed", "/embed/lanes", "/embed/traces"],
    profile: "macos.lanes",
    rootClassName: "s-agent-lanes-embed",
    chrome: { showSecondaryNav: false, showPageStatusBar: false },
    hosts: { macos: true },
    resolveEmbedProps: (params) => ({
      profileId: readLaneDeckProfileId(),
      laneSize: readAgentLaneSize(),
      harnessFilter: params.get("harness")?.trim() || null,
      projectFilter: params.get("project")?.trim() || null,
    }),
  },
});
