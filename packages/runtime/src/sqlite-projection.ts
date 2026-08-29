import type {
  ActorIdentity,
  AgentDefinition,
  ConversationDefinition,
  ControlEvent,
  DeliveryIntent,
  NodeDefinition,
  ThreadEventEnvelope,
  ThreadSnapshot,
} from "@openscout/protocol";

import {
  FileBackedBrokerJournal,
  type BrokerJournalEntry,
  type BrokerJournalReplayBoundary,
} from "./broker-journal.js";
import { SQLiteControlPlaneStore, type ActivityItem } from "./sqlite-store.js";

type ActivityQuery = Parameters<SQLiteControlPlaneStore["listActivityItems"]>[0];

type RecoverableSQLiteProjectionOptions = {
  disabled?: boolean;
  createStore?: (dbPath: string) => SQLiteControlPlaneStore;
  replayYieldEvery?: number;
};

const DEFAULT_REPLAY_YIELD_EVERY = 256;

export type SQLiteProjectionStatusSnapshot = {
  state: "ready" | "warming" | "degraded" | "disabled";
  detail: string | null;
};

function normalizeEntries(
  entriesInput: BrokerJournalEntry | BrokerJournalEntry[],
): BrokerJournalEntry[] {
  return Array.isArray(entriesInput) ? entriesInput : [entriesInput];
}

type ReplayParentScan = {
  providedNodes: Map<string, NodeDefinition>;
  providedActors: Map<string, ActorIdentity>;
  providedAgents: Map<string, AgentDefinition>;
  providedConversations: Map<string, ConversationDefinition>;
  referencedNodes: Set<string>;
  referencedActors: Set<string>;
  referencedConversations: Set<string>;
};

function createReplayParentScan(): ReplayParentScan {
  return {
    providedNodes: new Map(),
    providedActors: new Map(),
    providedAgents: new Map(),
    providedConversations: new Map(),
    referencedNodes: new Set(),
    referencedActors: new Set(),
    referencedConversations: new Set(),
  };
}

/**
 * Scan journal entries for FK target IDs that are referenced but never
 * provided by an upsert entry.  Insert minimal stub rows so the main
 * replay doesn't hit FK constraint failures on old/incomplete journals.
 */
function collectReplayParents(scan: ReplayParentScan, entry: BrokerJournalEntry): void {
  // Older / partial journal entries occasionally lack fields like
  // `homeNodeId` or `originNodeId`. Don't propagate those undefineds
  // into the stub upserts — they'd fail NOT NULL on stub creation
  // and abort the whole replay.
  const addRef = (set: Set<string>, value: string | null | undefined): void => {
    if (typeof value === "string" && value.length > 0) set.add(value);
  };

  switch (entry.kind) {
    case "node.upsert":
      scan.providedNodes.set(entry.node.id, entry.node);
      break;
    case "actor.upsert":
      scan.providedActors.set(entry.actor.id, entry.actor);
      break;
    case "agent.upsert":
      scan.providedActors.set(entry.agent.id, entry.agent);
      scan.providedAgents.set(entry.agent.id, entry.agent);
      addRef(scan.referencedNodes, entry.agent.homeNodeId);
      addRef(scan.referencedNodes, entry.agent.authorityNodeId);
      break;
    case "agent.endpoint.upsert":
      addRef(scan.referencedNodes, entry.endpoint.nodeId);
      break;
    case "agent.endpoint.delete":
    case "invocation.dispatch_job.record":
      break;
    case "conversation.upsert":
      scan.providedConversations.set(entry.conversation.id, entry.conversation);
      addRef(scan.referencedNodes, entry.conversation.authorityNodeId);
      addRef(scan.referencedConversations, entry.conversation.parentConversationId);
      for (const participantId of entry.conversation.participantIds) {
        addRef(scan.referencedActors, participantId);
      }
      break;
    case "message.record":
      addRef(scan.referencedNodes, entry.message.originNodeId);
      addRef(scan.referencedActors, entry.message.actorId);
      addRef(scan.referencedConversations, entry.message.conversationId);
      addRef(scan.referencedConversations, entry.message.threadConversationId);
      break;
    case "conversation.read_cursor.upsert":
      addRef(scan.referencedNodes, entry.cursor.readerNodeId);
      addRef(scan.referencedActors, entry.cursor.actorId);
      addRef(scan.referencedConversations, entry.cursor.conversationId);
      break;
    case "invocation.record":
      addRef(scan.referencedActors, entry.invocation.requesterId);
      addRef(scan.referencedNodes, entry.invocation.requesterNodeId);
      addRef(scan.referencedNodes, entry.invocation.targetNodeId);
      break;
    case "flight.record":
      addRef(scan.referencedActors, entry.flight.requesterId);
      break;
    case "collaboration.record":
      addRef(scan.referencedActors, entry.record.createdById);
      addRef(scan.referencedActors, entry.record.ownerId);
      addRef(scan.referencedActors, entry.record.nextMoveOwnerId);
      addRef(scan.referencedConversations, entry.record.conversationId);
      break;
    case "collaboration.event.record":
      addRef(scan.referencedActors, entry.event.actorId);
      break;
    case "deliveries.record":
      for (const delivery of entry.deliveries) {
        addRef(scan.referencedNodes, delivery.targetNodeId);
      }
      break;
    default:
      break;
  }
}

