import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testing, readRecentLiveEvents, readRecentTranscriptEvents } from "./service.js";
import type { TailEvent } from "./types.js";

const testDirectories = new Set<string>();

async function transcriptFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openscout-tail-memo-"));
  testDirectories.add(directory);
  const path = join(directory, "session.jsonl");
  await writeFile(path, "first\n", "utf8");
  const old = new Date(Date.now() - 10_000);
  await utimes(path, old, old);
  return path;
}

function event(overrides: Partial<TailEvent>): TailEvent {
  return {
    id: `event-${Math.random()}`,
    ts: 1_781_991_000_000,
    source: "grok",
    sessionId: "session-1",
    pid: 123,
    parentPid: null,
    project: "openscout",
    cwd: "/Users/arach/dev/openscout",
    harness: "unattributed",
    kind: "system",
    summary: "phase · streaming_text",
    ...overrides,
  };
}

beforeEach(() => {
  __testing.resetQuietTailCoalescer();
  __testing.resetTranscriptReplayMemo();
  __testing.resetTailEventBuffers();
});

afterEach(async () => {
  await Promise.all([...testDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
  testDirectories.clear();
});

describe("tail quiet event coalescing", () => {
  test("coalesces repeated Grok streaming_text phases inside the window", () => {
    const first = event({ id: "first", ts: 1_000 });
    const second = event({ id: "second", ts: 1_250 });
    const later = event({ id: "later", ts: 7_000 });

    expect(__testing.shouldCoalesceQuietTailEvent(first)).toBe(false);
    expect(__testing.shouldCoalesceQuietTailEvent(second)).toBe(true);
    expect(__testing.shouldCoalesceQuietTailEvent(later)).toBe(false);
  });

  test("does not coalesce substantive Grok work events", () => {
    const tool = event({
      source: "grok",
      kind: "tool",
      summary: "Read · apps/macos/Sources/ScoutAppCore/ScoutTailStore.swift",
    });
    const assistant = event({
      source: "grok",
      kind: "assistant",
      summary: "Implemented the store split.",
    });

    expect(__testing.shouldCoalesceQuietTailEvent(tool)).toBe(false);
    expect(__testing.shouldCoalesceQuietTailEvent(assistant)).toBe(false);
  });

  test("coalesces repeated Codex metadata markers without hiding task starts", () => {
    const first = event({
      source: "codex",
      kind: "system",
      summary: "tokens · 104453775",
      ts: 2_000,
    });
    const second = event({
      source: "codex",
      kind: "system",
      summary: "tokens · 104453776",
      ts: 2_100,
    });
    const taskStarted = event({
      source: "codex",
      kind: "system",
      summary: "task started",
      ts: 2_200,
    });

    expect(__testing.shouldCoalesceQuietTailEvent(first)).toBe(false);
    expect(__testing.shouldCoalesceQuietTailEvent(second)).toBe(true);
    expect(__testing.shouldCoalesceQuietTailEvent(taskStarted)).toBe(false);
  });
});

describe("session hot-buffer identity", () => {
  test("keeps same-id harness events scoped to the selected transcript source", () => {
    const codex = event({
      id: "codex-reply",
      source: "codex",
      sessionId: "shared-native-id",
      kind: "assistant",
      summary: "Codex reply",
    });
    const claude = event({
      id: "claude-reply",
      source: "claude",
      sessionId: "shared-native-id",
      kind: "assistant",
      summary: "Claude reply",
    });
    __testing.setSessionBuffer("shared-native-id", [codex, claude]);

    expect(__testing.snapshotSessionEvents("shared-native-id", "codex", 20)).toEqual([codex]);
    expect(__testing.snapshotSessionEvents("shared-native-id", "claude", 20)).toEqual([claude]);
    expect(__testing.snapshotSessionEvents("shared-native-id", "kimi", 20)).toEqual([]);
  });

  test("keeps assistant replies outside the generic live-event eviction ring", async () => {
    const reply = event({
      id: "reply-before-tool-flood",
      source: "codex",
      kind: "assistant",
      summary: "Completed response",
      ts: 1,
    });
    __testing.pushEvent(reply);
    for (let index = 0; index < 12_000; index++) {
      __testing.pushEvent(event({
        id: `tool-${index}`,
        source: "codex",
        kind: "tool",
        summary: `Tool ${index}`,
        ts: index + 2,
      }));
    }

    await expect(readRecentLiveEvents(1, { kinds: ["assistant"] })).resolves.toEqual([reply]);
  });

  test("finds a cold assistant reply before a 12k-line technical flood", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openscout-tail-cold-reply-"));
    testDirectories.add(directory);
    const transcriptPath = join(directory, "rollout-cold-reply.jsonl");
    const replyLine = JSON.stringify({
      timestamp: "2026-08-28T01:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "reply-before-cold-tool-flood",
        role: "assistant",
        content: [{ type: "output_text", text: "Cold completed response" }],
      },
    });
    const paddedToolOutput = "x".repeat(1_024);
    const toolLines = Array.from({ length: 12_000 }, (_, index) => JSON.stringify({
      timestamp: new Date(Date.parse("2026-08-28T01:00:01.000Z") + index).toISOString(),
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: `call-${index}`,
        output: `Tool result ${index} ${paddedToolOutput}`,
      },
    }));
    const transcriptBody = `${[replyLine, ...toolLines].join("\n")}\n`;
    await writeFile(transcriptPath, transcriptBody, "utf8");
    const discovery = {
      generatedAt: Date.now(),
      processes: [],
      transcripts: [{
        source: "codex",
        transcriptPath,
        sessionId: "cold-reply-session",
        cwd: "/Users/art/dev/openscout",
        project: "openscout",
        harness: "unattributed" as const,
        mtimeMs: Date.now(),
        size: Buffer.byteLength(transcriptBody),
      }],
      totals: {
        total: 0,
        scoutManaged: 0,
        hudsonManaged: 0,
        unattributed: 0,
        transcripts: 1,
      },
    };

    expect(Buffer.byteLength(transcriptBody)).toBeGreaterThan(8 * 1024 * 1024);

    const replies = await readRecentTranscriptEvents(1, {
      discovery,
      perTranscriptLineLimit: 200,
      kinds: ["assistant"],
      perTranscriptKindLimit: 1,
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]?.summary).toBe("Cold completed response");
  });
});

