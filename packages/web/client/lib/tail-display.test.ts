import { describe, expect, test } from "bun:test";

import {
  collapseTailDisplayRows,
  filterTailEventsForDisplay,
  isTailNoiseEvent,
  observeKindFromTailEvent,
  observeTextFromTailEvent,
  observeToolFieldsFromTailEvent,
  observeToolIsEdit,
  observeToolIsRead,
  shortTailSession,
  tailAttributionLabel,
  tailObserveEventDetail,
} from "./tail-display.ts";
import type { TailEvent } from "./types.ts";

function event(overrides: Partial<TailEvent> & Pick<TailEvent, "summary">): TailEvent {
  return {
    id: "evt-1",
    ts: 1_700_000_000_000,
    source: "grok",
    sessionId: "sess-1",
    pid: 1,
    parentPid: null,
    project: "openscout",
    cwd: "/tmp/openscout",
    harness: "unattributed",
    kind: "system",
    ...overrides,
  };
}

describe("shortTailSession", () => {
  test("shows the distinct portion of Kimi session ids", () => {
    expect(shortTailSession("session_a8ddc351-12b4-42e4-bb3d-ea3d975fafa4")).toBe("a8ddc351");
    expect(shortTailSession("session_b41e5f20:subagent")).toBe("b41e5f20");
  });

  test("keeps existing session id formats intact", () => {
    expect(shortTailSession("01k2wxyz:worker")).toBe("01k2wxyz");
    expect(shortTailSession("")).toBe("—");
  });
});

describe("isTailNoiseEvent", () => {
  test("flags grok streaming phase churn", () => {
    expect(isTailNoiseEvent(event({ summary: "phase · streaming_reasoning" }))).toBe(true);
    expect(isTailNoiseEvent(event({ summary: "phase · streaming_text" }))).toBe(true);
    expect(isTailNoiseEvent(event({ summary: "phase · tool_execution" }))).toBe(true);
    expect(isTailNoiseEvent(event({ summary: "phase · waiting_for_model" }))).toBe(true);
  });

  test("keeps substantive grok tool lines", () => {
    expect(isTailNoiseEvent(event({ summary: "Read started", kind: "tool" }))).toBe(false);
    expect(isTailNoiseEvent(event({ summary: "permission allow · Read" }))).toBe(false);
  });

  test("flags Cursor process samples without hiding other Cursor activity", () => {
    expect(isTailNoiseEvent(event({
      source: "cursor",
      kind: "system",
      summary: "process sample · openscout, vox",
    }))).toBe(true);
    expect(isTailNoiseEvent(event({
      source: "cursor",
      kind: "system",
      summary: "agent process exited",
    }))).toBe(false);
    expect(isTailNoiseEvent(event({
      source: "cursor",
      kind: "tool",
      summary: "Process sample data",
    }))).toBe(false);
  });

  test("flags codex lifecycle and chunk noise", () => {
    expect(isTailNoiseEvent(event({
      source: "codex",
      summary: "turn context · gpt-5.5 · xhigh",
    }))).toBe(true);
    expect(isTailNoiseEvent(event({
      source: "codex",
      summary: "tokens · 30991816",
    }))).toBe(true);
    expect(isTailNoiseEvent(event({
      source: "codex",
      summary: "agent_message",
    }))).toBe(true);
    expect(isTailNoiseEvent(event({
      source: "codex",
      summary: "-> Chunk ID: 66c6a0 Wall time: 0.0000 seconds Process exited with code 0",
      kind: "tool-result",
    }))).toBe(true);
    expect(isTailNoiseEvent(event({
      source: "codex",
      summary: "task started",
    }))).toBe(false);
  });
});

describe("filterTailEventsForDisplay", () => {
  test("work mode drops grok streaming noise", () => {
    const rows = filterTailEventsForDisplay([
      event({ summary: "phase · streaming_text" }),
      event({ summary: "Read started", kind: "tool" }),
    ], "work");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("Read started");
  });
});

