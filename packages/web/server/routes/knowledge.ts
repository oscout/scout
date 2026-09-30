import type { Hono } from "hono";
import { createReadStream, existsSync, statSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  resolveOpenScoutKnowledgePaths,
  SQLiteKnowledgeStore,
  type KnowledgeCollectionKind,
  type KnowledgeFacets,
  type KnowledgeSourceRef,
} from "@openscout/runtime/knowledge";
import { parseOptionalPositiveInt } from "../http-helpers.ts";

function parseOptionalFiniteNumber(value: string | null | undefined): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const KNOWLEDGE_SEARCH_FACET_PARAMS = [
  "harness",
  "project",
  "source",
  "sessionId",
  "documentKind",
  "recordKind",
  "recordTag",
  "toolName",
  "touchedPath",
  "state",
] as const;

const KNOWLEDGE_SEARCH_SOURCE_KINDS = new Set<KnowledgeCollectionKind>([
  "sessions",
  "skills",
  "mcp",
  "codebase",
  "context_pack",
  "mixed",
]);

function addKnowledgeFacetValue(facets: KnowledgeFacets, key: string, rawValue: string): void {
  const value = rawValue.trim();
  if (!key.trim() || !value || value === "all") return;
  const existing = facets[key];
  if (!existing) {
    facets[key] = value;
    return;
  }
  const next = Array.isArray(existing) ? existing : [existing];
  if (!next.includes(value)) facets[key] = [...next, value];
}

type SessionKnowledgeIndexOutcome = {
  ok: boolean;
  busy?: boolean;
  result?: unknown;
  status?: unknown;
  error?: string;
};

type SessionKnowledgeIndexInput = {
  days?: number;
  hours?: number;
  limit: number;
  force: boolean;
  harness?: string | string[];
};

// Session indexing runs in a child process: it parses hundreds of MB of
// transcripts and performs heavy SQLite/FTS writes, which froze every web
// request when it ran on the server's event loop (a worker thread still
// shares the process heap and took the server down under a full rebuild).
// Concurrent callers with identical parameters share the in-flight run
// instead of stacking writers; different parameters get 409 from the route.
const SESSION_KNOWLEDGE_INDEX_TIMEOUT_MS = 15 * 60 * 1000;

let activeSessionKnowledgeIndex: {
  input: SessionKnowledgeIndexInput;
  promise: Promise<SessionKnowledgeIndexOutcome>;
} | null = null;

function normalizeHarnessList(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map((entry) => entry.trim().toLowerCase()).filter(Boolean))].sort();
}

function sameSessionKnowledgeIndexInput(a: SessionKnowledgeIndexInput, b: SessionKnowledgeIndexInput): boolean {
  return a.days === b.days
    && a.hours === b.hours
    && a.limit === b.limit
    && a.force === b.force
    && normalizeHarnessList(a.harness).join("\0") === normalizeHarnessList(b.harness).join("\0");
}

