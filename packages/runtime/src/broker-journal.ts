import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import type {
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
  countsByKind: Partial<Record<BrokerJournalEntry["kind"], number>>;
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
};

function cloneSnapshot(snapshot: RuntimeRegistrySnapshot): RuntimeRegistrySnapshot {
  return createRuntimeRegistrySnapshot({
    nodes: { ...snapshot.nodes },
    actors: { ...snapshot.actors },
    agents: { ...snapshot.agents },
    endpoints: { ...snapshot.endpoints },
    conversations: { ...snapshot.conversations },
    bindings: { ...snapshot.bindings },
    messages: { ...snapshot.messages },
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

export class FileBackedBrokerJournal {
  private readonly filePath: string;

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

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<BrokerJournalLoadReport> {
    if (this.loaded) {
      return this.latestLoadReport!;
    }

    const startedAt = Date.now();
    const sourceBytes = await stat(this.filePath).then((value) => value.size).catch((error) => {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === "ENOENT") return 0;
      throw error;
    });
    const latestIndexByKey = new Map<string, number>();
    const lastFlightById = new Map<string, FlightRecord>();
    const countsByKind: BrokerJournalLoadReport["countsByKind"] = {};
    let compactionRequired = false;

    const scanStartedAt = Date.now();
    const scan = await this.visitEntries((entry, index) => {
      this.apply(entry);
      countsByKind[entry.kind] = (countsByKind[entry.kind] ?? 0) + 1;
      const key = dedupeKey(entry);
      if (key) {
        if (latestIndexByKey.has(key)) {
          compactionRequired = true;
        }
        latestIndexByKey.set(key, index);
      }
      if (entry.kind === "flight.record") {
        const previous = lastFlightById.get(entry.flight.id);
        if (previous && sameValue(previous, entry.flight)) {
          compactionRequired = true;
        }
        lastFlightById.set(entry.flight.id, entry.flight);
      }
    });
    const scanMs = Date.now() - scanStartedAt;

    let compactionMs = 0;
    if (compactionRequired) {
      const compactionStartedAt = Date.now();
      await this.rewriteCompactedEntries(latestIndexByKey);
      compactionMs = Date.now() - compactionStartedAt;
    }

    this.loaded = true;
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
      countsByKind,
    };
    return this.latestLoadReport;
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

  captureReplayBoundary(): Promise<BrokerJournalReplayBoundary> {
    let boundary: BrokerJournalReplayBoundary = { endByteExclusive: 0 };
    const capture = this.writeQueue.then(async () => {
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
      };
    });
    this.writeQueue = capture.then(() => undefined, () => undefined);
    return capture.then(() => boundary);
  }

  async replay(
    visitor: (entry: BrokerJournalEntry) => void | Promise<void>,
    boundary?: BrokerJournalReplayBoundary,
  ): Promise<void> {
    await this.visitEntries(
      (entry) => visitor(entry),
      boundary ? { endByteExclusive: boundary.endByteExclusive } : {},
    );
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
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      if (retained.length === 0) {
        return;
      }
      const payload = retained.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      await appendFile(this.filePath, payload, "utf8");
      for (const entry of retained) {
        this.apply(entry);
      }
    });

    await this.writeQueue;
    return retained;
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

  listDeliveries(options: {
    transport?: DeliveryIntent["transport"];
    status?: DeliveryIntent["status"];
    limit?: number;
  } = {}): DeliveryIntent[] {
    const limit = options.limit ?? 200;
    return [...this.state.deliveries.values()]
      .filter((delivery) => !options.transport || delivery.transport === options.transport)
      .filter((delivery) => !options.status || delivery.status === options.status)
      .slice(0, limit);
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
    visitor: (entry: BrokerJournalEntry, index: number) => void | Promise<void>,
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
        if (!rawLine.trim()) {
          report.blankLines += 1;
          continue;
        }
        const entry = parseEntry(rawLine);
        if (!entry) {
          report.invalidLines += 1;
          continue;
        }
        await visitor(entry, index);
        index += 1;
        report.validEntries += 1;
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
    }
    return report;
  }

  private async rewriteCompactedEntries(latestIndexByKey: Map<string, number>): Promise<void> {
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
      });
      output.end();
      await once(output, "finish");
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      output.destroy();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private selectEntriesToAppend(entries: BrokerJournalEntry[]): BrokerJournalEntry[] {
    const nextSnapshot = cloneSnapshot(this.state.snapshot);
    const retained: BrokerJournalEntry[] = [];

    for (const entry of entries) {
      if (!this.shouldAppendEntry(entry, nextSnapshot)) {
        continue;
      }
      retained.push(entry);
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
        this.state.snapshot.messages[entry.message.id] = entry.message;
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

        this.state.deliveries.set(entry.deliveryId, {
          ...current,
          status: entry.status,
          leaseOwner: entry.leaseOwner ?? undefined,
          leaseExpiresAt: entry.leaseExpiresAt ?? undefined,
          metadata: mergeMetadata(current.metadata, entry.metadata),
        });
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
