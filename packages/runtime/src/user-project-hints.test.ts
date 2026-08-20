import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadResolvedRelayAgents, writeOpenScoutSettings } from "./setup.js";
import {
  collectUserLevelProjectRootHints,
  decodeClaudeProjectsSlug,
  encodeClaudeProjectsSlug,
} from "./user-project-hints.js";

const hintTestDirs = new Set<string>();

afterEach(() => {
  for (const d of hintTestDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  hintTestDirs.clear();
});

describe("decodeClaudeProjectsSlug", () => {
  test("inverts Claude Code slash-to-hyphen encoding", () => {
    expect(decodeClaudeProjectsSlug("-Users-me-dev-openscout")).toBe("/Users/me/dev/openscout");
  });

  test("returns null for invalid slugs", () => {
    expect(decodeClaudeProjectsSlug("no-leading-dash")).toBeNull();
    expect(decodeClaudeProjectsSlug("")).toBeNull();
    expect(decodeClaudeProjectsSlug(".")).toBeNull();
  });
});

describe("collectUserLevelProjectRootHints", () => {
  test("discovers existing directory from ~/.claude/projects slug", async () => {
    const base = join(tmpdir(), `cc_hints_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    hintTestDirs.add(base);
    const repo = join(base, "from_claude_slug");
    const projectsRoot = join(base, ".claude", "projects");
    const slug = encodeClaudeProjectsSlug(repo);
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "CLAUDE.md"), "# x\n", "utf8");
    mkdirSync(projectsRoot, { recursive: true });
    mkdirSync(join(projectsRoot, slug), { recursive: true });

    const hints = await collectUserLevelProjectRootHints({ home: base });
    expect(hints.some((p) => resolve(p) === resolve(repo))).toBe(true);
  });

  test("parses Claude session cwd values and normalizes them to the enclosing project root", async () => {
    const base = join(tmpdir(), `cc_session_hints_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    hintTestDirs.add(base);
    const repo = join(base, "from_claude_session");
    const nested = join(repo, "packages", "ui");
    const slug = encodeClaudeProjectsSlug(repo);

    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(base, ".claude", "projects", slug), { recursive: true });
    writeFileSync(
      join(base, ".claude", "projects", slug, "session.jsonl"),
      `${JSON.stringify({ cwd: nested, gitBranch: "feature/ui" })}\n`,
      "utf8",
    );

    const hints = await collectUserLevelProjectRootHints({ home: base });
    expect(hints.some((p) => resolve(p) === resolve(repo))).toBe(true);
    expect(hints.some((p) => resolve(p) === resolve(nested))).toBe(false);
  });

  test("parses Codex history.jsonl for absolute directory paths", async () => {
    const base = join(tmpdir(), `cx_hints_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    hintTestDirs.add(base);
    const repo = join(base, "from-codex-history");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(base, ".codex"), { recursive: true });
    writeFileSync(
      join(base, ".codex", "history.jsonl"),
      `${JSON.stringify({ cwd: repo, meta: { workspace: "/nope/not-real" } })}\n`,
      "utf8",
    );

    const hints = await collectUserLevelProjectRootHints({ home: base });
    expect(hints.some((p) => resolve(p) === resolve(repo))).toBe(true);
  });
});

describe("loadResolvedRelayAgents + user hints", () => {
  test("merges Claude projects slug into inventory when outside workspace roots", async () => {
    const originalHome = process.env.HOME;
    const originalSkip = process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;
    const base = join(tmpdir(), `lrrah_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    hintTestDirs.add(base);
    process.env.HOME = base;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(base, "Library", "Application Support", "OpenScout");
    process.env.OPENSCOUT_CONTROL_HOME = join(base, ".openscout", "control-plane");
    process.env.OPENSCOUT_RELAY_HUB = join(base, ".openscout", "relay");
    process.env.OPENSCOUT_NODE_QUALIFIER = "test-node";
    delete process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;

    try {
      const onlyWorkspace = join(base, "w");
      const hintedRepo = join(base, "hinted_sidecar");
      mkdirSync(onlyWorkspace, { recursive: true });
      mkdirSync(join(hintedRepo, ".git"), { recursive: true });
      writeFileSync(join(hintedRepo, "CLAUDE.md"), "# sidecar\n", "utf8");

      const slug = encodeClaudeProjectsSlug(hintedRepo);
      mkdirSync(join(base, ".claude", "projects", slug), { recursive: true });

      await writeOpenScoutSettings({
        discovery: {
          workspaceRoots: [onlyWorkspace],
          includeCurrentRepo: false,
        },
      });

      const setup = await loadResolvedRelayAgents({ userLevelHintsHome: base });
      expect(setup.projectInventory.some((p) => resolve(p.projectRoot) === resolve(hintedRepo))).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
      delete process.env.OPENSCOUT_CONTROL_HOME;
      delete process.env.OPENSCOUT_RELAY_HUB;
      delete process.env.OPENSCOUT_NODE_QUALIFIER;
      if (originalSkip === undefined) {
        delete process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;
      } else {
        process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = originalSkip;
      }
    }
  });
});