function prepareReplayParents(
  store: SQLiteControlPlaneStore,
  scan: ReplayParentScan,
): void {
  const now = Date.now();

  const nodeIds = new Set([...scan.providedNodes.keys(), ...scan.referencedNodes]);
  for (const id of nodeIds) {
    store.upsertNode(scan.providedNodes.get(id) ?? {
      id,
      meshId: "unknown",
      name: id,
      advertiseScope: "local",
      registeredAt: now,
    } as NodeDefinition);
  }

  const actorIds = new Set([...scan.providedActors.keys(), ...scan.referencedActors]);
  for (const id of actorIds) {
    store.upsertActor(
      scan.providedActors.get(id) ?? { id, kind: "agent", displayName: id } as ActorIdentity,
    );
  }
  for (const agent of scan.providedAgents.values()) {
    store.upsertAgent(agent);
  }

  const anyNodeId =
    nodeIds.values().next().value ??
    "unknown";
  if (nodeIds.size === 0 && scan.referencedConversations.size > 0) {
    store.upsertNode({
      id: anyNodeId,
      meshId: "unknown",
      name: anyNodeId,
      advertiseScope: "local",
      registeredAt: now,
    } as NodeDefinition);
  }
  const conversationIds = new Set([
    ...scan.providedConversations.keys(),
    ...scan.referencedConversations,
  ]);
  for (const id of conversationIds) {
    store.upsertConversation({
      id,
      kind: "direct",
      title: id,
      visibility: "private",
      shareMode: "local",
      authorityNodeId: anyNodeId,
      participantIds: [],
    } as ConversationDefinition);
  }
  // Every conversation ID now exists, so parent references are safe regardless
  // of the order in which compacted definitions appear in the journal.
  for (const conversation of scan.providedConversations.values()) {
    store.upsertConversation(conversation);
  }
}

