import type { BrokerMessageHistory } from "./broker-message-history.js";
import { readableCanonicalMessage, readableJournalKinds } from "./broker-journal-record-contract.js";
import { shareLoadedRecordStrings } from "./broker-record-strings.js";
import { captureMessageRecords, asyncMessageRecordView } from "./broker-message-records.js";
import type { BrokerMemoryMaintenance } from "./broker-memory-maintenance.js";
import { applyHistoryRotationEviction, emptyHistoryRotationPlan, planHistoryRotation, type HistoryRotationContext, type HistoryRotationPlan } from "./history-rotation.js";
import { setImmediate as yieldReadTurn } from "node:timers/promises";
import { readableDelivery, readableDeliveryStatus, readableMetadata, type BrokerRecordRead } from "./broker-record-reader.js";
import { BrokerMessageBodyCache, BrokerMessageBodyCacheUnavailable, type MessageBodyCacheOptions } from "./broker-message-body-cache.js";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
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
  type RuntimeActorIdentity,
  type RuntimeAgentDefinition,
  type RuntimeRegistrySnapshot,
} from "./registry.js";
import type { BrokerInvocationDispatchJob } from "./broker-dispatch-job.js";

export type BrokerJournalEntry =
  | { kind: "node.upsert"; node: NodeDefinition }
  | { kind: "actor.upsert"; actor: RuntimeActorIdentity }
  | { kind: "agent.upsert"; agent: RuntimeAgentDefinition }
  // conversationIds is the delete preimage — the memberships captured before
  // the row went away — so the conversation projection can re-evaluate exactly
  // those rooms instead of scanning every direct conversation.
  | { kind: "agent.delete"; agentId: string; conversationIds?: string[] }
  | { kind: "agent.endpoint.upsert"; endpoint: AgentEndpoint }
  | { kind: "agent.endpoint.delete"; endpointId: string; agentId?: string }
  | { kind: "actor.delete"; actorId: string; conversationIds?: string[] }
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
  | { kind: "scout.dispatch.record"; dispatch: ScoutDispatchRecord }
  // Week-clock hot-set rotation marker: the snapshot and journal keep only the
  // live windows; SQLite holds everything. One logical stream — only the
  // newest survives compaction.
  | {
      kind: "history.rotate";
      cutoff: number;
      rotatedAt: number;
      /**
       * The ids the writer verified as persisted in durable SQLite before
       * journaling this marker. Apply removes exactly these records and
       * compaction dooms exactly these lines — eligibility is never
       * recomputed. Absent only on markers written before the verified
       * plan landed; those fall back to recomputing the closure rules.
       */
      evicted?: {
        messageIds: string[];
        invocationIds: string[];
        flightIds: string[];
        deliveryIds: string[];
        collaborationEventIds: string[];
        /**
         * Optional only for markers written between the verified-marker
         * change and delivery-attempt verification; absent means no
         * attempts were doomed — an empty set must evict nothing.
         */
        deliveryAttemptIds?: string[];
      };
    };


