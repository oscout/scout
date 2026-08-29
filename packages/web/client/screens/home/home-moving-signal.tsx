/**
 * Home "What's moving" — Signal-first stream & Docked Sidecar Inspector.
 *
 * One-line machine rows (age · harness mark · project/branch · action · context).
 * Selecting a row docks a rich sidecar inspector alongside the fleet stream
 * without losing context of the overall control room.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowRight,
  Code2,
  Cpu,
  ExternalLink,
  FileCode2,
  GitBranch,
  Terminal,
  X,
} from "lucide-react";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import type { ObserveCache } from "../../lib/observe.ts";
import { normalizeTimestampMs } from "../../lib/time.ts";
import type {
  Agent,
  FleetActivity,
  FleetAsk,
  ObserveData,
  ObserveEvent,
  ObserveFile,
  Route,
} from "../../lib/types.ts";
import type { AgentLane } from "../ops/agent-lanes-model.ts";
import { isAgentLaneLive } from "../ops/agent-lanes-model.ts";
import {
  contextActivityLine,
  homeCardPeekEnabled,
  homeCardRoute,
  homeCardTerminalEnabled,
  lastTouchedFileLine,
  liveActionSummary,
  usefulHeadline,
} from "./home-live-action.ts";
import type { HomeMovingSortMode } from "./home-moving.ts";
import "./home-moving-signal.css";

export type HomeMovingSignalCard =
  | {
      bucket: "working";
      id: string;
      agent: Agent;
      lastActivityAt: number;
    }
  | {
      bucket: "native";
      id: string;
      lane: AgentLane;
      lastActivityAt: number;
    }
  | {
      bucket: "observed";
      id: string;
      actor: FleetActivity;
      lastActivityAt: number;
    };

export type SignalRowModel = {
  id: string;
  /** Primary left-side line — prefer the ongoing ask/task over turn churn. */
  action: string;
  /** Latest turn/tool update when it differs from the ask (inspector only). */
  nowLine: string | null;
  name: string;
  harness: string | null;
  projectKey: string;
  projectLabel: string;
  projectRoot: string | null;
  branch: string | null;
  lastAge: string;
  sessionAge: string | null;
  live: boolean;
  contextPct: number | null;
  tokensUsed: number | null;
  tokensMax: number | null;
  touchedFiles: ObserveFile[];
  recentEvents: ObserveEvent[];
  observeData: ObserveData | null;
  /** For action routing */
  agent: Agent | null;
  observeRoute: Route | null;
  profileRoute: Route | null;
  terminalRoute: Route | null;
  peekRoute: Route | null;
  terminalEnabled: boolean;
  peekEnabled: boolean;
};

/** Ask body for the scan line — not status/checkpoint noise. */
function ongoingAskLine(ask: FleetAsk | null | undefined): string | null {
  const task = ask?.task?.trim();
  if (!task) return null;
  if (/^(working|idle|queued)$/i.test(task)) return null;
  return usefulHeadline(task);
}

function linesDiffer(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = left?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
  const b = right?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
  return Boolean(a && b && a !== b);
}

function formatAge(timestamp: number | null | undefined, nowMs: number): string {
  const timestampMs = normalizeTimestampMs(timestamp);
  if (timestampMs === null) return "—";
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function compactPath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("/Users/")) return `~/${path.split("/").slice(3).join("/")}`;
  if (path.startsWith("~/")) return path;
  return path;
}

