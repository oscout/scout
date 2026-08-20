import "./scope-views.css";

import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";

import type { Agent, ObserveEvent, Route } from "../../lib/types.ts";
import { useScopePresentationAttrs } from "../hooks.ts";
import { AgentFloorView } from "../../screens/ops/AgentFloorView.tsx";
import { ScopeLaneColumn } from "./ScopeLaneColumn.tsx";
import { ScopeLaneSpace } from "./ScopeLaneSpace.tsx";
import { ScopeLanesBar } from "./ScopeLanesBar.tsx";
import { ScopeLaneTraceSheet, type ScopeLaneTraceTarget } from "./ScopeLaneTraceSheet.tsx";
import { useAgentLanesData } from "./useAgentLanesData.ts";
import { useScopeLaneDragDrop } from "./useScopeLaneDragDrop.ts";
import { useScopeLaneSpaces } from "./useScopeLaneSpaces.ts";
import { useScopeLanesKeyboard } from "./useScopeLanesKeyboard.ts";
import { GRID_TRACK_COUNT, maxGridSpanForWidths } from "./scope-grid-layout.ts";
import { useScopeLaneLayout } from "./useScopeLaneLayout.ts";
import type { AgentLane } from "../../screens/ops/agent-lanes-model.ts";

function ScopeLaneIssueRow({ message }: { message: string }) {
  return (
    <li className="scope-lanes__issue">
      <span className="scope-lanes__issue-msg">{message}</span>
    </li>
  );
}

