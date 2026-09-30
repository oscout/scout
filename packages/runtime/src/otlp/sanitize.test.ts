import { describe, expect, test } from "bun:test";
import { sanitizeOtlpRequest, type OtlpSignal } from "./sanitize.js";

const limits = { maxItems: 4096, maxAttributes: 64, maxStringLength: 256 };
const secret = "PRIVATE CONTENT SENTINEL";
const attribute = (key: string, stringValue: string) => ({ key, value: { stringValue } });
const resource = { attributes: [
  attribute("service.name", "claude-code"), attribute("session.id", "session-1"),
  attribute("user.email", secret), attribute("process.command_args", secret),
  attribute("scout.flight_id", "untrusted-flight"),
] };

function syntheticRequest(signal: OtlpSignal, items: unknown[]) {
  if (signal === "traces") return { resourceSpans: [{ resource, scopeSpans: [{ spans: items }] }] };
  if (signal === "logs") return { resourceLogs: [{ resource, scopeLogs: [{ logRecords: items }] }] };
  return { resourceMetrics: [{ resource, scopeMetrics: [{ metrics: items }] }] };
}

const safeAttributes = [
  attribute("session.id", "session-1"),
  { key: "gen_ai.usage.input_tokens", value: { intValue: "9007199254740993" } },
  attribute("gen_ai.prompt", secret), attribute("gen_ai.tool.call.arguments", secret),
  attribute("unknown.key", secret),
];

describe("OTLP inspection sanitization (synthetic payloads)", () => {
  test("retains exact identifiers and integers, never log content or attribution claims", () => {
    const result = sanitizeOtlpRequest("logs", syntheticRequest("logs", [{
      timeUnixNano: "1789872335795123456", observedTimeUnixNano: "1789872335895123456",
      eventName: "claude_code.api_request", body: { stringValue: secret }, attributes: safeAttributes,
      severityText: secret, severityNumber: 9,
      traceId: "ABCDEF0123456789ABCDEF0123456789", spanId: "ABCDEF0123456789",
    }]), 123, limits);
    expect(result.total).toBe(1);
    expect(result.rejected).toBe(0);
    const record = result.observations[0]!;
    expect(record.resource).toEqual({ "service.name": "claude-code", "session.id": "session-1" });
    expect(record.attributes).toEqual({ "session.id": "session-1", "gen_ai.usage.input_tokens": "9007199254740993" });
    expect(record.data.timeUnixNano).toBe("1789872335795123456");
    expect(record.data.traceId).toBe("abcdef0123456789abcdef0123456789");
    expect(record.data.spanId).toBe("abcdef0123456789");
    expect(record.data.eventName).toBe("claude_code.api_request");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("untrusted-flight");
    expect(record.receivedAt).toBe(123);
  });

  test("never retains span names, events, links or exception/status text", () => {
    const result = sanitizeOtlpRequest("traces", syntheticRequest("traces", [{
      name: secret, startTimeUnixNano: "1789872335795123456", endTimeUnixNano: "1789872335895123456",
      status: { code: 2, message: secret }, attributes: safeAttributes,
      events: [{ name: secret, attributes: [attribute("exception.message", secret)] }],
      links: [{ attributes: [attribute("content", secret)] }],
    }]), 123, limits);
    expect(result.observations[0]!.data.statusCode).toBe(2);
    expect(result.observations[0]!.data.endTimeUnixNano).toBe("1789872335895123456");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("counts metric data points, preserves temporality without computing usage", () => {
    const point = { attributes: safeAttributes, asInt: "9007199254740993", timeUnixNano: "100", exemplars: [{ value: secret }] };
    const result = sanitizeOtlpRequest("metrics", syntheticRequest("metrics", [
      { name: "claude_code.token.usage", description: secret, sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [point, point] } },
      { name: "duration", histogram: { aggregationTemporality: 2, dataPoints: [{ count: "7", sum: 25, explicitBounds: [1, 2], bucketCounts: [2, 3, 2] }] } },
      { name: "duration", exponentialHistogram: { aggregationTemporality: 2, dataPoints: [{ count: "8", sum: 40 }] } },
      { name: "duration", summary: { dataPoints: [{ count: "9", sum: 90 }] } },
    ]), 123, { ...limits, maxItems: 3 });
    expect(result.total).toBe(5);
    expect(result.rejected).toBe(2);
    expect(result.observations.map((x) => x.data.metricKind)).toEqual(["sum", "sum", "histogram"]);
    expect(result.observations[0]!.data.asInt).toBe("9007199254740993");
    expect(result.observations[0]!.data.aggregationTemporality).toBe(1);
    expect(result.observations[2]!.data.aggregationTemporality).toBe(2);
    expect(result.observations[2]!.data.count).toBe("7");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.observations.every((x) => !("totalTokens" in x.data))).toBe(true);
  });

  test("unknown emitters receive no raw fallback", () => {
    const request = { resourceLogs: [{ resource: { attributes: [attribute("service.name", "unfamiliar"), attribute("user.email", secret)] }, scopeLogs: [{ scope: { name: secret, version: "1.2.3", attributes: [attribute("secret", secret)] }, logRecords: [{ body: { stringValue: secret }, attributes: [attribute("custom.prompt", secret)] }] }] }] };
    const result = sanitizeOtlpRequest("logs", request, 123, limits);
    expect(result.observations[0]!.scope).toEqual({ version: "1.2.3" });
    expect(result.observations[0]!.attributes).toEqual({});
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("bounds attributes and rejects unsafe integer or metadata values", () => {
    const result = sanitizeOtlpRequest("logs", syntheticRequest("logs", [{ attributes: [
      { key: "input_tokens", value: { intValue: 9007199254740992 } },
      { key: "output_tokens", value: { intValue: "-1" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: "18446744073709551616" } },
      attribute("session.id", "a".repeat(257)),
      { key: "model", value: { arrayValue: { values: [{ stringValue: secret }] } } },
      attribute("tool_name", "read-file"),
      attribute("conversation.id", "not-examined"),
    ] }]), 123, { ...limits, maxAttributes: 6 });
    expect(result.observations[0]!.attributes).toEqual({ tool_name: "read-file" });
  });

  test("canonical resource keys ignore attribute order and disallowed fields", () => {
    const a = sanitizeOtlpRequest("logs", syntheticRequest("logs", [{}]), 1, limits);
    const b = sanitizeOtlpRequest("logs", { resourceLogs: [{ resource: { attributes: [...resource.attributes].reverse() }, scopeLogs: [{ logRecords: [{}] }] }] }, 2, limits);
    expect(a.observations[0]!.resourceKey).toBe(b.observations[0]!.resourceKey);
    expect(a.observations[0]!.id).not.toBe(b.observations[0]!.id);
  });
});