function projectKeyFromRoot(root: string | null | undefined): string {
  const compact = compactPath(root);
  if (!compact) return "other";
  const parts = compact.replace(/\/+$/u, "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? compact;
}

function projectLabelFromRoot(root: string | null | undefined): string {
  const compact = compactPath(root);
  if (!compact) return "other";
  const key = projectKeyFromRoot(root);
  return key === "other" ? "other" : `~/${key}`;
}

function summarize(text: string | null | undefined, max = 140): string {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function extractContextUsage(observeData: ObserveData | null | undefined): {
  contextPct: number | null;
  tokensUsed: number | null;
  tokensMax: number | null;
} {
  const usage = observeData?.metadata?.usage;
  const contextInput = usage?.contextInputTokens;
  const window = usage?.contextWindowTokens;
  if (typeof contextInput === "number" && typeof window === "number" && window > 0) {
    const contextPct = Math.min(100, Math.round((contextInput / window) * 100));
    return { contextPct, tokensUsed: contextInput, tokensMax: window };
  }
  return { contextPct: null, tokensUsed: null, tokensMax: null };
}

function buildWorkingSignal(
  agent: Agent,
  ask: FleetAsk | null | undefined,
  observeData: ObserveData | null | undefined,
  observeLive: boolean,
  lastActivityAt: number,
  nowMs: number,
): SignalRowModel {
  const root = agent.projectRoot ?? agent.cwd ?? null;
  const projectKey = projectKeyFromRoot(root);
  const askLine = ongoingAskLine(ask);
  const turnLine = usefulHeadline(liveActionSummary({
    observeData,
    checkpoint: null,
    fallbackTask: null,
    observeLive,
    skipLifecycleTokens: true,
  }));
  const fileLine = usefulHeadline(lastTouchedFileLine(observeData));
  const onlyDiscovery = !askLine && !turnLine && !fileLine;
  const contextLine = contextActivityLine({
    harness: agent.harness,
    project: projectKey === "other" ? null : projectKey,
    branch: agent.branch,
    live: observeLive,
    attachedOnly: onlyDiscovery && !observeLive,
  });

  const action = askLine
    || turnLine
    || usefulHeadline(ask?.summary)
    || fileLine
    || contextLine
    || "Working";
  const nowLine = askLine && turnLine && linesDiffer(askLine, turnLine)
    ? turnLine
    : null;
  const sessionStart = normalizeTimestampMs(observeData?.metadata?.session?.sessionStart);
  const { contextPct, tokensUsed, tokensMax } = extractContextUsage(observeData);

  return {
    id: agent.id,
    action: usefulHeadline(action) || summarize(action, 160) || "Working",
    nowLine,
    name: agent.name,
    harness: agent.harness?.trim() || null,
    projectKey,
    projectLabel: projectLabelFromRoot(root),
    projectRoot: root,
    branch: agent.branch?.trim() || null,
    lastAge: formatAge(lastActivityAt, nowMs),
    sessionAge: sessionStart !== null ? formatAge(sessionStart, nowMs) : null,
    live: observeLive || Boolean(
      ask
      && (ask.status === "working"
        || ask.agentState === "working"
        || ask.agentState === "in_flight"),
    ),
    contextPct,
    tokensUsed,
    tokensMax,
    touchedFiles: observeData?.files ?? [],
    recentEvents: (observeData?.events ?? []).slice(-6),
    observeData: observeData ?? null,
    agent,
    observeRoute: homeCardRoute(agent, "observe"),
    profileRoute: homeCardRoute(agent, "profile"),
    terminalRoute: homeCardRoute(agent, "terminal"),
    peekRoute: homeCardRoute(agent, "peek"),
    terminalEnabled: homeCardTerminalEnabled(agent),
    peekEnabled: homeCardPeekEnabled(agent),
  };
}

function buildNativeSignal(
  lane: AgentLane,
  lastActivityAt: number,
  nowMs: number,
): SignalRowModel {
  const agent = lane.agent;
  const observeLive = isAgentLaneLive(lane.observe);
  const root = agent.projectRoot ?? agent.cwd ?? null;
  const projectKey = projectKeyFromRoot(root);
  const turnLine = usefulHeadline(liveActionSummary({
    observeData: lane.observe,
    fallbackTask: null,
    observeLive,
    skipLifecycleTokens: true,
  }));
  const fileLine = usefulHeadline(lastTouchedFileLine(lane.observe));
  const action = turnLine
    || fileLine
    || contextActivityLine({
      harness: agent.harness,
      project: projectKey === "other" ? null : projectKey,
      branch: agent.branch,
      live: observeLive,
      attachedOnly: !turnLine && !fileLine,
    });
  const sessionStart = normalizeTimestampMs(lane.observe?.metadata?.session?.sessionStart);
  const { contextPct, tokensUsed, tokensMax } = extractContextUsage(lane.observe);

  return {
    id: lane.id,
    action: usefulHeadline(action) || summarize(action, 160) || "Active",
    nowLine: null,
    name: agent.name,
    harness: agent.harness?.trim() || null,
    projectKey,
    projectLabel: projectLabelFromRoot(root),
    projectRoot: root,
    branch: agent.branch?.trim() || null,
    lastAge: formatAge(lastActivityAt, nowMs),
    sessionAge: sessionStart !== null ? formatAge(sessionStart, nowMs) : null,
    live: observeLive,
    contextPct,
    tokensUsed,
    tokensMax,
    touchedFiles: lane.observe?.files ?? [],
    recentEvents: (lane.observe?.events ?? []).slice(-6),
    observeData: lane.observe ?? null,
    agent,
    observeRoute: homeCardRoute(agent, "observe"),
    profileRoute: homeCardRoute(agent, "profile"),
    terminalRoute: homeCardRoute(agent, "terminal"),
    peekRoute: homeCardRoute(agent, "peek"),
    terminalEnabled: homeCardTerminalEnabled(agent),
    peekEnabled: homeCardPeekEnabled(agent),
  };
}

function buildObservedSignal(
  actor: FleetActivity,
  lastActivityAt: number,
  nowMs: number,
): SignalRowModel {
  const name = actor.actorName ?? actor.agentName ?? actor.agentId ?? "Observed";
  const text = usefulHeadline(actor.title)
    || usefulHeadline(actor.summary)
    || "Observed activity";
  const route: Route | null = actor.conversationId
    ? { view: "conversation", conversationId: actor.conversationId }
    : actor.recordId
      ? { view: "work", workId: actor.recordId }
      : actor.agentId
        ? { view: "agents-v2", agentId: actor.agentId }
        : null;

  return {
    id: actor.id,
    action: text,
    nowLine: null,
    name,
    harness: null,
    projectKey: "observed",
    projectLabel: "observed",
    projectRoot: null,
    branch: null,
    lastAge: formatAge(lastActivityAt, nowMs),
    sessionAge: null,
    live: false,
    contextPct: null,
    tokensUsed: null,
    tokensMax: null,
    touchedFiles: [],
    recentEvents: [],
    observeData: null,
    agent: null,
    observeRoute: route,
    profileRoute: actor.agentId
      ? { view: "agents-v2", agentId: actor.agentId, tab: "profile" }
      : null,
    terminalRoute: null,
    peekRoute: null,
    terminalEnabled: false,
    peekEnabled: false,
  };
}

function groupByProject(rows: SignalRowModel[]): Array<[string, SignalRowModel[]]> {
  const map = new Map<string, SignalRowModel[]>();
  for (const row of rows) {
    const bucket = map.get(row.projectKey) ?? [];
    bucket.push(row);
    map.set(row.projectKey, bucket);
  }
  return [...map.entries()];
}

export function HomeMovingSignalList({
  cards,
  sort,
  nowMs,
  movingAskByAgent,
  observeCache,
  navigate,
}: {
  cards: HomeMovingSignalCard[];
  sort: HomeMovingSortMode;
  nowMs: number;
  movingAskByAgent: Map<string, FleetAsk>;
  observeCache: ObserveCache;
  navigate: (route: Route) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; top: number; left: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const signals = useMemo(() => {
    return cards.map((card) => {
      if (card.bucket === "working") {
        return buildWorkingSignal(
          card.agent,
          movingAskByAgent.get(card.agent.id),
          observeCache[card.agent.id]?.data ?? null,
          isAgentLaneLive(observeCache[card.agent.id]?.data),
          card.lastActivityAt,
          nowMs,
        );
      }
      if (card.bucket === "native") {
        return buildNativeSignal(card.lane, card.lastActivityAt, nowMs);
      }
      return buildObservedSignal(card.actor, card.lastActivityAt, nowMs);
    });
  }, [cards, movingAskByAgent, nowMs, observeCache]);

  const groups = useMemo(() => groupByProject(signals), [signals]);
  const selectedIndex = signals.findIndex((row) => row.id === selectedId);
  const selected = selectedIndex >= 0 ? signals[selectedIndex]! : null;

  const showHover = useCallback((id: string, rect: DOMRect) => {
    if (selectedId) return; // Suppress hover when docked inspector is active
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      const cardWidth = 360;
      const cardHeightGuess = 220;
      const left = Math.max(16, Math.min(rect.left + 96, window.innerWidth - cardWidth - 16));
      const top = rect.bottom + 8 + cardHeightGuess > window.innerHeight
        ? Math.max(16, rect.top - 8 - cardHeightGuess)
        : rect.bottom + 8;
      setHover({ id, top, left });
    }, 180);
  }, [selectedId]);

  const hideHover = useCallback(() => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHover(null);
  }, []);

  const toggle = useCallback((id: string) => {
    hideHover();
    setSelectedId((cur) => (cur === id ? null : id));
  }, [hideHover]);

  // Keyboard navigation across signals
  const handleStageKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (signals.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIndex = selectedIndex < 0 ? 0 : Math.min(signals.length - 1, selectedIndex + 1);
      setSelectedId(signals[nextIndex]?.id ?? null);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prevIndex = selectedIndex < 0 ? signals.length - 1 : Math.max(0, selectedIndex - 1);
      setSelectedId(signals[prevIndex]?.id ?? null);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setSelectedId(null);
    } else if (event.key === "Enter" && selected) {
      if (selected.observeRoute) {
        event.preventDefault();
        navigate(selected.observeRoute);
      }
    }
  }, [navigate, selected, selectedIndex, signals]);

  useEffect(() => {
    if (selectedId && !signals.some((row) => row.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, signals]);

  return (
    <div
      ref={stageRef}
      className={`s-moving-signal-stage ${selected ? "s-moving-signal-stage--split" : ""}`}
      onKeyDown={handleStageKeyDown}
      tabIndex={0}
      role="region"
      aria-label="What's moving signal stream and inspector"
    >
      {/* ── Main Signals Stream Pane ───────────────────────────────── */}
      <div className="s-moving-stream-pane">
        {sort === "grouped" ? (
          <div className="s-moving-signal-grouped">
            {groups.map(([projectKey, rows]) => (
              <section key={projectKey} className="s-moving-signal-group">
                <header className="s-moving-signal-band">
                  <span className="s-moving-signal-band-title">
                    {rows[0]?.projectLabel ?? projectKey}
                  </span>
                  <span className="label-xs s-moving-signal-band-count">
                    {rows.length} {rows.length === 1 ? "Signal" : "Signals"}
                    {rows[0]?.branch ? ` · ${rows[0].branch}` : ""}
                  </span>
                </header>
                <div className="s-moving-signal-list">
                  {rows.map((row) => (
                    <SignalRow
                      key={row.id}
                      row={row}
                      grouped
                      selected={selectedId === row.id}
                      onSelect={toggle}
                      onHoverStart={showHover}
                      onHoverEnd={hideHover}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="s-moving-signal-list">
            {signals.map((row) => (
              <SignalRow
                key={row.id}
                row={row}
                selected={selectedId === row.id}
                onSelect={toggle}
                onHoverStart={showHover}
                onHoverEnd={hideHover}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Grounded Docked Sidecar Inspector ──────────────────────── */}
      {selected && (
        <aside
          className="s-moving-inspector-pane"
          aria-label={`Live Inspector · ${selected.name}`}
        >
          <DockedSidecarInspector
            row={selected}
            onClose={() => setSelectedId(null)}
            navigate={navigate}
          />
        </aside>
      )}

      {/* ── Floating Hover Card (Suppressed when Inspector is open) ── */}
      {!selected && hover && (
        <SignalHoverCard
          row={signals.find((r) => r.id === hover.id) ?? null}
          top={hover.top}
          left={hover.left}
        />
      )}
    </div>
  );
}

/* ── Signal Row Component ────────────────────────────────────────── */

function SignalRow({
  row,
  grouped,
  selected,
  onSelect,
  onHoverStart,
  onHoverEnd,
}: {
  row: SignalRowModel;
  grouped?: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onHoverStart: (id: string, rect: DOMRect) => void;
  onHoverEnd: () => void;
}) {
  const hasProject = row.projectKey !== "other" && row.projectKey !== "observed";
  const whereLabel = grouped || !hasProject
    ? row.name
    : row.projectKey;

  return (
    <div className="s-moving-signal-item">
      <button
        type="button"
        className={`s-moving-signal-row ${selected ? "is-selected" : ""}`}
        aria-pressed={selected}
        onClick={() => onSelect(row.id)}
        onMouseEnter={(event) => onHoverStart(row.id, event.currentTarget.getBoundingClientRect())}
        onMouseLeave={onHoverEnd}
        onFocus={(event) => onHoverStart(row.id, event.currentTarget.getBoundingClientRect())}
        onBlur={onHoverEnd}
      >
        {/* Elapsed age + live pulse */}
        <span className={`s-moving-signal-age ${row.live ? "is-live" : ""}`}>
          <span
            className={`dot ${row.live ? "dot--working dot--pulse dot--glow" : "dot--neutral"}`}
            aria-hidden="true"
          />
          <span className="label-xs">{row.lastAge}</span>
        </span>

        {/* Harness mark */}
        <span className="s-moving-signal-mark">
          {row.harness ? <HarnessMark harness={row.harness} size={12} /> : <Cpu size={12} />}
        </span>

        {/* Where / Project & Branch */}
        <span className="s-moving-signal-where">
          <span className="s-moving-signal-project">{whereLabel}</span>
          {row.branch && (
            <span className="chip chip--mono chip--sm chip--neutral s-moving-signal-branch-chip">
              <GitBranch size={9} aria-hidden="true" />
              <span>{row.branch}</span>
            </span>
          )}
        </span>

        {/* Action pill */}
        <span className="s-moving-signal-action" title={row.action}>
          {row.action}
        </span>

        {/* Mini token context badge */}
        {row.contextPct !== null && (
          <span className="s-moving-signal-ctx-badge" title={`Context window: ${row.contextPct}%`}>
            <span className="s-moving-signal-ctx-mini-bar">
              <span
                className="s-moving-signal-ctx-mini-fill"
                style={{ width: `${row.contextPct}%` }}
              />
            </span>
            <span className="label-xs">{row.contextPct}%</span>
          </span>
        )}
      </button>
    </div>
  );
}

/* ── Docked Sidecar Inspector ─────────────────────────────────────── */

function DockedSidecarInspector({
  row,
  onClose,
  navigate,
}: {
  row: SignalRowModel;
  onClose: () => void;
  navigate: (route: Route) => void;
}) {
  return (
    <div className="s-moving-inspector">
      {/* ── Inspector Header ────────────────────────────────────── */}
      <header className="s-moving-inspector-head">
        <div className="s-moving-inspector-head-left">
          <span
            className={`dot dot--sm ${row.live ? "dot--working dot--glow dot--pulse" : "dot--neutral"}`}
            aria-hidden="true"
          />
          <span className="label-xs s-moving-inspector-live-status">
            {row.live ? "LIVE ACTIVE" : "IDLE / LOGGED"}
          </span>
          <span className="label-xs s-moving-inspector-age">{row.lastAge} ago</span>
        </div>
        <div className="s-moving-inspector-head-right">
          <button
            type="button"
            className="s-moving-inspector-close-btn"
            title="Close inspector (Esc)"
            aria-label="Close inspector"
            onClick={onClose}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* ── Agent & Identity Bar ────────────────────────────────── */}
      <div className="s-moving-inspector-agent-strip">
        <div className="s-moving-inspector-agent-ident">
          <span className="s-moving-inspector-harness-icon">
            {row.harness ? <HarnessMark harness={row.harness} size={16} /> : <Cpu size={16} />}
          </span>
          <div className="s-moving-inspector-agent-meta">
            <span className="s-moving-inspector-name">{row.name}</span>
            <span className="label-xs s-moving-inspector-harness-tag">
              {row.harness || "native agent"}
            </span>
          </div>
        </div>
        {row.branch && (
          <span className="chip chip--mono chip--sm chip--working">
            <GitBranch size={10} aria-hidden="true" />
            <span>{row.branch}</span>
          </span>
        )}
      </div>

      {/* ── Inspector Scroll Body ───────────────────────────────── */}
      <div className="s-moving-inspector-body">
        {/* Main Objective */}
        <div className="s-moving-inspector-section">
          <span className="label-xs s-moving-inspector-sec-label">Active Task</span>
          <p className="s-moving-inspector-action-text">{row.action}</p>
        </div>

        {/* Live Step / Tool Action */}
        {row.nowLine && (
          <div className="s-moving-inspector-section s-moving-inspector-section--now">
            <span className="label-xs s-moving-inspector-now-badge">Latest Step</span>
            <p className="s-moving-inspector-now-text">{row.nowLine}</p>
          </div>
        )}

        {/* Token Context Gauge */}
        {row.contextPct !== null && (
          <div className="s-moving-inspector-section s-moving-inspector-token-sec">
            <div className="s-moving-inspector-token-header">
              <span className="label-xs s-moving-inspector-sec-label">Context Window</span>
              <span className="label-xs s-moving-inspector-token-pct">{row.contextPct}%</span>
            </div>
            <div className="s-moving-inspector-token-bar">
              <div
                className={`s-moving-inspector-token-fill ${row.contextPct > 80 ? "s-moving-inspector-token-fill--warn" : ""}`}
                style={{ width: `${row.contextPct}%` }}
              />
            </div>
            {row.tokensUsed !== null && row.tokensMax !== null && (
              <span className="label-xs s-moving-inspector-token-counts">
                {Math.round(row.tokensUsed / 1000)}k / {Math.round(row.tokensMax / 1000)}k tokens
              </span>
            )}
          </div>
        )}

        {/* Machine Metadata Grid */}
        <div className="s-moving-inspector-section">
          <span className="label-xs s-moving-inspector-sec-label">Session Metadata</span>
          <dl className="s-moving-inspector-meta-grid">
            {row.projectRoot && (
              <div>
                <dt>Root</dt>
                <dd title={row.projectRoot}>{compactPath(row.projectRoot)}</dd>
              </div>
            )}
            {row.sessionAge && (
              <div>
                <dt>Session</dt>
                <dd>{row.sessionAge} uptime</dd>
              </div>
            )}
            <div>
              <dt>Status</dt>
              <dd>{row.live ? "streaming" : "ready"}</dd>
            </div>
          </dl>
        </div>

        {/* Touched Files */}
        {row.touchedFiles.length > 0 && (
          <div className="s-moving-inspector-section">
            <span className="label-xs s-moving-inspector-sec-label">
              Active Files ({row.touchedFiles.length})
            </span>
            <ul className="s-moving-inspector-files-list">
              {row.touchedFiles.slice(0, 4).map((file, i) => (
                <li key={i} className="s-moving-inspector-file-item">
                  <FileCode2 size={11} aria-hidden="true" />
                  <span className="s-moving-inspector-file-path" title={file.path}>
                    {file.path.split("/").slice(-2).join("/")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── 1-Click Action Footer ───────────────────────────────── */}
      <footer className="s-moving-inspector-footer">
        {row.observeRoute && (
          <button
            type="button"
            className="btn btn--sm btn--accent s-moving-inspector-primary-action"
            onClick={() => navigate(row.observeRoute!)}
          >
            <span>Observe Live</span>
            <ArrowRight size={11} aria-hidden="true" />
          </button>
        )}
        {row.profileRoute && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => navigate(row.profileRoute!)}
          >
            <span>Profile</span>
          </button>
        )}
        {row.terminalEnabled && row.terminalRoute && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => navigate(row.terminalRoute!)}
          >
            <Terminal size={11} aria-hidden="true" />
            <span>Terminal</span>
          </button>
        )}
      </footer>
    </div>
  );
}

/* ── Lightweight Hover Card ──────────────────────────────────────── */

function SignalHoverCard({
  row,
  top,
  left,
}: {
  row: SignalRowModel | null;
  top: number;
  left: number;
}) {
  if (!row) return null;

  return (
    <div
      className="s-moving-signal-hovercard"
      style={{ top, left }}
      role="tooltip"
      aria-hidden="true"
    >
      <div className="s-moving-signal-hover-kicker">
        {row.live && <span className="chip chip--working chip--sm chip--caps">Live</span>}
        <span className="label-xs">{row.lastAge} ago</span>
        {row.harness && <HarnessMark harness={row.harness} size={11} />}
        <span className="s-moving-signal-hover-name">{row.name}</span>
      </div>
      <p className="s-moving-signal-hover-action">{row.action}</p>
      {row.nowLine && (
        <p className="s-moving-signal-hover-now">
          <span className="label-xs s-moving-signal-hover-now-tag">Now</span>
          <span>{row.nowLine}</span>
        </p>
      )}
    </div>
  );
}
