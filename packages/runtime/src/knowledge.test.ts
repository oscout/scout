import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deterministicKnowledgeChunkId,
  knowledgeCollectionQmdPath,
  resolveOpenScoutKnowledgePaths,
  SQLiteKnowledgeStore,
  type KnowledgeCollection,
  type KnowledgeDocument,
  type KnowledgeSourceRef,
} from "./knowledge/index.ts";

const roots = new Set<string>();
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
  if (originalControlHome === undefined) delete process.env.OPENSCOUT_CONTROL_HOME;
  else process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
  if (originalSupportDirectory === undefined) delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  else process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

function useTempSupportPaths(): ReturnType<typeof resolveOpenScoutKnowledgePaths> {
  const root = tempRoot("openscout-knowledge-");
  process.env.OPENSCOUT_CONTROL_HOME = join(root, "control-plane");
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(root, "support");
  return resolveOpenScoutKnowledgePaths();
}

function sourceRef(): KnowledgeSourceRef {
  return {
    kind: "harness_transcript",
    harness: "codex",
    path: {
      root: "HOME",
      relPath: ".codex/sessions/2026/06/session.jsonl",
    },
    sessionId: "session-1",
    recordRange: [1, 12],
    anchor: {
      sizeBytes: 1234,
      mtimeMs: 1780000000000,
      contentHash: "sha256:source",
    },
  };
}

function collection(paths: ReturnType<typeof resolveOpenScoutKnowledgePaths>): KnowledgeCollection {
  return {
    id: "sessions/codex/session-1",
    kind: "sessions",
    title: "Codex session 1",
    sourceRefs: [sourceRef()],
    qmdPath: join(paths.qmdRoot, "sessions", "codex", "session-1"),
    status: "ready",
    contentHash: "sha256:collection",
    extractorVersion: "test-extractor-v1",
    chunkPolicyVersion: "test-policy-v1",
    createdAt: 1780000000000,
    updatedAt: 1780000000001,
    facets: {
      harness: "codex",
      project: "openscout",
    },
  };
}

function document(collectionId: string): KnowledgeDocument {
  return {
    id: "doc-session-1-overview",
    collectionId,
    path: "overview.md",
    kind: "overview",
    origin: "mechanical",
    contentHash: "sha256:document",
  };
}

describe("knowledge paths", () => {
  test("resolve under OPENSCOUT_CONTROL_HOME and reject escaping collection ids", () => {
    const paths = useTempSupportPaths();
    expect(paths.knowledgeRoot).toEndWith("control-plane/knowledge");
    expect(paths.qmdRoot).toEndWith("control-plane/knowledge/qmd");
    expect(paths.sqlitePath).toEndWith("control-plane/knowledge/knowledge.sqlite");

    const collectionPath = knowledgeCollectionQmdPath("sessions/codex/session-1");
    expect(collectionPath).toBe(join(paths.qmdRoot, "sessions", "codex", "session-1"));
    expect(() => knowledgeCollectionQmdPath("sessions/../escape")).toThrow("invalid collectionId segment");
  });
});

