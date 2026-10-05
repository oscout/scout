import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { mountKnowledgeRoutes } from "./knowledge.ts";

const ENV_KEYS = [
  "OPENSCOUT_CONTROL_HOME",
  "OPENSCOUT_SUPPORT_DIRECTORY",
  "OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT",
  "OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT",
  "OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function useTempKnowledgeEnv(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-knowledge-basic-"));
  roots.push(root);
  process.env.OPENSCOUT_CONTROL_HOME = join(root, "control-plane");
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(root, "support");
  process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = join(root, "claude");
  process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT = join(root, "empty-codex");
  process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT = join(root, "empty-kimi");
  const dir = join(root, "claude", "-Users-art-dev-openscout");
  mkdirSync(dir, { recursive: true });
  const base = { cwd: "/Users/art/dev/openscout", sessionId: "basic-route", timestamp: new Date().toISOString() };
  writeFileSync(join(dir, "basic-route.jsonl"), [
    { ...base, type: "attachment" },
    { ...base, type: "user", message: { role: "user", content: "Search should work before the index exists." } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  return root;
}

test("search answers from a basic transcript scan while no index exists", async () => {
  const root = useTempKnowledgeEnv();
  const app = new Hono();
  mountKnowledgeRoutes(app, { currentDirectory: root });

  const response = await app.request("/api/knowledge/search?q=before%20index");
  expect(response.status).toBe(200);
  const body = await response.json() as {
    mode: string;
    hits: Array<{ facets: Record<string, unknown> }>;
    basic: { scannedFiles: number };
    status: { chunks: number; indexing: unknown };
  };
  expect(body.mode).toBe("basic");
  expect(body.status.chunks).toBe(0);
  expect(body.status.indexing).toBeNull();
  expect(body.basic.scannedFiles).toBe(1);
  expect(body.hits).toHaveLength(1);
  expect(body.hits[0]?.facets.project).toBe("openscout");

  const filtered = await app.request("/api/knowledge/search?q=before%20index&project=elsewhere");
  expect(((await filtered.json()) as { hits: unknown[] }).hits).toHaveLength(0);
});

test("background indexing returns at once and status follows the run", async () => {
  const root = useTempKnowledgeEnv();
  const app = new Hono();
  mountKnowledgeRoutes(app, { currentDirectory: root });

  const started = await app.request("/api/knowledge/sessions/index", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ days: 1, limit: 5, background: true }),
  });
  expect(started.status).toBe(202);
  const startBody = await started.json() as { started: boolean; indexing: { startedAt: number } | null };
  expect(startBody.started).toBe(true);
  expect(startBody.indexing?.startedAt).toBeNumber();

  let status: { indexing: unknown; lastIndex: { ok: boolean; error?: string } | null; chunks: number } | null = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    status = await (await app.request("/api/knowledge/status")).json() as typeof status;
    if (status && status.indexing === null) break;
    await Bun.sleep(100);
  }
  expect(status?.indexing).toBeNull();
  expect(status?.lastIndex?.error).toBeUndefined();
  expect(status?.lastIndex?.ok).toBe(true);
  expect(status?.chunks ?? 0).toBeGreaterThan(0);

  const indexed = await (await app.request("/api/knowledge/search?q=before%20index")).json() as { mode: string; hits: unknown[] };
  expect(indexed.mode).toBe("index");
  expect(indexed.hits.length).toBeGreaterThan(0);
}, 40_000);
