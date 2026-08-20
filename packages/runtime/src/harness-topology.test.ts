import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HarnessTopologyObserver } from "./harness-topology/service.js";
import type { HarnessTopologyEvent } from "./harness-topology/types.js";

const tempPaths = new Set<string>();

afterEach(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-harness-topology-"));
  tempPaths.add(root);
  return root;
}

function writeClaudeTeam(home: string, memberCount = 1): void {
  const teamDir = join(home, ".claude", "teams", "review-team");
  const taskDir = join(home, ".claude", "tasks", "review-team", "pending");
  mkdirSync(teamDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });

  const members = Array.from({ length: memberCount }, (_, index) => ({
    name: `Reviewer ${index + 1}`,
    agentId: `reviewer-${index + 1}`,
    agentType: "reviewer",
    sessionId: `reviewer-session-${index + 1}`,
    status: "running",
  }));

  writeFileSync(join(teamDir, "config.json"), JSON.stringify({
    name: "review-team",
    cwd: "/tmp/project",
    members,
  }), "utf8");

  writeFileSync(join(taskDir, "task.json"), JSON.stringify({
    id: "review-task",
    title: "Review the patch",
    status: "pending",
    assigneeId: "reviewer-1",
  }), "utf8");
}

function writeCodexConfig(home: string, cwd: string): void {
  const userAgentsDir = join(home, ".codex", "agents");
  const projectCodexDir = join(cwd, ".codex");
  mkdirSync(userAgentsDir, { recursive: true });
  mkdirSync(projectCodexDir, { recursive: true });

  writeFileSync(join(userAgentsDir, "researcher.toml"), [
    'name = "researcher"',
    'description = "Researches focused questions"',
    'model = "gpt-5.4"',
  ].join("\n"), "utf8");

  writeFileSync(join(projectCodexDir, "config.toml"), [
    "max_threads = 4",
    "max_depth = 2",
  ].join("\n"), "utf8");
}

describe("HarnessTopologyObserver", () => {
  test("scans Claude teams and Codex agent definitions into one snapshot", async () => {
    const root = makeTempRoot();
    const home = join(root, "home");
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    writeClaudeTeam(home);
    writeCodexConfig(home, cwd);

    const observer = new HarnessTopologyObserver({
      homeDir: home,
      cwd,
      now: () => new Date("2026-05-05T12:00:00.000Z"),
    });

    const snapshot = await observer.scan();

    expect(snapshot.totals.sources).toBe(2);
    expect(snapshot.totals.groups).toBeGreaterThanOrEqual(2);
    expect(snapshot.totals.agents).toBeGreaterThanOrEqual(2);
    expect(snapshot.observations.map((entry) => entry.source).sort()).toEqual([
      "claude-code-agent-teams",
      "codex-subagents",
    ]);
  });

  test("emits changed and removed events without treating observedAt as a change", async () => {
    const root = makeTempRoot();
    const home = join(root, "home");
    writeClaudeTeam(home);

    let observedAt = "2026-05-05T12:00:00.000Z";
    const observer = new HarnessTopologyObserver({
      homeDir: home,
      sources: ["claude"],
      pollIntervalMs: 60_000,
      now: () => new Date(observedAt),
    });
    const events: HarnessTopologyEvent[] = [];
    const unsubscribe = observer.subscribe((event) => events.push(event));

    try {
      await observer.scan();
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("snapshot");

      observedAt = "2026-05-05T12:00:05.000Z";
      await observer.scan();
      expect(events).toHaveLength(1);

      writeClaudeTeam(home, 2);
      await observer.scan();
      expect(events).toHaveLength(2);
      expect(events[1]?.kind).toBe("snapshot");

      rmSync(join(home, ".claude", "teams", "review-team"), { recursive: true, force: true });
      await observer.scan();
      expect(events).toHaveLength(3);
      expect(events[2]).toMatchObject({
        kind: "removed",
        source: "claude-code-agent-teams",
      });
    } finally {
      unsubscribe();
    }
  });
});
