import { performance } from "node:perf_hooks";

import type {
  RepoWatchPathHint,
  RepoWatchSnapshot,
  RepoWatchSnapshotOptions,
} from "./repo-watch/index.js";
import type { ServerTimingMetric } from "./broker-http-helpers.js";
import {
  filterTailEventsForDisplay,
  type DiscoverySnapshot,
  type TailEvent,
} from "./tail/index.js";

export type BrokerRepoWatchReadOptions = {
  force?: boolean;
  includeTail?: boolean;
  includeDiff?: boolean;
  includeLastCommit?: boolean;
  useNativeRepoService?: boolean;
  maxRoots?: number;
  maxWorktrees?: number;
  maxFilesPerWorktree?: number;
  scanBudgetMs?: number;
  cacheTtlMs?: number;
};

export type TailRecentPayload = {
  generatedAt: number;
  limit: number;
  cursor: string | null;
  events: TailEvent[];
};

export type TimedTailRecentPayload = {
  payload: TailRecentPayload;
  timings: ServerTimingMetric[];
};

export type BrokerRepoTailServiceOptions<TBrokerSnapshot> = {
  readBrokerSnapshot: () => Promise<TBrokerSnapshot>;
  getRepoWatchSnapshot: (options?: RepoWatchSnapshotOptions) => Promise<RepoWatchSnapshot>;
  repoWatchHintsFromBrokerSnapshot: (snapshot: TBrokerSnapshot) => RepoWatchPathHint[];
  repoWatchHintsFromTailDiscovery: (discovery: DiscoverySnapshot | null | undefined) => RepoWatchPathHint[];
  getTailDiscovery: (force?: boolean) => Promise<DiscoverySnapshot>;
  readRecentLiveEvents: (limit: number) => Promise<TailEvent[]>;
  readRecentTranscriptEvents: (
    limit: number,
    options?: {
      discovery?: DiscoverySnapshot | null;
      perTranscriptLineLimit?: number;
    },
  ) => Promise<TailEvent[]>;
  repoWatchServeCacheTtlMs: number;
  repoWatchRehydrateAfterMs: number;
  warn?: (message: string) => void;
  now?: () => number;
};

export function parseTailLimit(url: URL): number {
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "500", 10);
  if (!Number.isFinite(limit) || limit <= 0) return 500;
  return Math.min(limit, 10_000);
}

