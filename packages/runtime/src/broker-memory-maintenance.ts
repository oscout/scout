import type { BrokerJournalEntry } from './broker-journal.js';

type MaintenanceOptions = {
  collect?: () => void;
  now?: () => number;
  replayWorkBytes?: number;
  liveWorkRecords?: number;
  liveWorkBytes?: number;
};

/** Opt-in allocation maintenance, not a hard process-memory limit. Work budgets
 * schedule collection without idle timers; native footprint remains the gate. */
export class BrokerMemoryMaintenance {
  private readonly replayBudget: number;
  private readonly liveBudget: number;
  private readonly liveByteBudget: number;
  private readonly now: () => number;
  private liveWork = 0;
  private liveBytes = 0;
  // Keys are the already-owned in-flight batch arrays, never historical records.
  private readonly encodedBatchBytes = new WeakMap<readonly BrokerJournalEntry[], number>();
  private projectionWork = 0;
  private projectionBytes = 0;
  private snapshotBytes = 0;
  private snapshotCollections = 0;
  private collections = 0;
  private replayCollections = 0;
  private liveCollections = 0;
  private projectionCollections = 0;
  private totalMs = 0;
  private maxMs = 0;
  private failure: string | null = null;

  constructor(private readonly options: MaintenanceOptions) {
    this.replayBudget = options.replayWorkBytes ?? 2 * 1024 * 1024;
    this.liveBudget = options.liveWorkRecords ?? 256;
    this.liveByteBudget = options.liveWorkBytes ?? 256 * 1024;
    for (const budget of [this.replayBudget, this.liveBudget, this.liveByteBudget]) {
      if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Memory maintenance work budgets must be positive safe integers');
    }
    this.now = options.now ?? (() => performance.now());
  }

  beginReplay(): { add(bytes: number): void; finish(): void } {
    let work = 0;
    let finished = false;
    return {
      add: (bytes) => {
        if (finished || !Number.isFinite(bytes) || bytes <= 0) return;
        work = Math.min(Number.MAX_SAFE_INTEGER, work + bytes);
        if (work >= this.replayBudget) { this.collect('replay'); work = 0; }
      },
      finish: () => {
        if (finished) return;
        finished = true;
        if (work > 0) this.collect('replay');
        work = 0;
      },
    };
  }

  accepted(entries: readonly BrokerJournalEntry[], encodedBytes = 0): void {
    if (Number.isFinite(encodedBytes) && encodedBytes > 0) {
      this.liveBytes = Math.min(Number.MAX_SAFE_INTEGER, this.liveBytes + encodedBytes);
      if (entries.length > 0) this.encodedBatchBytes.set(entries, encodedBytes);
    }
    for (const entry of entries) {
      this.liveWork = Math.min(Number.MAX_SAFE_INTEGER,
        this.liveWork + (entry.kind === 'deliveries.record' ? entry.deliveries.length : 1));
    }
    if (this.liveWork >= this.liveBudget || this.liveBytes >= this.liveByteBudget) {
      this.collect('live'); this.liveWork = 0; this.liveBytes = 0;
    }
  }

  /** Charge the asynchronous projection where its allocations actually finish. */
  projected(entries: readonly BrokerJournalEntry[]): void {
    this.projectionBytes = Math.min(Number.MAX_SAFE_INTEGER, this.projectionBytes + (this.encodedBatchBytes.get(entries) ?? 0));
    this.encodedBatchBytes.delete(entries);
    for (const entry of entries) {
      this.projectionWork = Math.min(Number.MAX_SAFE_INTEGER,
        this.projectionWork + (entry.kind === 'deliveries.record' ? entry.deliveries.length : 1));
    }
    if (this.projectionWork >= this.liveBudget || this.projectionBytes >= this.liveByteBudget) {
      this.collect('projection'); this.projectionWork = 0; this.projectionBytes = 0;
    }
  }

  /** Process-wide encoded output work, shared across concurrent snapshots. */
  snapshotEncoded(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.snapshotBytes = Math.min(Number.MAX_SAFE_INTEGER, this.snapshotBytes + bytes);
    if (this.snapshotBytes >= this.replayBudget) {
      this.collect('snapshot'); this.snapshotBytes = 0;
    }
  }

  status() {
    return {
      enabled: true,
      available: Boolean(this.options.collect) && this.failure === null,
      replayWorkBudgetBytes: this.replayBudget,
      liveWorkBudgetRecords: this.liveBudget,
      liveWorkBudgetBytes: this.liveByteBudget,
      collections: this.collections,
      replayCollections: this.replayCollections,
      liveCollections: this.liveCollections,
      projectionCollections: this.projectionCollections,
      snapshotCollections: this.snapshotCollections,
      snapshotWorkBudgetBytes: this.replayBudget,
      totalMs: this.totalMs,
      maxMs: this.maxMs,
      failure: this.failure,
    };
  }

  private collect(reason: 'replay' | 'live' | 'projection' | 'snapshot'): void {
    if (!this.options.collect || this.failure !== null) return;
    // A failed optional collector must never turn an accepted durable write
    // into an apparent rejection, or poison the canonical writer queue.
    try {
      const start = this.now();
      this.options.collect();
      const duration = Math.max(0, this.now() - start);
      this.collections++;
      if (reason === 'replay') this.replayCollections++;
      else if (reason === 'live') this.liveCollections++;
      else if (reason === 'projection') this.projectionCollections++;
      else this.snapshotCollections++;
      this.totalMs += duration;
      this.maxMs = Math.max(this.maxMs, duration);
    } catch (error) {
      this.failure = (error instanceof Error ? error.message : String(error)).slice(0, 256);
    }
  }
}

export function memoryMaintenanceFromEnv(env: Record<string, string | undefined>): BrokerMemoryMaintenance | undefined {
  if (env.OPENSCOUT_BROKER_MEMORY_MAINTENANCE !== '1') return undefined;
  return new BrokerMemoryMaintenance({ collect: typeof Bun === 'undefined' ? undefined : () => { Bun.gc(true); } });
}