describe("observeToolFieldsFromTailEvent", () => {
  test("parses grok tool lifecycle summaries", () => {
    expect(observeToolFieldsFromTailEvent(event({ summary: "Read started", kind: "tool" }))).toEqual({
      tool: "Read",
      arg: "started",
    });
    expect(observeToolFieldsFromTailEvent(event({
      summary: "Shell completed · success",
      kind: "tool-result",
    }))).toEqual({
      tool: "Shell",
      arg: "completed",
      result: { outcome: "success" },
    });
    expect(observeToolFieldsFromTailEvent(event({
      summary: "Shell · curl -s http://127.0.0.1:43122/api/session-ref/test · success",
      kind: "tool-result",
    }))).toEqual({
      tool: "Shell",
      arg: "curl -s http://127.0.0.1:43122/api/session-ref/test",
      result: { outcome: "success" },
    });
  });

  test("classifies codex bare shell commands as bash with the full command line", () => {
    expect(observeToolFieldsFromTailEvent(event({
      source: "codex",
      summary: "sed -n '1,70p' crates/scoutd/src/main.rs",
      kind: "tool",
    }))).toEqual({
      tool: "bash",
      arg: "sed -n '1,70p' crates/scoutd/src/main.rs",
    });
    expect(observeToolFieldsFromTailEvent(event({
      source: "codex",
      summary: "sed -n '1,70p' crates/scoutd/src/main.rs -> res: use std::env; use std::fs; fn main() { println!(\"scoutd\"); (5 lines)",
      kind: "tool-result",
    }))).toEqual({
      tool: "bash",
      arg: "sed -n '1,70p' crates/scoutd/src/main.rs",
      result: { outcome: "success" },
      stream: ["use std::env; use std::fs; fn main() { println!(\"scoutd\"); (5 lines)"],
    });
  });

  test("parses codex-style function calls and plain summaries", () => {
    expect(observeToolFieldsFromTailEvent(event({
      source: "codex",
      summary: "Read({\"path\":\"README.md\"})",
      kind: "tool",
    }))).toEqual({
      tool: "Read",
      arg: "{\"path\":\"README.md\"}",
    });
    expect(observeToolFieldsFromTailEvent(event({
      source: "codex",
      summary: "exec_command({\"cmd\":\"git status --short\",\"workdir\":\"/repo\"})",
      kind: "tool",
    }))).toEqual({
      tool: "Shell",
      arg: "git status --short",
    });
    expect(observeToolFieldsFromTailEvent(event({
      source: "codex",
      summary: "exec_command({\"cmd\":\"npm --prefix packages/web run build:client\",\"workdir\":\"/Users/example/dev/openscout\",\"yield_time_ms\":1000,\"",
      kind: "tool",
    }))).toEqual({
      tool: "Shell",
      arg: "npm --prefix packages/web run build:client",
    });
    expect(observeToolFieldsFromTailEvent(event({
      source: "codex",
      summary: "apply_patch({\"patch\":\"*** Begin Patch\"})",
      kind: "tool",
    }))).toEqual({
      tool: "Edit",
      arg: "patch",
    });
    expect(observeToolFieldsFromTailEvent(event({
      source: "codex",
      summary: "grep foo",
      kind: "tool",
    }))).toEqual({ tool: "bash", arg: "grep foo" });
  });

  test("matches observe tool kinds case-insensitively", () => {
    expect(observeToolIsRead("Read")).toBe(true);
    expect(observeToolIsEdit("Write")).toBe(true);
    expect(observeToolIsEdit("read")).toBe(false);
  });

  test("recovers the snippet from Claude's space-separated tool summaries", () => {
    expect(observeToolFieldsFromTailEvent(event({
      source: "claude",
      summary: "Read views/scout-tail.tsx",
      kind: "tool",
    }))).toEqual({ tool: "Read", arg: "views/scout-tail.tsx" });
    expect(observeToolFieldsFromTailEvent(event({
      source: "claude",
      summary: "Edit broker/service.ts",
      kind: "tool",
    }))).toEqual({ tool: "Edit", arg: "broker/service.ts" });
    expect(observeToolFieldsFromTailEvent(event({
      source: "claude",
      summary: "Grep data-scout-skin",
      kind: "tool",
    }))).toEqual({ tool: "Grep", arg: "data-scout-skin" });
    expect(observeToolFieldsFromTailEvent(event({
      source: "claude",
      summary: "Task explore the codebase",
      kind: "tool",
    }))).toEqual({ tool: "Task", arg: "explore the codebase" });
  });

  test("treats a bare Claude tool name (no arg) as just the tool", () => {
    expect(observeToolFieldsFromTailEvent(event({
      source: "claude",
      summary: "TodoWrite",
      kind: "tool",
    }))).toEqual({ tool: "TodoWrite" });
  });

  test("classifies a bare Claude shell command as bash", () => {
    expect(observeToolFieldsFromTailEvent(event({
      source: "claude",
      summary: "./node_modules/.bin/tsc --noEmit",
      kind: "tool",
    }))).toEqual({ tool: "bash", arg: "./node_modules/.bin/tsc --noEmit" });
    expect(observeToolFieldsFromTailEvent(event({
      source: "claude",
      summary: "git status --short",
      kind: "tool",
    }))).toEqual({ tool: "bash", arg: "git status --short" });
  });

  test("surfaces the Claude tool-result preview and outcome", () => {
    expect(observeToolFieldsFromTailEvent(event({
      source: "claude",
      summary: "res: 0 errors",
      kind: "tool-result",
    }))).toEqual({
      tool: "res",
      arg: "0 errors",
      result: { outcome: "success" },
      stream: ["0 errors"],
    });
    expect(observeToolFieldsFromTailEvent(event({
      source: "claude",
      summary: "res: error: cannot find module 'foo'",
      kind: "tool-result",
    }))).toEqual({
      tool: "res",
      arg: "error: cannot find module 'foo'",
      result: { outcome: "error" },
      stream: ["error: cannot find module 'foo'"],
    });
    expect(observeToolFieldsFromTailEvent(event({
      source: "claude",
      summary: "res: done",
      kind: "tool-result",
    }))).toEqual({
      tool: "res",
      arg: "done",
      result: { outcome: "success" },
      stream: ["done"],
    });
  });

  test("parses Kimi clean-log tool calls and correlated results", () => {
    expect(observeToolFieldsFromTailEvent(event({
      source: "kimi",
      summary: "Read runtime/tail/service.ts",
      kind: "tool",
    }))).toEqual({ tool: "Read", arg: "runtime/tail/service.ts" });
    expect(observeToolFieldsFromTailEvent(event({
      source: "kimi",
      summary: "Read runtime/tail/service.ts -> res: export function refreshTailDiscovery",
      kind: "tool-result",
    }))).toEqual({
      tool: "Read",
      arg: "runtime/tail/service.ts",
      result: { outcome: "success" },
      stream: ["export function refreshTailDiscovery"],
    });
    expect(observeToolFieldsFromTailEvent(event({
      source: "kimi",
      summary: "git status --short -> res: M packages/runtime/src/tail/service.ts",
      kind: "tool-result",
    }))).toEqual({
      tool: "bash",
      arg: "git status --short",
      result: { outcome: "success" },
      stream: ["M packages/runtime/src/tail/service.ts"],
    });
  });
});

