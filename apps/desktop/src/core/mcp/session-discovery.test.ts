import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SQLiteKnowledgeStore, type KnowledgeSearchHit } from "@openscout/runtime";
import { registerSessionDiscoveryTools, sessionDiscoveryDependencies, type SessionDiscoveryDependencies } from "./session-discovery.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function clientFor(deps: SessionDiscoveryDependencies) {
  const server = new McpServer({ name: "test", version: "1" });
  registerSessionDiscoveryTools(server, deps);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}
const warmed = { kind: "warmed" as const, spans: [], stale: true, staleAfterMs: 1000 };
const hit: KnowledgeSearchHit = {
  id: "hit", collectionId: "collection", documentId: "doc", chunkId: "chunk", title: "Prior build",
  snippet: "xcodebuild failed", score: 1, scoreSource: "fts", origin: "mechanical", ownership: "derived", freshness: "stale",
  sourceRefs: [{ kind: "harness_transcript", harness: "codex", sessionId: "native-1", path: { root: "HOME", relPath: ".codex/sessions/example.jsonl" } }],
  drilldown: [], facets: { harness: "codex", project: "openscout" },
};
function dependencies(overrides: Partial<SessionDiscoveryDependencies> = {}): SessionDiscoveryDependencies {
  return { webOrigin: "http://localhost:43120", openStore: () => ({ assessCoverage: () => warmed, searchLexical: () => [hit], close() {} }), readInventory: async () => ({ sessions: [], terminals: [] }), ...overrides };
}
describe("Scoutbot read-only session tools", () => {
  test("unwarmed query never searches or loads inventory, and closes the read store", async () => {
    let closed = false;
    const client = await clientFor(dependencies({ openStore: () => ({ assessCoverage: () => ({ kind: "empty_index", suggestion: "scout search index --source sessions --days 3" }), searchLexical: () => { throw new Error("must not search"); }, close() { closed = true; } }), readInventory: async () => { throw new Error("must not load inventory"); } }));
    const result = await client.callTool({ name: "sessions_search", arguments: { query: "build" } });
    expect(result.structuredContent).toMatchObject({ mode: "lexical", coverage: { kind: "empty_index" }, results: [], inventoryStatus: "not_requested" });
    expect(closed).toBe(true);
  });
  test("a window deeper than the index narrows to what is warmed instead of returning nothing", async () => {
    // The index is only ever warmed to ~72h, but the schema invites up to 720h,
    // so "what did we do last week" used to come back structurally empty.
    const now = Date.now();
    const span = {
      id: "span-1", source: "sessions" as const, harness: "*", lookbackMs: 72 * 3_600_000,
      cutoffMs: now - 72 * 3_600_000, completedAt: now - 60_000, jobId: "job-1",
      discovered: 40, indexed: 40, failed: 0,
    };
    const asked: number[] = [];
    const client = await clientFor(dependencies({
      openStore: () => ({
        assessCoverage: (request = {}) => {
          asked.push(request.lookbackMs ?? 0);
          return (request.lookbackMs ?? 0) > span.lookbackMs
            ? { kind: "not_warmed", source: "sessions", harness: [], lookbackMs: request.lookbackMs, suggestion: "scout search index", nearestSpans: [span] }
            : { kind: "warmed", spans: [span], stale: false, staleAfterMs: 1000 };
        },
        searchLexical: () => [hit],
        close() {},
      }),
    }));
    const result = await client.callTool({ name: "sessions_search", arguments: { query: "xcodebuild", hours: 168 } });
    expect(asked).toEqual([168 * 3_600_000, 72 * 3_600_000]);
    expect(result.structuredContent).toMatchObject({
      coverage: { kind: "warmed" },
      requestedHours: 168,
      searchedHours: 72,
      narrowedToWarmedWindow: true,
    });
    expect((result.structuredContent as { results: unknown[] }).results).toHaveLength(1);
  });
  test("a window with nothing warmed behind it still reports not_warmed rather than inventing coverage", async () => {
    const now = Date.now();
    // Scanned 4h of history two days ago: every 4h-window hit predates the scan.
    const stale = {
      id: "span-2", source: "sessions" as const, harness: "*", lookbackMs: 4 * 3_600_000,
      cutoffMs: now - 52 * 3_600_000, completedAt: now - 48 * 3_600_000, jobId: "job-2",
      discovered: 5, indexed: 5, failed: 0,
    };
    const client = await clientFor(dependencies({
      openStore: () => ({
        assessCoverage: (request = {}) => ({ kind: "not_warmed", source: "sessions", harness: [], lookbackMs: request.lookbackMs, suggestion: "scout search index", nearestSpans: [stale] }),
        searchLexical: () => { throw new Error("must not search"); },
        close() {},
      }),
    }));
    const result = await client.callTool({ name: "sessions_search", arguments: { query: "xcodebuild", hours: 168 } });
    expect(result.structuredContent).toMatchObject({ coverage: { kind: "not_warmed" }, results: [], searchedHours: 168 });
    expect(result.structuredContent).not.toHaveProperty("narrowedToWarmedWindow");
  });
  test.each(["codex", "claude"])("uses real indexed coverage for %s without crossing harnesses or accepting failed scans", async (harness) => {
    const directory = mkdtempSync(join(tmpdir(), "scout-session-coverage-"));
    const store = new SQLiteKnowledgeStore(join(directory, "knowledge.sqlite"));
    const now = Date.now();
    try {
      for (const [indexedHarness, indexed] of [["codex", 2], ["claude", 0]] as const) {
        store.recordWarmSpan({ source: "sessions", harness: indexedHarness, lookbackMs: 72 * 3_600_000,
          cutoffMs: now - 72 * 3_600_000, completedAt: now - 60_000, jobId: `job-${indexedHarness}`,
          discovered: 2, indexed, failed: 2 - indexed });
      }
      let requested: Parameters<SQLiteKnowledgeStore["searchLexical"]>[0] | undefined;
      const client = await clientFor(dependencies({ openStore: () => ({
        assessCoverage: (request) => store.assessCoverage(request),
        searchLexical: (query) => { requested = query; return [hit]; },
        close() {},
      }) }));
      const result = await client.callTool({ name: "sessions_search", arguments: { query: "build", harness, project: "openscout", hours: 168 } });
      if (harness === "codex") {
        expect(result.structuredContent).toMatchObject({ requestedHours: 168, searchedHours: 72,
          narrowedToWarmedWindow: true, coverage: { kind: "warmed" }, results: [{ sessionId: "native-1" }] });
        expect(requested).toMatchObject({ facets: { harness: "codex", project: "openscout" } });
        expect(requested!.sourceUpdatedAfterMs).toBeGreaterThanOrEqual(now - 72 * 3_600_000);
        expect(requested!.sourceUpdatedAfterMs).toBeLessThanOrEqual(Date.now() - 72 * 3_600_000);
      } else {
        expect(result.structuredContent).toMatchObject({ coverage: { kind: "not_warmed" }, results: [] });
        expect(requested).toBeUndefined();
      }
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test("bounds queries before opening the store", async () => {
    let opened = false;
    const client = await clientFor(dependencies({ openStore: () => { opened = true; throw new Error("must not open"); } }));
    for (const args of [{ query: "build", limit: 21 }, { query: "build", hours: 721 }, { query: "x".repeat(301) }]) {
      expect((await client.callTool({ name: "sessions_search", arguments: args })).isError).toBe(true);
    }
    expect(opened).toBe(false);
  });
  test("preserves coverage and reports unknown liveness when canonical inventory is unavailable", async () => {
    const client = await clientFor(dependencies({ readInventory: async () => { throw new Error("offline"); } }));
    const result = await client.callTool({ name: "sessions_search", arguments: { query: "xcodebuild" } });
    expect(result.structuredContent).toMatchObject({ coverage: { kind: "warmed", stale: true }, inventoryStatus: "unavailable", results: [{ sessionId: "native-1", state: "unknown", actions: [] }] });
  });
  test("matches harness-native identity and only offers attach for observed live surfaces", async () => {
    const client = await clientFor(dependencies({ readInventory: async () => ({ sessions: [{ id: "conv-1", title: "Build", harness: "codex", sessionId: null, harnessSessionId: "native-1", workspaceRoot: "/project" }], terminals: [{ id: "ts-1", harness: "codex", sourceSessionId: "native-1", cwd: "/project", resumeCommand: "", createdAt: 1, updatedAt: 2, surfaces: [{ backend: "tmux", sessionName: "worker", paneId: null, attachCommand: [], observeCommand: null, relay: { backend: "tmux", sessionName: "worker" }, state: "live" }, { backend: "tmux", sessionName: "old", paneId: null, attachCommand: [], observeCommand: null, relay: { backend: "tmux", sessionName: "old" }, state: "exited" }] }] }) }));
    const result = await client.callTool({ name: "sessions_search", arguments: { query: "xcodebuild" } });
    const data = result.structuredContent as { results: Array<{ state: string; actions: Array<{ kind: string; url: string }> }> };
    expect(data.results[0]?.state).toBe("live_attachable");
    expect(data.results[0]?.actions).toHaveLength(2);
    expect(data.results[0]?.actions[0]?.url).toBe("http://localhost:43120/sessions/conv-1");
    expect(data.results[0]?.actions[1]?.url).toContain("/terminal/s/");
    expect(data.results[0]?.actions[1]?.url).toContain("session=ts-1");
  });
  test("passes bounded lexical facets and source date to the existing store", async () => {
    let requested: unknown;
    const client = await clientFor(dependencies({ openStore: () => ({ assessCoverage: () => warmed, searchLexical: (query) => { requested = query; return []; }, close() {} }) }));
    await client.callTool({ name: "sessions_search", arguments: { query: "build", project: "openscout", harness: "codex", hours: 12, limit: 3 } });
    expect(requested).toMatchObject({ q: "build", facets: { project: "openscout", harness: "codex" }, limit: 3, sourceKinds: ["sessions"], sourceUpdatedAfterMs: expect.any(Number) });
  });
  test("inventory keeps unknown surfaces non-attachable and applies literal query bounds", async () => {
    const client = await clientFor(dependencies({ readInventory: async () => ({ sessions: [], terminals: [
      { id: "ts-unknown", harness: "codex", sourceSessionId: "native-2", cwd: "/wanted", resumeCommand: "", createdAt: 1, updatedAt: 2, surfaces: [{ backend: "tmux", sessionName: "worker", paneId: null, attachCommand: [], observeCommand: null, relay: { backend: "tmux", sessionName: "worker" } }] },
      { id: "ts-other", harness: "codex", sourceSessionId: "native-3", cwd: "/other", resumeCommand: "", createdAt: 1, updatedAt: 2, surfaces: [] },
    ] }) }));
    const result = await client.callTool({ name: "sessions_inventory", arguments: { query: "wanted", limit: 1 } });
    expect(result.structuredContent).toMatchObject({ query: "wanted", truncated: false, results: [{ sessionId: "native-2", state: "unknown", actions: [] }] });
    expect((result.structuredContent as { results: unknown[] }).results).toHaveLength(1);
  });
  test("search failure still closes its read-only store", async () => {
    let closed = false;
    const client = await clientFor(dependencies({ openStore: () => ({ assessCoverage: () => warmed, searchLexical: () => { throw new Error("index unreadable"); }, close() { closed = true; } }) }));
    expect((await client.callTool({ name: "sessions_search", arguments: { query: "build" } })).isError).toBe(true);
    expect(closed).toBe(true);
  });

  test("inventory bootstraps local authentication on 401 and retries with its cookie", async () => {
    const reads: Array<{ path: string; cookie: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const cookie = new Headers(init?.headers).get("cookie");
      reads.push({ path: url.pathname, cookie });
      if (url.pathname === "/api/bootstrap.js") return new Response("// bootstrap", { headers: { "set-cookie": "openscout_web_session=example; Path=/; HttpOnly" } });
      if (!cookie) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname === "/api/sessions") return Response.json([{ id: "chat_one", title: "One", harness: "codex", sessionId: "s1", harnessSessionId: "s1", workspaceRoot: "/work" }]);
      return Response.json({ ok: true, sessions: [] });
    }) as typeof fetch;
    const deps = sessionDiscoveryDependencies("http://localhost:43120", { env: {}, fetchImpl });
    const inventory = await deps.readInventory();
    expect(inventory.sessions[0]?.id).toBe("chat_one");
    expect(inventory.terminals).toEqual([]);
    expect(reads.filter((read) => read.path === "/api/bootstrap.js")).toHaveLength(2);
    expect(reads.filter((read) => read.cookie === "openscout_web_session=example")).toHaveLength(2);
  });
  test("inventory uses configured bearer auth without local bootstrap", async () => {
    const paths: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      paths.push(url.pathname);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer configured-token");
      return Response.json(url.pathname === "/api/sessions" ? [] : { sessions: [] });
    }) as typeof fetch;
    await sessionDiscoveryDependencies("http://localhost:43120", { env: { OPENSCOUT_WEB_AUTH_TOKEN: "configured-token" }, fetchImpl }).readInventory();
    expect(paths).not.toContain("/api/bootstrap.js");
  });

  test("a missing on-disk index returns empty coverage without creating any database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "scout-session-search-"));
    const indexPath = join(directory, "not-created", "knowledge.sqlite");
    try {
      const client = await clientFor(dependencies({ openStore: () => new SQLiteKnowledgeStore(indexPath, undefined, { readonly: true }) }));
      const result = await client.callTool({ name: "sessions_search", arguments: { query: "build" } });
      expect(result.structuredContent).toMatchObject({ coverage: { kind: "empty_index" }, results: [] });
      expect(existsSync(join(directory, "not-created"))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("history hit with no terminal evidence retains unknown liveness", async () => {
    const client = await clientFor(dependencies());
    const result = await client.callTool({ name: "sessions_search", arguments: { query: "build" } });
    expect(result.structuredContent).toMatchObject({ results: [{ sessionId: "native-1", state: "unknown", actions: [] }] });
  });
  test("explicitly exited surfaces are history-only while surface-free records stay unknown", async () => {
    const client = await clientFor(dependencies({ readInventory: async () => ({ sessions: [], terminals: [
      { id: "ts-exited", harness: "codex", sourceSessionId: "one", cwd: "/work", resumeCommand: "", createdAt: 1, updatedAt: 2, surfaces: [{ backend: "tmux", sessionName: "old", paneId: null, attachCommand: [], observeCommand: null, relay: { backend: "tmux", sessionName: "old" }, state: "exited" }] },
      { id: "ts-unknown", harness: "codex", sourceSessionId: "two", cwd: "/work", resumeCommand: "", createdAt: 1, updatedAt: 2, surfaces: [] },
    ] }) }));
    const result = await client.callTool({ name: "sessions_inventory", arguments: {} });
    expect(result.structuredContent).toMatchObject({ results: [{ sessionId: "one", state: "history_only", actions: [] }, { sessionId: "two", state: "unknown", actions: [] }] });
  });

});
