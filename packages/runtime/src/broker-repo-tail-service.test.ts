import { describe, expect, test } from "bun:test";

import type {
  RepoWatchPathHint,
  RepoWatchSnapshot,
  RepoWatchSnapshotOptions,
} from "./repo-watch/index.js";
import {
  BrokerRepoTailService,
  parsePositiveIntParam,
  parseTailLimit,
} from "./broker-repo-tail-service.js";
import type {
  DiscoverySnapshot,
  TailEvent,
} from "./tail/index.js";

type BrokerSnapshot = {
  id: string;
};

function repoSnapshot(input: Partial<RepoWatchSnapshot> = {}): RepoWatchSnapshot {
  return {
    generatedAt: 1_000,
    projects: [],
    totals: {
      projects: 0,
      worktrees: 0,
      dirtyWorktrees: 0,
      conflictedWorktrees: 0,
      attentionWorktrees: 0,
      attachedAgents: 0,
      attachedSessions: 0,
    },
    warnings: [],
    ...input,
  };
}

function discoverySnapshot(): DiscoverySnapshot {
  return {
    generatedAt: 1_000,
    processes: [],
    transcripts: [],
    totals: {
      total: 0,
      scoutManaged: 0,
      hudsonManaged: 0,
      unattributed: 0,
      transcripts: 0,
    },
  };
}

function tailEvent(input: Partial<TailEvent> & { id: string; ts: number }): TailEvent {
  return {
    source: "codex",
    sessionId: "session-1",
    pid: 1,
    parentPid: null,
    project: "openscout",
    cwd: "/tmp/openscout",
    harness: "scout-managed",
    kind: "assistant",
    summary: input.id,
    ...input,
  };
}

function createHarness(input: {
  repoSnapshots?: RepoWatchSnapshot[];
  liveEvents?: TailEvent[];
  transcriptEvents?: TailEvent[];
  repoWatchReject?: Error;
  now?: number;
} = {}) {
  const repoWatchCalls: RepoWatchSnapshotOptions[] = [];
  const warnings: string[] = [];
  let repoSnapshotIndex = 0;
  let liveLimit: number | null = null;
  let transcriptRequest: { limit: number; perTranscriptLineLimit?: number } | null = null;
  const service = new BrokerRepoTailService<BrokerSnapshot>({
    readBrokerSnapshot: async () => ({ id: "snapshot-1" }),
    async getRepoWatchSnapshot(options = {}) {
      repoWatchCalls.push(options);
      if (input.repoWatchReject) {
        throw input.repoWatchReject;
      }
      const snapshots = input.repoSnapshots ?? [repoSnapshot()];
      return snapshots[Math.min(repoSnapshotIndex++, snapshots.length - 1)] ?? repoSnapshot();
    },
    repoWatchHintsFromBrokerSnapshot: () => [{
      path: "/repo/from-broker",
      source: "agent",
      agentId: "agent-1",
    }],
    repoWatchHintsFromTailDiscovery: () => [{
      path: "/repo/from-tail",
      source: "tail-process",
      sessionId: "session-1",
    }],
    getTailDiscovery: async () => discoverySnapshot(),
    readRecentLiveEvents: async (limit) => {
      liveLimit = limit;
      return input.liveEvents ?? [];
    },
    readRecentTranscriptEvents: async (limit, options) => {
      transcriptRequest = {
        limit,
        perTranscriptLineLimit: options?.perTranscriptLineLimit,
      };
      return input.transcriptEvents ?? [];
    },
    repoWatchServeCacheTtlMs: 60_000,
    repoWatchRehydrateAfterMs: 30_000,
    warn: (message) => warnings.push(message),
    now: () => input.now ?? 100_000,
  });

  return {
    get liveLimit() {
      return liveLimit;
    },
    get transcriptRequest() {
      return transcriptRequest;
    },
    repoWatchCalls,
    service,
    warnings,
  };
}

