import { useMemo, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";

import { AgentAvatar } from "../../components/AgentAvatar.tsx";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import { isAgentBusy } from "../../lib/agent-state.ts";
import { formatLabel } from "../../lib/text.ts";
import { normalizeTimestampMs } from "../../lib/time.ts";
import type { Agent, FleetAsk, ObserveData, ObservePulse, Route } from "../../lib/types.ts";
import {
  homeCardPeekEnabled,
  homeCardRoute,
  homeCardTerminalEnabled,
  liveActionSummary,
  type HomeCardAction,
} from "./home-live-action.ts";
import type { HomeMovingLayout } from "./home-moving-layout.ts";
import type { WorkingAgentContext } from "./home-moving.ts";
import { homeNowCardHasDetail, homeNowCardLaneModel } from "./home-now-card-model.ts";
import { HomeNowFilesPanel, HomeNowNanoStat } from "./home-now-card-nano.tsx";

function summarize(text: string | null | undefined, max = 140): string {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function middleTruncate(value: string, max = 118): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) * 0.58);
  const tail = Math.floor((max - 1) * 0.42);
  return `${value.slice(0, head).trimEnd()}…${value.slice(value.length - tail).trimStart()}`;
}

function compactPath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("/Users/")) return `~/${path.split("/").slice(3).join("/")}`;
  if (path.startsWith("~/")) return path;
  return path;
}

function compactSessionId(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const withoutExtension = raw.endsWith(".jsonl") ? raw.slice(0, -".jsonl".length) : raw;
  const segment = withoutExtension.split(/[/:]/u).filter(Boolean).pop() ?? withoutExtension;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/iu.test(segment)) {
    return `${segment.slice(0, 8)}…${segment.slice(-6)}`;
  }
  return middleTruncate(segment, 22);
}

