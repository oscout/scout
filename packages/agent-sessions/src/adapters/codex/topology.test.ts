import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexObservedTopologyTracker } from "./topology.ts";

const tempPaths = new Set<string>();

afterEach(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.add(path);
  return path;
}

describe("CodexObservedTopologyTracker", () => {
  test("reads project and user Codex custom agent definitions", () => {
    const cwd = makeTempDir("openscout-codex-topology-project-");
    const home = makeTempDir("openscout-codex-topology-home-");
    mkdirSync(join(cwd, ".codex", "agents"), { recursive: true });
    mkdirSync(join(home, ".codex", "agents"), { recursive: true });

    writeFileSync(join(cwd, ".codex", "config.toml"), `
[agents]
max_threads = 6
max_depth = 1
`, "utf8");
    writeFileSync(join(cwd, ".codex", "agents", "reviewer.toml"), `
name = "reviewer"
description = "PR reviewer focused on correctness."
model = "gpt-5.4"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
`, "utf8");
    writeFileSync(join(home, ".codex", "agents", "explorer.toml"), `
name = "explorer"
description = "Read-only explorer."
model = "gpt-5.4-mini"
`, "utf8");

    const tracker = new CodexObservedTopologyTracker({
      cwd,
      homeDir: home,
      threadId: "thread-main",
      sessionName: "Codex Main",
      now: () => new Date("2026-05-05T13:00:00.000Z"),
    });
    const topology = tracker.toTopology();

    expect(topology).toMatchObject({
      schemaVersion: "openscout.observed-harness-topology.v1",
      ownership: "harness_observed",
      source: "codex-subagents",
      observedAt: "2026-05-05T13:00:00.000Z",
    });
    expect(topology?.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "thread", name: "Codex Main" }),
      expect.objectContaining({
        kind: "agent_config",
        providerMeta: expect.objectContaining({ maxThreads: 6, maxDepth: 1 }),
      }),
    ]));
    expect(topology?.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex-agent-definition:project:reviewer", role: "definition", model: "gpt-5.4" }),
      expect.objectContaining({ id: "codex-agent-definition:user:explorer", role: "definition", model: "gpt-5.4-mini" }),
    ]));
  });

  test("normalizes live Codex collaboration and subagent items", () => {
    const cwd = makeTempDir("openscout-codex-topology-live-");
    const tracker = new CodexObservedTopologyTracker({
      cwd,
      homeDir: cwd,
      threadId: "thread-parent",
      sessionName: "Codex Parent",
      now: () => new Date("2026-05-05T13:30:00.000Z"),
    });

    tracker.observeItem({
      type: "collabToolCall",
      id: "collab-1",
      tool: "spawn_agent",
      senderThreadId: "thread-parent",
      receiverThreadId: "thread-child",
      prompt: "Review test coverage.",
      agentStatus: "inProgress",
    }, "started");
    tracker.observeItem({
      type: "subagent",
      id: "subagent-1",
      agentId: "worker-1",
      agentName: "Worker",
      prompt: "Implement isolated patch.",
      status: "running",
    }, "completed");

    const topology = tracker.toTopology();

    expect(topology?.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex-thread-agent:thread-parent", role: "lead" }),
      expect.objectContaining({ id: "codex-thread-agent:thread-child", role: "subagent" }),
      expect.objectContaining({ id: "codex-subagent:worker-1", name: "Worker", status: "completed" }),
    ]));
    expect(topology?.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "codex-task:collab-1",
        title: "Review test coverage.",
        assigneeId: "codex-thread-agent:thread-child",
      }),
      expect.objectContaining({
        id: "codex-task:subagent-1",
        title: "Implement isolated patch.",
        state: "completed",
        assigneeId: "codex-subagent:worker-1",
      }),
    ]));
    expect(topology?.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "spawned",
        fromId: "codex-thread-agent:thread-parent",
        toId: "codex-thread-agent:thread-child",
      }),
      expect.objectContaining({
        kind: "assigned_to",
        fromId: "codex-task:subagent-1",
        toId: "codex-subagent:worker-1",
      }),
    ]));
  });
});
