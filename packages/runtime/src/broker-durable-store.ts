import type {
  ThreadEventEnvelope,
} from "@openscout/protocol";

import type { BrokerJournalEntry } from "./broker-journal.js";

export type BrokerJournalWriter = {
  appendEntries(entries: BrokerJournalEntry[]): Promise<BrokerJournalEntry[]>;
};

export type BrokerProjectionWriter = {
  applyEntries(entries: BrokerJournalEntry[]): Promise<ThreadEventEnvelope[]>;
};

export type BrokerThreadEventPublisher = {
  publish(events: ThreadEventEnvelope[]): void;
};

export type BrokerDurableStoreOptions = {
  journal: BrokerJournalWriter;
  projection: BrokerProjectionWriter;
  threadEvents: BrokerThreadEventPublisher;
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
    await applyRuntime(entries);
    if (options.enqueueProjection !== false) {
      await this.applyProjectedEntries(entries);
    }
    return entries;
  };

  readonly applyProjectedEntries = async (
    entriesInput: BrokerJournalEntry | BrokerJournalEntry[],
  ): Promise<void> => {
    const entries = normalizeBrokerJournalEntries(entriesInput);
    if (entries.length === 0 || this.projectionWritesAbandoned) {
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

  private readonly projectEntries = async (entries: BrokerJournalEntry[]): Promise<void> => {
    const threadEventEnvelopes = await this.options.projection.applyEntries(entries);
    if (!this.projectionWritesAbandoned && threadEventEnvelopes.length > 0) {
      this.options.threadEvents.publish(threadEventEnvelopes);
    }
  };
}
