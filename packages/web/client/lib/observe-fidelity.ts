export type ObserveEvidenceSource = "history" | "live" | "unavailable" | "broker" | "tail";
export type ObserveEvidenceFidelity = "timestamped" | "synthetic";

export type ObserveEvidencePresentation = {
  label: string;
  detail: string;
  tone: "live" | "recorded" | "reconstructed" | "unavailable";
  replayable: boolean;
  /** Number of captured trace events. Broker lifecycle receipts never count. */
  traceEventCount: number;
  eventCountLabel: string;
  /** Render broker setup records as receipts, never as a timeline. */
  receiptOnly: boolean;
};

function traceEventCount(input: {
  source?: ObserveEvidenceSource;
  eventCount: number;
}): number {
  if (input.source === "broker" || input.source === "unavailable") return 0;
  if (!Number.isFinite(input.eventCount)) return 0;
  return Math.max(0, Math.floor(input.eventCount));
}

function traceEventCountLabel(count: number): string {
  if (count === 0) return "No trace events";
  return `${count} event${count === 1 ? "" : "s"}`;
}

export function describeObserveEvidence(input: {
  source?: ObserveEvidenceSource;
  fidelity?: ObserveEvidenceFidelity;
  live?: boolean;
  eventCount: number;
}): ObserveEvidencePresentation {
  const observedEventCount = traceEventCount(input);
  const eventCountLabel = traceEventCountLabel(observedEventCount);

  if (input.source === "unavailable") {
    return {
      label: "Trace unavailable",
      detail: "The session is known to the broker, but no readable event trace was captured.",
      tone: "unavailable",
      replayable: false,
      traceEventCount: 0,
      eventCountLabel,
      receiptOnly: false,
    };
  }

  if (input.source === "broker") {
    return {
      label: "Session setup receipts",
      detail: "The broker recorded session setup, but no observed trace activity is available.",
      tone: "reconstructed",
      replayable: false,
      traceEventCount: 0,
      eventCountLabel,
      receiptOnly: true,
    };
  }

  if (
    input.fidelity === "timestamped"
    && input.source === "live"
    && input.live
    && observedEventCount > 0
  ) {
    return {
      label: "Live observed events",
      detail: "New timestamped events will appear here while the session runs.",
      tone: "live",
      replayable: observedEventCount > 1,
      traceEventCount: observedEventCount,
      eventCountLabel,
      receiptOnly: false,
    };
  }

  if (input.fidelity === "timestamped" && observedEventCount === 0) {
    return {
      label: "Attached · no trace events",
      detail: "This worker is attached but is not emitting trace events.",
      tone: "reconstructed",
      replayable: false,
      traceEventCount: 0,
      eventCountLabel,
      receiptOnly: false,
    };
  }

  if (input.fidelity === "timestamped") {
    return {
      label: "Recorded event history",
      detail: "This timeline is replayed from timestamped session history.",
      tone: "recorded",
      replayable: observedEventCount > 1,
      traceEventCount: observedEventCount,
      eventCountLabel,
      receiptOnly: false,
    };
  }

  return {
    label: "Reconstructed session evidence",
    detail: "Lifecycle and session attachment are available; fine-grained activity may be missing.",
    tone: "reconstructed",
    replayable: false,
    traceEventCount: observedEventCount,
    eventCountLabel,
    receiptOnly: false,
  };
}
