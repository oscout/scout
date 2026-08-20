import type { KeyboardEvent } from "react";

import { lanePrimaryLabel, type AgentLane } from "../../screens/ops/agent-lanes-model.ts";
import type { ObserveEvent } from "../../lib/types.ts";
import type { AgentLaneWidthTier } from "../../screens/ops/lane-deck.ts";
import { SessionObserve } from "../../screens/sessions/SessionObserve.tsx";
import { buildScopeLaneHeader } from "./lane-present.ts";
import { ScopeLaneDragHandle } from "./ScopeLaneDragHandle.tsx";
import { ScopeLaneWidthControls } from "./ScopeLaneWidthControls.tsx";
import type { ScopeLaneLayoutMode } from "./useScopeLaneLayout.ts";

export function ScopeLaneColumn({
  lane,
  layoutMode,
  compact,
  laneWidth,
  defaultLaneWidth,
  onLaneWidthChange,
  nowMs,
  traceWindowMs,
  traceWindowLabel,
  onOpenTrace,
  onTraceEventSelect,
  onDragStart,
  onDragEnd,
  onDragKeyMove,
  focusProps,
}: {
  lane: AgentLane;
  layoutMode: ScopeLaneLayoutMode;
  compact?: boolean;
  laneWidth?: AgentLaneWidthTier | number;
  defaultLaneWidth: AgentLaneWidthTier;
  onLaneWidthChange?: (width: AgentLaneWidthTier) => void;
  nowMs: number;
  traceWindowMs: number;
  traceWindowLabel: string;
  onOpenTrace: (lane: AgentLane, event?: ObserveEvent) => void;
  onTraceEventSelect: (lane: AgentLane, event: ObserveEvent) => void;
  onDragStart?: (laneId: string) => void;
  onDragEnd?: () => void;
  onDragKeyMove?: (direction: "before" | "after") => void;
  focusProps?: {
    "data-cursor"?: boolean;
    tabIndex: 0 | -1;
    ref: (node: HTMLElement | null) => void;
    onFocus: () => void;
  };
}) {
  const { agent, observe, source } = lane;
  const header = buildScopeLaneHeader(lane, nowMs);
  const hasTrace = Boolean(observe && observe.events.length > 0);
  const laneRef = focusProps?.ref;
  const laneFocusRest = focusProps
    ? {
        "data-cursor": focusProps["data-cursor"],
        tabIndex: focusProps.tabIndex,
        onFocus: focusProps.onFocus,
      }
    : undefined;

  const openTrace = () => {
    const event = observe?.events?.at(-1);
    onOpenTrace(lane, event);
  };

  const onHeadKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTrace();
    }
  };

  return (
    <article
      ref={laneRef}
      data-lane-id={lane.id}
      className={[
        "scope-lane",
        header.live ? "is-live" : "",
        focusProps?.["data-cursor"] ? "is-cursor" : "",
        compact ? "is-stack-compact" : "",
        layoutMode === "grid" ? "is-grid" : "",
      ].filter(Boolean).join(" ")}
      {...laneFocusRest}
    >
      <header
        className={`scope-lane__head${compact ? " is-compact" : ""}`}
        role="button"
        tabIndex={0}
        onClick={(event) => {
          if (event.target instanceof HTMLElement && event.target.closest(".scope-lane__drag")) return;
          openTrace();
        }}
        onKeyDown={onHeadKeyDown}
        aria-label={`${header.source} ${header.sessionRef}`}
      >
        <ScopeLaneDragHandle
          laneId={lane.id}
          onKeyMove={onDragKeyMove}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        />
        <span className="scope-lane__live" aria-hidden="true" />
        <div className="scope-lane__meta">
          <span className="scope-lane__source">
            {header.source}
            <span className="scope-lane__ref"> · {header.sessionRef}</span>
          </span>
          <span className="scope-lane__path" title={agent.cwd ?? agent.project ?? undefined}>
            {header.path}
          </span>
          {!compact ? (
            <span className="scope-lane__status">{header.statusLine}</span>
          ) : null}
          {onLaneWidthChange && (layoutMode === "grid" || !compact) ? (
            <ScopeLaneWidthControls
              value={laneWidth}
              defaultValue={defaultLaneWidth}
              onChange={onLaneWidthChange}
              compact
              label={`${header.sessionRef} width`}
              variant={layoutMode === "grid" ? "grid" : "tier"}
            />
          ) : null}
        </div>
      </header>
      <section
        className="scope-lane__trace"
        aria-label={`${lanePrimaryLabel(agent, source)} trace · ${traceWindowLabel}`}
      >
        {hasTrace ? (
          <SessionObserve
            data={observe ?? undefined}
            agentId={source === "scout" ? agent.id : undefined}
            sessionId={agent.harnessSessionId}
            showRail={false}
            variant="lane"
            surface="scope"
            nowMs={nowMs}
            traceWindowMs={traceWindowMs}
            traceWindowLabel={traceWindowLabel}
            onLaneEventSelect={(event) => onTraceEventSelect(lane, event)}
          />
        ) : (
          <div className="scope-lane__empty">waiting for events</div>
        )}
      </section>
    </article>
  );
}