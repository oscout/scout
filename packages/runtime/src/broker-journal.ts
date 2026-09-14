import type { BrokerMessageHistory } from "./broker-message-history.js";
import { readableCanonicalMessage, readableJournalKinds } from "./broker-journal-record-contract.js";
import { shareLoadedRecordStrings } from "./broker-record-strings.js";
import { captureMessageRecords } from "./broker-message-records.js";
import type { BrokerMemoryMaintenance } from "./broker-memory-maintenance.js";
import { setImmediate as yieldReadTurn } from "node:timers/promises";
import { readableDelivery, readableDeliveryStatus, readableMetadata, type BrokerRecordRead } from "./broker-record-reader.js";
import { BrokerMessageBodyCache, BrokerMessageBodyCacheUnavailable, type MessageBodyCacheOptions } from "./broker-message-body-cache.js";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import type {
  ControlEvent,
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  CollaborationEvent,
  CollaborationRecord,
  ConversationBinding,
  ConversationDefinition,
  ConversationReadCursor,
  DeliveryAttempt,
  DeliveryIntent,
  DurableAction,
  DurableActionHeartbeatInput,
  DurableAttempt,
  DurableCheckpoint,
  DurableSignal,
  FlightRecord,
  InvocationRequest,
  MessageRecord,
  NodeDefinition,
  ScoutDispatchRecord,
} from "@openscout/protocol";

import {
  createRuntimeRegistrySnapshot,
  type RuntimeRegistrySnapshot,
} from "./registry.js";
import type { BrokerInvocationDispatchJob } from "./broker-dispatch-job.js";

export type BrokerJournalEntry =
  | { kind: "node.upsert"; node: NodeDefinition }
  | { kind: "actor.upsert"; actor: ActorIdentity }
  | { kind: "agent.upsert"; agent: AgentDefinition }
  | { kind: "agent.endpoint.upsert"; endpoint: AgentEndpoint }
  | { kind: "agent.endpoint.delete"; endpointId: string }
  | { kind: "conversation.upsert"; conversation: ConversationDefinition }
  | { kind: "binding.upsert"; binding: ConversationBinding }
  | { kind: "message.record"; message: MessageRecord }
  | { kind: "conversation.read_cursor.upsert"; cursor: ConversationReadCursor }
  | { kind: "invocation.record"; invocation: InvocationRequest }
  | { kind: "invocation.dispatch_job.record"; job: BrokerInvocationDispatchJob }
  | { kind: "flight.record"; flight: FlightRecord }
  | { kind: "collaboration.record"; record: CollaborationRecord }
  | { kind: "collaboration.event.record"; event: CollaborationEvent }
  | { kind: "deliveries.record"; deliveries: DeliveryIntent[] }
  | { kind: "delivery.attempt.record"; attempt: DeliveryAttempt }
  | { kind: "durable.action.record"; action: DurableAction }
  | { kind: "durable.action.heartbeat"; input: DurableActionHeartbeatInput }
  | { kind: "durable.attempt.record"; attempt: DurableAttempt }
  | { kind: "durable.checkpoint.record"; checkpoint: DurableCheckpoint }
  | { kind: "durable.signal.record"; signal: DurableSignal }
  | { kind: "control.event.record"; event: ControlEvent }
  | { kind: "journal.replay_barrier"; barrier: BrokerJournalReplayBarrier }
  | {
      kind: "delivery.status.update";
      deliveryId: string;
      status: DeliveryIntent["status"];
      metadata?: Record<string, unknown>;
      leaseOwner?: string | null;
      leaseExpiresAt?: number | null;
    }
  | { kind: "scout.dispatch.record"; dispatch: ScoutDispatchRecord };


type JournalSnapshotState = {
  snapshot: RuntimeRegistrySnapshot;
  collaborationEvents: CollaborationEvent[];
  deliveries: Map<string, DeliveryIntent>;
  deliveryAttempts: Map<string, DeliveryAttempt[]>;
  durableActions: Map<string, DurableAction>;
  invocationDispatchJobs: Map<string, BrokerInvocationDispatchJob>;
  scoutDispatches: ScoutDispatchRecord[];
};

export type BrokerJournalLoadReport = {
  startedAt: number;
  completedAt: number;
  totalMs: number;
  scanMs: number;
  compactionMs: number;
  sourceBytes: number;
  compactedBytes: number;
  validEntries: number;
  invalidLines: number;
  blankLines: number;
  compactionRequired: boolean;
  estimatedReclaimBytes: number;
  estimatedReclaimRatio: number;
  compactionReason: BrokerJournalCompactionReason | null;
  countsByKind: Partial<Record<BrokerJournalEntry["kind"], number>>;
};

export type BrokerJournalCompactionReason = "bytes" | "ratio" | "high_water";

export type BrokerJournalCompactionPolicy = {
  minimumReclaimBytes: number;
  minimumReclaimRatio: number;
  highWaterBytes: number;
  highWaterMinimumReclaimBytes: number;
};

export type FileBackedBrokerJournalOptions = {
  messageHistory?: BrokerMessageHistory;
  progressiveStartup?: boolean;
  shareLoadedStrings?: boolean;
  compactionPolicy?: Partial<BrokerJournalCompactionPolicy>;
  messageBodyCache?: MessageBodyCacheOptions;
  memoryMaintenance?: BrokerMemoryMaintenance;
};

