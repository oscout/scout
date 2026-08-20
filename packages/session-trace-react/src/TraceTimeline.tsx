"use client";

import React from "react";
import { type SessionSnapshot, type TraceIntent, type TraceViewModelOptions } from "@openscout/session-trace";
import { useTraceTimelineViewModel } from "./hooks.js";
import { TraceTurn } from "./TraceTurn.js";

type TraceTimelineProps = {
  snapshot: SessionSnapshot;
  onIntent?: (intent: TraceIntent) => void;
  className?: string;
  emptyLabel?: string;
  options?: TraceViewModelOptions;
};

export function TraceTimeline({
  snapshot,
  onIntent,
  className,
  emptyLabel = "No trace events yet.",
  options = {},
}: TraceTimelineProps) {
  const timeline = useTraceTimelineViewModel(snapshot, options);
  const rootClassName = ["os-trace-timeline", className].filter(Boolean).join(" ");

  if (timeline.turns.length === 0) {
    return <div className={rootClassName} data-trace-empty>{emptyLabel}</div>;
  }

  return (
    <div className={rootClassName} data-trace-timeline>
      {timeline.turns.map((turn) => (
        <TraceTurn key={turn.id} turn={turn} onIntent={onIntent} />
      ))}
    </div>
  );
}