function startSessionKnowledgeIndex(input: SessionKnowledgeIndexInput): Promise<SessionKnowledgeIndexOutcome> {
  if (activeSessionKnowledgeIndex) {
    return sameSessionKnowledgeIndexInput(activeSessionKnowledgeIndex.input, input)
      ? activeSessionKnowledgeIndex.promise
      : Promise.resolve({ ok: false, busy: true, error: "session knowledge index already running" });
  }
  const promise = (async () => {
    try {
      // Dev serves this file's TS source; packaged builds bundle the child as
      // a sibling .mjs (see build:server). Prefer whichever exists.
      const childTs = new URL("./knowledge-index-child.ts", import.meta.url);
      const childMjs = new URL("./knowledge-index-child.mjs", import.meta.url);
      const scriptPath = fileURLToPath(existsSync(childTs) ? childTs : childMjs);
      const child = Bun.spawn([process.execPath, scriptPath, JSON.stringify(input)], {
        stdout: "pipe",
        stderr: "inherit",
        env: process.env,
      });
      const timeout = setTimeout(() => child.kill(), SESSION_KNOWLEDGE_INDEX_TIMEOUT_MS);
      const stdout = await new Response(child.stdout).text();
      const exitCode = await child.exited;
      clearTimeout(timeout);
      const lastLine = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (lastLine) {
        try {
          return JSON.parse(lastLine) as SessionKnowledgeIndexOutcome;
        } catch {
          // fall through to the generic failure below
        }
      }
      return {
        ok: false,
        error: `knowledge index child exited ${exitCode} without a result`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      activeSessionKnowledgeIndex = null;
    }
  })();
  activeSessionKnowledgeIndex = { input, promise };
  return promise;
}

function parseKnowledgeSearchParams(rawUrl: string): {
  facets?: KnowledgeFacets;
  collections?: string[];
  sourceKinds?: KnowledgeCollectionKind[];
  sourceUpdatedAfterMs?: number;
  sourceUpdatedBeforeMs?: number;
} {
  const url = new URL(rawUrl, "http://localhost");
  const facets: KnowledgeFacets = {};

  for (const key of KNOWLEDGE_SEARCH_FACET_PARAMS) {
    for (const value of url.searchParams.getAll(key)) {
      addKnowledgeFacetValue(facets, key, value);
    }
  }
  for (const [key, value] of url.searchParams.entries()) {
    if (key.startsWith("facet:")) addKnowledgeFacetValue(facets, key.slice("facet:".length), value);
    if (key.startsWith("facet.")) addKnowledgeFacetValue(facets, key.slice("facet.".length), value);
  }

  const collections = [
    ...url.searchParams.getAll("collection"),
    ...url.searchParams.getAll("collectionId"),
  ].map((value) => value.trim()).filter(Boolean);
  const sourceKinds = url.searchParams.getAll("sourceKind")
    .map((value) => value.trim())
    .filter((value): value is KnowledgeCollectionKind =>
      KNOWLEDGE_SEARCH_SOURCE_KINDS.has(value as KnowledgeCollectionKind)
    );

  return {
    facets: Object.keys(facets).length > 0 ? facets : undefined,
    collections: collections.length > 0 ? collections : undefined,
    sourceKinds: sourceKinds.length > 0 ? sourceKinds : undefined,
    sourceUpdatedAfterMs: parseOptionalFiniteNumber(url.searchParams.get("updatedAfterMs")),
    sourceUpdatedBeforeMs: parseOptionalFiniteNumber(url.searchParams.get("updatedBeforeMs")),
  };
}

type HarnessTranscriptSourceRef = Extract<KnowledgeSourceRef, { kind: "harness_transcript" }>;

type JsonlPreviewRecord = {
  index: number;
  raw: string;
  type?: string;
  role?: string;
  kind?: string;
  summary: string;
  renderedText: string;
  parsed: boolean;
  matched?: boolean;
  matchCount?: number;
  matchTerms?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function trimPreviewLine(value: string, max = 260): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3))}...`;
}

function previewQueryTerms(query: string | undefined): string[] {
  const seen = new Set<string>();
  return (query ?? "")
    .split(/[^A-Za-z0-9_./-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function matchStats(text: string, terms: string[]): { count: number; terms: string[] } {
  if (!text || terms.length === 0) return { count: 0, terms: [] };
  const lower = text.toLowerCase();
  let count = 0;
  const matchedTerms: string[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    let index = lower.indexOf(needle);
    let matched = false;
    while (index >= 0) {
      count++;
      matched = true;
      index = lower.indexOf(needle, index + needle.length);
    }
    if (matched) matchedTerms.push(term);
  }
  return { count, terms: matchedTerms };
}

function extractPreviewText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => extractPreviewText(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join(" ");
    return joined || null;
  }
  if (!isRecord(value)) return null;
  for (const key of [
    "text",
    "message",
    "content",
    "input",
    "arguments",
    "args",
    "output",
    "result",
    "prompt",
    "command",
    "lastPrompt",
    "aiTitle",
    "summary",
  ]) {
    const extracted = extractPreviewText(value[key]);
    if (extracted) return extracted;
  }
  return null;
}

function summarizeJsonlRecord(raw: string, index: number, terms: string[]): JsonlPreviewRecord {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const payload = isRecord(parsed) ? parsed.payload : null;
    const message = isRecord(parsed) ? parsed.message : null;
    const candidate = payload ?? message ?? parsed;
    const type = stringField(parsed, "type") ?? stringField(candidate, "type");
    const role = stringField(parsed, "role") ?? stringField(candidate, "role") ?? stringField(message, "role");
    const kind = stringField(parsed, "kind") ?? stringField(candidate, "kind") ?? type ?? role;
    const renderedText = extractPreviewText(candidate) ?? extractPreviewText(parsed) ?? raw;
    const summary = trimPreviewLine(renderedText);
    const stats = matchStats(`${summary}\n${renderedText}\n${raw}`, terms);
    return {
      index,
      raw,
      ...(type ? { type } : {}),
      ...(role ? { role } : {}),
      ...(kind ? { kind } : {}),
      summary,
      renderedText,
      parsed: true,
      matched: stats.count > 0,
      matchCount: stats.count,
      matchTerms: stats.terms,
    };
  } catch {
    const stats = matchStats(raw, terms);
    return {
      index,
      raw,
      kind: "unparseable",
      summary: trimPreviewLine(raw),
      renderedText: raw,
      parsed: false,
      matched: stats.count > 0,
      matchCount: stats.count,
      matchTerms: stats.terms,
    };
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveKnowledgePreviewPath(
  sourceRef: HarnessTranscriptSourceRef,
  currentDirectory: string,
): string | null {
  const paths = resolveOpenScoutKnowledgePaths();
  const controlHome = dirname(paths.knowledgeRoot);
  const portable = sourceRef.path;
  const relPath = portable.relPath?.trim();
  if (!relPath) return null;

  if (portable.root === "ABSOLUTE") {
    const absolute = resolve(relPath);
    const trustedRoots = [homedir(), currentDirectory, controlHome].map((root) => resolve(root));
    return trustedRoots.some((root) => isInsideRoot(root, absolute)) ? absolute : null;
  }

  const root = portable.root === "HOME"
    ? homedir()
    : portable.root === "OPENSCOUT_CONTROL_HOME"
      ? controlHome
      : portable.root === "OPENSCOUT_SUPPORT_DIRECTORY"
        ? dirname(controlHome)
        : portable.root === "PROJECT_ROOT"
          ? currentDirectory
          : null;
  if (!root) return null;
  const resolved = resolve(root, relPath);
  return isInsideRoot(resolve(root), resolved) ? resolved : null;
}

async function readKnowledgeJsonlPreview(input: {
  sourceRef: HarnessTranscriptSourceRef;
  currentDirectory: string;
  contextRecords?: number;
  maxRecords?: number;
  query?: string;
}) {
  const resolvedPath = resolveKnowledgePreviewPath(input.sourceRef, input.currentDirectory);
  if (!resolvedPath) {
    throw new Error("source path is outside trusted preview roots");
  }
  const stats = statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error("source path is not a file");
  }

  const requested = input.sourceRef.recordRange;
  const requestedStart = Array.isArray(requested) && Number.isFinite(requested[0])
    ? Math.max(0, Math.floor(requested[0]))
    : 0;
  const requestedEnd = Array.isArray(requested) && Number.isFinite(requested[1])
    ? Math.max(requestedStart, Math.floor(requested[1]))
    : requestedStart + 24;
  const contextRecords = Math.min(20, Math.max(0, Math.floor(input.contextRecords ?? 4)));
  const maxRecords = Math.min(120, Math.max(1, Math.floor(input.maxRecords ?? 80)));
  const start = Math.max(0, requestedStart - contextRecords);
  const desiredEnd = requestedEnd + contextRecords;
  const end = Math.min(desiredEnd, start + maxRecords - 1);
  const terms = previewQueryTerms(input.query);

  const records: JsonlPreviewRecord[] = [];
  let index = 0;
  let truncatedAfter = false;
  const reader = createInterface({
    input: createReadStream(resolvedPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    if (index > end) {
      truncatedAfter = true;
      reader.close();
      break;
    }
    if (index >= start) {
      records.push(summarizeJsonlRecord(line, index, terms));
    }
    index++;
  }

  const first = records[0]?.index ?? start;
  const last = records.at(-1)?.index ?? first;
  return {
    path: resolvedPath,
    sourcePath: input.sourceRef.path,
    harness: input.sourceRef.harness,
    sessionId: input.sourceRef.sessionId,
    requestedRange: requested,
    previewRange: [first, last] as [number, number],
    records,
    recordsRead: records.length,
    truncatedBefore: start > 0,
    truncatedAfter,
    query: input.query,
    queryTerms: terms,
  };
}

export type KnowledgeRouteDeps = {
  currentDirectory: string;
};

export function mountKnowledgeRoutes(app: Hono, deps: KnowledgeRouteDeps) {
  const { currentDirectory } = deps;

  app.get("/api/knowledge/status", (c) => {
    const store = new SQLiteKnowledgeStore(undefined, undefined, { readonly: true });
    try {
      return c.json(store.status());
    } finally {
      store.close();
    }
  });

  app.get("/api/knowledge/search", (c) => {
    const q = c.req.query("q") ?? "";
    const limit = parseOptionalPositiveInt(c.req.query("limit"), 30) ?? 30;
    const primitives = parseKnowledgeSearchParams(c.req.url);
    const store = new SQLiteKnowledgeStore(undefined, undefined, { readonly: true });
    try {
      return c.json({
        q,
        hits: store.searchLexical({
          q,
          sourceKinds: primitives.sourceKinds ?? ["sessions"],
          collections: primitives.collections,
          facets: primitives.facets,
          sourceUpdatedAfterMs: primitives.sourceUpdatedAfterMs,
          sourceUpdatedBeforeMs: primitives.sourceUpdatedBeforeMs,
          limit,
          mode: "lexical",
        }),
        status: store.status(),
      });
    } finally {
      store.close();
    }
  });

  app.get("/api/knowledge/search-primitives", (c) => {
    const keys = new URL(c.req.url, "http://localhost").searchParams.getAll("key");
    const limit = parseOptionalPositiveInt(c.req.query("limit"), 200) ?? 200;
    const store = new SQLiteKnowledgeStore(undefined, undefined, { readonly: true });
    try {
      return c.json({
        facets: store.listFacetValues(keys, limit),
        params: {
          facets: KNOWLEDGE_SEARCH_FACET_PARAMS,
          genericFacetPrefixes: ["facet:", "facet."],
          ranges: ["updatedAfterMs", "updatedBeforeMs"],
          collections: ["collection", "collectionId"],
          sourceKinds: [...KNOWLEDGE_SEARCH_SOURCE_KINDS],
        },
        status: store.status(),
      });
    } finally {
      store.close();
    }
  });

  app.post("/api/knowledge/source-preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      sourceRef?: unknown;
      contextRecords?: unknown;
      maxRecords?: unknown;
      q?: unknown;
    };
    const sourceRef = body.sourceRef;
    if (!isRecord(sourceRef) || sourceRef.kind !== "harness_transcript") {
      return c.json({ error: "sourceRef must be a harness transcript ref" }, 400);
    }
    try {
      return c.json(await readKnowledgeJsonlPreview({
        sourceRef: sourceRef as HarnessTranscriptSourceRef,
        currentDirectory,
        contextRecords: typeof body.contextRecords === "number" ? body.contextRecords : undefined,
        maxRecords: typeof body.maxRecords === "number" ? body.maxRecords : undefined,
        query: typeof body.q === "string" ? body.q : undefined,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("trusted preview roots") ? 403 : 500;
      return c.json({ error: message }, status as 403 | 500);
    }
  });

  app.post("/api/knowledge/sessions/index", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      days?: unknown;
      hours?: unknown;
      limit?: unknown;
      force?: unknown;
      harness?: unknown;
    };
    const hours = typeof body.hours === "number" && Number.isFinite(body.hours) && body.hours > 0
      ? body.hours
      : undefined;
    const days = hours == null
      && typeof body.days === "number"
      && Number.isFinite(body.days)
      ? body.days
      : hours == null
        ? 3
        : undefined;
    const limit = typeof body.limit === "number" && Number.isFinite(body.limit)
      ? body.limit
      : 220;
    const force = body.force === true;
    let harness: string | string[] | undefined;
    if (typeof body.harness === "string" && body.harness.trim()) {
      harness = body.harness.trim();
    } else if (Array.isArray(body.harness)) {
      const list = body.harness
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim());
      if (list.length > 0) harness = list;
    }
    const outcome = await startSessionKnowledgeIndex({ days, hours, limit, force, harness });
    if (outcome.busy) {
      return c.json({ error: outcome.error ?? "session knowledge index already running" }, 409);
    }
    if (!outcome.ok) {
      return c.json({ error: outcome.error ?? "session indexing failed" }, 500);
    }
    return c.json({ result: outcome.result, status: outcome.status });
  });
}
