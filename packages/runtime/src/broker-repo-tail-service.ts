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
  type TailEventKind,
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
  readRecentLiveEvents: (
    limit: number,
    options?: { kinds?: TailEventKind[] },
  ) => Promise<TailEvent[]>;
  readRecentTranscriptEvents: (
    limit: number,
    options?: {
      discovery?: DiscoverySnapshot | null;
      perTranscriptLineLimit?: number;
      kinds?: TailEventKind[];
      perTranscriptKindLimit?: number;
    },
  ) => Promise<TailEvent[]>;
  repoWatchServeCacheTtlMs: number;
  repoWatchRehydrateAfterMs: number;
  /**
   * Serve-cache TTL for `/v1/tail/recent?transcripts=1`. The transcript replay
   * phase re-reads up to dozens of transcripts per call and can take seconds on
   * a busy machine; without a TTL every poll pays that cost again and the
   * requests queue behind each other. 0 disables caching (test default).
   */
  tailRecentServeCacheTtlMs?: number;
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

const TAIL_RECENT_ASSISTANT_REPLIES_MODE = "assistant-replies";

function isAssistantRepliesMode(url: URL): boolean {
  return url.searchParams.get("mode") === TAIL_RECENT_ASSISTANT_REPLIES_MODE;
}

function tailEventMessageRole(event: TailEvent): string | null {
  if (!event.raw || typeof event.raw !== "object" || Array.isArray(event.raw)) return null;
  const payload = (event.raw as Record<string, unknown>).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const role = (payload as Record<string, unknown>).role;
  return typeof role === "string" ? role.trim().toLowerCase() : null;
}

function isApprovalReviewerDecision(summary: string): boolean {
  const trimmed = summary.trim();
  if (!trimmed.startsWith("{")) return false;
  if (
    trimmed.startsWith('{"risk_level":')
    && trimmed.includes('"user_authorization":')
    && trimmed.includes('"outcome":')
    && trimmed.includes('"rationale":')
  ) {
    return true;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof parsed.risk_level === "string"
      && typeof parsed.user_authorization === "string"
      && typeof parsed.outcome === "string"
      && typeof parsed.rationale === "string";
  } catch {
    return false;
  }
}

/** Keep only user-facing harness output for the Projects control-plane inbox. */
function isAssistantReply(event: TailEvent): boolean {
  if (event.kind !== "assistant") return false;
  const summary = event.summary.trim();
  if (!summary || /^\[(?:assistant|message)\]$/iu.test(summary)) return false;
  const role = tailEventMessageRole(event);
  if (role && role !== "assistant") return false;
  return !isApprovalReviewerDecision(summary);
}

function assistantReplySessionKey(event: TailEvent): string {
  const source = event.source.trim().toLowerCase();
  const sessionId = event.sessionId.trim();
  return source && sessionId ? `${source}\u0000${sessionId}` : `event\u0000${event.id}`;
}

/** Collapse streaming fragments/history to the latest reply per harness session. */
function latestAssistantReplies(events: Iterable<TailEvent>): TailEvent[] {
  const latestBySession = new Map<string, TailEvent>();
  for (const event of events) {
    if (!isAssistantReply(event)) continue;
    const key = assistantReplySessionKey(event);
    const current = latestBySession.get(key);
    if (
      !current
      || event.ts > current.ts
      || (event.ts === current.ts && event.id.localeCompare(current.id) > 0)
    ) {
      latestBySession.set(key, event);
    }
  }
  return [...latestBySession.values()];
}

function booleanQuery(url: URL, key: string): boolean {
  return url.searchParams.get(key) === "1" || url.searchParams.get(key) === "true";
}

export class BrokerRepoTailService<TBrokerSnapshot> {
  private repoWatchWarmInFlight: Promise<unknown> | null = null;
  private tailRecentCache: {
    key: string;
    result: TimedTailRecentPayload;
    expiresAtMs: number;
  } | null = null;
  private tailRecentInFlight: { key: string; promise: Promise<TimedTailRecentPayload> } | null = null;
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
    const cacheTtlMs = this.options.tailRecentServeCacheTtlMs ?? 0;
    const cacheKey = `${parseTailLimit(url)}:${url.searchParams.get("transcripts") === "true"
      || url.searchParams.get("transcripts") === "1"}:${isAssistantRepliesMode(url) ? TAIL_RECENT_ASSISTANT_REPLIES_MODE : "all"}`;
    const now = this.now();
    if (cacheTtlMs > 0 && this.tailRecentCache?.key === cacheKey && this.tailRecentCache.expiresAtMs > now) {
      const cached = this.tailRecentCache;
      return {
        payload: {
          ...cached.result.payload,
          events: [...cached.result.payload.events],
        },
        timings: [
          ...cached.result.timings,
          { name: "tail-serve-cache", dur: Math.max(0, now - (cached.expiresAtMs - cacheTtlMs)) },
        ],
      };
    }
    const inFlight = this.tailRecentInFlight;
    if (cacheTtlMs > 0 && inFlight && inFlight.key === cacheKey) return inFlight.promise;

    const request = (async () => {
      const result = await this.computeTailRecentPayloadWithTiming(url);
      if (cacheTtlMs > 0) {
        this.tailRecentCache = {
          key: cacheKey,
          result,
          expiresAtMs: this.now() + cacheTtlMs,
        };
      }
      return result;
    })();
    if (cacheTtlMs > 0) {
      this.tailRecentInFlight = { key: cacheKey, promise: request };
      try {
        return await request;
      } finally {
        if (this.tailRecentInFlight?.promise === request) this.tailRecentInFlight = null;
      }
    }
    return request;
  }

  private async computeTailRecentPayloadWithTiming(url: URL): Promise<TimedTailRecentPayload> {
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
    const assistantRepliesOnly = isAssistantRepliesMode(url);
    const kinds: TailEventKind[] | undefined = assistantRepliesOnly ? ["assistant"] : undefined;
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
            kinds,
            ...(assistantRepliesOnly ? { perTranscriptKindLimit: 1 } : {}),
          },
        )),
      );
      for (const event of transcriptEvents) {
        eventsById.set(event.id, event);
      }
    }

    const mergeStart = performance.now();
    const bufferedEvents = filterTailEventsForDisplay(
      await measure("tail-live", () => this.options.readRecentLiveEvents(limit, { kinds })),
    );
    for (const event of bufferedEvents) {
      eventsById.set(event.id, event);
    }

    const candidates = assistantRepliesOnly
      ? latestAssistantReplies(eventsById.values())
      : [...eventsById.values()];
    const events = candidates
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

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async readTailRecentPayload(url: URL): Promise<TailRecentPayload> {
    return (await this.readTailRecentPayloadWithTiming(url)).payload;
  }

}