function applyJournalEntryToStore(
  store: SQLiteControlPlaneStore,
  entry: BrokerJournalEntry,
): ThreadEventEnvelope[] {
  switch (entry.kind) {
    case "node.upsert":
      store.upsertNode(entry.node);
      return [];
    case "actor.upsert":
      store.upsertActor(entry.actor);
      return [];
    case "agent.upsert":
      store.upsertAgent(entry.agent);
      return [];
    case "agent.endpoint.upsert":
      store.upsertEndpoint(entry.endpoint);
      return [];
    case "agent.endpoint.delete":
      store.deleteEndpoint(entry.endpointId);
      return [];
    case "conversation.upsert":
      store.upsertConversation(entry.conversation);
      return [];
    case "binding.upsert":
      store.upsertBinding(entry.binding);
      return [];
    case "message.record":
      return store.recordMessage(entry.message);
    case "conversation.read_cursor.upsert":
      store.upsertReadCursor(entry.cursor);
      return [];
    case "invocation.record":
      store.recordInvocation(entry.invocation);
      return [];
    case "invocation.dispatch_job.record":
      return [];
    case "flight.record":
      return store.recordFlight(entry.flight);
    case "collaboration.record":
      return store.recordCollaborationRecord(entry.record);
    case "collaboration.event.record":
      return store.recordCollaborationEvent(entry.event);
    case "deliveries.record":
      store.recordDeliveries(entry.deliveries);
      return [];
    case "delivery.attempt.record":
      store.recordDeliveryAttempt(entry.attempt);
      return [];
    case "delivery.status.update":
      store.updateDeliveryStatus(entry.deliveryId, entry.status, {
        metadata: entry.metadata,
        leaseOwner: entry.leaseOwner,
        leaseExpiresAt: entry.leaseExpiresAt,
      });
      return [];
    case "durable.action.record":
      store.recordDurableAction(entry.action);
      return [];
    case "durable.action.heartbeat":
      store.heartbeatDurableAction(entry.input);
      return [];
    case "durable.attempt.record":
      store.recordDurableAttempt(entry.attempt);
      return [];
    case "durable.checkpoint.record":
      store.commitDurableCheckpoint({
        ...entry.checkpoint,
        leaseOwner: undefined,
        leaseGeneration: undefined,
      });
      return [];
    case "durable.signal.record":
      store.emitDurableSignal({
        ...entry.signal,
        leaseOwner: undefined,
        leaseGeneration: undefined,
      });
      return [];
    case "scout.dispatch.record":
      store.recordScoutDispatch(entry.dispatch);
      return [];
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

/**
 * Apply each entry independently. A single bad entry (NOT NULL / FK
 * violation from a malformed historical journal record) must not be
 * allowed to abort the batch — otherwise the caller invalidates the
 * whole store and the next write triggers a full re-replay that hits
 * the same entry again, degrading the projection forever.
 */
function applyJournalEntriesToStore(
  store: SQLiteControlPlaneStore,
  entriesInput: BrokerJournalEntry | BrokerJournalEntry[],
  onSkip?: (entry: BrokerJournalEntry, error: unknown) => void,
): ThreadEventEnvelope[] {
  const threadEvents: ThreadEventEnvelope[] = [];
  for (const entry of normalizeEntries(entriesInput)) {
    try {
      threadEvents.push(...applyJournalEntryToStore(store, entry));
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        throw error;
      }
      onSkip?.(entry, error);
    }
  }
  return threadEvents;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const skippedEntryReasons = new Set<string>();

function reportSkippedEntry(entry: BrokerJournalEntry, error: unknown): void {
  const reason = formatError(error);
  const key = `${entry.kind}:${reason}`;
  if (skippedEntryReasons.has(key)) return;
  skippedEntryReasons.add(key);
  console.warn(
    `[broker] sqlite projection skipped malformed ${entry.kind} entry: ${reason}`,
  );
}

function isTransientStoreBusyError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      return true;
    }
  }

  const msg = formatError(error).toLowerCase();
  if (msg.includes("database is locked")) return true;
  if (msg.includes("database is busy")) return true;
  if (msg.includes("sqlite_busy")) return true;
  return false;
}

/**
 * Errors that mean the store itself is unusable (closed db, disk full,
 * schema mismatch). These must invalidate the store so the next call
 * rebuilds it. Transient lock contention is handled separately and must
 * preserve the store.
 */
function isFatalStoreError(error: unknown): boolean {
  if (isTransientStoreBusyError(error)) return false;
  const msg = formatError(error).toLowerCase();
  if (msg.includes("disk i/o")) return true;
  if (msg.includes("database disk image is malformed")) return true;
  if (msg.includes("no such table")) return true;
  if (msg.includes("readonly database")) return true;
  return false;
}

export class RecoverableSQLiteProjection {
  private store: SQLiteControlPlaneStore | null = null;

  private queue: Promise<void> = Promise.resolve();

  private closed = false;

  private lastUnavailableReason: string | null = null;

  private warming = false;

  private warmBoundaryReady: Promise<void> | null = null;

  private startupRecoveryInitiated = false;

  private deferredStartupEvents: ControlEvent[] = [];

  constructor(
    private readonly dbPath: string,
    private readonly journal: FileBackedBrokerJournal,
    private readonly options: RecoverableSQLiteProjectionOptions = {},
  ) {}

  statusSnapshot(): SQLiteProjectionStatusSnapshot {
    if (this.options.disabled) {
      return {
        state: "disabled",
        detail: "SQLite projection is disabled by configuration.",
      };
    }
    if (this.store) {
      return { state: "ready", detail: null };
    }
    if (this.warming) {
      return {
        state: "warming",
        detail: "SQLite activity projection is rebuilding from the broker journal.",
      };
    }
    return {
      state: "degraded",
      detail: this.lastUnavailableReason
        ?? (this.closed ? "SQLite projection is closed." : "SQLite projection is not ready."),
    };
  }

