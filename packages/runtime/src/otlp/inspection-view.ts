import type { OtlpObservation, OtlpScalar, OtlpSignal } from "./sanitize.js";

export type InspectionHealth = {
  accepted: Record<OtlpSignal, number>;
  rejected: Record<OtlpSignal, number>;
  invalidRequests: number;
  persistenceFailures: number;
  persistenceLost: number;
  queue: { items: number; bytes: number };
  store: { rows: number; bytes: number; retentionEvicted: number };
};
export type InspectionRequest = {
  id: string;
  occurredAt: number;
  model: string;
  input?: string;
  output?: string;
  cacheRead?: string;
  cacheCreation?: string;
  reasoning?: string;
};
export type InspectionTimelineItem = {
  id: string;
  signal: OtlpSignal;
  label: string;
  occurredAt: number;
  model?: string;
  durationMs?: string;
  traceId?: string;
  spanId?: string;
  statusCode?: OtlpScalar;
};
export type InspectionSession = {
  key: string;
  nativeSessionId?: string;
  service: string;
  version?: string;
  firstReceivedAt: number;
  lastReceivedAt: number;
  counts: Record<OtlpSignal, number>;
  observationCount: number;
  models: string[];
  requestEvents: InspectionRequest[];
  timeline: InspectionTimelineItem[];
  timelineCount: number;
};
export type InspectionView = {
  generatedAt: number;
  retentionMs: number;
  loadedCount: number;
  bounded: boolean;
  sessionCount: number;
  uncorrelatedGroupCount: number;
  counts: Record<OtlpSignal, number>;
  sessions: InspectionSession[];
  selected?: InspectionSession;
  health: InspectionHealth;
};

function text(value: OtlpScalar | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function bucket(value: OtlpScalar | undefined): string | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  return typeof value === "string" && /^\d{1,20}$/.test(value) ? BigInt(value).toString() : undefined;
}
function nativeId(record: OtlpObservation): string | undefined {
  const ids = new Set<string>();
  for (const source of [record.resource, record.attributes]) {
    for (const key of ["session.id", "conversation.id", "gen_ai.conversation.id"]) {
      const id = text(source[key]);
      if (id) ids.add(id);
    }
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}
function occurrence(record: OtlpObservation): number {
  const raw = record.data.timeUnixNano ?? record.data.startTimeUnixNano;
  if (typeof raw !== "string" || !/^\d{1,20}$/.test(raw)) return record.receivedAt;
  const ms = BigInt(raw) / 1_000_000n;
  return ms > 0n && ms <= 8_640_000_000_000_000n ? Number(ms) : record.receivedAt;
}
function duration(record: OtlpObservation): string | undefined {
  const start = record.data.startTimeUnixNano;
  const end = record.data.endTimeUnixNano;
  if (typeof start !== "string" || typeof end !== "string" || !/^\d{1,20}$/.test(start) || !/^\d{1,20}$/.test(end)) return undefined;
  const elapsed = BigInt(end) - BigInt(start);
  if (elapsed < 0n) return undefined;
  return `${elapsed / 1_000_000n}.${((elapsed % 1_000_000n) / 1000n).toString().padStart(3, "0")}`;
}

export function buildInspectionView(
  records: readonly OtlpObservation[],
  health: InspectionHealth,
  selectedKey: string | undefined,
  generatedAt: number,
  retentionMs: number,
): InspectionView {
  const groups = new Map<string, InspectionSession>();
  const counts = { traces: 0, logs: 0, metrics: 0 };
  for (const record of records) {
    counts[record.signal] += 1;
    const id = nativeId(record);
    const key = JSON.stringify([record.resourceKey, id ?? null]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key, nativeSessionId: id, service: text(record.resource["service.name"]) ?? "Unknown emitter",
        version: text(record.resource["service.version"]), firstReceivedAt: record.receivedAt,
        lastReceivedAt: record.receivedAt, counts: { traces: 0, logs: 0, metrics: 0 },
        observationCount: 0, models: [], requestEvents: [], timeline: [], timelineCount: 0,
      };
      groups.set(key, group);
    }
    group.observationCount += 1;
    group.counts[record.signal] += 1;
    group.firstReceivedAt = Math.min(group.firstReceivedAt, record.receivedAt);
    group.lastReceivedAt = Math.max(group.lastReceivedAt, record.receivedAt);
    const model = text(record.attributes["gen_ai.response.model"])
      ?? text(record.attributes["gen_ai.request.model"]) ?? text(record.attributes.model);
    if (model && !group.models.includes(model)) group.models.push(model);
    const event = text(record.attributes["event.name"]) ?? text(record.data.eventName);
    if (record.signal === "logs" && ["claude-code", "claude-code-desktop"].includes(group.service)
      && (event === "api_request" || event === "claude_code.api_request")) {
      group.requestEvents.push({
        id: record.id, occurredAt: occurrence(record), model: model ?? "Unknown model",
        input: bucket(record.attributes.input_tokens ?? record.attributes["gen_ai.usage.input_tokens"]),
        output: bucket(record.attributes.output_tokens ?? record.attributes["gen_ai.usage.output_tokens"]),
        cacheRead: bucket(record.attributes.cache_read_tokens ?? record.attributes["gen_ai.usage.cache_read.input_tokens"]),
        cacheCreation: bucket(record.attributes.cache_creation_tokens ?? record.attributes["gen_ai.usage.cache_creation.input_tokens"]),
        reasoning: bucket(record.attributes["gen_ai.usage.reasoning.output_tokens"]),
      });
    }
    if (record.signal !== "metrics") {
      group.timeline.push({
        id: record.id, signal: record.signal, label: event ?? (record.signal === "traces" ? (duration(record) === undefined ? "Span evidence" : "Completed span") : "Log event"),
        occurredAt: occurrence(record), model,
        durationMs: record.signal === "traces" ? duration(record) : undefined,
        traceId: text(record.data.traceId), spanId: text(record.data.spanId), statusCode: record.data.statusCode,
      });
    }
  }
  const sessions = [...groups.values()].sort((a, b) => b.lastReceivedAt - a.lastReceivedAt || a.key.localeCompare(b.key));
  for (const session of sessions) {
    session.requestEvents.sort((a, b) => a.occurredAt - b.occurredAt);
    session.timeline.sort((a, b) => a.occurredAt - b.occurredAt);
    session.timelineCount = session.timeline.length;
    session.timeline = session.timeline.slice(-80);
  }
  const selected = sessions.find((session) => session.key === selectedKey) ?? sessions[0];
  const sessionCount = sessions.filter((session) => session.nativeSessionId !== undefined).length;
  return {
    generatedAt, retentionMs, loadedCount: records.length, bounded: health.store.rows > records.length,
    sessionCount, uncorrelatedGroupCount: sessions.length - sessionCount, counts, sessions, selected, health,
  };
}
