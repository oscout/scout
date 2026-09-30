import { createHash, randomUUID } from "node:crypto";

export type OtlpSignal = "traces" | "logs" | "metrics";
export type OtlpScalar = string | number | boolean;
export type OtlpObservation = {
  id: string;
  signal: OtlpSignal;
  receivedAt: number;
  resourceKey: string;
  resource: Record<string, OtlpScalar>;
  scope: Record<string, OtlpScalar>;
  attributes: Record<string, OtlpScalar>;
  data: Record<string, OtlpScalar>;
};
export type OtlpSanitizeLimits = {
  maxItems: number;
  maxAttributes: number;
  maxStringLength: number;
};
export type OtlpSanitizeResult = {
  observations: OtlpObservation[];
  total: number;
  rejected: number;
};

type ObjectValue = Record<string, unknown>;

const resourceKeys = new Set([
  "service.name", "service.version", "service.instance.id", "telemetry.sdk.name",
  "telemetry.sdk.language", "telemetry.sdk.version", "process.pid",
  "session.id", "conversation.id", "gen_ai.conversation.id",
]);
const identifierKeys = new Set([
  "session.id", "conversation.id", "gen_ai.conversation.id", "gen_ai.provider.name",
  "gen_ai.system", "gen_ai.request.model", "gen_ai.response.model", "gen_ai.operation.name",
  "gen_ai.tool.name", "gen_ai.tool.call.id", "error.type", "event.name", "model", "tool_name",
]);
const tokenKeys = new Set([
  "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens",
  "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_creation.input_tokens",
  "gen_ai.usage.reasoning.output_tokens", "input_tokens", "output_tokens",
  "cache_read_tokens", "cache_creation_tokens",
]);
const metricKinds = ["gauge", "sum", "histogram", "exponentialHistogram", "summary"] as const;

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function identifier(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && /^[A-Za-z0-9_.:/@+-]+$/.test(value) ? value : undefined;
}

function integer(value: unknown, unsigned = true): string | undefined {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value)
    : typeof value === "string" ? value : "";
  if (!(unsigned ? /^\d{1,20}$/ : /^-?\d{1,20}$/).test(text)) return undefined;
  const n = BigInt(text);
  const low = unsigned ? 0n : -(1n << 63n);
  const high = unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n;
  return n >= low && n <= high ? n.toString() : undefined;
}