describe("SQLiteKnowledgeStore", () => {
  test("stores collections, stable chunks, lexical search hits, and job status", () => {
    const paths = useTempSupportPaths();
    const store = new SQLiteKnowledgeStore(undefined, paths);
    try {
      const storedCollection = collection(paths);
      const storedDocument = document(storedCollection.id);
      store.upsertCollection(storedCollection);
      store.upsertDocument(storedDocument);

      const text = "This session discussed QMD knowledge indexing, broker APIs, and raw transcript drilldown.";
      const chunkId = deterministicKnowledgeChunkId({
        collectionId: storedCollection.id,
        documentPath: storedDocument.path,
        ordinal: 1,
        chunkPolicyVersion: storedCollection.chunkPolicyVersion,
        text,
      });
      const chunkIdAgain = deterministicKnowledgeChunkId({
        collectionId: storedCollection.id,
        documentPath: storedDocument.path,
        ordinal: 1,
        chunkPolicyVersion: storedCollection.chunkPolicyVersion,
        text,
      });
      expect(chunkIdAgain).toBe(chunkId);

      store.upsertChunk({
        id: chunkId,
        collectionId: storedCollection.id,
        documentId: storedDocument.id,
        documentPath: storedDocument.path,
        ordinal: 1,
        text,
        textHash: "sha256:text",
        origin: "mechanical",
        ownership: "derived",
        sourceRefs: [sourceRef()],
        facets: {
          harness: "codex",
          project: "openscout",
        },
      });

      const hits = store.searchLexical({ q: "QMD", limit: 5 });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.chunkId).toBe(chunkId);
      expect(hits[0]?.origin).toBe("mechanical");
      expect(hits[0]?.ownership).toBe("derived");
      expect(hits[0]?.drilldown.map((entry) => entry.kind)).toContain("qmd");
      expect(hits[0]?.drilldown.map((entry) => entry.kind)).toContain("harness_transcript");

      const job = store.createIndexJob({ source: "sessions", days: 7 });
      const running = store.updateIndexJob({
        id: job.id,
        state: "running",
        leaseOwner: "test-worker",
        leaseGeneration: 1,
        progress: { discovered: 1, extracted: 1 },
      });
      expect(running?.state).toBe("running");
      expect(running?.leaseGeneration).toBe(1);

      const status = store.status();
      expect(status.collections).toBe(1);
      expect(status.readyCollections).toBe(1);
      expect(status.chunks).toBe(1);
      expect(status.activeJobs.map((activeJob) => activeJob.id)).toContain(job.id);
      expect(status.paths.sqlitePath).toBe(paths.sqlitePath);

      // Readonly path must not require a writable open (and must see WAL data).
      const readonly = new SQLiteKnowledgeStore(undefined, paths, { readonly: true });
      try {
        expect(readonly.status().chunks).toBe(1);
        expect(readonly.searchLexical({ q: "broker", limit: 3 })).toHaveLength(1);
      } finally {
        readonly.close();
      }
    } finally {
      store.close();
    }
  });

  test("warm spans make query coverage distinguish not-warmed from empty matches", () => {
    const paths = useTempSupportPaths();
    const store = new SQLiteKnowledgeStore(undefined, paths);
    try {
      expect(store.assessCoverage({ source: "sessions", harness: "kimi", lookbackMs: 12 * 3600_000 }).kind)
        .toBe("empty_index");

      store.recordWarmSpan({
        source: "sessions",
        harness: "claude",
        lookbackMs: 3 * 24 * 3600_000,
        cutoffMs: Date.now() - 3 * 24 * 3600_000,
        completedAt: Date.now(),
        jobId: "job-claude",
        discovered: 2,
        indexed: 2,
        failed: 0,
      });

      // Global chunks still zero, but a warm span exists — not empty_index; kimi still not covered.
      const notKimi = store.assessCoverage({ source: "sessions", harness: "kimi", lookbackMs: 12 * 3600_000 });
      expect(notKimi.kind).toBe("not_warmed");
      if (notKimi.kind === "not_warmed") {
        expect(notKimi.suggestion).toContain("--harness kimi");
        expect(notKimi.suggestion).toContain("--hours 12");
      }

      store.recordWarmSpan({
        source: "sessions",
        harness: "kimi",
        lookbackMs: 12 * 3600_000,
        cutoffMs: Date.now() - 12 * 3600_000,
        completedAt: Date.now(),
        jobId: "job-kimi",
        discovered: 4,
        indexed: 4,
        failed: 0,
      });
      // Insert a chunk so empty_index does not short-circuit solely on span presence.
      const storedCollection = collection(paths);
      store.upsertCollection(storedCollection);
      store.upsertDocument(document(storedCollection.id));
      store.upsertChunk({
        id: "chunk-coverage",
        collectionId: storedCollection.id,
        documentId: "doc-session-1-overview",
        documentPath: "overview.md",
        ordinal: 1,
        text: "coverage probe chunk about nothing particular",
        textHash: "sha256:coverage",
        origin: "mechanical",
        ownership: "derived",
        sourceRefs: [sourceRef()],
        facets: { harness: "kimi" },
      });

      const warmed = store.assessCoverage({ source: "sessions", harness: "kimi", lookbackMs: 12 * 3600_000 });
      expect(warmed.kind).toBe("warmed");
      if (warmed.kind === "warmed") {
        expect(warmed.stale).toBe(false);
        expect(warmed.spans.some((span) => span.harness === "kimi")).toBe(true);
      }

      // Asking for a longer lookback than any span claimed → not warmed.
      const tooLong = store.assessCoverage({ source: "sessions", harness: "kimi", lookbackMs: 48 * 3600_000 });
      expect(tooLong.kind).toBe("not_warmed");

      // Zero-overlap: query window entirely after the scan finished → not warmed.
      // Use a dedicated harness so an earlier fresh kimi span does not cover it.
      store.recordWarmSpan({
        source: "sessions",
        harness: "grok",
        lookbackMs: 12 * 3600_000,
        cutoffMs: Date.now() - 20 * 3600_000,
        completedAt: Date.now() - 5 * 3600_000,
        jobId: "job-grok-stale-window",
        discovered: 2,
        indexed: 2,
        failed: 0,
      });
      const zeroOverlap = store.assessCoverage({
        source: "sessions",
        harness: "grok",
        lookbackMs: 1 * 3600_000,
      });
      expect(zeroOverlap.kind).toBe("not_warmed");

      // All-failed warm is not coverage.
      store.recordWarmSpan({
        source: "sessions",
        harness: "pi",
        lookbackMs: 12 * 3600_000,
        cutoffMs: Date.now() - 12 * 3600_000,
        completedAt: Date.now(),
        jobId: "job-pi-failed",
        discovered: 5,
        indexed: 0,
        failed: 5,
      });
      expect(store.assessCoverage({ source: "sessions", harness: "pi", lookbackMs: 12 * 3600_000 }).kind)
        .toBe("not_warmed");

      // Empty scan (discovered=0) still covers — we walked the root and found nothing.
      store.recordWarmSpan({
        source: "sessions",
        harness: "codex",
        lookbackMs: 12 * 3600_000,
        cutoffMs: Date.now() - 12 * 3600_000,
        completedAt: Date.now(),
        jobId: "job-codex-empty",
        discovered: 0,
        indexed: 0,
        failed: 0,
      });
      expect(store.assessCoverage({ source: "sessions", harness: "codex", lookbackMs: 12 * 3600_000 }).kind)
        .toBe("warmed");

      expect(store.status().warmSpans?.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  test("searchLexical prefers AND precision and falls back to OR on zero rows", () => {
    const paths = useTempSupportPaths();
    const store = new SQLiteKnowledgeStore(undefined, paths);
    try {
      const storedCollection = collection(paths);
      store.upsertCollection(storedCollection);
      store.upsertDocument(document(storedCollection.id));
      store.upsertChunk({
        id: "chunk-and-or",
        collectionId: storedCollection.id,
        documentId: "doc-session-1-overview",
        documentPath: "overview.md",
        ordinal: 1,
        text: "iOS simulator build completed successfully with xcodebuild",
        textHash: "sha256:and-or",
        origin: "mechanical",
        ownership: "derived",
        sourceRefs: [sourceRef()],
        facets: { harness: "kimi" },
      });

      // All significant tokens present → AND path.
      expect(store.searchLexical({ q: "iOS xcodebuild", limit: 5 })).toHaveLength(1);
      // One rare/absent token ("steps") would fail AND; OR fallback still hits.
      expect(store.searchLexical({ q: "iOS build steps", limit: 5 }).length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