describe("tailObserveEventDetail", () => {
  test("prefers workspace context over raw attribution jargon", () => {
    expect(tailObserveEventDetail(event({ summary: "phase · waiting_for_model" }))).toBe(
      "openscout · native",
    );
    expect(tailObserveEventDetail(event({
      summary: "phase · waiting_for_model",
      harness: "scout-managed",
    }))).toBe("openscout · scout");
  });

  test("falls back to source when workspace context is missing", () => {
    expect(tailObserveEventDetail(event({
      summary: "phase · waiting_for_model",
      project: "",
      cwd: "",
    }))).toBe("grok · native");
  });

  test("omits detail for tool lifecycle rows", () => {
    expect(tailObserveEventDetail(event({ summary: "Read started", kind: "tool" }))).toBeUndefined();
  });
});

describe("observeKindFromTailEvent", () => {
  test("maps grok turns into note rows", () => {
    expect(observeKindFromTailEvent(event({
      summary: "turn 24 · grok-composer-2.5-fast",
    }))).toBe("note");
  });

  test("maps codex lifecycle and reasoning into lane-friendly kinds", () => {
    expect(observeKindFromTailEvent(event({
      source: "codex",
      summary: "task started",
    }))).toBe("note");
    expect(observeKindFromTailEvent(event({
      source: "codex",
      summary: "task complete",
    }))).toBe("note");
    expect(observeKindFromTailEvent(event({
      source: "codex",
      summary: "Need to inspect the broker path before changing lanes.",
      raw: { payload: { type: "reasoning" } },
    }))).toBe("think");
    expect(observeKindFromTailEvent(event({
      source: "codex",
      summary: "done",
      kind: "assistant",
    }))).toBe("message");
  });

  test("maps Kimi thinking into lane-friendly reasoning", () => {
    expect(observeKindFromTailEvent(event({
      source: "kimi",
      summary: "[thinking] Inspect the firehose registry first.",
    }))).toBe("think");
  });
});

describe("observeTextFromTailEvent", () => {
  test("renders codex shell tools and turn milestones as readable activity", () => {
    const fields = observeToolFieldsFromTailEvent(event({
      source: "codex",
      summary: "exec_command({\"cmd\":\"git status --short\"})",
      kind: "tool",
    }));
    expect(observeTextFromTailEvent(event({
      source: "codex",
      summary: "exec_command({\"cmd\":\"git status --short\"})",
      kind: "tool",
    }), fields)).toBe("Shell · git status --short");
    expect(observeTextFromTailEvent(event({
      source: "codex",
      summary: "task complete",
    }), {})).toBe("Turn complete");
  });

  test("renders Kimi thinking without its transport marker", () => {
    expect(observeTextFromTailEvent(event({
      source: "kimi",
      summary: "[thinking] Inspect the firehose registry first.",
    }), {})).toBe("Inspect the firehose registry first.");
  });
});

describe("tailAttributionLabel", () => {
  test("maps internal attribution enums to operator-facing labels", () => {
    expect(tailAttributionLabel("unattributed")).toBe("native");
    expect(tailAttributionLabel("scout-managed")).toBe("scout");
  });
});

describe("collapseTailDisplayRows", () => {
  test("merges consecutive identical session summaries", () => {
    const collapsed = collapseTailDisplayRows([
      { event: event({ id: "a", summary: "phase · streaming_text", ts: 1 }), meta: null },
      { event: event({ id: "b", summary: "phase · streaming_text", ts: 2 }), meta: null },
      { event: event({ id: "c", summary: "Read started", kind: "tool", ts: 3 }), meta: null },
    ]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]?.repeatCount).toBe(2);
    expect(collapsed[0]?.event.ts).toBe(2);
    expect(collapsed[1]?.repeatCount).toBe(1);
  });
});
