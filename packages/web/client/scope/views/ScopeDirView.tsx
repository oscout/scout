import "./scope-views.css";

import { useCallback, useMemo, useState, type KeyboardEvent } from "react";

import type { Agent, ObserveEvent, Route } from "../../lib/types.ts";
import { useScopePresentationAttrs } from "../hooks.ts";
import { buildScopeLaneHeader } from "./lane-present.ts";
import { ScopeLaneTraceSheet, type ScopeLaneTraceTarget } from "./ScopeLaneTraceSheet.tsx";
import { useAgentLanesData } from "./useAgentLanesData.ts";
import type { AgentLane } from "../../screens/ops/agent-lanes-model.ts";

type HarnessGroup = {
  harness: string;
  label: string;
  lanes: AgentLane[];
  liveCount: number;
};

function titleCase(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : "local";
}

function groupLanesByHarness(lanes: AgentLane[]): HarnessGroup[] {
  const groups = new Map<string, AgentLane[]>();
  for (const lane of lanes) {
    const harness = lane.agent.harness?.trim() || lane.source;
    const bucket = groups.get(harness) ?? [];
    bucket.push(lane);
    groups.set(harness, bucket);
  }

  return [...groups.entries()]
    .map(([harness, groupLanes]) => {
      const sorted = [...groupLanes].sort((left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0));
      const liveCount = sorted.filter((lane) => buildScopeLaneHeader(lane).live).length;
      return {
        harness,
        label: titleCase(harness),
        lanes: sorted,
        liveCount,
      };
    })
    .sort((left, right) => right.lanes.length - left.lanes.length);
}

function ScopeDirRow({
  lane,
  nowMs,
  onOpen,
}: {
  lane: AgentLane;
  nowMs: number;
  onOpen: (lane: AgentLane) => void;
}) {
  const header = buildScopeLaneHeader(lane, nowMs);
  const events = lane.observe?.events?.length ?? 0;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(lane);
    }
  };

  return (
    <div
      className={`scope-dir__row${header.live ? " is-live" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(lane)}
      onKeyDown={onKeyDown}
      aria-label={`${header.source} ${header.sessionRef}`}
    >
      <span className={`scope-dir__dot${header.live ? " is-live" : ""}`} aria-hidden />
      <span className="scope-dir__ref">{header.sessionRef}</span>
      <span className="scope-dir__path" title={lane.agent.cwd ?? lane.agent.project ?? undefined}>
        {header.path}
      </span>
      <span className="scope-dir__events">{events}<span className="scope-dir__unit">ev</span></span>
      <span className="scope-dir__status">{header.statusLine}</span>
    </div>
  );
}

export function ScopeDirView({
  navigate: _navigate,
  agents,
}: {
  navigate: (route: Route) => void;
  agents: Agent[];
}) {
  const scopeAttrs = useScopePresentationAttrs();
  const { now, horizonLabel, lanes, tailLoading } = useAgentLanesData({
    scoutAgents: agents,
    defaultWidthTier: "md",
  });

  const groups = useMemo(() => groupLanesByHarness(lanes), [lanes]);
  const [traceSheetTarget, setTraceSheetTarget] = useState<ScopeLaneTraceTarget | null>(null);

  const openLane = useCallback((lane: AgentLane) => {
    const event: ObserveEvent | undefined = lane.observe?.events?.at(-1);
    if (!event) return;
    setTraceSheetTarget({ lane, event });
  }, []);

  const totalInstances = lanes.length;
  const totalLive = groups.reduce((sum, group) => sum + group.liveCount, 0);

  return (
    <div className="scope-dir" data-scope-presentation {...scopeAttrs}>
      <header className="scope-dir__bar">
        <div className="scope-dir__summary">
          <span className="scope-dir__count">
            {totalInstances} instance{totalInstances === 1 ? "" : "s"}
          </span>
          {totalLive > 0 ? (
            <span className="scope-dir__live">{totalLive} live</span>
          ) : null}
          <span className="scope-dir__window">window {horizonLabel}</span>
        </div>
      </header>

      {groups.length === 0 ? (
        <div className="scope-dir__empty">
          {tailLoading ? "Discovering sessions…" : "No sessions discovered for this workspace."}
        </div>
      ) : (
        <div className="scope-dir__body">
          {groups.map((group) => (
            <section key={group.harness} className="scope-dir__group">
              <header className="scope-dir__group-head">
                <span className="scope-dir__group-name">{group.label}</span>
                <span className="scope-dir__group-kind">runtime</span>
                <span className="scope-dir__group-counts">
                  {group.lanes.length} {group.lanes.length === 1 ? "instance" : "instances"}
                  {group.liveCount ? ` · ${group.liveCount} live` : ""}
                </span>
              </header>
              <div className="scope-dir__list" role="list">
                {group.lanes.map((lane) => (
                  <ScopeDirRow key={lane.id} lane={lane} nowMs={now} onOpen={openLane} />
                ))}
              </div>
            </section>
          ))}
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