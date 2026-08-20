import { useMemo } from "react";

import { HarnessMark } from "../../components/HarnessMark.tsx";
import { timeAgo } from "../../lib/time.ts";
import type { ObserveEvent } from "../../lib/types.ts";
import { fmtLaneAgeLabel, fmtLaneAgeTitle, observeEventWallMs } from "../../lib/lane-observe.ts";
import { SessionObserve } from "../../screens/sessions/SessionObserve.tsx";
import { LaneTraceEventFocus } from "../../screens/ops/LaneTraceEventFocus.tsx";
import { buildLaneSessionStats } from "../../screens/ops/agent-lane-detail.ts";
import type { AgentLane } from "../../screens/ops/agent-lanes-model.ts";
import { buildScopeLaneHeader } from "./lane-present.ts";

const EVENT_KIND_LABEL: Record<string, string> = {
  think: "Thought",
  tool: "Tool",
  ask: "Request",
  message: "Message",
  note: "Note",
  system: "System",
  boot: "Boot",
};

export function ScopeLaneDetailView({
  lane,
  event,
  nowMs = Date.now(),
}: {
  lane: AgentLane;
  event?: ObserveEvent;
  nowMs?: number;
}) {
  const { agent, observe, source, lastActiveAt } = lane;
  const stats = useMemo(() => buildLaneSessionStats(lane), [lane]);
  const header = buildScopeLaneHeader(lane, nowMs);
  const focusEvent = event ?? observe?.events?.at(-1);
  const eventLabel = focusEvent ? (EVENT_KIND_LABEL[focusEvent.kind] ?? focusEvent.kind) : null;
  const sessionStartMs = observe?.metadata?.session?.sessionStart;
  const eventWallMs = focusEvent ? observeEventWallMs(focusEvent, sessionStartMs) : null;
  const eventWallLabel = eventWallMs != null ? fmtLaneAgeLabel(eventWallMs, lastActiveAt) : undefined;
  const eventWallTitle = eventWallMs != null ? fmtLaneAgeTitle(eventWallMs) : undefined;
  const inlineFocus =
    focusEvent?.kind === "tool" || focusEvent?.kind === "ask"
      ? focusEvent
      : undefined;

  return (
    <div className="scope-lane-detail">
      <header className="scope-lane-detail__head">
        <div className="scope-lane-detail__copy">
          <span className="scope-lane-detail__kicker">Lane trace</span>
          <h2 className="scope-lane-detail__title">
            {header.source}
            <span className="scope-lane-detail__ref"> · {header.sessionRef}</span>
          </h2>
          <div className="scope-lane-detail__sub">
            {header.path}
            {eventLabel ? ` · ${eventLabel}` : ""}
            {lastActiveAt ? ` · ${timeAgo(lastActiveAt)}` : ""}
          </div>
        </div>
        <HarnessMark
          harness={agent.harness ?? stats.harness}
          size={18}
          className="scope-lane-detail__hmark"
        />
      </header>

      <dl className="scope-lane-detail__meta" aria-label="Session stats">
        <div className="scope-lane-detail__stat">
          <dt>events</dt>
          <dd>{stats.events}</dd>
        </div>
        <div className="scope-lane-detail__stat">
          <dt>tools</dt>
          <dd>{stats.tools}</dd>
        </div>
        <div className="scope-lane-detail__stat">
          <dt>files</dt>
          <dd>{stats.files}</dd>
        </div>
        <div className="scope-lane-detail__stat">
          <dt>model</dt>
          <dd>{stats.model ?? "—"}</dd>
        </div>
        <div className="scope-lane-detail__stat">
          <dt>branch</dt>
          <dd>{stats.branch ?? "—"}</dd>
        </div>
        <div className="scope-lane-detail__stat">
          <dt>status</dt>
          <dd>{header.statusLine}</dd>
        </div>
      </dl>

      <div className="scope-lane-detail__trace">
        <SessionObserve
          data={observe ?? undefined}
          agentId={source === "scout" ? agent.id : undefined}
          sessionId={agent.harnessSessionId ?? stats.sessionId}
          showRail={false}
          variant="default"
          surface="scope"
          initialCursorT={focusEvent?.t}
          focusEventId={focusEvent?.id}
          inlineFocusEventId={inlineFocus?.id}
          inlineFocusContent={inlineFocus ? (
            <LaneTraceEventFocus
              event={inlineFocus}
              wallLabel={eventWallLabel}
              wallTitle={eventWallTitle}
              variant="inline"
            />
          ) : undefined}
        />
      </div>
    </div>
  );
}
