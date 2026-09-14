import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureClaudeStatuslineSnapshot,
  claudeStatuslineObservedRuntime,
  formatClaudeStatuslineFallback,
  readClaudeStatuslineSessionSnapshot,
  resolveClaudeStatuslineHistoryPath,
  resolveClaudeStatuslineLatestPath,
  resolveClaudeStatuslineSessionSnapshotPath,
} from "./claude-statusline.js";

const originalHome = process.env.HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const testDirectories = new Set<string>();

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }

  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

describe("Claude statusline capture", () => {
  test("keeps the newest payload per session id so a session's model and effort can be observed", async () => {
    const home = join(tmpdir(), `openscout-claude-statusline-session-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    testDirectories.add(home);
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");

    const sessionId = "7b81300d-0a9c-4953-8d7f-9274b11ebdfb";
    const payload = (model: string, level: string) => JSON.stringify({
      session_id: sessionId,
      session_name: "project-woolf-20-relay-agent",
      transcript_path: `/Users/art/.claude/projects/-Users-art-dev-openscout/${sessionId}.jsonl`,
      cwd: "/Users/art/dev/openscout",
      effort: { level },
      model: { id: model, display_name: model },
    });
    await captureClaudeStatuslineSnapshot(payload("claude-opus-5", "high"), { capturedAt: 1_000 });
    await captureClaudeStatuslineSnapshot(payload("claude-sonnet-5", "medium"), { capturedAt: 2_000 });

    const snapshot = await readClaudeStatuslineSessionSnapshot(sessionId);
    expect(snapshot).not.toBeNull();
    expect(claudeStatuslineObservedRuntime(snapshot!)).toEqual({
      model: "claude-sonnet-5",
      reasoningEffort: "medium",
      sessionName: "project-woolf-20-relay-agent",
      cwd: "/Users/art/dev/openscout",
      transcriptPath: `/Users/art/.claude/projects/-Users-art-dev-openscout/${sessionId}.jsonl`,
      capturedAt: 2_000,
    });
    // History still has both ticks; the per-session file is the latest only.
    expect(readFileSync(resolveClaudeStatuslineHistoryPath(), "utf8").trim().split("\n")).toHaveLength(2);
    expect(await readClaudeStatuslineSessionSnapshot("0a898412-b3a2-4659-aad3-405e9a24d015")).toBeNull();
    expect(resolveClaudeStatuslineSessionSnapshotPath("../escape")).toBeNull();
    expect(resolveClaudeStatuslineSessionSnapshotPath("")).toBeNull();
  });

  test("writes latest and history snapshots for the quota view", async () => {
    const home = join(tmpdir(), `openscout-claude-statusline-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    testDirectories.add(home);
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");

    const capturedAt = Date.UTC(2026, 5, 19, 12, 0, 0);
    const result = await captureClaudeStatuslineSnapshot(JSON.stringify({
      model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
      workspace: { current_dir: "/Users/art/dev/openscout" },
      context_window: { used_percentage: 31 },
      rate_limits: {
        five_hour: { used_percentage: 12 },
        seven_day: { used_percentage: 70 },
      },
    }), { capturedAt });

    expect(result.captured).toBe(true);
    const latest = JSON.parse(readFileSync(resolveClaudeStatuslineLatestPath(), "utf8")) as Record<string, unknown>;
    const history = readFileSync(resolveClaudeStatuslineHistoryPath(), "utf8").trim().split("\n");

    expect(latest).toEqual(expect.objectContaining({
      cwd: "/Users/art/dev/openscout",
      openscoutCapturedAt: capturedAt,
    }));
    expect(history).toHaveLength(1);
    expect(formatClaudeStatuslineFallback(latest)).toBe("Scout | Opus 4.8 | openscout | ctx 31% | 5h 12% | 7d 70%");
  });
});
