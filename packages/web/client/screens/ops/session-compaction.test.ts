import { describe, expect, test } from "bun:test";

import { laneCompactionStateFromTail } from "./session-compaction.ts";
import type { TailEvent } from "../../lib/types.ts";

const NOW = Date.parse("2026-06-27T04:00:00.000Z");

function stubEvent(partial: Partial<TailEvent> & Pick<TailEvent, "id">): TailEvent {
  return {
    ts: NOW,
    source: "codex",
    sessionId: "sess-1",
    pid: 1,
    parentPid: null,
    project: "repo",
    cwd: "/repo",
    harness: "unattributed",
    kind: "system",
    summary: "",
    ...partial,
  };
}

describe("laneCompactionStateFromTail", () => {
  test("flags over-limit sessions as eligible for compaction", () => {
    const state = laneCompactionStateFromTail([], {
      contextInputTokens: 315_000,
      contextWindowTokens: 258_400,
    }, { model: "gpt-5.5", adapterType: "codex" });

    expect(state.eligible).toBe(true);
    expect(state.reason).toBe("over_limit");
  });

  test("detects prior compaction events in the tail", () => {
    const state = laneCompactionStateFromTail([
      stubEvent({
        id: "compact-1",
        summary: "context compacted · 142k → 38k",
        raw: {
          type: "event_msg",
          payload: { type: "context_compacted" },
        },
      }),
    ], {
      contextInputTokens: 90_000,
      contextWindowTokens: 258_400,
    });

    expect(state.lastCompactedSummary).toContain("context compacted");
    expect(state.reason).toBe("post_compaction_point");
  });
});