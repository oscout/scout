import { describe, expect, test } from "bun:test";

import { describeObserveEvidence } from "./observe-fidelity.ts";

describe("describeObserveEvidence", () => {
  test("only calls a timestamped live source live", () => {
    expect(describeObserveEvidence({
      source: "live",
      fidelity: "timestamped",
      live: true,
      eventCount: 8,
    })).toEqual(expect.objectContaining({
      label: "Live observed events",
      tone: "live",
      replayable: true,
      traceEventCount: 8,
      eventCountLabel: "8 events",
      receiptOnly: false,
    }));
  });

  test("labels timestamped history as recorded, not live", () => {
    expect(describeObserveEvidence({
      source: "history",
      fidelity: "timestamped",
      live: false,
      eventCount: 8,
    })).toEqual(expect.objectContaining({
      label: "Recorded event history",
      tone: "recorded",
      replayable: true,
      traceEventCount: 8,
      eventCountLabel: "8 events",
    }));
  });

  test("presents synthetic broker events as uncounted setup receipts", () => {
    expect(describeObserveEvidence({
      source: "broker",
      fidelity: "synthetic",
      live: true,
      eventCount: 2,
    })).toEqual(expect.objectContaining({
      label: "Session setup receipts",
      tone: "reconstructed",
      replayable: false,
      traceEventCount: 0,
      eventCountLabel: "No trace events",
      receiptOnly: true,
    }));
  });

  test("counts synthetic tail and live activity without calling either live", () => {
    for (const source of ["tail", "live"] as const) {
      expect(describeObserveEvidence({
        source,
        fidelity: "synthetic",
        live: true,
        eventCount: 4,
      })).toEqual(expect.objectContaining({
        label: "Reconstructed session evidence",
        tone: "reconstructed",
        replayable: false,
        traceEventCount: 4,
        eventCountLabel: "4 events",
        receiptOnly: false,
      }));
    }
  });

  test("does not call an attached timestamped source live before its first trace event", () => {
    expect(describeObserveEvidence({
      source: "live",
      fidelity: "timestamped",
      live: true,
      eventCount: 0,
    })).toEqual(expect.objectContaining({
      label: "Attached · no trace events",
      tone: "reconstructed",
      replayable: false,
      traceEventCount: 0,
      eventCountLabel: "No trace events",
      receiptOnly: false,
    }));
  });

  test("makes an unavailable trace explicit", () => {
    expect(describeObserveEvidence({
      source: "unavailable",
      fidelity: "synthetic",
      live: false,
      eventCount: 0,
    })).toEqual(expect.objectContaining({
      label: "Trace unavailable",
      tone: "unavailable",
      replayable: false,
      traceEventCount: 0,
      eventCountLabel: "No trace events",
    }));
  });
});