describe("BrokerRepoTailService", () => {
  test("parses bounded positive integer query parameters", () => {
    expect(parseTailLimit(new URL("http://test/tail"))).toBe(500);
    expect(parseTailLimit(new URL("http://test/tail?limit=-1"))).toBe(500);
    expect(parseTailLimit(new URL("http://test/tail?limit=2000"))).toBe(2_000);
    expect(parseTailLimit(new URL("http://test/tail?limit=20000"))).toBe(10_000);
    expect(parsePositiveIntParam(new URL("http://test/repo?maxRoots=300"), "maxRoots", 128)).toBe(128);
    expect(parsePositiveIntParam(new URL("http://test/repo?maxRoots=0"), "maxRoots", 128)).toBeUndefined();
  });

  test("reads repo watch snapshots from URL options and includes tail hints", async () => {
    const harness = createHarness({ now: 10_000 });

    await harness.service.readRepoWatchSnapshotForUrl(new URL(
      "http://test/v1/repo-watch/snapshot?includeTail=1&includeDiff=true&includeLastCommit=1&native=false&maxRoots=12&maxWorktrees=3&maxFilesPerWorktree=55&scanBudgetMs=222",
    ));

    expect(harness.repoWatchCalls).toEqual([
      expect.objectContaining({
        force: false,
        includeDiff: true,
        includeLastCommit: true,
        useNativeRepoService: false,
        maxRoots: 12,
        maxWorktrees: 3,
        maxFilesPerWorktree: 55,
        scanBudgetMs: 222,
        cacheTtlMs: 60_000,
        hints: expect.arrayContaining<RepoWatchPathHint>([
          expect.objectContaining({ path: "/repo/from-broker", source: "agent" }),
          expect.objectContaining({ path: "/repo/from-tail", source: "tail-process" }),
        ]),
      }),
    ]);
  });

  test("deduplicates warm requests and reports warm failures", async () => {
    const harness = createHarness({
      repoWatchReject: new Error("boom"),
    });

    const first = harness.service.warmRepoWatchSnapshot("test");
    const second = harness.service.warmRepoWatchSnapshot("test");
    expect(first).toBe(second);
    await first;

    expect(harness.repoWatchCalls).toHaveLength(1);
    expect(harness.repoWatchCalls[0]).toEqual(expect.objectContaining({
      force: true,
      includeDiff: true,
      includeLastCommit: true,
    }));
    expect(harness.warnings).toEqual([
      "[openscout-runtime] repo-watch test warm failed: boom",
    ]);
  });

  test("schedules stale repo-watch rehydrate in the background", async () => {
    const harness = createHarness({
      repoSnapshots: [
        repoSnapshot({ generatedAt: 1_000 }),
        repoSnapshot({ generatedAt: 100_000 }),
      ],
      now: 100_000,
    });

    await harness.service.readRepoWatchSnapshotForUrl(new URL("http://test/v1/repo-watch/snapshot?includeDiff=1"));
    await Promise.resolve();

    expect(harness.repoWatchCalls).toHaveLength(2);
    expect(harness.repoWatchCalls[0]).toEqual(expect.objectContaining({
      force: false,
      includeDiff: true,
      cacheTtlMs: 60_000,
    }));
    expect(harness.repoWatchCalls[1]).toEqual(expect.objectContaining({
      force: true,
      includeDiff: true,
      includeLastCommit: false,
    }));
  });

  test("merges recent live and transcript tail events by id and timestamp", async () => {
    const harness = createHarness({
      liveEvents: [
        tailEvent({ id: "b", ts: 20, summary: "live b" }),
        tailEvent({ id: "same", ts: 30, summary: "live wins" }),
      ],
      transcriptEvents: [
        tailEvent({ id: "a", ts: 10, summary: "transcript a" }),
        tailEvent({ id: "same", ts: 25, summary: "transcript replaced" }),
      ],
      now: 42_000,
    });

    const payload = await harness.service.readTailRecentPayload(
      new URL("http://test/v1/tail/recent?limit=2&transcripts=1"),
    );

    expect(harness.liveLimit).toBe(2);
    expect(harness.transcriptRequest).toEqual({
      limit: 800,
      perTranscriptLineLimit: 50,
    });
    expect(payload).toEqual({
      generatedAt: 42_000,
      limit: 2,
      cursor: "same",
      events: [
        expect.objectContaining({ id: "b", summary: "live b" }),
        expect.objectContaining({ id: "same", summary: "live wins" }),
      ],
    });
  });

  test("keeps Cursor process samples out of the presented tail only", async () => {
    const harness = createHarness({
      liveEvents: [
        tailEvent({
          id: "cursor-sample",
          ts: 10,
          source: "cursor",
          kind: "system",
          summary: "process sample · openscout, vox",
          raw: { rows: [{ processName: "Cursor Helper openscout" }] },
        }),
        tailEvent({
          id: "cursor-activity",
          ts: 20,
          source: "cursor",
          kind: "system",
          summary: "agent process exited",
        }),
      ],
      now: 42_000,
    });

    const payload = await harness.service.readTailRecentPayload(
      new URL("http://test/v1/tail/recent?limit=50"),
    );

    expect(payload.events.map((event) => event.id)).toEqual(["cursor-activity"]);
  });
});