type JournalSnapshotState = {
  snapshot: RuntimeRegistrySnapshot;
  /** Actor ids deleted by a tombstone entry. Not part of the wire snapshot —
   * replayed deletes rebuild it so the runtime can fence stale roster writes
   * that would resurrect a retired actor's membership. */
  retiredActorIds: Set<string>;
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
  | BrokerJournalEntry & { kind: "actor.delete" }
  | BrokerJournalEntry & { kind: "agent.upsert" }
  | BrokerJournalEntry & { kind: "agent.delete" }
  | BrokerJournalEntry & { kind: "agent.endpoint.upsert" }
  | BrokerJournalEntry & { kind: "agent.endpoint.delete" }
  | BrokerJournalEntry & { kind: "conversation.upsert" }
  | BrokerJournalEntry & { kind: "binding.upsert" }
  | BrokerJournalEntry & { kind: "history.rotate" };

type JournalVisitReport = {
  rawLines: number;
  validEntries: number;
  invalidLines: number;
  blankLines: number;
};

type AppliedHistoryRotation = HistoryRotationPlan & {
  cutoff: number;
};

/** The `evicted` wire shape on a `history.rotate` marker, as id Sets. */
function historyRotationPlanFromMarker(
  evicted: NonNullable<Extract<BrokerJournalEntry, { kind: "history.rotate" }>["evicted"]>,
): HistoryRotationPlan {
  const plan = emptyHistoryRotationPlan();
  for (const id of evicted.messageIds) plan.messageIds.add(id);
  for (const id of evicted.invocationIds) plan.invocationIds.add(id);
  for (const id of evicted.flightIds) plan.flightIds.add(id);
  for (const id of evicted.deliveryIds) plan.deliveryIds.add(id);
  for (const id of evicted.deliveryAttemptIds ?? []) plan.deliveryAttemptIds.add(id);
  for (const id of evicted.collaborationEventIds) plan.collaborationEventIds.add(id);
  return plan;
}

/**
 * Whether a record line that predates the rotate marker was evicted by it:
 * "all" drops the whole line, "partial" (a deliveries.record carrying both
 * doomed and surviving intents) keeps the line filtered, "none" keeps it.
 */
function historyRotationDropsEntry(
  rotations: readonly AppliedHistoryRotation[],
  entry: BrokerJournalEntry,
): "all" | "partial" | "none" {
  if (rotations.length === 0) return "none";
  switch (entry.kind) {
    case "message.record":
      return rotations.some((r) => r.messageIds.has(entry.message.id)) ? "all" : "none";
    case "flight.record":
      return rotations.some((r) => r.flightIds.has(entry.flight.id)) ? "all" : "none";
    case "invocation.record":
      return rotations.some((r) => r.invocationIds.has(entry.invocation.id)) ? "all" : "none";
    case "deliveries.record": {
      const kept = entry.deliveries.filter(
        (delivery) => !rotations.some((r) => r.deliveryIds.has(delivery.id)),
      );
      if (kept.length === 0) return "all";
      return kept.length === entry.deliveries.length ? "none" : "partial";
    }
    case "delivery.attempt.record":
      return rotations.some((r) => r.deliveryAttemptIds.has(entry.attempt.id)) ? "all" : "none";
    case "collaboration.event.record":
      return rotations.some((r) => r.collaborationEventIds.has(entry.event.id)) ? "all" : "none";
    default:
      return "none";
  }
}

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
    case "actor.delete":
      // A delete shares its upsert's key so compaction keeps only the final
      // state for the record — whether that state is a row or its absence.
      return `actor.upsert:${entry.actorId}`;
    case "agent.upsert":
      return `${entry.kind}:${entry.agent.id}`;
    case "agent.delete":
      return `agent.upsert:${entry.agentId}`;
    case "agent.endpoint.upsert":
      return `${entry.kind}:${entry.endpoint.id}`;
    case "agent.endpoint.delete":
      return `agent.endpoint.upsert:${entry.endpointId}`;
    case "conversation.upsert":
      return `${entry.kind}:${entry.conversation.id}`;
    case "binding.upsert":
      return `${entry.kind}:${entry.binding.id}`;
    case "history.rotate":
      // One logical rotation stream — compaction keeps only the newest marker.
      return "history.rotate";
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
    retiredActorIds: new Set<string>(),
    collaborationEvents: [],
    deliveries: new Map<string, DeliveryIntent>(),
    deliveryAttempts: new Map<string, DeliveryAttempt[]>(),
    durableActions: new Map<string, DurableAction>(),
    invocationDispatchJobs: new Map<string, BrokerInvocationDispatchJob>(),
    scoutDispatches: [],
  };

  private loaded = false;

  private latestLoadReport: BrokerJournalLoadReport | null = null;

  /** Eviction sets per applied history.rotate, in journal order. Compaction
   * drops a record line when ANY rotation after the line doomed it — later
   * markers alone cannot describe what earlier ones evicted. */
  private appliedRotations: AppliedHistoryRotation[] = [];

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
    await this.reapOrphanedCompactionTemps();
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
    // Rotated-out history lines are reclaim too, but they never appear in the
    // dedupe map — measure them in a second streaming pass only when a rotate
    // marker is present. Each line is evaluated against the rotations that
    // come after it (earlier markers cannot describe a later record's fate).
    const rotationIndex = latestIndexByKey.get("history.rotate");
    if (this.appliedRotations.length > 0 && rotationIndex !== undefined) {
      const remaining = [...this.appliedRotations];
      await this.visitEntries((entry, index, encodedLineBytes) => {
        if (index >= rotationIndex) return;
        if (entry.kind === "history.rotate") {
          remaining.shift();
          return;
        }
        if (historyRotationDropsEntry(remaining, entry) === "all") {
          estimatedReclaimBytes += encodedLineBytes;
        }
      });
    }
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
        // The load report was published before this deferred compaction ran —
        // fold the real numbers back in so consumers do not read `compaction
        // 0ms`, a stale post-compaction size, or a total that ended before the
        // work did.
        const compactedBytes = await stat(this.filePath).then((value) => value.size).catch(() => 0);
        if (this.latestLoadReport) {
          const completedAt = Date.now();
          this.latestLoadReport = {
            ...this.latestLoadReport,
            completedAt,
            totalMs: completedAt - this.latestLoadReport.startedAt,
            compactionMs: this.startupCompactionMs,
            compactedBytes,
          };
        }
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
   * Remove `broker-journal.jsonl.<pid>.<ts>.tmp` siblings left behind when a
   * broker died mid-compaction. The pid is the third dot-field of the temp
   * basename; only files whose pid is not a live process are touched.
   */
  private async reapOrphanedCompactionTemps(): Promise<void> {
    const journalBase = basename(this.filePath);
    const prefix = `${journalBase}.`;
    let names: string[];
    try {
      names = await readdir(dirname(this.filePath));
    } catch {
      return;
    }
    let removed = 0;
    let removedBytes = 0;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const pidField = name.slice(prefix.length, -".tmp".length).split(".")[0];
      const pid = Number.parseInt(pidField ?? "", 10);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      if (pid === process.pid) continue;
      let dead = false;
      try {
        process.kill(pid, 0);
      } catch (error) {
        // ESRCH means no such process — the compaction temp is an orphan.
        // EPERM means the pid exists but is not ours; leave its file alone.
        dead = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!dead) continue;
      const orphanPath = `${dirname(this.filePath)}/${name}`;
      const size = await stat(orphanPath).then((value) => value.size).catch(() => 0);
      await unlink(orphanPath).then(
        () => { removed += 1; removedBytes += size; },
        () => undefined,
      );
    }
    if (removed > 0) {
      console.log(`[openscout-runtime] reaped ${removed} orphaned journal compaction temp file(s), ${removedBytes} bytes`);
    }
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

  /**
   * Actor ids retired by `actor.delete` tombstones — including tombstones
   * that survived compaction — used to seed the runtime's stale-roster fence
   * at hydration. Live view; callers must not mutate.
   */
  retiredActorIds(): ReadonlySet<string> {
    return this.state.retiredActorIds;
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
    conversationId?: string;
    includeThreads?: boolean;
    orderByCreatedAt?: boolean;
    afterCreatedAt?: number;
    afterId?: string;
    limit?: number;
    kind?: CollaborationRecord["kind"];
    state?: string;
    ownerId?: string;
    nextMoveOwnerId?: string;
  } = {}): CollaborationRecord[] {
    const limit = options.limit ?? 200;
    return Object.values(this.state.snapshot.collaborationRecords)
      .filter(record => !options.conversationId || record.conversationId === options.conversationId
        || Boolean(options.includeThreads && record.conversationId && this.state.snapshot.conversations[record.conversationId]?.kind === "thread"
          && this.state.snapshot.conversations[record.conversationId]?.parentConversationId === options.conversationId))
      .filter(record => options.afterCreatedAt == null || record.createdAt > options.afterCreatedAt
        || (record.createdAt === options.afterCreatedAt && record.id > (options.afterId ?? "")))
      .filter((record) => !options.kind || record.kind === options.kind)
      .filter((record) => !options.state || record.state === options.state)
      .filter((record) => !options.ownerId || record.ownerId === options.ownerId)
      .filter((record) => !options.nextMoveOwnerId || record.nextMoveOwnerId === options.nextMoveOwnerId)
      .sort((left, right) => options.orderByCreatedAt
        ? left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        : right.updatedAt - left.updatedAt)
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

  /** Every journaled delivery attempt by id — the verifier's expected records. */
  deliveryAttemptsById(): Map<string, DeliveryAttempt> {
    const found = new Map<string, DeliveryAttempt>();
    for (const attempts of this.state.deliveryAttempts.values()) {
      for (const attempt of attempts) {
        found.set(attempt.id, attempt);
      }
    }
    return found;
  }

  /** Every journaled collaboration event by id — the verifier's expected records. */
  collaborationEventsById(): Map<string, CollaborationEvent> {
    const found = new Map<string, CollaborationEvent>();
    for (const event of this.state.collaborationEvents) {
      found.set(event.id, event);
    }
    return found;
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
    // Every history.rotate marker applied during the scan kept its eviction
    // sets in `appliedRotations`. A record line is dropped when ANY rotation
    // after it doomed the record — the marker itself survives via the shared
    // "history.rotate" dedupe key, so only the newest one is written.
    const rotationIndex = latestIndexByKey.get("history.rotate");
    const remainingRotations = rotationIndex !== undefined ? [...this.appliedRotations] : [];

    try {
      await this.visitEntries(async (entry, index) => {
        if (entry.kind === "history.rotate") {
          remainingRotations.shift();
        }
        let writeEntry = entry;
        if (index < (rotationIndex ?? -1) && remainingRotations.length > 0) {
          switch (historyRotationDropsEntry(remainingRotations, entry)) {
            case "all":
              return;
            case "partial":
              if (entry.kind === "deliveries.record") {
                writeEntry = {
                  ...entry,
                  deliveries: entry.deliveries.filter(
                    (delivery) => !remainingRotations.some(
                      (rotation) => rotation.deliveryIds.has(delivery.id),
                    ),
                  ),
                };
              }
              break;
            case "none":
              break;
          }
        }

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
          // A latest-entry delete is KEPT as a tombstone. SQLite recovery
          // replays a checkpoint suffix onto an existing database — it cannot
          // infer deletes from absence, so dropping the tombstone would leave
          // the deleted row (and its references) in the store permanently.
        }

        if (!output.write(`${JSON.stringify(writeEntry)}\n`, "utf8")) {
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
      throw error;
    } finally {
      // After publish() the path no longer exists (it was renamed away); on any
      // failure the half-written temp must not survive to the next boot.
      await unlink(temporaryPath).catch(() => undefined);
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
        case "agent.delete": copy("agents"); copy("endpoints"); break;
        case "actor.delete": copy("actors"); break;
        case "agent.endpoint.upsert":
        case "agent.endpoint.delete": copy("endpoints"); break;
        case "conversation.upsert": copy("conversations"); break;
        case "binding.upsert": copy("bindings"); break;
        case "flight.record": copy("flights"); break;
        case "history.rotate":
          // The rotation deletes from the maps it touches — copy them so the
          // dedupe check cannot evict live records from the real snapshot.
          if (!asyncMessageRecordView(nextSnapshot.messages)) copy("messages");
          copy("flights");
          copy("invocations");
          break;
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
      case "history.rotate":
        // A same-cutoff repeat changes nothing — the daemon also checks, but
        // the journal must not accumulate duplicate markers.
        return this.appliedRotations.at(-1)?.cutoff !== entry.cutoff;
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
            createdAt: entry.agent.createdAt,
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
      case "agent.delete":
        delete snapshot.agents[entry.agentId];
        // Deleting an agent also deletes its endpoints. The caller journals an
        // agent.endpoint.delete per endpoint first; these deletes must be
        // idempotent when those entries already removed them.
        for (const endpoint of Object.values(snapshot.endpoints)) {
          if (endpoint.agentId === entry.agentId) {
            delete snapshot.endpoints[endpoint.id];
          }
        }
        return;
      case "actor.delete":
        delete snapshot.actors[entry.actorId];
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
      case "history.rotate": {
        const evicted = entry.evicted
          ? historyRotationPlanFromMarker(entry.evicted)
          : planHistoryRotation(snapshot, entry.cutoff, this.historyRotationContext());
        applyHistoryRotationEviction(snapshot, evicted);
        return;
      }
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
        // Re-registration revives the identity — clear the tombstone.
        this.state.retiredActorIds.delete(entry.actor.id);
        this.state.snapshot.actors[entry.actor.id] = entry.actor;
        return;
      case "agent.upsert":
        // An agent registration synthesizes its actor identity — revive it.
        this.state.retiredActorIds.delete(entry.agent.id);
        this.state.snapshot.agents[entry.agent.id] = entry.agent;
        if (!this.state.snapshot.actors[entry.agent.id]) {
          this.state.snapshot.actors[entry.agent.id] = {
            id: entry.agent.id,
            kind: entry.agent.kind,
            createdAt: entry.agent.createdAt,
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
      case "agent.delete":
        delete this.state.snapshot.agents[entry.agentId];
        // Deleting an agent also deletes its endpoints; idempotent when the
        // caller's agent.endpoint.delete entries already removed them.
        for (const endpoint of Object.values(this.state.snapshot.endpoints)) {
          if (endpoint.agentId === entry.agentId) {
            delete this.state.snapshot.endpoints[endpoint.id];
          }
        }
        return;
      case "actor.delete":
        // The tombstone is the fact: mark retired even when the row is
        // already absent (idempotent replay).
        this.state.retiredActorIds.add(entry.actorId);
        delete this.state.snapshot.actors[entry.actorId];
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
      case "history.rotate":
        this.applyHistoryRotation(entry);
        return;
      default: {
        const exhaustive: never = entry;
        return exhaustive;
      }
    }
  }

  /**
   * The dependency-closure context history rotation needs: this journal's
   * delivery intents and invocation dispatch jobs (both live outside the
   * rotated snapshot) plus a presence probe for disk-backed message history.
   * The daemon passes the same context to the runtime mirror so both sides
   * evict identical records.
   */
  historyRotationContext(): HistoryRotationContext {
    return {
      deliveries: this.state.deliveries.values(),
      dispatchJobs: this.state.invocationDispatchJobs.values(),
      collaborationEvents: this.state.collaborationEvents,
      deliveryAttempts: [...this.state.deliveryAttempts.values()].flat(),
      // Under the disk-backed async history the records map is a proxy that
      // cannot answer `in`; assume present so referent-absent never evicts
      // a delivery whose message is safely on disk.
      messageIdPresent: asyncMessageRecordView(this.state.snapshot.messages)
        ? () => true
        : undefined,
    };
  }

  /**
   * Apply a `history.rotate` marker to the hot state. Modern markers carry
   * the id sets the writer verified against durable SQLite — apply removes
   * exactly those records and records them on `appliedRotations` so
   * compaction drops exactly the same journal lines; eligibility is never
   * recomputed. Markers written before the `evicted` sets existed fall back
   * to recomputing the closure rules. Registry, conversation, and binding
   * records are untouched — that is the retention sweep's job.
   */
  private applyHistoryRotation(
    entry: Extract<BrokerJournalEntry, { kind: "history.rotate" }>,
  ): void {
    const evicted = entry.evicted
      ? historyRotationPlanFromMarker(entry.evicted)
      : planHistoryRotation(this.state.snapshot, entry.cutoff, this.historyRotationContext());
    applyHistoryRotationEviction(this.state.snapshot, evicted);

    for (const deliveryId of evicted.deliveryIds) {
      this.state.deliveries.delete(deliveryId);
    }
    for (const [deliveryId, attempts] of this.state.deliveryAttempts) {
      const kept = attempts.filter((attempt) => !evicted.deliveryAttemptIds.has(attempt.id));
      if (kept.length === 0) {
        this.state.deliveryAttempts.delete(deliveryId);
      } else if (kept.length !== attempts.length) {
        this.state.deliveryAttempts.set(deliveryId, kept);
      }
    }
    this.state.collaborationEvents = this.state.collaborationEvents.filter(
      (event) => !evicted.collaborationEventIds.has(event.id),
    );

    this.appliedRotations.push({ cutoff: entry.cutoff, ...evicted });
  }

  /** Cutoff of the newest applied `history.rotate` marker, if any. */
  historyRotationCutoff(): number | null {
    return this.appliedRotations.at(-1)?.cutoff ?? null;
  }

  listScoutDispatches(options: { limit?: number; askedLabel?: string } = {}): ScoutDispatchRecord[] {
    const limit = options.limit ?? 200;
    return [...this.state.scoutDispatches]
      .filter((record) => !options.askedLabel || record.askedLabel === options.askedLabel)
      .sort((left, right) => right.dispatchedAt - left.dispatchedAt)
      .slice(0, limit);
  }
}