function shortModelLabel(value: string | null | undefined): string | null {
  const model = value?.trim();
  if (!model) return null;
  return model
    .replace(/^claude-/iu, "")
    .replace(/^gpt-/iu, "gpt ")
    .replace(/\s*\([^)]*\)\s*/u, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactNode(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  return raw.replace(/\.local$/iu, "").replace(/-local$/iu, "");
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

type WorkingCardTaskStatus = FleetAsk["status"] | "working";
type WorkingCardExecutionState = "working" | "idle" | "queued";

type AgentWorkingCardData = {
  agentId: string;
  agentName: string;
  harness: string | null;
  model: string | null;
  branch: string | null;
  task: {
    title: string;
    openedAt: number | null;
  };
  execution: {
    state: WorkingCardExecutionState;
    lastEventAt: number | null;
  };
  checkpoint: { line: string } | null;
};

function meaningfulCheckpoint(
  ask: FleetAsk | null | undefined,
  taskTitle: string,
): AgentWorkingCardData["checkpoint"] {
  const raw = ask?.summary?.trim();
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, " ");
  if (!compact || compact === taskTitle) return null;
  if (/acknowledged via|queued for local execution|received the message/i.test(compact)) return null;
  return { line: summarize(compact, 120) };
}

function buildAgentWorkingCardData(
  agent: Agent,
  ask: FleetAsk | null | undefined,
  observeLive = false,
): AgentWorkingCardData {
  const openedAt = normalizeTimestampMs(ask?.startedAt)
    ?? normalizeTimestampMs(ask?.acknowledgedAt)
    ?? normalizeTimestampMs(ask?.updatedAt)
    ?? null;
  const lastEventAt = normalizeTimestampMs(agent.updatedAt);
  const taskTitle = ask?.task?.trim()
    || agent.project
    || compactPath(agent.cwd)
    || `Working in ${agent.project ?? "workspace"}`;
  const askStatus: WorkingCardTaskStatus = ask?.status ?? "working";
  const agentWorking = isAgentBusy(agent.state) || observeLive;
  const executionState: WorkingCardExecutionState =
    askStatus === "queued" ? "queued"
      : agentWorking ? "working"
        : "idle";

  return {
    agentId: agent.id,
    agentName: agent.name,
    harness: ask?.harness ?? agent.harness,
    model: agent.model,
    branch: agent.branch ?? "main",
    task: { title: taskTitle, openedAt },
    execution: { state: executionState, lastEventAt },
    checkpoint: meaningfulCheckpoint(ask, taskTitle),
  };
}

function liveTone(card: AgentWorkingCardData): string {
  if (card.execution.state === "queued") return "queued";
  if (card.execution.state === "idle") return "idle";
  return "live";
}

function handleCardKey(event: KeyboardEvent<HTMLElement>, action: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

function stopCardClick(event: MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

function avatarSize(layout: HomeMovingLayout): number {
  switch (layout) {
    case "spotlight": return 40;
    case "duo": return 32;
    case "strip": return 28;
    case "dense": return 24;
  }
}

function harnessMarkSize(layout: HomeMovingLayout): number {
  switch (layout) {
    case "spotlight": return 22;
    case "duo": return 20;
    case "strip": return 18;
    case "dense": return 16;
  }
}

function showActivityDetail(layout: HomeMovingLayout, hasDetail: boolean): boolean {
  if (!hasDetail) return false;
  return layout === "spotlight" || layout === "duo";
}

function sparklineDims(layout: HomeMovingLayout): { w: number; h: number } {
  switch (layout) {
    case "spotlight": return { w: 96, h: 20 };
    case "duo": return { w: 88, h: 20 };
    case "strip": return { w: 72, h: 18 };
    case "dense": return { w: 64, h: 16 };
  }
}

/**
 * Aggregate a fine-grained pulse into `target` contiguous bars (summing each
 * group, newest on the right). Keeping bars few and wide guarantees a visible
 * gap between them, so a flat-out session degrades to a legible equalizer comb
 * instead of one merged block.
 */
function downsamplePulse(counts: number[], target: number): number[] {
  if (counts.length <= target) return counts;
  const out = new Array<number>(target).fill(0);
  for (let index = 0; index < counts.length; index += 1) {
    const bucket = Math.min(target - 1, Math.floor((index / counts.length) * target));
    out[bucket] += counts[index]!;
  }
  return out;
}

/**
 * A tiny inline activity chart: the observe pulse (per-bucket event density)
 * drawn as flat-topped accent bars with a clear gap. Bars share one quiet
 * opacity (only the most recent is accented, to hint "now"), so at flat-max the
 * chart degrades to a legible equalizer comb, never a solid rounded pill —
 * dimming the older bars, by contrast, let a thin gap blur them into a block.
 * Single accent, no axes, no labels. Returns null when there's nothing worth
 * showing so the card never renders a dead chart.
 */
function ActivitySparkline({
  pulse,
  layout,
}: {
  pulse: ObservePulse;
  layout: HomeMovingLayout;
}) {
  const { w, h } = sparklineDims(layout);
  // Few, wide bars: target ~8px per slot so the 2px gap always reads as a gap.
  const bars = downsamplePulse(pulse.counts, Math.max(5, Math.round(w / 8)));
  const peak = bars.length > 0 ? Math.max(...bars) : 0;
  if (peak <= 0 || bars.length < 2) return null;

  const gap = 2;
  const slot = w / bars.length;
  const barW = Math.max(1.5, slot - gap);
  const minBar = 2; // a nonzero bucket always shows a visible tick
  const maxBar = h - 1; // a hair of headroom so peaks never slam the top edge
  const last = bars.length - 1;

  return (
    /* Fixed px inline so no flex negotiation can collapse the chart. */
    <span
      className="s-now-card-pulse"
      style={{ width: w, height: h }}
      title="activity · last 30m"
      aria-hidden="true"
    >
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {bars.map((count, index) => {
          if (count <= 0) return null;
          const barH = Math.min(maxBar, Math.max(minBar, (count / peak) * maxBar));
          const x = index * slot + (slot - barW) / 2;
          return (
            <rect
              key={index}
              x={x.toFixed(2)}
              y={(h - barH).toFixed(2)}
              width={barW.toFixed(2)}
              height={barH.toFixed(2)}
              fill="var(--accent)"
              fillOpacity={index === last ? "0.95" : "0.62"}
            />
          );
        })}
      </svg>
    </span>
  );
}

export function NowCard({
  agent,
  ask,
  context,
  observeData,
  observeLive = false,
  lastActivityAt,
  layout,
  nowMs,
  navigate,
  enter = false,
  enterIndex = 0,
}: {
  agent: Agent;
  ask?: FleetAsk | null;
  context?: WorkingAgentContext | null;
  observeData?: ObserveData | null;
  observeLive?: boolean;
  lastActivityAt?: number | null;
  layout: HomeMovingLayout;
  nowMs: number;
  navigate: (r: Route) => void;
  /** Play the one-time entrance animation (first appearance of this unit). */
  enter?: boolean;
  /** Stagger position; drives `--enter-delay`. Caller caps this. */
  enterIndex?: number;
}) {
  const card = buildAgentWorkingCardData(agent, ask, observeLive);
  const laneModel = useMemo(
    () => homeNowCardLaneModel(agent, observeData, observeLive, nowMs),
    [agent, observeData, observeLive, nowMs],
  );
  const hasDetail = homeNowCardHasDetail(laneModel);
  const showDetail = showActivityDetail(layout, hasDetail);
  const tone = liveTone(card);
  const fullRoot = agent.projectRoot ?? agent.cwd ?? undefined;
  const rootLabel = compactPath(fullRoot) ?? "no workspace";
  const branchLabel = card.branch ?? "no branch";
  const harnessLabel = laneModel.harness ?? card.harness ?? null;
  const modelLabel = laneModel.model ?? shortModelLabel(context?.model ?? card.model);
  const sessionLabel = compactSessionId(context?.sessionId ?? agent.harnessSessionId);
  const contextPct = laneModel.context ?? context?.contextPct ?? null;
  const machineLabel = compactNode(agent.homeNodeName ?? agent.nodeQualifier);
  const sessionStart = normalizeTimestampMs(observeData?.metadata?.session?.sessionStart);
  const uptimeLabel = sessionStart !== null ? formatAge(sessionStart, nowMs) : null;
  const pulse = observeData?.pulse ?? null;
  const showPulse = Boolean(pulse && pulse.counts.some((count) => count > 0));
  const turnAge = card.task.openedAt ? formatAge(card.task.openedAt, nowMs) : "new";
  const lastActivityAtMs = normalizeTimestampMs(lastActivityAt) ?? card.execution.lastEventAt;
  const lastActivityAge = formatAge(lastActivityAtMs, nowMs);
  const actionLine = liveActionSummary({
    observeData,
    checkpoint: card.checkpoint?.line ?? null,
    fallbackTask: card.task.title,
    observeLive,
    // Prefer real work over discovery / turn-complete churn on home cards too.
    skipLifecycleTokens: true,
  });
  const peekEnabled = homeCardPeekEnabled(agent);
  const terminalEnabled = homeCardTerminalEnabled(agent);
  const dense = layout === "dense";
  const strip = layout === "strip";
  const fileGroup = laneModel.pops.edits.rows.length > 0
    ? laneModel.pops.edits
    : laneModel.pops.files;
  const filePanelLabel = laneModel.pops.edits.rows.length > 0 ? "Files modified" : "Files touched";

  const metaParts: { key: string; text: string; title?: string; mono?: boolean }[] = [
    { key: "root", text: rootLabel, title: fullRoot, mono: true },
    { key: "branch", text: branchLabel, title: branchLabel, mono: true },
  ];
  if (agent.role) metaParts.push({ key: "role", text: formatLabel(agent.role) ?? agent.role });

  const tiles: {
    key: string;
    label: string;
    value: string;
    inlineValue?: string;
    title?: string;
    tone?: "work" | "warn" | "dim";
  }[] = [
    {
      key: "last",
      label: "last activity",
      value: lastActivityAge,
      inlineValue: `last ${lastActivityAge}`,
      title: lastActivityAtMs !== null ? `Last activity ${lastActivityAge} ago` : "Last activity unknown",
      tone: lastActivityAtMs !== null ? "work" : "dim",
    },
    { key: "turn", label: "turn", value: turnAge, tone: card.task.openedAt ? "work" : "dim" },
  ];
  if (contextPct !== null) {
    tiles.push({
      key: "context",
      label: "context",
      value: `${contextPct}%`,
      tone: contextPct >= 80 ? "warn" : "work",
    });
  }
  if (uptimeLabel) {
    tiles.push({ key: "uptime", label: "uptime", value: uptimeLabel, tone: "work" });
  }
  /* The session id is the one variable-width fact; in dense rows it breaks
     the fixed metrics column, so it stays on the wider layouts only. */
  if (sessionLabel && !dense) tiles.push({ key: "session", label: "session", value: sessionLabel });
  if (machineLabel && !dense) tiles.push({ key: "machine", label: "machine", value: machineLabel });

  const defaultRoute = homeCardRoute(agent, "observe");

  const onAction = (action: HomeCardAction) => (event: MouseEvent<HTMLButtonElement>) => {
    stopCardClick(event);
    navigate(homeCardRoute(agent, action));
  };

  return (
    <article
      className={`s-now-card s-now-card--${tone} s-now-card--layout-${layout}${enter ? " s-now-card--enter" : ""}`}
      style={enter ? ({ "--enter-delay": `${enterIndex * 45}ms` } as CSSProperties) : undefined}
      onClick={() => navigate(defaultRoute)}
      onKeyDown={(event) => handleCardKey(event, () => navigate(defaultRoute))}
      role="button"
      tabIndex={0}
    >
      <div className="s-now-card-top">
        <AgentAvatar
          agent={agent}
          placement="row"
          size={avatarSize(layout)}
          className="s-now-card-avatar"
        />
        <div className="s-now-card-ident">
          <span className="s-now-card-name" title={card.agentName}>
            {card.agentName}
          </span>
          {!dense && !strip ? (
            <span className={`s-now-card-live s-now-card-live--${tone}`}>
              <span className="s-now-card-live-dot" aria-hidden="true" />
              {tone}
            </span>
          ) : null}
        </div>
        {(harnessLabel || modelLabel) ? (
          <div className="s-now-card-runtime" title={modelLabel ?? harnessLabel ?? undefined}>
            {harnessLabel ? (
              <HarnessMark
                harness={harnessLabel}
                size={harnessMarkSize(layout)}
                className="s-now-card-hmark"
              />
            ) : null}
            {modelLabel ? (
              <span className="s-now-card-model">{modelLabel}</span>
            ) : null}
          </div>
        ) : null}
      </div>

      {!dense ? (
        <div className="s-now-card-idline">
          {metaParts.map((part, index) => (
            <span key={part.key} className="s-now-card-idgroup">
              {index > 0 ? <span className="s-now-card-idsep" aria-hidden="true">·</span> : null}
              <span
                className={`s-now-card-idpart${part.mono ? " s-now-card-idpart--mono" : ""}`}
                title={part.title}
              >
                {part.text}
              </span>
            </span>
          ))}
        </div>
      ) : (
        <div className="s-now-card-idline s-now-card-idline--dense">
          {[harnessLabel, rootLabel, branchLabel].filter(Boolean).join(" · ")}
        </div>
      )}

      {actionLine ? (
        <div className={`s-now-card-action${observeLive ? " s-now-card-action--live" : ""}`}>
          <span className="s-now-card-action-caret" aria-hidden="true">›</span>
          <span className="s-now-card-action-text" title={actionLine}>
            {actionLine}
          </span>
          {observeLive ? <span className="s-now-card-action-cursor" aria-hidden="true" /> : null}
        </div>
      ) : null}

      {dense && showPulse && pulse ? (
        <div className="s-now-card-pulse-cell">
          <ActivitySparkline pulse={pulse} layout={layout} />
        </div>
      ) : null}

      {showDetail ? (
        <div className="s-now-card-detail" onClick={stopCardClick}>
          <div className="s-now-card-nanos">
            {laneModel.stats.tools > 0 ? (
              <>
                <HomeNowNanoStat value={laneModel.stats.tools} label="tools" group={laneModel.pops.tools} />
                {laneModel.stats.edits > 0 ? (
                  <HomeNowNanoStat value={laneModel.stats.edits} label="edits" group={laneModel.pops.edits} />
                ) : null}
                {laneModel.stats.reads > 0 ? (
                  <HomeNowNanoStat value={laneModel.stats.reads} label="reads" group={laneModel.pops.reads} />
                ) : null}
                {laneModel.stats.files > 0 ? (
                  <HomeNowNanoStat value={laneModel.stats.files} label="files" group={laneModel.pops.files} />
                ) : null}
              </>
            ) : (
              <span className="s-now-card-nanos-empty">no tool activity yet</span>
            )}
            {/* Sparkline first: `.s-now-card-ctx` right-anchors with an auto
                margin, so anything after it gets crushed against the edge. */}
            {showPulse && pulse ? (
              <ActivitySparkline pulse={pulse} layout={layout} />
            ) : null}
            {contextPct !== null ? (
              <span
                className="s-now-card-ctx"
                title={`Context window ${contextPct}% used`}
              >
                <span className="s-now-card-ctx-gauge" aria-hidden="true">
                  <span className="s-now-card-ctx-fill" style={{ width: `${contextPct}%` }} />
                </span>
                <span className="s-now-card-ctx-val">{contextPct}%</span>
                <span className="s-now-card-ctx-label">ctx</span>
              </span>
            ) : null}
          </div>
          <HomeNowFilesPanel label={filePanelLabel} group={fileGroup} />
        </div>
      ) : null}

      {!dense && !strip ? (
        <div
          className="s-now-card-metrics"
          style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}
          aria-label={`${card.agentName} signals`}
        >
          {tiles.map((tile) => (
            <MetricTile
              key={tile.key}
              label={tile.label}
              value={tile.value}
              tone={tile.tone}
              title={tile.title}
            />
          ))}
        </div>
      ) : (
        <div className="s-now-card-metrics s-now-card-metrics--inline" aria-label={`${card.agentName} signals`}>
          {strip && showPulse && pulse ? (
            <ActivitySparkline pulse={pulse} layout={layout} />
          ) : null}
          {tiles.map((tile) => (
            <span
              key={tile.key}
              className={`s-now-card-metric-inline s-now-card-metric-inline--${tile.tone ?? "dim"}`}
              title={tile.title}
            >
              {tile.inlineValue ?? tile.value}
            </span>
          ))}
        </div>
      )}

      <div className="s-now-card-actions" onClick={stopCardClick}>
        <CardAction label="Profile" onClick={onAction("profile")} />
        <CardAction label="Observe" onClick={onAction("observe")} primary />
        <CardAction label="Terminal" onClick={onAction("terminal")} disabled={!terminalEnabled} />
        <CardAction label="Peek" onClick={onAction("peek")} disabled={!peekEnabled} />
      </div>
    </article>
  );
}

function CardAction({
  label,
  onClick,
  primary = false,
  disabled = false,
}: {
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`s-now-card-action-btn${primary ? " s-now-card-action-btn--primary" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      {label}
    </button>
  );
}

function MetricTile({
  label,
  value,
  tone = "dim",
  title,
}: {
  label: string;
  value: string;
  tone?: "work" | "warn" | "dim";
  title?: string;
}) {
  return (
    <span className={`s-metric-tile s-metric-tile--${tone}`} title={title}>
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
  );
}