  warm(): Promise<void> {
    if (this.options.disabled || this.closed || this.store || this.warming) {
      return this.warmBoundaryReady ?? Promise.resolve();
    }
    this.startupRecoveryInitiated = true;
    const deferredStartupEvents = this.deferredStartupEvents.splice(0);
    this.warming = true;
    let resolveBoundary: () => void = () => {};
    let rejectBoundary: (error: unknown) => void = () => {};
    let boundaryCaptured = false;
    this.warmBoundaryReady = new Promise<void>((resolve, reject) => {
      resolveBoundary = resolve;
      rejectBoundary = reject;
    });
    this.enqueue(async () => {
      try {
        await this.ensureStore(() => {
          boundaryCaptured = true;
          resolveBoundary();
        });
      } finally {
        this.warming = false;
        if (!boundaryCaptured) {
          rejectBoundary(new Error(
            this.lastUnavailableReason ?? "SQLite projection replay boundary could not be established.",
          ));
        }
      }
    });
    for (const event of deferredStartupEvents) {
      this.enqueueEvent(event);
    }
    return this.warmBoundaryReady;
  }

  enqueueEntries(entriesInput: BrokerJournalEntry | BrokerJournalEntry[]): void {
    const entries = normalizeEntries(entriesInput);
    if (entries.length === 0 || this.options.disabled || this.closed) {
      return;
    }
    // Before explicit recovery starts, durable entries are already present in
    // the journal and will be included by warm()'s later fixed boundary.
    if (!this.startupRecoveryInitiated) {
      return;
    }

    this.enqueue(async () => {
      const store = await this.ensureStore();
      if (!store) {
        return;
      }

      try {
        applyJournalEntriesToStore(store, entries, reportSkippedEntry);
      } catch (error) {
        if (isTransientStoreBusyError(error)) {
          return;
        }
        if (isFatalStoreError(error)) {
          this.invalidateStore(error);
        } else {
          reportSkippedEntry({ kind: "unknown" } as never, error);
        }
      }
    });
  }

  enqueueEvent(event: ControlEvent): void {
    if (this.options.disabled || this.closed) {
      return;
    }
    // Runtime priming emits control events before the daemon begins recovery.
    // Preserve those events without allowing this incidental path to choose
    // the authoritative journal replay boundary.
    if (!this.startupRecoveryInitiated) {
      this.deferredStartupEvents.push(event);
      return;
    }

    this.enqueue(async () => {
      const store = await this.ensureStore();
      if (!store) {
        return;
      }

      try {
        store.recordEvent(event);
      } catch (error) {
        if (isTransientStoreBusyError(error)) {
          return;
        }
        this.invalidateStore(error);
      }
    });
  }

