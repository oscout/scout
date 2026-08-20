import { beforeEach, describe, expect, test } from "bun:test";

import { __testing } from "./service.js";
import type { TailEvent } from "./types.js";

function event(overrides: Partial<TailEvent>): TailEvent {
  return {
    id: `event-${Math.random()}`,
    ts: 1_781_991_000_000,
    source: "grok",
    sessionId: "session-1",
    pid: 123,
    parentPid: null,
    project: "openscout",
    cwd: "/Users/example/dev/openscout",
    harness: "unattributed",
    kind: "system",
    summary: "phase · streaming_text",
    ...overrides,
  };
}

beforeEach(() => {
  __testing.resetQuietTailCoalescer();
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