function attributes(value: unknown, resource: boolean, limits: OtlpSanitizeLimits): Record<string, OtlpScalar> {
  const out: Record<string, OtlpScalar> = {};
  for (const entry of array(value).slice(0, limits.maxAttributes)) {
    const { key, value: raw } = object(entry);
    if (typeof key !== "string") continue;
    const item = object(raw);
    let clean: OtlpScalar | undefined;
    if (resource ? resourceKeys.has(key) : identifierKeys.has(key)) {
      clean = key === "process.pid" ? integer(item.intValue)
        : identifier(item.stringValue, limits.maxStringLength);
    } else if (!resource && tokenKeys.has(key)) {
      clean = integer(item.intValue);
    } else if (!resource && key === "http.response.status_code") {
      const status = integer(item.intValue);
      if (status !== undefined && Number(status) >= 100 && Number(status) <= 599) clean = Number(status);
    }
    if (clean !== undefined) out[key] = clean;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function putInteger(data: Record<string, OtlpScalar>, key: string, value: unknown, unsigned = true): void {
  const clean = integer(value, unsigned);
  if (clean !== undefined) data[key] = clean;
}

function putNumber(data: Record<string, OtlpScalar>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) data[key] = value;
}

function putIdentifier(data: Record<string, OtlpScalar>, key: string, value: unknown, limits: OtlpSanitizeLimits): void {
  const clean = identifier(value, limits.maxStringLength);
  if (clean !== undefined) data[key] = clean;
}

function putTraceIds(data: Record<string, OtlpScalar>, item: ObjectValue): void {
  for (const [key, size] of [["traceId", 32], ["spanId", 16], ["parentSpanId", 16]] as const) {
    const value = item[key];
    if (typeof value === "string" && value.length === size && /^[a-fA-F0-9]+$/.test(value)) {
      data[key] = value.toLowerCase();
    }
  }
}

export function sanitizeOtlpRequest(
  signal: OtlpSignal,
  request: ObjectValue,
  receivedAt: number,
  limits: OtlpSanitizeLimits,
): OtlpSanitizeResult {
  const observations: OtlpObservation[] = [];
  let total = 0;
  const resourceField = { traces: "resourceSpans", logs: "resourceLogs", metrics: "resourceMetrics" }[signal];
  const scopeField = { traces: "scopeSpans", logs: "scopeLogs", metrics: "scopeMetrics" }[signal];
  for (const resourceValue of array(request[resourceField])) {
    const resourceContainer = object(resourceValue);
    const resource = attributes(object(resourceContainer.resource).attributes, true, limits);
    const resourceKey = createHash("sha256").update(JSON.stringify(resource)).digest("hex");
    for (const scopeValue of array(resourceContainer[scopeField])) {
      const scopeContainer = object(scopeValue);
      const rawScope = object(scopeContainer.scope);
      const scope: Record<string, OtlpScalar> = {};
      putIdentifier(scope, "name", rawScope.name, limits);
      putIdentifier(scope, "version", rawScope.version, limits);
      const append = (item: ObjectValue, data: Record<string, OtlpScalar>) => {
        observations.push({
          id: randomUUID(), signal, receivedAt, resourceKey, resource, scope,
          attributes: attributes(item.attributes, false, limits), data,
        });
      };
      if (signal === "metrics") {
        for (const metricValue of array(scopeContainer.metrics)) {
          const metric = object(metricValue);
          for (const kind of metricKinds) {
            const container = object(metric[kind]);
            for (const pointValue of array(container.dataPoints)) {
              total += 1;
              if (observations.length >= limits.maxItems) continue;
              const point = object(pointValue);
              const data: Record<string, OtlpScalar> = { metricKind: kind };
              putIdentifier(data, "metricName", metric.name, limits);
              putIdentifier(data, "unit", metric.unit, limits);
              putInteger(data, "startTimeUnixNano", point.startTimeUnixNano);
              putInteger(data, "timeUnixNano", point.timeUnixNano);
              putInteger(data, "asInt", point.asInt, false);
              putNumber(data, "asDouble", point.asDouble);
              putInteger(data, "count", point.count);
              putNumber(data, "sum", point.sum);
              putNumber(data, "min", point.min);
              putNumber(data, "max", point.max);
              putNumber(data, "aggregationTemporality", container.aggregationTemporality);
              if (typeof container.isMonotonic === "boolean") data.isMonotonic = container.isMonotonic;
              append(point, data);
            }
          }
        }
      } else {
        for (const itemValue of array(scopeContainer[signal === "traces" ? "spans" : "logRecords"])) {
          total += 1;
          if (observations.length >= limits.maxItems) continue;
          const item = object(itemValue);
          const data: Record<string, OtlpScalar> = {};
          putTraceIds(data, item);
          if (signal === "traces") {
            putInteger(data, "startTimeUnixNano", item.startTimeUnixNano);
            putInteger(data, "endTimeUnixNano", item.endTimeUnixNano);
            putNumber(data, "kind", item.kind);
            putNumber(data, "statusCode", object(item.status).code);
          } else {
            putInteger(data, "timeUnixNano", item.timeUnixNano);
            putInteger(data, "observedTimeUnixNano", item.observedTimeUnixNano);
            putNumber(data, "severityNumber", item.severityNumber);
            putIdentifier(data, "eventName", item.eventName, limits);
          }
          append(item, data);
        }
      }
    }
  }
  return { observations, total, rejected: total - observations.length };
}
