import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexRecentSessionKnowledge, scanRecentSessionKnowledge, SQLiteKnowledgeStore } from "./index.ts";

const roots = new Set<string>();
const originalEnv = {
  controlHome: process.env.OPENSCOUT_CONTROL_HOME,
  support: process.env.OPENSCOUT_SUPPORT_DIRECTORY,
  kimiRoot: process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT,
  codexRoot: process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT,
  claudeRoot: process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT,
};

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
  restoreEnv("OPENSCOUT_CONTROL_HOME", originalEnv.controlHome);
  restoreEnv("OPENSCOUT_SUPPORT_DIRECTORY", originalEnv.support);
  restoreEnv("OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT", originalEnv.kimiRoot);
  restoreEnv("OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT", originalEnv.codexRoot);
  restoreEnv("OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT", originalEnv.claudeRoot);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

function writeKimiWireFixture(sessionsRoot: string): string {
  const sessionId = "session_test-kimi-ios-build";
  const wireDir = join(sessionsRoot, "wd_openscout_test", sessionId, "agents", "main");
  mkdirSync(wireDir, { recursive: true });
  writeFileSync(
    join(sessionsRoot, "wd_openscout_test", sessionId, "state.json"),
    JSON.stringify({
      version: 2,
      cwd: "/Users/art/dev/openscout",
      title: "iOS navigation slice",
    }),
    "utf8",
  );
  const lines = [
    {
      type: "turn.prompt",
      input: [{ type: "text", text: "Implement iOS v3 navigation and run build steps." }],
      time: Date.now() - 60_000,
    },
    {
      type: "context.append_loop_event",
      time: Date.now() - 50_000,
      event: {
        type: "tool.call",
        uuid: "tool_xcodegen",
        toolCallId: "tool_xcodegen",
        name: "Bash",
        args: { command: "cd apps/ios && xcodegen" },
      },
    },
    {
      type: "context.append_loop_event",
      time: Date.now() - 40_000,
      event: {
        type: "tool.call",
        uuid: "tool_xcodebuild",
        toolCallId: "tool_xcodebuild",
        name: "Bash",
        args: {
          command:
            "xcodebuild -project apps/ios/Scout.xcodeproj -scheme Scout -destination 'platform=iOS Simulator,name=iPhone 16' build",
        },
      },
    },
    {
      type: "context.append_loop_event",
      time: Date.now() - 30_000,
      event: {
        type: "content.part",
        uuid: "part_1",
        part: { type: "text", text: "Build succeeded after fixing the V3 chrome compile error." },
      },
    },
  ];
  const wirePath = join(wireDir, "wire.jsonl");
  writeFileSync(wirePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return wirePath;
}

describe("session knowledge indexer (kimi)", () => {
  test("indexes kimi state v2 wire.jsonl and finds iOS build-step queries", async () => {
    const root = tempRoot("openscout-kimi-knowledge-");
    process.env.OPENSCOUT_CONTROL_HOME = join(root, "control-plane");
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(root, "support");
    process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT = join(root, "kimi-sessions");
    // Keep other harnesses empty so discovery is kimi-only even without filter.
    process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT = join(root, "empty-codex");
    process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = join(root, "empty-claude");
    mkdirSync(process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT, { recursive: true });

    writeKimiWireFixture(process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT);

    const indexed = await indexRecentSessionKnowledge({
      hours: 12,
      harness: "kimi",
      force: true,
    });
    expect(indexed.discovered).toBe(1);
    expect(indexed.failed).toBe(0);
    expect(indexed.sessions[0]?.harness).toBe("kimi");
    expect(indexed.sessions[0]?.project).toBe("openscout");
    expect(indexed.sessions[0]?.chunks ?? 0).toBeGreaterThan(0);

    writeFileSync(
      join(
        process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT,
        "wd_openscout_test",
        "session_test-kimi-ios-build",
        "state.json",
      ),
      JSON.stringify({
        workDir: "/Users/art/dev/openscout",
        title: "iOS navigation slice",
      }),
      "utf8",
    );
    const legacyIndexed = await indexRecentSessionKnowledge({
      hours: 12,
      harness: "kimi",
      force: true,
    });
    expect(legacyIndexed.sessions[0]?.project).toBe("openscout");

    const store = new SQLiteKnowledgeStore();
    try {
      const hits = store.searchLexical({
        q: "xcodebuild iOS Simulator",
        facets: { harness: "kimi" },
        limit: 10,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((hit) => /xcodebuild/i.test(hit.snippet) || /xcodebuild/i.test(hit.title))).toBe(true);
      expect(hits[0]?.facets.harness === "kimi" || hits[0]?.facets.harness?.[0] === "kimi").toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("basic session scan (no index)", () => {
  function writeClaudeFixture(projectsRoot: string): void {
    const dir = join(projectsRoot, "-Users-art-dev-openscout");
    mkdirSync(dir, { recursive: true });
    const sessionId = "0f2c7a1e-basic-scan";
    const base = {
      cwd: "/Users/art/dev/openscout",
      sessionId,
      timestamp: new Date(Date.now() - 30_000).toISOString(),
    };
    const lines = [
      { ...base, type: "attachment" },
      { ...base, type: "user", message: { role: "user", content: "Why does the knowledge index child exit 1?" } },
      { ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The child script path moved after the route split." }] } },
      { ...base, type: "user", message: { role: "user", content: "Unrelated note about the header." } },
    ];
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  }

  for (const engine of ["ripgrep", "reader"] as const) {
    test(`finds matching transcript records without an index (${engine})`, async () => {
      const root = tempRoot("openscout-basic-scan-");
      const originalRg = process.env.OPENSCOUT_RG_PATH;
      if (engine === "reader") process.env.OPENSCOUT_RG_PATH = "none";
      try {
        process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT = join(root, "claude");
        process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT = join(root, "empty-codex");
        process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT = join(root, "empty-kimi");
        writeClaudeFixture(process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT);

        const result = await scanRecentSessionKnowledge({ q: "index CHILD" });
        expect(result.scannedFiles).toBe(1);
        expect(result.totalFiles).toBe(1);
        expect(result.truncated).toBe(false);
        expect(result.hits).toHaveLength(1);
        const hit = result.hits[0]!;
        expect(hit.snippet).toContain("knowledge index child");
        expect(hit.facets.harness).toBe("claude");
        expect(hit.facets.project).toBe("openscout");
        expect(hit.facets.match).toBe("basic");
        expect(hit.sourceRefs[0]?.kind).toBe("harness_transcript");

        const none = await scanRecentSessionKnowledge({ q: "nothing-matches-this" });
        expect(none.hits).toHaveLength(0);
      } finally {
        restoreEnv("OPENSCOUT_RG_PATH", originalRg);
      }
    });
  }
});