  async listActivityItems(options: ActivityQuery = {}): Promise<ActivityItem[]> {
    if (this.options.disabled || this.closed) {
      return [];
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return [];
    }

    try {
      return store.listActivityItems(options);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return [];
      }
      this.invalidateStore(error);
      return [];
    }
  }

  async listDeliveries(options: {
    transport?: DeliveryIntent["transport"];
    status?: DeliveryIntent["status"];
    limit?: number;
  } = {}): Promise<DeliveryIntent[]> {
    if (this.options.disabled || this.closed) {
      return this.journal.listDeliveries(options);
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return this.journal.listDeliveries(options);
    }

    try {
      return store.listDeliveries(options);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return this.journal.listDeliveries(options);
      }
      this.invalidateStore(error);
      return this.journal.listDeliveries(options);
    }
  }

  async flush(): Promise<void> {
    await this.queue.catch(() => {});
  }

  async applyEntries(entriesInput: BrokerJournalEntry | BrokerJournalEntry[]): Promise<ThreadEventEnvelope[]> {
    const entries = normalizeEntries(entriesInput);
    if (entries.length === 0 || this.options.disabled || this.closed) {
      return [];
    }

    return this.enqueueResult(async () => {
      const store = await this.ensureStore();
      if (!store) {
        return [];
      }

      try {
        return applyJournalEntriesToStore(store, entries, reportSkippedEntry);
      } catch (error) {
        if (isTransientStoreBusyError(error)) {
          return [];
        }
        if (isFatalStoreError(error)) {
          this.invalidateStore(error);
        } else {
          reportSkippedEntry({ kind: "unknown" } as never, error);
        }
        return [];
      }
    });
  }

  async latestThreadSeq(conversationId: string): Promise<number> {
    if (this.options.disabled || this.closed) {
      return 0;
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return 0;
    }

    try {
      return store.latestThreadSeq(conversationId);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return 0;
      }
      this.invalidateStore(error);
      return 0;
    }
  }

  async oldestThreadSeq(conversationId: string): Promise<number> {
    if (this.options.disabled || this.closed) {
      return 0;
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return 0;
    }

    try {
      return store.oldestThreadSeq(conversationId);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return 0;
      }
      this.invalidateStore(error);
      return 0;
    }
  }

  async listThreadEvents(options: {
    conversationId: string;
    afterSeq?: number;
    limit?: number;
  }): Promise<ThreadEventEnvelope[]> {
    if (this.options.disabled || this.closed) {
      return [];
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return [];
    }

    try {
      return store.listThreadEvents(options);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return [];
      }
      this.invalidateStore(error);
      return [];
    }
  }

  async getThreadSnapshot(conversationId: string): Promise<ThreadSnapshot | null> {
    if (this.options.disabled || this.closed) {
      return null;
    }

    await this.flush();
    const store = await this.ensureStore();
    if (!store) {
      return null;
    }

    try {
      return store.getThreadSnapshot(conversationId);
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return null;
      }
      this.invalidateStore(error);
      return null;
    }
  }

  close(): void {
    this.closed = true;
    const current = this.store;
    this.store = null;
    current?.close();
  }

  private enqueue(task: () => Promise<void>): void {
    if (this.closed) {
      return;
    }

    this.queue = this.queue
      .catch(() => {})
      .then(task);
  }

  private enqueueResult<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.resolve(undefined as T);
    }

    const next = this.queue
      .catch(() => {})
      .then(task);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  private async replayJournal(
    visitor: (entry: BrokerJournalEntry) => void | Promise<void>,
    boundary: BrokerJournalReplayBoundary,
  ): Promise<void> {
    const configuredBatchSize = this.options.replayYieldEvery ?? DEFAULT_REPLAY_YIELD_EVERY;
    const batchSize = Math.max(1, Math.floor(configuredBatchSize));
    let visited = 0;
    await this.journal.replay(async (entry) => {
      await visitor(entry);
      visited += 1;
      if (visited % batchSize === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }, boundary);
  }

  private async ensureStore(onReplayBoundaryCaptured?: () => void): Promise<SQLiteControlPlaneStore | null> {
    if (this.options.disabled || this.closed) {
      return null;
    }
    if (!this.startupRecoveryInitiated) {
      return null;
    }
    if (this.store) {
      return this.store;
    }

    try {
      const replayBoundary = await this.journal.captureReplayBoundary();
      onReplayBoundaryCaptured?.();
      const createStore = this.options.createStore ?? ((dbPath: string) => new SQLiteControlPlaneStore(dbPath));
      const store = createStore(this.dbPath);
      // First pass retains only the latest FK parents and referenced IDs. The
      // second pass applies the journal in order. Memory is bounded by current
      // entity cardinality instead of historical journal entry count.
      const parents = createReplayParentScan();
      await this.replayJournal((entry) => {
        collectReplayParents(parents, entry);
      }, replayBoundary);
      prepareReplayParents(store, parents);
      await this.replayJournal((entry) => {
        try {
          applyJournalEntryToStore(store, entry);
        } catch (error) {
          if (isTransientStoreBusyError(error)) {
            throw error;
          }
          if (isFatalStoreError(error)) {
            throw error;
          }
          reportSkippedEntry(entry, error);
        }
      }, replayBoundary);
      this.store = store;
      this.lastUnavailableReason = null;
      return store;
    } catch (error) {
      if (isTransientStoreBusyError(error)) {
        return null;
      }
      this.invalidateStore(error);
      return null;
    }
  }

  private invalidateStore(error: unknown): void {
    const reason = formatError(error);
    if (this.lastUnavailableReason !== reason) {
      console.warn(`[broker] sqlite projection unavailable (degraded): ${reason}`);
      this.lastUnavailableReason = reason;
    }

    const current = this.store;
    this.store = null;
    current?.close();
  }
}