const DEFAULT_BROKER_JOURNAL_COMPACTION_POLICY: BrokerJournalCompactionPolicy = {
  // Rewriting the journal has a fixed cost proportional to the whole file, not
  // to the superseded entries. A few changing registry heartbeats must not turn
  // every broker boot into a full-file rewrite.
  minimumReclaimBytes: 4 * 1024 * 1024,
  minimumReclaimRatio: 0.05,
  // Once the journal is large, accept a smaller absolute win so redundant
  // registry history cannot grow without bound. The 1 MiB floor still prevents
  // a single tiny duplicate from rewriting hundreds of megabytes.
  highWaterBytes: 256 * 1024 * 1024,
  highWaterMinimumReclaimBytes: 1024 * 1024,
};

type DedupableJournalEntry =
  | BrokerJournalEntry & { kind: "node.upsert" }
  | BrokerJournalEntry & { kind: "actor.upsert" }
  | BrokerJournalEntry & { kind: "agent.upsert" }
  | BrokerJournalEntry & { kind: "agent.endpoint.upsert" }
  | BrokerJournalEntry & { kind: "conversation.upsert" }
  | BrokerJournalEntry & { kind: "binding.upsert" };

type JournalVisitReport = {
  rawLines: number;
  validEntries: number;
  invalidLines: number;
  blankLines: number;
};

export type BrokerJournalReplayBoundary = {
  endByteExclusive: number;
  barrier?: BrokerJournalReplayBarrier;
};

/**
 * An opaque, durable position in the broker journal. Byte offsets are useful
 * only for one open file: journal compaction rewrites them. The marker itself
 * remains in the order-preserving journal stream, so a SQLite projection can
 * safely resume after it even when compaction changed every byte position.
 */
export type BrokerJournalReplayBarrier = {
  id: string;
  projectionId: string;
  projectionVersion: number;
  createdAt: number;
};

export type BrokerJournalReplayReport = {
  afterBarrierFound: boolean;
  visitedEntries: number;
};

export type BrokerJournalReplayOptions = {
  afterBarrier?: Pick<
    BrokerJournalReplayBarrier,
    "id" | "projectionId" | "projectionVersion"
  >;
};

function sameReplayBarrier(
  left: BrokerJournalReplayBarrier,
  right: NonNullable<BrokerJournalReplayOptions["afterBarrier"]>,
): boolean {
  return left.id === right.id
    && left.projectionId === right.projectionId
    && left.projectionVersion === right.projectionVersion;
}

function cloneSnapshot(snapshot: RuntimeRegistrySnapshot): RuntimeRegistrySnapshot {
  return createRuntimeRegistrySnapshot({
    nodes: { ...snapshot.nodes },
    actors: { ...snapshot.actors },
    agents: { ...snapshot.agents },
    endpoints: { ...snapshot.endpoints },
    conversations: { ...snapshot.conversations },
    bindings: { ...snapshot.bindings },
    messages: captureMessageRecords(snapshot.messages),
    readCursors: { ...snapshot.readCursors },
    invocations: { ...snapshot.invocations },
    flights: { ...snapshot.flights },
    collaborationRecords: { ...snapshot.collaborationRecords },
  });
}

function mergeMetadata(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!patch) {
    return current;
  }

  return {
    ...(current ?? {}),
    ...patch,
  };
}

function parseEntry(rawLine: string): BrokerJournalEntry | null {
  const line = rawLine.trim();
  if (!line) {
    return null;
  }

  try {
    return JSON.parse(line) as BrokerJournalEntry;
  } catch {
    return null;
  }
}

function normalizeComparableValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparableValue(entry));
  }

  if (value && typeof value === "object") {
    const normalizedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeComparableValue(entry)] as const);
    return Object.fromEntries(normalizedEntries);
  }

  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeComparableValue(left))
    === JSON.stringify(normalizeComparableValue(right));
}

function dedupeKey(entry: BrokerJournalEntry): string | null {
  switch (entry.kind) {
    case "node.upsert":
      return `${entry.kind}:${entry.node.id}`;
    case "actor.upsert":
      return `${entry.kind}:${entry.actor.id}`;
    case "agent.upsert":
      return `${entry.kind}:${entry.agent.id}`;
    case "agent.endpoint.upsert":
      return `${entry.kind}:${entry.endpoint.id}`;
    case "conversation.upsert":
      return `${entry.kind}:${entry.conversation.id}`;
    case "binding.upsert":
      return `${entry.kind}:${entry.binding.id}`;
    default:
      return null;
  }
}

function isDedupableEntry(entry: BrokerJournalEntry): entry is DedupableJournalEntry {
  return dedupeKey(entry) !== null;
}

function resolveCompactionPolicy(
  input: FileBackedBrokerJournalOptions["compactionPolicy"],
): BrokerJournalCompactionPolicy {
  const resolveNonNegative = (value: number | undefined, fallback: number): number => (
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
  );
  return {
    minimumReclaimBytes: resolveNonNegative(
      input?.minimumReclaimBytes,
      DEFAULT_BROKER_JOURNAL_COMPACTION_POLICY.minimumReclaimBytes,
    ),
    minimumReclaimRatio: resolveNonNegative(
      input?.minimumReclaimRatio,
      DEFAULT_BROKER_JOURNAL_COMPACTION_POLICY.minimumReclaimRatio,
    ),
    highWaterBytes: resolveNonNegative(
      input?.highWaterBytes,
      DEFAULT_BROKER_JOURNAL_COMPACTION_POLICY.highWaterBytes,
    ),
    highWaterMinimumReclaimBytes: resolveNonNegative(
      input?.highWaterMinimumReclaimBytes,
      DEFAULT_BROKER_JOURNAL_COMPACTION_POLICY.highWaterMinimumReclaimBytes,
    ),
  };
}