describe("tail transcript replay memo", () => {
  test("reuses unchanged replays without sharing mutable arrays", async () => {
    const path = await transcriptFile();
    let loads = 0;
    const load = async () => {
      loads++;
      return [event({ id: `load-${loads}` })];
    };

    const first = await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    first.push(event({ id: "caller-only" }));
    const second = await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);

    expect(loads).toBe(1);
    expect(second.map((item) => item.id)).toEqual(["load-1"]);
    expect(second).not.toBe(first);
  });

  test("replays changed files after the active grace window", async () => {
    const path = await transcriptFile();
    let loads = 0;
    const load = async () => [event({ id: `load-${++loads}` })];

    await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    await appendFile(path, "second\n", "utf8");
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);
    const refreshed = await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);

    expect(loads).toBe(2);
    expect(refreshed[0]?.id).toBe("load-2");
  });

  test("replays when a multi-file parser dependency fingerprint changes", async () => {
    const path = await transcriptFile();
    let loads = 0;
    const load = async () => [event({ id: `load-${++loads}` })];
    const firstDependency = { size: 100, mtimeMs: Date.now() - 20_000 };
    const changedDependency = { size: 140, mtimeMs: Date.now() - 10_000 };

    await __testing.memoizedTranscriptReplay(path, "recent:file:opencode", load, firstDependency);
    const refreshed = await __testing.memoizedTranscriptReplay(
      path,
      "recent:file:opencode",
      load,
      changedDependency,
    );

    expect(loads).toBe(2);
    expect(refreshed[0]?.id).toBe("load-2");
  });

  test("serves the prior replay while an actively written file is inside grace", async () => {
    const path = await transcriptFile();
    let loads = 0;
    const load = async () => [event({ id: `load-${++loads}` })];

    await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    await appendFile(path, "active\n", "utf8");
    const duringGrace = await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);

    expect(loads).toBe(1);
    expect(duringGrace[0]?.id).toBe("load-1");

    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);
    await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    expect(loads).toBe(2);
  });

  test("bounds stale replay time while a transcript is written continuously", async () => {
    const path = await transcriptFile();
    let loads = 0;
    const load = async () => [event({ id: `load-${++loads}` })];

    await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    const deadline = Date.now() + 2_400;
    let replay = [event({ id: "unread" })];
    while (Date.now() < deadline) {
      await appendFile(path, "active\n", "utf8");
      replay = await __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
      await Bun.sleep(300);
    }

    expect(loads).toBeGreaterThan(1);
    expect(replay[0]?.id).not.toBe("load-1");
  });

  test("coalesces concurrent loads for the same replay shape", async () => {
    const path = await transcriptFile();
    const gate = Promise.withResolvers<void>();
    let loads = 0;
    const load = async () => {
      loads++;
      await gate.promise;
      return [event({ id: "shared" })];
    };

    const first = __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    const second = __testing.memoizedTranscriptReplay(path, "recent:lines:200", load);
    gate.resolve();
    const [left, right] = await Promise.all([first, second]);

    expect(loads).toBe(1);
    expect(right).toEqual(left);
    expect(right).not.toBe(left);
  });

  test("keeps list and detail replay budgets in separate memo entries", async () => {
    const path = await transcriptFile();
    let loads = 0;

    const recent = await __testing.memoizedTranscriptReplay(path, "recent:lines:50", async () => {
      loads++;
      return [event({ id: "recent" })];
    });
    const detail = await __testing.memoizedTranscriptReplay(path, "session:lines:2000", async () => {
      loads++;
      return [event({ id: "detail-1" }), event({ id: "detail-2" })];
    });

    expect(loads).toBe(2);
    expect(recent).toHaveLength(1);
    expect(detail).toHaveLength(2);
  });

  test("evicts the oldest replay shape at the configured bound", async () => {
    const path = await transcriptFile();
    let loads = 0;
    for (let index = 0; index <= 256; index++) {
      await __testing.memoizedTranscriptReplay(path, `variant-${index}`, async () => {
        loads++;
        return [event({ id: `event-${index}` })];
      });
    }

    expect(__testing.transcriptReplayMemoSize()).toBe(256);
    await __testing.memoizedTranscriptReplay(path, "variant-0", async () => {
      loads++;
      return [event({ id: "reloaded" })];
    });
    expect(loads).toBe(258);
  });
});