export function parsePositiveIntParam(url: URL, key: string, cap: number): number | undefined {
  const value = Number.parseInt(url.searchParams.get(key) ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(value, cap);
}

function booleanQuery(url: URL, key: string): boolean {
  return url.searchParams.get(key) === "1" || url.searchParams.get(key) === "true";
}

export class BrokerRepoTailService<TBrokerSnapshot> {
  private repoWatchWarmInFlight: Promise<unknown> | null = null;

  constructor(private readonly options: BrokerRepoTailServiceOptions<TBrokerSnapshot>) {}

  async readRepoWatchSnapshot(
    options: BrokerRepoWatchReadOptions = {},
  ): Promise<RepoWatchSnapshot> {
    const snapshot = await this.options.readBrokerSnapshot();
    const tailHints = options.includeTail
      ? this.options.repoWatchHintsFromTailDiscovery(await this.options.getTailDiscovery(false))
      : [];
    return this.options.getRepoWatchSnapshot({
      force: options.force,
      includeDiff: options.includeDiff,
      includeLastCommit: options.includeLastCommit,
      useNativeRepoService: options.useNativeRepoService,
      maxRoots: options.maxRoots,
      maxWorktrees: options.maxWorktrees,
      maxFilesPerWorktree: options.maxFilesPerWorktree,
      scanBudgetMs: options.scanBudgetMs,
      cacheTtlMs: options.cacheTtlMs,
      hints: [
        ...this.options.repoWatchHintsFromBrokerSnapshot(snapshot),
        ...tailHints,
      ],
    });
  }

  warmRepoWatchSnapshot(
    reason: string,
    options: BrokerRepoWatchReadOptions = {},
  ): Promise<unknown> {
    if (this.repoWatchWarmInFlight) return this.repoWatchWarmInFlight;
    this.repoWatchWarmInFlight = this.readRepoWatchSnapshot({
      includeTail: false,
      includeDiff: true,
      includeLastCommit: true,
      ...options,
      force: true,
    })
      .catch((error) => {
        this.options.warn?.(
          `[openscout-runtime] repo-watch ${reason} warm failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.repoWatchWarmInFlight = null;
      });
    return this.repoWatchWarmInFlight;
  }

  async readRepoWatchSnapshotForUrl(url: URL): Promise<RepoWatchSnapshot> {
    const force = booleanQuery(url, "force");
    const includeTail = booleanQuery(url, "includeTail");
    const includeDiff = booleanQuery(url, "includeDiff");
    const includeLastCommit = booleanQuery(url, "includeLastCommit");
    const nativeParam = url.searchParams.get("native");
    const useNativeRepoService = nativeParam == null
      ? undefined
      : nativeParam === "1" || nativeParam === "true";
    const maxRoots = parsePositiveIntParam(url, "maxRoots", 128);
    const maxWorktrees = parsePositiveIntParam(url, "maxWorktrees", 32);
    const maxFilesPerWorktree = parsePositiveIntParam(url, "maxFilesPerWorktree", 100);
    const scanBudgetMs = parsePositiveIntParam(url, "scanBudgetMs", 30_000);
    const cacheTtlMs = force ? undefined : this.options.repoWatchServeCacheTtlMs;
    const snapshot = await this.readRepoWatchSnapshot({
      force,
      includeDiff,
      includeLastCommit,
      useNativeRepoService,
      maxRoots,
      maxWorktrees,
      maxFilesPerWorktree,
      scanBudgetMs,
      includeTail,
      cacheTtlMs,
    });

    if (
      !force
      && Number.isFinite(this.options.repoWatchRehydrateAfterMs)
      && this.options.repoWatchRehydrateAfterMs > 0
      && this.now() - snapshot.generatedAt > this.options.repoWatchRehydrateAfterMs
    ) {
      void this.warmRepoWatchSnapshot("http-rehydrate", {
        includeTail,
        includeDiff,
        includeLastCommit,
        useNativeRepoService,
        maxRoots,
        maxWorktrees,
        maxFilesPerWorktree,
        scanBudgetMs,
      });
    }

    return snapshot;
  }

  async readTailRecentPayloadWithTiming(url: URL): Promise<TimedTailRecentPayload> {
    const timings: ServerTimingMetric[] = [];
    const measure = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        timings.push({ name, dur: performance.now() - start });
      }
    };
    const limit = parseTailLimit(url);
    const includeTranscripts = url.searchParams.get("transcripts") === "true"
      || url.searchParams.get("transcripts") === "1";
    const eventsById = new Map<string, TailEvent>();

    if (includeTranscripts) {
      const discovery = await measure("tail-discover", () => this.options.getTailDiscovery(false));
      const transcriptEvents = filterTailEventsForDisplay(
        await measure("tail-transcripts", () => this.options.readRecentTranscriptEvents(
          Math.max(limit, 800),
          {
            discovery,
            perTranscriptLineLimit: Math.min(200, Math.max(50, limit)),
          },
        )),
      );
      for (const event of transcriptEvents) {
        eventsById.set(event.id, event);
      }
    }

    const mergeStart = performance.now();
    const bufferedEvents = filterTailEventsForDisplay(
      await measure("tail-live", () => this.options.readRecentLiveEvents(limit)),
    );
    for (const event of bufferedEvents) {
      eventsById.set(event.id, event);
    }

    const events = [...eventsById.values()]
      .sort((left, right) => {
        if (left.ts === right.ts) return left.id.localeCompare(right.id);
        return left.ts - right.ts;
      })
      .slice(-limit);
    timings.push({ name: "tail-merge", dur: performance.now() - mergeStart });

    return {
      payload: {
        generatedAt: this.now(),
        limit,
        cursor: events.at(-1)?.id ?? null,
        events,
      },
      timings,
    };
  }

  async readTailRecentPayload(url: URL): Promise<TailRecentPayload> {
    return (await this.readTailRecentPayloadWithTiming(url)).payload;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