function journalCompactionReason(
  sourceBytes: number,
  estimatedReclaimBytes: number,
  policy: BrokerJournalCompactionPolicy,
): BrokerJournalCompactionReason | null {
  if (sourceBytes <= 0 || estimatedReclaimBytes <= 0) return null;
  if (estimatedReclaimBytes >= policy.minimumReclaimBytes) return "bytes";
  if (estimatedReclaimBytes / sourceBytes >= policy.minimumReclaimRatio) return "ratio";
  if (
    sourceBytes >= policy.highWaterBytes
    && estimatedReclaimBytes >= policy.highWaterMinimumReclaimBytes
  ) {
    return "high_water";
  }
  return null;
}

export class FileBackedBrokerJournal {
  private readonly filePath: string;

  private readonly messageHistory?: BrokerMessageHistory;
  private readonly messageBodyCache?: BrokerMessageBodyCache;
  private readonly shareLoadedStrings: boolean;
  private readonly memoryMaintenance?: BrokerMemoryMaintenance;

  private readonly state: JournalSnapshotState = {
    snapshot: createRuntimeRegistrySnapshot(),
    collaborationEvents: [],
    deliveries: new Map<string, DeliveryIntent>(),
    deliveryAttempts: new Map<string, DeliveryAttempt[]>(),
    durableActions: new Map<string, DurableAction>(),
    invocationDispatchJobs: new Map<string, BrokerInvocationDispatchJob>(),
    scoutDispatches: [],
  };

  private loaded = false;

  private latestLoadReport: BrokerJournalLoadReport | null = null;

  private writeQueue: Promise<void> = Promise.resolve();

  private readonly compactionPolicy: BrokerJournalCompactionPolicy;
  private readonly progressiveStartup: boolean;
  private finishStartupWork: (() => Promise<void>) | undefined;
  private startupWork: Promise<void> | undefined;
  private startupPhase: "journal" | "maintenance" | "history" | "complete" | "failed" = "journal";
  private startupCompactionMs = 0;
  private startupError: string | null = null;
  private replayedEntries = 0;
  private replayedBytes = 0;
  private startupSourceBytes: number | null = null;

  startupStatus() { return { phase: this.startupPhase, entries: this.replayedEntries,
    messageCount: this.startupPhase === "complete" ? this.messageHistory?.status().count ?? Object.keys(this.state.snapshot.messages).length : null,
    bytes: this.replayedBytes, totalBytes: this.startupSourceBytes, compactionMs: this.startupCompactionMs, error: this.startupError }; }
  finishStartup(): Promise<void> {
    if (!this.loaded) return Promise.reject(new Error("Journal must be loaded before startup hydration."));
    if (this.startupWork) return this.startupWork;
    const work = this.finishStartupWork;
    // Release the compaction dedupe map after the one hydration call. The
    // resolved promise must not keep the historical metadata closure resident.
    this.finishStartupWork = undefined;
    return this.startupWork = (work?.() ?? Promise.resolve()).catch(error => {
      this.startupPhase = "failed";
      this.startupError = String(error);
      throw error;
    });
  }


  constructor(filePath: string, options: FileBackedBrokerJournalOptions = {}) {
    this.filePath = filePath;
    this.progressiveStartup = options.progressiveStartup ?? false;
    this.messageHistory = options.messageHistory;
    if(this.messageHistory)this.state.snapshot.messages=this.messageHistory.records;
    this.shareLoadedStrings = options.shareLoadedStrings ?? false;
    this.memoryMaintenance = options.memoryMaintenance;
    if (options.messageBodyCache) this.messageBodyCache = new BrokerMessageBodyCache(dirname(filePath), {
      ...options.messageBodyCache,
    });
    this.compactionPolicy = resolveCompactionPolicy(options.compactionPolicy);
  }

  async load(): Promise<BrokerJournalLoadReport> {
    if (this.loaded) {
      return this.latestLoadReport!;
    }

    if(this.messageHistory){await mkdir(dirname(this.filePath),{recursive:true});await appendFile(this.filePath, "", "utf8");}
    const startedAt = Date.now();
    const sourceBytes = await stat(this.filePath).then((value) => value.size).catch((error) => {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === "ENOENT") return 0;
      throw error;
    });
    this.startupSourceBytes = sourceBytes;
    const latestIndexByKey = new Map<string, number>();
    const latestEncodedBytesByKey = new Map<string, number>();
    const lastFlightById = new Map<string, FlightRecord>();
    const countsByKind: BrokerJournalLoadReport["countsByKind"] = {};
    let estimatedReclaimBytes = 0;

    const scanStartedAt = Date.now();
    const scan = await this.visitEntries((entry, index, encodedLineBytes) => {
      this.replayedEntries++; this.replayedBytes += encodedLineBytes;
      if (this.shareLoadedStrings) shareLoadedRecordStrings(entry);
      this.apply(this.messageHistory && entry.kind === "message.record" ? entry : this.prepareEntry(entry));
      countsByKind[entry.kind] = (countsByKind[entry.kind] ?? 0) + 1;
      const key = dedupeKey(entry);
      if (key) {
        const previousBytes = latestEncodedBytesByKey.get(key);
        if (previousBytes !== undefined) {
          estimatedReclaimBytes += previousBytes;
        }
        latestIndexByKey.set(key, index);
        latestEncodedBytesByKey.set(key, encodedLineBytes);
      }
      if (entry.kind === "flight.record") {
        const previous = lastFlightById.get(entry.flight.id);
        if (previous && sameValue(previous, entry.flight)) {
          estimatedReclaimBytes += encodedLineBytes;
        }
        lastFlightById.set(entry.flight.id, entry.flight);
      }
    });
    const scanMs = Date.now() - scanStartedAt;
    const estimatedReclaimRatio = sourceBytes > 0
      ? estimatedReclaimBytes / sourceBytes
      : 0;
    const compactionReason = journalCompactionReason(
      sourceBytes,
      estimatedReclaimBytes,
      this.compactionPolicy,
    );
    const compactionRequired = compactionReason !== null;

