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
    if (entries.length === 0) {
      return;
    }

    const threadEventEnvelopes = await this.options.projection.applyEntries(entries);
    if (threadEventEnvelopes.length > 0) {
      this.options.threadEvents.publish(threadEventEnvelopes);
    }
  };
}
