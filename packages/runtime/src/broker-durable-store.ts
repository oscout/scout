import type { BrokerMemoryMaintenance } from "./broker-memory-maintenance.js";
import type {
  ThreadEventEnvelope,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";
import {
  assertRotationPlanPartition,
  emptyHistoryRotationPlan,
  type HistoryRotationPlan,
} from "./history-rotation.js";

export type BrokerJournalWriter = {
  appendEntries(entries: BrokerJournalEntry[]): Promise<BrokerJournalEntry[]>;
};

export type BrokerProjectionHealth = {
  /**
   * Monotonic count of live-path entries/batches the projection failed to
   * apply or skipped as malformed since the last proven full replay — a
   * coarse boundary gate only. It is deliberately NOT per-record coverage
   * evidence: records the plan names are verified positively via
   * `verifyPersisted` before any journal line is doomed.
   */
  failures: number;
  /** Non-null while the projection cannot durably accept writes. */
  unavailable: string | null;
};

/**
 * Positive per-record verification result: `present` ids were observed in
 * durable SQLite with matching mutable state at verify time; `missing` ids
 * were absent or stale and must stay journaled until a later rotation sees
 * them land.
 */
export type BrokerPersistenceVerification = {
  present: HistoryRotationPlan;
  missing: HistoryRotationPlan;
};

export type BrokerProjectionWriter = {
  applyEntries(entries: BrokerJournalEntry[]): Promise<ThreadEventEnvelope[]>;
  /** Drain the projection's own internal queue, if it serializes work itself. */
  flush?(): Promise<void>;
  /** Health probe consulted by the persistence boundary. */
  health?(): BrokerProjectionHealth;
  /**
   * Direct durable-store lookups for the ids a rotation plans to evict —
   * the positive coverage proof that replaces the old skip ledger.
   */
  verifyPersisted?(plan: HistoryRotationPlan): Promise<BrokerPersistenceVerification>;
};

export type BrokerThreadEventPublisher = {
  publish(events: ThreadEventEnvelope[]): void;
};

/**
 * A recoverable external publisher fed from the canonical commit path.
 *
 * Deliberately hooked here rather than onto the projection queue: that queue is
 * abandoned on every clean shutdown by design, because SQLite projections are
 * rebuildable. An event transport is not, so it is handed the entries the
 * journal has just durably accepted. The call must not block — it registers
 * intent, and the publisher's own journal rescan is what makes it recoverable.
 */
export type BrokerCommittedEntryPublisher = {
  notifyCommitted(entries: BrokerJournalEntry[]): void;
};

export type BrokerDurableStoreOptions = {
  memoryMaintenance?: BrokerMemoryMaintenance;
  deferProjection?: () => boolean;
  afterRuntime?: () => Promise<void>;
  journal: BrokerJournalWriter;
  projection: BrokerProjectionWriter;
  threadEvents: BrokerThreadEventPublisher;
  eventPublisher?: BrokerCommittedEntryPublisher;
};

export type BrokerDurableCommitOptions = {
  enqueueProjection?: boolean;
};

export function normalizeBrokerJournalEntries(
  entriesInput: BrokerJournalEntry | BrokerJournalEntry[],
): BrokerJournalEntry[] {
  return Array.isArray(entriesInput) ? entriesInput : [entriesInput];
}

export class BrokerDurableStore {
  private durableWriteQueue = Promise.resolve();

  private projectionWriteQueue = Promise.resolve();

  private projectionWritesAbandoned = false;

  /** Live-path applyEntries throws — distinct from failures the projection reports itself. */
  private projectionQueueFailures = 0;

  /** Failure evidence acknowledged by the last successful persistence boundary. */
  private lastBoundaryFailureCount = 0;

  constructor(private readonly options: BrokerDurableStoreOptions) {}

  readonly runWrite = <T>(work: () => Promise<T>): Promise<T> => {
    const next = this.durableWriteQueue.then(work, work);
    this.durableWriteQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  readonly commitEntries = async (
    entriesInput: BrokerJournalEntry | BrokerJournalEntry[],
    applyRuntime: (entries: BrokerJournalEntry[]) => Promise<void>,
    options: BrokerDurableCommitOptions = {},
  ): Promise<BrokerJournalEntry[]> => {
    const entries = await this.options.journal.appendEntries(
      normalizeBrokerJournalEntries(entriesInput),
    );
    if (entries.length === 0) {
      return [];
    }
    // After the journal accepted them, before anything rebuildable runs. A
    // throwing publisher must not fail an already-durable write.
    try {
      this.options.eventPublisher?.notifyCommitted(entries);
    } catch (error) {
      console.warn("[openscout-runtime] committed-entry publisher rejected a batch:", error);
    }
    await applyRuntime(entries);
    await this.options.afterRuntime?.();
    if (options.enqueueProjection !== false) {
      await this.applyProjectedEntries(entries);
    }
    return entries;
  };

  readonly applyProjectedEntries = async (
    entriesInput: BrokerJournalEntry | BrokerJournalEntry[],
  ): Promise<void> => {
    const entries = normalizeBrokerJournalEntries(entriesInput);
    if (entries.length === 0 || this.projectionWritesAbandoned || this.options.deferProjection?.()) {
      return;
    }

    // Projection and native artifacts are rebuildable delivery caches. Keep
    // their ordering, but never put SQLite replay/aggregation on the durable
    // journal + in-memory acknowledgement path used by UI mutations.
    const next = this.projectionWriteQueue
      .catch(() => {})
      .then(() => this.projectionWritesAbandoned
        ? undefined
        : this.projectEntries(entries));
    this.projectionWriteQueue = next.then(() => {}, () => {});
  };

  /**
   * Stop and detach replaceable projection work during process shutdown.
   *
   * Every accepted mutation is already durable in the journal before it can
   * reach this queue. SQLite projections and native artifacts can therefore be
   * rebuilt after restart; an in-progress startup replay must not turn SIGTERM
   * into an unbounded drain. Resetting the tracked queue does not cancel the
   * underlying promise, but it makes the terminal shutdown boundary immediate
   * and prevents late projection events from being published.
   */
  readonly abandonProjectedEntries = (): void => {
    this.projectionWritesAbandoned = true;
    this.projectionWriteQueue = Promise.resolve();
  };

  readonly flushProjectedEntries = async (): Promise<void> => {
    await this.projectionWriteQueue.catch(() => {});
  };

  /**
   * The persistence boundary callers must hold before evicting journaled
   * history or pruning SQLite-only rows: resolves once every queued
   * projection write has drained AND the projection reports no skipped,
   * failed, or deferred entries since the last successful boundary.
   *
   * It fails closed — disabled, deferred, abandoned, or degraded projections
   * all refuse — because a boundary that cannot prove the rows landed must
   * preserve the journal rather than certify an archive it cannot verify.
   * Callers run it inside `runWrite` so a write queued ahead of the boundary
   * cannot still be projecting when it resolves.
   */
  readonly awaitProjectionBoundary = async (): Promise<
    { ok: true } | { ok: false; reason: string }
  > => {
    const refusal = (): { ok: false; reason: string } | null => {
      if (this.projectionWritesAbandoned) {
        return { ok: false, reason: "projection writes abandoned" };
      }
      if (this.options.deferProjection?.()) {
        return { ok: false, reason: "projection deferred" };
      }
      const health = this.options.projection.health?.();
      if (health?.unavailable) {
        return { ok: false, reason: health.unavailable };
      }
      return null;
    };

    const early = refusal();
    if (early) return early;

    // Drain this store's queue, then the projection's own internal queue —
    // read-side callers and deferred event sinks also serialize there.
    await this.projectionWriteQueue.catch(() => {});
    await this.options.projection.flush?.().catch(() => {});

    const late = refusal();
    if (late) return late;

    const health = this.options.projection.health?.();
    const failures = this.projectionQueueFailures + (health?.failures ?? 0);
    if (failures > this.lastBoundaryFailureCount) {
      return {
        ok: false,
        reason: `${failures - this.lastBoundaryFailureCount} projection write(s) failed or were skipped since the last persistence boundary`,
      };
    }
    this.lastBoundaryFailureCount = failures;
    return { ok: true };
  };

  /**
   * Positive per-record coverage proof for a rotation plan, run inside
   * `runWrite` after the coarse boundary. Drains this store's projection
   * queue and the projection's internal queue, then asks the projection to
   * confirm each planned id exists in durable SQLite with matching mutable
   * state. Anything it cannot confirm is reported `missing` — the caller
   * keeps those records journaled and retries on the next rotation.
   *
   * Fails closed: an unavailable or non-verifying projection reports every
   * planned id missing rather than evicting on unproven coverage.
   */
  readonly verifyPersisted = async (
    plan: HistoryRotationPlan,
  ): Promise<BrokerPersistenceVerification> => {
    const allMissing = (): BrokerPersistenceVerification => ({
      present: emptyHistoryRotationPlan(),
      missing: {
        messageIds: new Set(plan.messageIds),
        invocationIds: new Set(plan.invocationIds),
        flightIds: new Set(plan.flightIds),
        deliveryIds: new Set(plan.deliveryIds),
        deliveryAttemptIds: new Set(plan.deliveryAttemptIds),
        collaborationEventIds: new Set(plan.collaborationEventIds),
      },
    });
    if (
      this.projectionWritesAbandoned
      || this.options.deferProjection?.()
      || !this.options.projection.verifyPersisted
    ) {
      return allMissing();
    }
    await this.projectionWriteQueue.catch(() => {});
    await this.options.projection.flush?.().catch(() => {});
    const verification = await this.options.projection.verifyPersisted(plan);
    // The contract: present and missing partition the plan — an overlapping
    // or unanswered id means the verifier's answer is untrustworthy; throw
    // inside the writer rather than evict on it.
    assertRotationPlanPartition(plan, verification.present, verification.missing);
    return verification;
  };

  private readonly projectEntries = async (entries: BrokerJournalEntry[]): Promise<void> => {
    try {
      const threadEventEnvelopes = await this.options.projection.applyEntries(entries);
      if (!this.projectionWritesAbandoned && threadEventEnvelopes.length > 0) {
        this.options.threadEvents.publish(threadEventEnvelopes);
      }
    } catch (error) {
      this.projectionQueueFailures += 1;
      throw error;
    } finally {
      this.options.memoryMaintenance?.projected(entries);
    }
  };
}
