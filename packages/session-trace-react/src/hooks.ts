"use client";

import React from "react";
import { createTraceTimelineViewModel, type SessionSnapshot, type TraceTimelineViewModel, type TraceViewModelOptions } from "@openscout/session-trace";

export function useTraceTimelineViewModel(
  snapshot: SessionSnapshot,
  options: TraceViewModelOptions = {},
): TraceTimelineViewModel {
  const collapseCompletedReasoning = options.collapseCompletedReasoning ?? true;
  const locale = options.locale;

  return React.useMemo(
    () => createTraceTimelineViewModel(snapshot, { collapseCompletedReasoning, locale }),
    [snapshot, collapseCompletedReasoning, locale],
  );
}

