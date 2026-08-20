/**
 * Home "What's moving" — signal-first list.
 *
 * One-line rows (age · where · harness mark · action). Recent is a flat
 * stream; Grouped wraps the same rows under project bands. Selection opens a
 * fixed centered glass overlay (detail + actions) without reflowing the list.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import type { ObserveCache } from "../../lib/observe.ts";
import { useFocusTrap } from "../../lib/keyboard-nav.ts";
import { normalizeTimestampMs } from "../../lib/time.ts";
import type {
  Agent,
  FleetActivity,
  FleetAsk,
  ObserveData,
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
import type { HomeMovingSortMode, WorkingAgentContext } from "./home-moving.ts";
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

type SignalRowModel = {
  id: string;
  /** Primary left-side line — prefer the ongoing ask/task over turn churn. */
  action: string;
  /** Latest turn/tool update when it differs from the ask (overlay only). */
  nowLine: string | null;
  name: string;
  harness: string | null;
  projectKey: string;
  projectLabel: string;
  branch: string | null;
  lastAge: string;
  sessionAge: string | null;
  live: boolean;
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
  // Left scan line: ongoing ask first. Turn/tool churn is secondary (overlay).
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
  // Every candidate goes through usefulHeadline so discovery/lifecycle never win.
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

  return {
    id: agent.id,
    action: usefulHeadline(action) || summarize(action, 160) || "Working",
    nowLine,
    name: agent.name,
    harness: agent.harness?.trim() || null,
    projectKey,
    projectLabel: projectLabelFromRoot(root),
    branch: agent.branch?.trim() || null,
    lastAge: formatAge(lastActivityAt, nowMs),
    sessionAge: sessionStart !== null ? formatAge(sessionStart, nowMs) : null,
    live: observeLive || Boolean(
      ask
      && (ask.status === "working"
        || ask.agentState === "working"
        || ask.agentState === "in_flight"),
    ),
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

  return {
    id: lane.id,
    action: usefulHeadline(action) || summarize(action, 160) || "Active",
    nowLine: null,
    name: agent.name,
    harness: agent.harness?.trim() || null,
    projectKey,
    projectLabel: projectLabelFromRoot(root),
    branch: agent.branch?.trim() || null,
    lastAge: formatAge(lastActivityAt, nowMs),
    sessionAge: sessionStart !== null ? formatAge(sessionStart, nowMs) : null,
    live: observeLive,
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
    branch: null,
    lastAge: formatAge(lastActivityAt, nowMs),
    sessionAge: null,
    live: false,
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

  const showHover = useCallback((id: string, rect: DOMRect) => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      const cardWidth = 380;
      const cardHeightGuess = 240;
      const left = Math.max(16, Math.min(rect.left + 96, window.innerWidth - cardWidth - 16));
      const top = rect.bottom + 8 + cardHeightGuess > window.innerHeight
        ? Math.max(16, rect.top - 8 - cardHeightGuess)
        : rect.bottom + 8;
      setHover({ id, top, left });
    }, 180);
  }, []);

  const hideHover = useCallback(() => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHover(null);
  }, []);

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
  const selected = signals.find((row) => row.id === selectedId) ?? null;
  const hoverRow = !selectedId && hover
    ? signals.find((row) => row.id === hover.id) ?? null
    : null;

  const toggle = useCallback((id: string) => {
    hideHover();
    setSelectedId((cur) => (cur === id ? null : id));
  }, [hideHover]);

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  // Drop selection if the row leaves the list.
  useEffect(() => {
    if (selectedId && !signals.some((row) => row.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, signals]);

  // Drop the hover card if its row leaves the list.
  useEffect(() => {
    if (hover && !signals.some((row) => row.id === hover.id)) {
      setHover(null);
    }
  }, [hover, signals]);

  // A scroll detaches the fixed-position card from its row — just close it.
  useEffect(() => {
    if (!hover) return;
    const onScroll = () => setHover(null);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [hover]);

  return (
    <div className="s-moving-signal-stage">
      {sort === "grouped" ? (
        <div className="s-moving-signal-grouped">
          {groups.map(([projectKey, rows]) => (
            <section key={projectKey} className="s-moving-signal-group">
              <header className="s-moving-signal-band">
                <span>{rows[0]?.projectLabel ?? projectKey}</span>
                <span>
                  {rows.length} moving
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

      {hoverRow && hover && typeof document !== "undefined"
        ? createPortal(
            <SignalHoverCard row={hoverRow} top={hover.top} left={hover.left} />,
            document.body,
          )
        : null}

      {selected && typeof document !== "undefined"
        ? createPortal(
            <SignalOverlay
              row={selected}
              onClose={() => setSelectedId(null)}
              navigate={navigate}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

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
  // Where-column: flat mode leads with project · branch (agent name moves to
  // the tooltip + overlay); grouped mode sits under a project band already,
  // so the agent name takes the slot instead.
  const hasProject = row.projectKey !== "other" && row.projectKey !== "observed";
  const where = grouped || !hasProject
    ? row.name
    : `${row.projectKey}${row.branch ? ` · ${row.branch}` : ""}`;
  const context = [row.name, row.harness, hasProject ? row.projectKey : null, row.branch]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="s-moving-signal-item">
      <button
        type="button"
        className={`s-moving-signal-row${selected ? " is-selected" : ""}`}
        aria-pressed={selected}
        aria-controls={selected ? "home-moving-signal-overlay" : undefined}
        onClick={() => onSelect(row.id)}
        onMouseEnter={(event) => onHoverStart(row.id, event.currentTarget.getBoundingClientRect())}
        onMouseLeave={onHoverEnd}
        onFocus={(event) => onHoverStart(row.id, event.currentTarget.getBoundingClientRect())}
        onBlur={onHoverEnd}
      >
        <span className={`s-moving-signal-age${row.live ? " is-live" : ""}`}>
          {row.lastAge}
        </span>
        <span className="s-moving-signal-mark">
          {row.harness ? <HarnessMark harness={row.harness} size={11} /> : null}
        </span>
        <span className="s-moving-signal-where" title={context}>
          {where}
        </span>
        <span className="s-moving-signal-action" title={row.action}>
          {row.action}
        </span>
      </button>
    </div>
  );
}

function SignalMeta({ row }: { row: SignalRowModel }) {
  return (
    <dl className="s-moving-signal-overlay-meta">
      <div>
        <dt>Agent</dt>
        <dd>{row.name}</dd>
      </div>
      {row.harness ? (
        <div>
          <dt>Harness</dt>
          <dd>{row.harness}</dd>
        </div>
      ) : null}
      <div>
        <dt>Project</dt>
        <dd>{row.projectLabel}</dd>
      </div>
      {row.branch ? (
        <div>
          <dt>Branch</dt>
          <dd>{row.branch}</dd>
        </div>
      ) : null}
      {row.sessionAge ? (
        <div>
          <dt>Session</dt>
          <dd>new {row.sessionAge}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/** Non-interactive peek card — detail only; click still opens the overlay. */
function SignalHoverCard({
  row,
  top,
  left,
}: {
  row: SignalRowModel;
  top: number;
  left: number;
}) {
  return (
    <div
      className="s-moving-signal-hovercard"
      style={{ top, left }}
      role="presentation"
      aria-hidden="true"
    >
      <div className="s-moving-signal-overlay-kicker">
        {row.live ? <span className="s-moving-signal-overlay-live">Live</span> : null}
        <span>{row.lastAge} ago</span>
        {row.harness ? <HarnessMark harness={row.harness} size={11} /> : null}
        <span>{row.name}</span>
      </div>
      <p className="s-moving-signal-overlay-action">{row.action}</p>
      {row.nowLine ? (
        <p className="s-moving-signal-overlay-now" title={row.nowLine}>
          <span className="s-moving-signal-overlay-now-label">Now</span>
          {row.nowLine}
        </p>
      ) : null}
      <SignalMeta row={row} />
    </div>
  );
}

function SignalOverlay({
  row,
  onClose,
  navigate,
}: {
  row: SignalRowModel;
  onClose: () => void;
  navigate: (route: Route) => void;
}) {
  const focusTrap = useFocusTrap<HTMLElement>();
  const go = (route: Route | null) => (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (!route) return;
    onClose();
    navigate(route);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    focusTrap.onKeyDown(event);
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      className="s-moving-signal-overlay-root"
      role="presentation"
      onClick={onClose}
    >
      <aside
        ref={focusTrap.ref}
        id="home-moving-signal-overlay"
        className="s-moving-signal-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={`Details · ${row.name}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="s-moving-signal-overlay-head">
          <div className="s-moving-signal-overlay-kicker">
            {row.live ? <span className="s-moving-signal-overlay-live">Live</span> : null}
            <span>{row.lastAge} ago</span>
          </div>
          <button
            type="button"
            className="s-moving-signal-overlay-close"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="s-moving-signal-overlay-body">
          <p className="s-moving-signal-overlay-action">{row.action}</p>
          {row.nowLine ? (
            <p className="s-moving-signal-overlay-now" title={row.nowLine}>
              <span className="s-moving-signal-overlay-now-label">Now</span>
              {row.nowLine}
            </p>
          ) : null}
          <SignalMeta row={row} />
        </div>

        <div className="s-moving-signal-overlay-actions">
          <button
            type="button"
            className="s-moving-signal-overlay-primary"
            disabled={!row.observeRoute}
            onClick={go(row.observeRoute)}
          >
            Observe
          </button>
          <button
            type="button"
            className="s-moving-signal-overlay-ghost"
            disabled={!row.profileRoute}
            onClick={go(row.profileRoute)}
          >
            Profile
          </button>
          <button
            type="button"
            className="s-moving-signal-overlay-ghost"
            disabled={!row.terminalEnabled || !row.terminalRoute}
            onClick={go(row.terminalRoute)}
          >
            Terminal
          </button>
          <button
            type="button"
            className="s-moving-signal-overlay-ghost"
            disabled={!row.peekEnabled || !row.peekRoute}
            onClick={go(row.peekRoute)}
          >
            Peek
          </button>
        </div>
      </aside>
    </div>
  );
}