    let compactionMs = 0;
    if (compactionRequired && !this.progressiveStartup) {
      const compactionStartedAt = Date.now();
      await this.rewriteCompactedEntries(latestIndexByKey);
      compactionMs = Date.now() - compactionStartedAt;
    }

    if (!this.progressiveStartup) await this.messageHistory?.accepted();
    this.loaded = true;
    this.startupPhase = this.progressiveStartup ? "maintenance" : "complete";
    this.finishStartupWork = !this.progressiveStartup ? undefined : async () => {
      if (compactionRequired && this.progressiveStartup) {
        const start = Date.now();
        await this.rewriteCompactedEntries(latestIndexByKey, sourceBytes);
        this.startupCompactionMs = Date.now() - start;
      }
      this.startupPhase = "history";
      // Unlike accepted(), startup must surface failed history coverage.
      await this.messageHistory?.refresh();
      this.startupPhase = "complete";
    };
    const completedAt = Date.now();
    const compactedBytes = await stat(this.filePath).then((value) => value.size).catch(() => 0);
    this.latestLoadReport = {
      startedAt,
      completedAt,
      totalMs: completedAt - startedAt,
      scanMs,
      compactionMs,
      sourceBytes,
      compactedBytes,
      validEntries: scan.validEntries,
      invalidLines: scan.invalidLines,
      blankLines: scan.blankLines,
      compactionRequired,
      estimatedReclaimBytes,
      estimatedReclaimRatio,
      compactionReason,
      countsByKind,
    };
    return this.latestLoadReport;
  }

  /**
   * Complete asynchronous durable lookup, independent of SQLite/body caches.
   * A bounded streaming scan is intentionally a correctness baseline, not a
   * per-message hot-path index. Callers receive explicit source coverage.
   */
  async readCanonicalMessage(messageId: string): Promise<BrokerRecordRead<MessageRecord>> {
    return this.readCanonicalRecord("message", (entry, current) => {
      if (entry.kind !== "message.record") return { value: current, valid: true };
      const message = entry.message;
      const valid = readableCanonicalMessage(message);
      return { value: valid && message.id === messageId ? message : current, valid };
    });
  }

  async readCanonicalDelivery(deliveryId: string): Promise<BrokerRecordRead<DeliveryIntent>> {
    return this.readCanonicalRecord("delivery", (entry, current) => {
      if (entry.kind === "deliveries.record") {
        if (!Array.isArray(entry.deliveries) || !entry.deliveries.every(readableDelivery)) return { value: current, valid: false };
        for (const delivery of entry.deliveries) if (delivery.id === deliveryId) current = delivery;
      } else if (entry.kind === "delivery.status.update") {
        const valid = typeof entry.deliveryId === "string" && readableDeliveryStatus(entry.status)
          && readableMetadata(entry.metadata)
          && (entry.leaseOwner == null || typeof entry.leaseOwner === "string")
          && (entry.leaseExpiresAt == null || (typeof entry.leaseExpiresAt === "number" && Number.isFinite(entry.leaseExpiresAt)));
        if (!valid) return { value: current, valid: false };
        // Legacy status updates for unknown IDs never create a delivery.
        if (current && entry.deliveryId === deliveryId) current = {
          ...current, status: entry.status,
          leaseOwner: entry.leaseOwner ?? undefined, leaseExpiresAt: entry.leaseExpiresAt ?? undefined,
          metadata: mergeMetadata(current.metadata, entry.metadata),
        };
      }
      return { value: current, valid: true };
    });
  }

  private async readCanonicalRecord<T>(
    recordKind: "message" | "delivery",
    reduce: (entry: BrokerJournalEntry, current: T | undefined) => { value: T | undefined; valid: boolean },
  ): Promise<BrokerRecordRead<T>> {
    try {
      await this.load();
      const boundary = await this.captureReplayBoundary();
      const before = await stat(this.filePath);
      if (before.size < boundary.endByteExclusive) {
        return { kind: "unavailable", reason: "journal_truncated", retryable: true };
      }
      let value: T | undefined;
      let unsupported = false;
      let visited = 0;
      const report = await this.visitEntries(async (entry) => {
        if (!entry || typeof entry !== "object" || !Object.hasOwn(readableJournalKinds, entry.kind)) {
          unsupported = true;
        } else {
          const next = reduce(entry, value);
          if (!next.valid) unsupported = true;
          value = next.value;
        }
        if (++visited % 128 === 0) await yieldReadTurn();
      }, { endByteExclusive: boundary.endByteExclusive });
      const after = await stat(this.filePath);
      if (before.dev !== after.dev || before.ino !== after.ino || after.size < boundary.endByteExclusive) {
        return { kind: "unavailable", reason: "journal_changed_during_read", retryable: true };
      }
      if (unsupported || report.invalidLines > 0) {
        return { kind: "unavailable", reason: `journal_${recordKind}_coverage_incomplete`, retryable: false };
      }
      const coverage = { source: "broker_journal" as const, fileIdentity: `${before.dev}:${before.ino}`, endByteExclusive: boundary.endByteExclusive };
      return value ? { kind: "found", value, coverage } : { kind: "not_found", coverage };
    } catch {
      return { kind: "unavailable", reason: "journal_read_failed", retryable: true };
    }
  }

  messageBodyCacheStatus() {
    return this.messageBodyCache?.status() ?? { enabled: false };
  }


  close(): Promise<void> { this.messageBodyCache?.close(); return this.messageHistory?.close() ?? Promise.resolve(); }

  private deliveryValues(activeOnly = false): IterableIterator<DeliveryIntent> {
    const values = this.state.deliveries.values();
    if (!activeOnly) return values;
    return (function* () {
      for (const delivery of values) {
        if (!["acknowledged", "completed", "failed", "cancelled"].includes(delivery.status)) yield delivery;
      }
    })();
  }

  private prepareEntry(entry: BrokerJournalEntry): BrokerJournalEntry {
    return this.messageBodyCache && entry.kind === "message.record"
      ? { ...entry, message: this.messageBodyCache.prepare(entry.message) }
      : entry;
  }

  loadReport(): BrokerJournalLoadReport | null {
    return this.latestLoadReport
      ? {
          ...this.latestLoadReport,
          countsByKind: { ...this.latestLoadReport.countsByKind },
        }
      : null;
  }

  async readEntries(): Promise<BrokerJournalEntry[]> {
    const entries: BrokerJournalEntry[] = [];
    await this.visitEntries((entry) => { entries.push(entry); });
    return entries;
  }

  captureReplayBoundary(options: {
    barrier?: BrokerJournalReplayBarrier;
  } = {}): Promise<BrokerJournalReplayBoundary> {
    let boundary: BrokerJournalReplayBoundary = { endByteExclusive: 0 };
    const capture = this.writeQueue.then(async () => {
      if (options.barrier) {
        await mkdir(dirname(this.filePath), { recursive: true });
        const entry: BrokerJournalEntry = {
          kind: "journal.replay_barrier",
          barrier: options.barrier,
        };
        await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
        // Deliberately a no-op for domain state, but keeping all journal state
        // transitions on this path prevents future entry kinds from silently
        // diverging between capture and ordinary append.
        this.apply(entry);
      }
      boundary = {
        endByteExclusive: await stat(this.filePath)
          .then((value) => value.size)
          .catch((error) => {
            const code = error && typeof error === "object" && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
            if (code === "ENOENT") return 0;
            throw error;
          }),
        ...(options.barrier ? { barrier: options.barrier } : {}),
      };
    });
    this.writeQueue = capture.then(() => undefined, () => undefined);
    return capture.then(() => boundary);
  }

  async replay(
    visitor: (entry: BrokerJournalEntry) => void | Promise<void>,
    boundary?: BrokerJournalReplayBoundary,
    options: BrokerJournalReplayOptions = {},
  ): Promise<BrokerJournalReplayReport> {
    let afterBarrierFound = options.afterBarrier === undefined;
    let visitedEntries = 0;
    await this.visitEntries(
      async (entry) => {
        if (!afterBarrierFound) {
          if (
            entry.kind === "journal.replay_barrier"
            && sameReplayBarrier(entry.barrier, options.afterBarrier!)
          ) {
            afterBarrierFound = true;
          }
          return;
        }
        // Replay barriers carry no domain state. They exist solely to locate a
        // crash-safe resume point and must never leak into projection reducers.
        if (entry.kind === "journal.replay_barrier") {
          return;
        }
        await visitor(entry);
        visitedEntries += 1;
      },
      boundary ? { endByteExclusive: boundary.endByteExclusive } : {},
    );
    return { afterBarrierFound, visitedEntries };
  }

  snapshot(): RuntimeRegistrySnapshot {
    return cloneSnapshot(this.state.snapshot);
  }

  async appendEntries(entriesInput: BrokerJournalEntry | BrokerJournalEntry[]): Promise<BrokerJournalEntry[]> {
    const entries = Array.isArray(entriesInput) ? entriesInput : [entriesInput];
    if (entries.length === 0) {
      return [];
    }

    const retained = this.selectEntriesToAppend(entries);
    let prepared = retained;
    let acceptedEncodedBytes = 0;
    let preparationError: BrokerMessageBodyCacheUnavailable | undefined;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      if (retained.length === 0) {
        return;
      }
      // Spill must succeed before accepting the canonical append. Tentative
      // cache bytes are disposable; a failed append never publishes records.
      try {
        prepared = retained.map((entry) => this.prepareEntry(entry));
      } catch (error) {
        if (!(error instanceof BrokerMessageBodyCacheUnavailable)) throw error;
        // Reject this new payload without poisoning the canonical write queue:
        // acknowledgements/leases/completions do not need fresh body spill space.
        preparationError = error;
        return;
      }
      const payload = retained.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      if (this.memoryMaintenance) acceptedEncodedBytes = Buffer.byteLength(payload, "utf8");
      await appendFile(this.filePath, payload, "utf8");
      for (const entry of prepared) {
        this.apply(entry);
      }
      // Registration/control records do not change message membership. During
      // progressive startup they must not trigger the initial history scan.
      if (!this.progressiveStartup || prepared.some(entry => entry.kind === "message.record")) {
        await this.messageHistory?.accepted();
      }
    });

    await this.writeQueue;
    if (preparationError) throw preparationError;
    this.memoryMaintenance?.accepted(prepared, acceptedEncodedBytes);
    return prepared;
  }

  listCollaborationRecords(options: {
    limit?: number;
    kind?: CollaborationRecord["kind"];
    state?: string;
    ownerId?: string;
    nextMoveOwnerId?: string;
  } = {}): CollaborationRecord[] {
    const limit = options.limit ?? 200;
    return Object.values(this.state.snapshot.collaborationRecords)
      .filter((record) => !options.kind || record.kind === options.kind)
      .filter((record) => !options.state || record.state === options.state)
      .filter((record) => !options.ownerId || record.ownerId === options.ownerId)
      .filter((record) => !options.nextMoveOwnerId || record.nextMoveOwnerId === options.nextMoveOwnerId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit);
  }

  listCollaborationEvents(options: { limit?: number; recordId?: string } = {}): CollaborationEvent[] {
    const limit = options.limit ?? 200;
    return [...this.state.collaborationEvents]
      .filter((event) => !options.recordId || event.recordId === options.recordId)
      .sort((left, right) => right.at - left.at)
      .slice(0, limit);
  }

  getDelivery(deliveryId: string): DeliveryIntent | undefined {
    return this.state.deliveries.get(deliveryId);
  }

  /** Complete insertion-order search without allocating a historical list. */
  findDelivery(predicate: (delivery: DeliveryIntent) => boolean, options: { activeOnly?: boolean } = {}): DeliveryIntent | undefined {
    for (const delivery of this.deliveryValues(options.activeOnly)) {
      if (predicate(delivery)) return delivery;
    }
    return undefined;
  }

  /**
   * Visit every delivery present at entry without allocating a history array.
   * Entries are never deleted/reinserted in this map; replacements retain their
   * insertion position. Later appends are outside this traversal's boundary.
   */
  async visitDeliveries(visitor: (delivery: DeliveryIntent) => void | Promise<void>, options: { activeOnly?: boolean } = {}): Promise<void> {
    const boundary = this.state.deliveries.size;
    const iterator = this.state.deliveries.values();
    for (let visited = 0; visited < boundary; visited++) {
      const next = iterator.next();
      if (next.done) return;
      // Count original map positions, including filtered terminal records.
      // Otherwise a sparse active scan can drift into later appended entries.
      if (!options.activeOnly || !["acknowledged", "completed", "failed", "cancelled"].includes(next.value.status)) {
        await visitor(next.value);
      }
      if ((visited + 1) % 128 === 0) await yieldReadTurn();
    }
  }

  listDeliveries(options: {
    transport?: DeliveryIntent["transport"];
    status?: DeliveryIntent["status"];
    limit?: number;
  } = {}): DeliveryIntent[] {
    const limit = options.limit ?? 200;
    // Preserve Array.slice's public limit semantics, including negative limits.
    // Ordinary bounded reads must not allocate arrays for the entire history.
    const end = Number.isNaN(limit) ? 0 : Math.trunc(limit);
    if (end === 0 || end === -Infinity) return [];
    const deliveries: DeliveryIntent[] = [];
    for (const delivery of this.deliveryValues()) {
      if (options.transport && delivery.transport !== options.transport) continue;
      if (options.status && delivery.status !== options.status) continue;
      deliveries.push(delivery);
      if (end > 0 && deliveries.length >= end) break;
    }
    return end < 0 ? deliveries.slice(0, end) : deliveries;
  }

  listDeliveryAttempts(deliveryId: string): DeliveryAttempt[] {
    return [...(this.state.deliveryAttempts.get(deliveryId) ?? [])]
      .sort((left, right) => (
        left.attempt === right.attempt
          ? left.createdAt - right.createdAt
          : left.attempt - right.attempt
      ));
  }

  getDurableAction(actionId: string): DurableAction | null {
    return this.state.durableActions.get(actionId) ?? null;
  }

  getDurableActionByIdempotencyKey(input: {
    authorityCellId: string;
    kind: DurableAction["kind"];
    idempotencyKey: string;
  }): DurableAction | null {
    for (const action of this.state.durableActions.values()) {
      if (
        action.authorityCellId === input.authorityCellId
        && action.kind === input.kind
        && action.idempotencyKey === input.idempotencyKey
      ) {
        return action;
      }
    }
    return null;
  }

  getInvocationDispatchJob(jobId: string): BrokerInvocationDispatchJob | null {
    return this.state.invocationDispatchJobs.get(jobId) ?? null;
  }

  getInvocationDispatchJobForInvocation(invocationId: string): BrokerInvocationDispatchJob | null {
    for (const job of this.state.invocationDispatchJobs.values()) {
      if (job.invocationId === invocationId) {
        return job;
      }
    }
    return null;
  }

  listInvocationDispatchJobs(options: {
    limit?: number;
    state?: BrokerInvocationDispatchJob["state"];
  } = {}): BrokerInvocationDispatchJob[] {
    const limit = options.limit ?? 1000;
    return [...this.state.invocationDispatchJobs.values()]
      .filter((job) => !options.state || job.state === options.state)
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, limit);
  }

  private async visitEntries(
    visitor: (
      entry: BrokerJournalEntry,
      index: number,
      encodedLineBytes: number,
    ) => void | Promise<void>,
    options: { endByteExclusive?: number } = {},
  ): Promise<JournalVisitReport> {
    const endByteExclusive = options.endByteExclusive;
    if (endByteExclusive !== undefined && endByteExclusive <= 0) {
      return {
        rawLines: 0,
        validEntries: 0,
        invalidLines: 0,
        blankLines: 0,
      };
    }
    const maintenance = this.memoryMaintenance?.beginReplay();
    const input = createReadStream(this.filePath, {
      encoding: "utf8",
      ...(endByteExclusive === undefined ? {} : { end: endByteExclusive - 1 }),
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let index = 0;
    const report: JournalVisitReport = {
      rawLines: 0,
      validEntries: 0,
      invalidLines: 0,
      blankLines: 0,
    };
    try {
      for await (const rawLine of lines) {
        report.rawLines += 1;
        // Broker journal appends always use one-byte LF terminators. Reuse the
        // bytes already read instead of serializing every parsed entry again on
        // the startup scan's hot path.
        const encodedLineBytes = Buffer.byteLength(rawLine, "utf8") + 1;
        if (!rawLine.trim()) {
          report.blankLines += 1;
          maintenance?.add(encodedLineBytes);
          continue;
        }
        const entry = parseEntry(rawLine);
        if (!entry) {
          report.invalidLines += 1;
          maintenance?.add(encodedLineBytes);
          continue;
        }
        await visitor(entry, index, encodedLineBytes);
        index += 1;
        report.validEntries += 1;
        maintenance?.add(encodedLineBytes);
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    } finally {
      lines.close();
      input.destroy();
      maintenance?.finish();
    }
    return report;
  }

  private async rewriteCompactedEntries(latestIndexByKey: Map<string, number>, prefixBytes?: number): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const output = createWriteStream(temporaryPath, { encoding: "utf8", flags: "wx" });
    const lastFlightById = new Map<string, FlightRecord>();

    try {
      await this.visitEntries(async (entry, index) => {
        if (entry.kind === "flight.record") {
          const previous = lastFlightById.get(entry.flight.id);
          lastFlightById.set(entry.flight.id, entry.flight);
          if (previous && sameValue(previous, entry.flight)) {
            return;
          }
        } else {
          const key = dedupeKey(entry);
          if (key && latestIndexByKey.get(key) !== index) {
            return;
          }
        }

        if (!output.write(`${JSON.stringify(entry)}\n`, "utf8")) {
          await once(output, "drain");
        }
      }, prefixBytes === undefined ? {} : { endByteExclusive: prefixBytes });
      const publish = async () => {
        if (prefixBytes !== undefined) {
          // The prefix rewrite runs cooperatively while control registrations
          // append. Capture/copy its accepted suffix under the canonical writer
          // before atomic rename; no accepted late record can be dropped.
          const end = (await stat(this.filePath)).size;
          if (end > prefixBytes) {
            const suffix = createReadStream(this.filePath, { start: prefixBytes, end: end - 1 });
            for await (const bytes of suffix) if (!output.write(bytes)) await once(output, "drain");
          }
        }
        output.end();
        await once(output, "finish");
        await rename(temporaryPath, this.filePath);
      };
      if (prefixBytes === undefined) await publish();
      else {
        const committed = this.writeQueue.then(publish);
        this.writeQueue = committed.catch(() => {});
        await committed;
      }
    } catch (error) {
      output.destroy();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private selectEntriesToAppend(entries: BrokerJournalEntry[]): BrokerJournalEntry[] {
    // Duplicate selection only mutates entity/flight maps. Copy each touched
    // map once; message-only batches must not clone all historical messages.
    const nextSnapshot = { ...this.state.snapshot };
    const copied = new Set<keyof RuntimeRegistrySnapshot>();
    const copy = <K extends keyof RuntimeRegistrySnapshot>(key: K): void => {
      if (copied.has(key)) return;
      nextSnapshot[key] = { ...nextSnapshot[key] };
      copied.add(key);
    };
    const retained: BrokerJournalEntry[] = [];

    for (const entry of entries) {
      if (!this.shouldAppendEntry(entry, nextSnapshot)) {
        continue;
      }
      retained.push(entry);
      switch (entry.kind) {
        case "node.upsert": copy("nodes"); break;
        case "actor.upsert": copy("actors"); break;
        case "agent.upsert": copy("agents"); copy("actors"); break;
        case "agent.endpoint.upsert":
        case "agent.endpoint.delete": copy("endpoints"); break;
        case "conversation.upsert": copy("conversations"); break;
        case "binding.upsert": copy("bindings"); break;
        case "flight.record": copy("flights"); break;
      }
      this.applyToSnapshot(nextSnapshot, entry);
    }

    return retained;
  }

  private shouldAppendEntry(
    entry: BrokerJournalEntry,
    snapshot: RuntimeRegistrySnapshot,
  ): boolean {
    if (entry.kind === "flight.record") {
      return !sameValue(snapshot.flights[entry.flight.id], entry.flight);
    }

    if (!isDedupableEntry(entry)) {
      return true;
    }

    switch (entry.kind) {
      case "node.upsert":
        return !sameValue(snapshot.nodes[entry.node.id], entry.node);
      case "actor.upsert":
        return !sameValue(snapshot.actors[entry.actor.id], entry.actor);
      case "agent.upsert":
        return !sameValue(snapshot.agents[entry.agent.id], entry.agent);
      case "agent.endpoint.upsert":
        return !sameValue(snapshot.endpoints[entry.endpoint.id], entry.endpoint);
      case "conversation.upsert":
        return !sameValue(snapshot.conversations[entry.conversation.id], entry.conversation);
      case "binding.upsert":
        return !sameValue(snapshot.bindings[entry.binding.id], entry.binding);
      default:
        return true;
    }
  }

  private applyToSnapshot(snapshot: RuntimeRegistrySnapshot, entry: BrokerJournalEntry): void {
    switch (entry.kind) {
      case "node.upsert":
        snapshot.nodes[entry.node.id] = entry.node;
        return;
      case "actor.upsert":
        snapshot.actors[entry.actor.id] = entry.actor;
        return;
      case "agent.upsert":
        snapshot.agents[entry.agent.id] = entry.agent;
        if (!snapshot.actors[entry.agent.id]) {
          snapshot.actors[entry.agent.id] = {
            id: entry.agent.id,
            kind: entry.agent.kind,
            displayName: entry.agent.displayName,
            handle: entry.agent.handle,
            labels: entry.agent.labels,
            metadata: entry.agent.metadata,
          };
        }
        return;
      case "agent.endpoint.upsert":
        snapshot.endpoints[entry.endpoint.id] = entry.endpoint;
        return;
      case "agent.endpoint.delete":
        delete snapshot.endpoints[entry.endpointId];
        return;
      case "conversation.upsert":
        snapshot.conversations[entry.conversation.id] = entry.conversation;
        return;
      case "binding.upsert":
        snapshot.bindings[entry.binding.id] = entry.binding;
        return;
      case "flight.record":
        snapshot.flights[entry.flight.id] = entry.flight;
        return;
      default:
        return;
    }
  }

  private apply(entry: BrokerJournalEntry): void {
    switch (entry.kind) {
      case "node.upsert":
        this.state.snapshot.nodes[entry.node.id] = entry.node;
        return;
      case "actor.upsert":
        this.state.snapshot.actors[entry.actor.id] = entry.actor;
        return;
      case "agent.upsert":
        this.state.snapshot.agents[entry.agent.id] = entry.agent;
        if (!this.state.snapshot.actors[entry.agent.id]) {
          this.state.snapshot.actors[entry.agent.id] = {
            id: entry.agent.id,
            kind: entry.agent.kind,
            displayName: entry.agent.displayName,
            handle: entry.agent.handle,
            labels: entry.agent.labels,
            metadata: entry.agent.metadata,
          };
        }
        return;
      case "agent.endpoint.upsert":
        this.state.snapshot.endpoints[entry.endpoint.id] = entry.endpoint;
        return;
      case "agent.endpoint.delete":
        delete this.state.snapshot.endpoints[entry.endpointId];
        return;
      case "conversation.upsert":
        this.state.snapshot.conversations[entry.conversation.id] = entry.conversation;
        return;
      case "binding.upsert":
        this.state.snapshot.bindings[entry.binding.id] = entry.binding;
        return;
      case "message.record":
        if(!this.messageHistory)this.state.snapshot.messages[entry.message.id] = entry.message;
        return;
      case "conversation.read_cursor.upsert":
        this.state.snapshot.readCursors[`${entry.cursor.conversationId}\u0000${entry.cursor.actorId}`] = entry.cursor;
        return;
      case "invocation.record":
        this.state.snapshot.invocations[entry.invocation.id] = entry.invocation;
        return;
      case "invocation.dispatch_job.record":
        this.state.invocationDispatchJobs.set(entry.job.id, entry.job);
        return;
      case "flight.record":
        this.state.snapshot.flights[entry.flight.id] = entry.flight;
        return;
      case "collaboration.record":
        this.state.snapshot.collaborationRecords[entry.record.id] = entry.record;
        return;
      case "collaboration.event.record":
        this.state.collaborationEvents.push(entry.event);
        return;
      case "deliveries.record":
        for (const delivery of entry.deliveries) {
          this.state.deliveries.set(delivery.id, delivery);
        }
        return;
      case "delivery.attempt.record": {
        const attempts = this.state.deliveryAttempts.get(entry.attempt.deliveryId) ?? [];
        attempts.push(entry.attempt);
        this.state.deliveryAttempts.set(entry.attempt.deliveryId, attempts);
        return;
      }
      case "delivery.status.update": {
        const current = this.state.deliveries.get(entry.deliveryId);
        if (!current) {
          return;
        }

        const next = {
          ...current,
          status: entry.status,
          leaseOwner: entry.leaseOwner ?? undefined,
          leaseExpiresAt: entry.leaseExpiresAt ?? undefined,
          metadata: mergeMetadata(current.metadata, entry.metadata),
        };
        this.state.deliveries.set(entry.deliveryId, next);
        return;
      }
      case "durable.action.record":
        this.state.durableActions.set(entry.action.id, entry.action);
        return;
      case "durable.action.heartbeat": {
        const current = this.state.durableActions.get(entry.input.actionId);
        if (
          current
          && current.leaseOwner === entry.input.owner
          && current.leaseGeneration === entry.input.generation
          && current.state !== "completed"
          && current.state !== "failed"
          && current.state !== "cancelled"
        ) {
          this.state.durableActions.set(current.id, {
            ...current,
            leaseExpiresAt: entry.input.heartbeatAt + entry.input.leaseMs,
            updatedAt: entry.input.heartbeatAt,
          });
        }
        return;
      }
      case "durable.attempt.record":
      case "durable.checkpoint.record":
      case "durable.signal.record":
        // Durable action facts are intentionally not projected into the
        // in-memory RuntimeRegistrySnapshot. They are journal-durable and
        // replay into SQLite through RecoverableSQLiteProjection.
        return;
      case "control.event.record":
        return;
      case "journal.replay_barrier":
        // Opaque recovery metadata only. It intentionally has no domain-state
        // representation in the in-memory broker snapshot.
        return;
      case "scout.dispatch.record":
        this.state.scoutDispatches.push(entry.dispatch);
        return;
      default: {
        const exhaustive: never = entry;
        return exhaustive;
      }
    }
  }

  listScoutDispatches(options: { limit?: number; askedLabel?: string } = {}): ScoutDispatchRecord[] {
    const limit = options.limit ?? 200;
    return [...this.state.scoutDispatches]
      .filter((record) => !options.askedLabel || record.askedLabel === options.askedLabel)
      .sort((left, right) => right.dispatchedAt - left.dispatchedAt)
      .slice(0, limit);
  }
}
