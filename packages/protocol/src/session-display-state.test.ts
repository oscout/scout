import { describe, expect, test } from "bun:test";

import {
  createScoutSessionDisplayState,
  reduceScoutSessionDisplayState,
} from "./session-display-state";

describe("session display state reducer", () => {
  test("folds tool and attention events into a renderable snapshot", () => {
    let state = createScoutSessionDisplayState({ sessionId: "session-1", now: 1 });

    state = reduceScoutSessionDisplayState(state, {
      type: "phase_changed",
      phase: "running",
      at: 2,
    });
    state = reduceScoutSessionDisplayState(state, {
      type: "tool_started",
      tool: {
        id: "tool-1",
        name: "read_file",
        status: "running",
        updatedAt: 3,
      },
    });
    state = reduceScoutSessionDisplayState(state, {
      type: "attention_opened",
      item: {
        id: "approval-1",
        kind: "approval",
        title: "Approve command",
        updatedAt: 4,
      },
    });

    expect(state.phase).toBe("running");
    expect(state.activeTools["tool-1"]?.status).toBe("running");
    expect(state.attention["approval-1"]?.kind).toBe("approval");

    state = reduceScoutSessionDisplayState(state, {
      type: "tool_finished",
      toolId: "tool-1",
      at: 5,
    });
    state = reduceScoutSessionDisplayState(state, {
      type: "attention_closed",
      itemId: "approval-1",
      at: 6,
    });

    expect(state.activeTools["tool-1"]?.status).toBe("completed");
    expect(state.attention["approval-1"]).toBeUndefined();
    expect(state.phase).toBe("running");
  });

  test("resets thread-scoped display details without changing session identity", () => {
    let state = createScoutSessionDisplayState({ sessionId: "session-1", now: 1 });
    state = reduceScoutSessionDisplayState(state, {
      type: "tasks_snapshot",
      tasks: [{
        id: "task-1",
        title: "Review fork policy",
        status: "in_progress",
        updatedAt: 2,
      }],
      at: 2,
    });

    state = reduceScoutSessionDisplayState(state, { type: "reset_thread", at: 3 });

    expect(state.sessionId).toBe("session-1");
    expect(state.phase).toBe("idle");
    expect(state.tasks).toEqual([]);
    expect(state.updatedAt).toBe(3);
  });
});