export function ScopeLanesView({
  navigate: _navigate,
  agents,
}: {
  navigate: (route: Route) => void;
  agents: Agent[];
}) {
  const scopeAttrs = useScopePresentationAttrs();
  const { layoutMode, setLayoutMode } = useScopeLaneLayout();
  const floorEnabled = layoutMode === "floor";
  const {
    now,
    horizon,
    setHorizon,
    horizonLabel,
    traceWindowMs,
    lanes,
    layout,
    deck,
    setLaneWidth,
    setDefaultLaneWidth,
    activeFilterLabel,
    issues,
    tailLoading,
  } = useAgentLanesData({
    scoutAgents: agents,
    defaultWidthTier: "md",
    // The floor's recency bands span up to 4h; admission follows the bands.
    horizonOverride: floorEnabled ? "4h" : undefined,
  });
  const {
    resolvedSpaces,
    flatColumns,
    reorderLane,
    stackLane,
    stackMax,
  } = useScopeLaneSpaces(layout.flat);

  const gridEnabled = layoutMode === "grid";
  const [traceSheetTarget, setTraceSheetTarget] = useState<ScopeLaneTraceTarget | null>(null);
  const dropIndicatorRef = useRef<HTMLDivElement | null>(null);

  const {
    scrollRef,
    onDragStart,
    onDragEnd,
    scrollDragProps,
  } = useScopeLaneDragDrop({
    stackMax,
    onReorder: reorderLane,
    onStack: stackLane,
    indicatorRef: dropIndicatorRef,
  });

  const scrollContainerRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
  }, [scrollRef]);

  const openTraceSheet = useCallback((lane: AgentLane, event?: ObserveEvent) => {
    const focusEvent = event ?? lane.observe?.events?.at(-1);
    if (!focusEvent) return;
    setTraceSheetTarget({ lane, event: focusEvent });
  }, []);

  const laneIndexById = useMemo(() => {
    const map = new Map<string, number>();
    flatColumns.forEach((column, index) => map.set(column.lane.id, index));
    return map;
  }, [flatColumns]);

  const { getLaneFocusProps } = useScopeLanesKeyboard({
    lanes: flatColumns.map((column) => column.lane),
    onOpenTrace: openTraceSheet,
    onHorizonChange: setHorizon,
  });

  const emptyMessage = useMemo(() => {
    if (tailLoading) return "Loading sessions…";
    if (activeFilterLabel) return `No lanes match ${activeFilterLabel} in the last ${horizonLabel}.`;
    return `No sessions with recent work in the last ${horizonLabel}.`;
  }, [activeFilterLabel, horizonLabel, tailLoading]);

  return (
    <div
      className={`scope-lanes${layoutMode === "grid" ? " is-grid" : ""}`}
      data-scope-presentation
      data-scope-view="lanes"
      data-scope-layout={layoutMode}
      data-grid-cols={gridEnabled ? GRID_TRACK_COUNT : undefined}
      style={{ "--scope-lane-stack-max": String(stackMax) } as CSSProperties}
      {...scopeAttrs}
    >
      <ScopeLanesBar
        liveCount={floorEnabled ? lanes.length : flatColumns.length}
        horizon={horizon}
        horizonLabel={horizonLabel}
        layoutMode={layoutMode}
        laneWidth={deck.defaultLaneWidth}
        onHorizonChange={setHorizon}
        onLayoutChange={setLayoutMode}
        onLaneWidthChange={setDefaultLaneWidth}
      />

      {issues.length > 0 ? (
        <div className="scope-lanes__issues" role="status" aria-live="polite">
          <ul className="scope-lanes__issues-list">
            {issues.map((issue) => (
              <ScopeLaneIssueRow key={issue.id} message={issue.message} />
            ))}
          </ul>
        </div>
      ) : null}

      {(floorEnabled ? lanes.length : flatColumns.length) === 0 ? (
        <div className="scope-lanes__empty">{emptyMessage}</div>
      ) : floorEnabled ? (
        <AgentFloorView lanes={lanes} now={now} onOpenTrace={openTraceSheet} />
      ) : (
        <div className="scope-lanes__canvas" role="listbox" aria-label="Session lanes">
          <div
            ref={scrollContainerRef}
            className={`scope-lanes__scroll${layoutMode === "grid" ? " is-grid" : ""}`}
            {...scrollDragProps}
          >
            {resolvedSpaces.map((entry, slotIndex) => {
              const compact = entry.space.orient === "column" && entry.columns.length > 1;
              const widthPx = Math.max(...entry.columns.map((column) => column.widthPx));
              const gridSpan = gridEnabled
                ? maxGridSpanForWidths(
                  entry.columns.map((column) => deck.laneWidths[column.lane.id] ?? deck.defaultLaneWidth),
                  deck.defaultLaneWidth,
                )
                : undefined;
              return (
                <ScopeLaneSpace
                  key={entry.space.ids.join(":")}
                  space={entry.space}
                  layoutMode={layoutMode}
                  widthPx={widthPx}
                  gridSpan={gridSpan}
                >
                  {entry.columns.map((column) => {
                    const laneIndex = laneIndexById.get(column.lane.id) ?? 0;
                    return (
                      <ScopeLaneColumn
                        key={column.key}
                        lane={column.lane}
                        layoutMode={layoutMode}
                        compact={compact}
                        laneWidth={deck.laneWidths[column.lane.id] ?? deck.defaultLaneWidth}
                        defaultLaneWidth={deck.defaultLaneWidth}
                        onLaneWidthChange={(width) => setLaneWidth(column.lane.id, width)}
                        nowMs={now}
                        traceWindowMs={traceWindowMs}
                        traceWindowLabel={horizonLabel}
                        onOpenTrace={openTraceSheet}
                        onTraceEventSelect={openTraceSheet}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                        onDragKeyMove={(direction) => {
                          reorderLane(
                            column.lane.id,
                            slotIndex,
                            direction === "before",
                          );
                        }}
                        focusProps={getLaneFocusProps(laneIndex, column.lane.id)}
                      />
                    );
                  })}
                </ScopeLaneSpace>
              );
            })}
            <div
              ref={dropIndicatorRef}
              className="scope-lane-drop"
              aria-hidden="true"
              hidden
            />
          </div>
        </div>
      )}

      {traceSheetTarget ? (
        <ScopeLaneTraceSheet
          target={traceSheetTarget}
          onClose={() => setTraceSheetTarget(null)}
        />
      ) : null}
    </div>
  );
}