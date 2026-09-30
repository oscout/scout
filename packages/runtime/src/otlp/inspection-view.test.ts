import { describe, expect, test } from "bun:test";
import { buildInspectionView, type InspectionHealth } from "./inspection-view.js";
import type { OtlpObservation } from "./sanitize.js";

const health: InspectionHealth = {
  accepted: { logs: 0, traces: 0, metrics: 0 }, rejected: { logs: 0, traces: 0, metrics: 0 },
  invalidRequests: 0, persistenceFailures: 0, persistenceLost: 0,
  queue: { items: 0, bytes: 0 }, store: { rows: 3, bytes: 1000, retentionEvicted: 0 },
};
function record(patch: Partial<OtlpObservation> = {}): OtlpObservation {
  return {
    id: "event-1", signal: "logs", receivedAt: 2000, resourceKey: "resource-1",
    resource: { "service.name": "claude-code", "service.version": "2.1.258" }, scope: {},
    attributes: { "session.id": "session-1", "event.name": "api_request", model: "sonnet", input_tokens: "9007199254740993", output_tokens: "13" },
    data: { timeUnixNano: "1234000000" }, ...patch,
  };
}

describe("inspection view semantics", () => {
  test("uses only log request events for the token table, never combines channels", () => {
    const view = buildInspectionView([record(), record({ id: "span-1", signal: "traces", data: { startTimeUnixNano: "1000000000", endTimeUnixNano: "1957285208" } }), record({ id: "point-1", signal: "metrics", data: { metricName: "claude_code.token.usage", asDouble: 13 } })], health, undefined, 3000, 21600000);
    expect(view.loadedCount).toBe(3);
    expect(view.counts).toEqual({ logs: 1, traces: 1, metrics: 1 });
    expect(view.health.accepted.logs).toBe(0);
    expect(view.sessionCount).toBe(1);
    expect(view.selected!.requestEvents.length).toBe(1);
    expect(view.selected!.requestEvents[0]!.input).toBe("9007199254740993");
    expect(view.selected!.requestEvents[0]!.cacheCreation).toBeUndefined();
    expect(view.selected!.timeline.find((item) => item.signal === "traces")!.durationMs).toBe("957.285");
    expect(view.selected!.timeline.length).toBe(2);
    expect(view.selected!.requestEvents[0]!.occurredAt).toBe(1234);
    expect(view.selected!.models).toEqual(["sonnet"]);
  });
  test("retains explicit zero buckets and does not infer missing values", () => {
    const row = record({ attributes: { "event.name": "api_request", input_tokens: "0", output_tokens: "-1", cache_read_tokens: "0" } });
    const view = buildInspectionView([row], health, undefined, 3000, 21600000);
    expect(view.selected!.requestEvents[0]).toMatchObject({ input: "0", cacheRead: "0", model: "Unknown model" });
    expect(view.selected!.requestEvents[0]!.output).toBeUndefined();
    expect(view.sessionCount).toBe(0);
    expect(view.uncorrelatedGroupCount).toBe(1);
  });
  test("does not merge conflicting ids or invent requests for an unknown dialect", () => {
    const conflicting = record({ resource: { "session.id": "other", "service.name": "claude-code" } });
    const unknown = record({ id: "other", resourceKey: "resource-2", resource: { "service.name": "unknown" } });
    const view = buildInspectionView([conflicting, unknown], health, undefined, 3000, 21600000);
    expect(view.sessions.length).toBe(2);
    expect(view.uncorrelatedGroupCount).toBe(1);
    expect(view.sessions.find((group) => group.service === "unknown")!.requestEvents).toEqual([]);
  });
  test("marks bounded history, preserves grouping and applies selection without echoing unknown keys", () => {
    const a = record();
    const b = record({ id: "second", receivedAt: 2500, attributes: { "session.id": "second" } });
    const view = buildInspectionView([a, b], health, undefined, 3000, 21600000);
    expect(view.bounded).toBe(true);
    expect(view.selected!.nativeSessionId).toBe("second");
    const next = buildInspectionView([a, b], health, view.sessions[1]!.key, 3000, 21600000);
    expect(next.selected!.nativeSessionId).toBe("session-1");
    expect(buildInspectionView([], health, "invalid", 3000, 21600000).selected).toBeUndefined();
  });
  test("never labels an undated span completed and bounds the timeline", () => {
    const records = Array.from({ length: 90 }, (_, i) => record({ id: String(i), signal: "traces", attributes: { "session.id": "session-1" }, data: {} }));
    const view = buildInspectionView(records, health, undefined, 3000, 21600000);
    expect(view.selected!.timelineCount).toBe(90);
    expect(view.selected!.timeline.length).toBe(80);
    expect(view.selected!.timeline[0]!.label).toBe("Span evidence");
    expect(view.selected!.timeline[0]!.durationMs).toBeUndefined();
  });
});
