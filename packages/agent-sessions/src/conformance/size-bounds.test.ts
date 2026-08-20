import { describe, expect, test } from "bun:test";
import { createCodexEventNormalizer } from "../adapters/codex/normalizer.js";
import { createClaudeCodeEventNormalizer } from "../adapters/claude-code/normalizer.js";
import { createOpenCodeV2EventNormalizer } from "../adapters/opencode-v2/normalizer.js";
import {
  MAX_ACTION_OUTPUT_EVENT_UTF8_BYTES,
  MAX_DIAGNOSTIC_UTF8_BYTES,
  MAX_SESSION_EVENT_UTF8_BYTES,
  truncateUtf8,
  utf8ByteLength,
  type AdapterReplayRecord,
} from "../protocol/normalizer.js";
import type { AgentSessionStreamEvent, Session } from "../protocol/primitives.js";
import { StateTracker } from "../state.js";

function createNormalizer() {
  const times = [
    "2026-08-07T20:00:00.000Z",
    "2026-08-07T20:00:01.000Z",
  ];
  let nextTime = 0;
  let nextBlock = 0;
  return createCodexEventNormalizer({
    sessionId: "size-bound-session",
    now: () => times[nextTime++] ?? times.at(-1)!,
    nextId: (kind) => `${kind}-${++nextBlock}`,
  });
}

function replay(records: AdapterReplayRecord[]): AgentSessionStreamEvent[] {
  const normalizer = createNormalizer();
  return records.flatMap((record) => normalizer.ingest(record));
}

describe("SCO-042 event size bounds (C009)", () => {
  test("truncateUtf8 never splits a multi-byte scalar", () => {
    const value = `ab${"🙂".repeat(4)}`;
    const result = truncateUtf8(value, 5);
    expect(result.text).toBe("ab");
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(5);
    expect(result.omittedBytes).toBe(16);
  });

  test("bounds repeated Codex action output and preserves exact omission metadata", () => {
    const firstOutput = "a".repeat(70 * 1024);
    const secondOutput = "b".repeat(70 * 1024);
    const events = replay([
      {
        source: "harness",
        sequence: 0,
        payload: {
          method: "turn/started",
          params: { turn: { id: "turn-large", status: "inProgress" } },
        },
      },
      {
        source: "harness",
        sequence: 1,
        payload: {
          method: "item/started",
          params: {
            turnId: "turn-large",
            item: { id: "command-large", type: "commandExecution", command: ["fixture"] },
          },
        },
      },
      {
        source: "harness",
        sequence: 2,
        payload: {
          method: "item/commandExecution/outputDelta",
          params: { turnId: "turn-large", itemId: "command-large", delta: firstOutput },
        },
      },
      {
        source: "harness",
        sequence: 3,
        payload: {
          method: "item/commandExecution/outputDelta",
          params: { turnId: "turn-large", itemId: "command-large", delta: secondOutput },
        },
      },
      {
        source: "harness",
        sequence: 4,
        payload: {
          method: "turn/completed",
          params: { turn: { id: "turn-large", status: "completed" } },
        },
      },
    ]);

    for (const event of events) {
      expect(utf8ByteLength(JSON.stringify(event))).toBeLessThanOrEqual(
        MAX_SESSION_EVENT_UTF8_BYTES,
      );
    }

    const outputEvents = events.filter(
      (event): event is Extract<AgentSessionStreamEvent, { event: "block:action:output" }> =>
        event.event === "block:action:output",
    );
    expect(outputEvents.map((event) => event.truncation?.omittedBytes)).toEqual([
      10 * 1024,
      70 * 1024,
    ]);

    const tracker = new StateTracker();
    const session: Session = {
      id: "size-bound-session",
      name: "size-bound-session",
      adapterType: "codex",
      status: "active",
    };
    tracker.createSession(session.id, session);
    const immutableSnapshot = JSON.stringify(events);
    for (const event of events) tracker.trackEvent(session.id, event);
    expect(JSON.stringify(events)).toBe(immutableSnapshot);

    const action = tracker.getSessionState(session.id)?.turns[0]?.blocks.find(
      (entry) => entry.block.type === "action",
    )?.block;
    expect(action?.type).toBe("action");
    if (action?.type !== "action") throw new Error("Expected an action block");
    expect(utf8ByteLength(action.action.output)).toBe(MAX_ACTION_OUTPUT_EVENT_UTF8_BYTES);
    expect(action.action.truncation).toEqual({
      omittedBytes: 80 * 1024,
      maxRetainedBytes: 64 * 1024,
      sourceRef: "block:command-large",
    });
  });

  test("bounds diagnostic text and records its omitted bytes", () => {
    const message = "x".repeat(10 * 1024);
    const events = replay([
      {
        source: "harness",
        sequence: 0,
        payload: {
          method: "turn/started",
          params: { turn: { id: "turn-error", status: "inProgress" } },
        },
      },
      {
        source: "adapter_control",
        sequence: 1,
        event: "transport_error",
        payload: { message },
      },
    ]);
    const errorStart = events.find(
      (event) => event.event === "block:start" && event.block.type === "error",
    );
    expect(errorStart?.event).toBe("block:start");
    if (errorStart?.event !== "block:start" || errorStart.block.type !== "error") {
      throw new Error("Expected an error block");
    }
    expect(utf8ByteLength(errorStart.block.message)).toBe(MAX_DIAGNOSTIC_UTF8_BYTES);
    expect(errorStart.block.truncation).toEqual({
      omittedBytes: 6 * 1024,
      maxRetainedBytes: MAX_DIAGNOSTIC_UTF8_BYTES,
      sourceRef: "turn:turn-error",
    });
  });

  test("chunks oversized assistant text below the event limit", () => {
    const text = "x".repeat(80 * 1024);
    const codex = createNormalizer();
    const codexEvents = [
      ...codex.ingest({
        source: "harness",
        sequence: 0,
        payload: {
          method: "turn/started",
          params: { turn: { id: "turn-text", status: "inProgress" } },
        },
      }),
      ...codex.ingest({
        source: "harness",
        sequence: 1,
        payload: {
          method: "item/completed",
          params: {
            turnId: "turn-text",
            item: { id: "message-large", type: "agentMessage", text },
          },
        },
      }),
    ];

    let nextId = 0;
    const claude = createClaudeCodeEventNormalizer({
      sessionId: "size-bound-session",
      now: () => "2026-08-07T20:00:00.000Z",
      nextId: (kind) => `${kind}-${++nextId}`,
    });
    const claudeEvents = [
      ...claude.ingest({
        source: "adapter_control",
        sequence: 0,
        event: "prompt_accepted",
        turnId: "turn-text",
      }),
      ...claude.ingest({
        source: "harness",
        sequence: 1,
        payload: { type: "assistant", message: { content: [{ type: "text", text }] } },
      }),
    ];

    for (const event of [...codexEvents, ...claudeEvents]) {
      expect(utf8ByteLength(JSON.stringify(event))).toBeLessThanOrEqual(
        MAX_SESSION_EVENT_UTF8_BYTES,
      );
    }
    const codexText = codexEvents
      .filter((event) => event.event === "block:delta")
      .map((event) => event.text)
      .join("");
    const claudeText = claudeEvents
      .filter((event) => event.event === "block:delta")
      .map((event) => event.text)
      .join("");
    expect(codexText).toBe(text);
    expect(claudeText).toBe(text);
  });

  test("replaces oversized opaque tool input with source-linked truncation metadata", () => {
    let nextId = 0;
    const normalizer = createClaudeCodeEventNormalizer({
      sessionId: "size-bound-session",
      now: () => "2026-08-07T20:00:00.000Z",
      nextId: (kind) => `${kind}-${++nextId}`,
    });
    const events = [
      ...normalizer.ingest({
        source: "adapter_control",
        sequence: 0,
        event: "prompt_accepted",
        turnId: "turn-tool",
      }),
      ...normalizer.ingest({
        source: "harness",
        sequence: 1,
        payload: {
          type: "tool_use",
          id: "tool-large",
          name: "CustomTool",
          input: { value: "x".repeat(80 * 1024) },
        },
      }),
    ];

    for (const event of events) {
      expect(utf8ByteLength(JSON.stringify(event))).toBeLessThanOrEqual(
        MAX_SESSION_EVENT_UTF8_BYTES,
      );
    }
    const actionStart = events.find(
      (event) => event.event === "block:start" && event.block.type === "action",
    );
    expect(actionStart?.event).toBe("block:start");
    if (actionStart?.event !== "block:start" || actionStart.block.type !== "action") {
      throw new Error("Expected an action block");
    }
    expect(actionStart.block.action.kind).toBe("tool_call");
    if (actionStart.block.action.kind !== "tool_call") {
      throw new Error("Expected a tool-call action");
    }
    expect(actionStart.block.action.input).toEqual({
      truncated: true,
      omittedBytes: 80 * 1024 + 12,
      maxRetainedBytes: 0,
      sourceRef: "tool:tool-large:input",
    });
  });

  test("bounds large structured action fields with truncation metadata", () => {
    const codex = createNormalizer();
    const codexEvents = [
      ...codex.ingest({
        source: "harness",
        sequence: 0,
        payload: {
          method: "turn/started",
          params: { turn: { id: "turn-action", status: "inProgress" } },
        },
      }),
      ...codex.ingest({
        source: "harness",
        sequence: 1,
        payload: {
          method: "item/started",
          params: {
            turnId: "turn-action",
            item: {
              id: "file-large",
              type: "fileChange",
              filePath: "large.txt",
              diff: "x".repeat(80 * 1024),
            },
          },
        },
      }),
    ];

    let nextId = 0;
    const claude = createClaudeCodeEventNormalizer({
      sessionId: "size-bound-session",
      now: () => "2026-08-07T20:00:00.000Z",
      nextId: (kind) => `${kind}-${++nextId}`,
    });
    const claudeEvents = [
      ...claude.ingest({
        source: "adapter_control",
        sequence: 0,
        event: "prompt_accepted",
        turnId: "turn-action",
      }),
      ...claude.ingest({
        source: "harness",
        sequence: 1,
        payload: {
          type: "tool_use",
          id: "bash-large",
          name: "Bash",
          input: { command: "x".repeat(80 * 1024) },
        },
      }),
    ];

    for (const event of [...codexEvents, ...claudeEvents]) {
      expect(utf8ByteLength(JSON.stringify(event))).toBeLessThanOrEqual(
        MAX_SESSION_EVENT_UTF8_BYTES,
      );
    }
    const starts = [...codexEvents, ...claudeEvents].filter(
      (event) => event.event === "block:start" && event.block.type === "action",
    );
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      if (start.event !== "block:start" || start.block.type !== "action") continue;
      expect(start.block.action.truncation?.omittedBytes).toBeGreaterThan(0);
      expect(start.block.action.truncation?.sourceRef).toBeTruthy();
    }
  });

  test("accounts for JSON escaping when bounding action output events", () => {
    const output = `"\\\u0000`.repeat(30 * 1024);
    const events = replay([
      {
        source: "harness",
        sequence: 0,
        payload: {
          method: "turn/started",
          params: { turn: { id: "turn-escaped", status: "inProgress" } },
        },
      },
      {
        source: "harness",
        sequence: 1,
        payload: {
          method: "item/started",
          params: {
            turnId: "turn-escaped",
            item: { id: "command-escaped", type: "commandExecution", command: ["fixture"] },
          },
        },
      },
      {
        source: "harness",
        sequence: 2,
        payload: {
          method: "item/commandExecution/outputDelta",
          params: { turnId: "turn-escaped", itemId: "command-escaped", delta: output },
        },
      },
    ]);

    for (const event of events) {
      expect(utf8ByteLength(JSON.stringify(event))).toBeLessThanOrEqual(
        MAX_SESSION_EVENT_UTF8_BYTES,
      );
    }
    const emitted = events.filter((event) => event.event === "block:action:output");
    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.at(-1)?.truncation?.sourceRef).toBe("block:command-escaped");
  });

  test("bounds OpenCode V2 structured tools, metadata, files, questions, and diagnostics", () => {
    let nextId = 0;
    const normalizer = createOpenCodeV2EventNormalizer({
      sessionId: "size-bound-opencode-v2",
      now: () => "2026-08-11T12:00:00.000Z",
      nextId: (kind) => `${kind}-${++nextId}`,
    });
    const large = "x".repeat(100 * 1024);
    const records: AdapterReplayRecord[] = [
      {
        source: "adapter_control",
        sequence: 0,
        event: "prompt_accepted",
        turnId: "turn-opencode-large",
        payload: { remoteSessionId: "ses-opencode-large" },
      },
      {
        source: "harness",
        sequence: 1,
        payload: {
          id: "evt-tool-input",
          type: "session.tool.input.started",
          data: {
            sessionID: "ses-opencode-large",
            assistantMessageID: "msg-assistant",
            id: "tool-large",
            name: "terminal",
          },
        },
      },
      {
        source: "harness",
        sequence: 2,
        payload: {
          id: "evt-tool-called",
          type: "session.tool.called",
          data: {
            sessionID: "ses-opencode-large",
            assistantMessageID: "msg-assistant",
            id: "tool-large",
            input: { command: large },
            executed: true,
          },
        },
      },
      {
        source: "harness",
        sequence: 3,
        payload: {
          id: "evt-tool-success",
          type: "session.tool.success",
          data: {
            sessionID: "ses-opencode-large",
            assistantMessageID: "msg-assistant",
            id: "tool-large",
            content: [{ type: "file", uri: `data:text/plain;base64,${large}`, mime: large, name: large }],
            metadata: { large },
            executed: true,
          },
        },
      },
      {
        source: "harness",
        sequence: 4,
        payload: {
          id: "evt-question",
          type: "question.asked",
          data: {
            sessionID: "ses-opencode-large",
            id: "question-large",
            questions: [{
              header: large,
              question: large,
              options: Array.from({ length: 100 }, (_, index) => ({
                label: `${index}:${large}`,
                description: large,
              })),
            }],
          },
        },
      },
      {
        source: "harness",
        sequence: 5,
        payload: {
          id: "evt-execution-failed",
          type: "session.execution.failed",
          data: {
            sessionID: "ses-opencode-large",
            error: { type: "ProviderError", message: large },
          },
        },
      },
    ];
    const events = records.flatMap((record) => normalizer.ingest(record));
    for (const event of events) {
      expect(utf8ByteLength(JSON.stringify(event))).toBeLessThanOrEqual(
        MAX_SESSION_EVENT_UTF8_BYTES,
      );
    }
    const actionStart = events.find(
      (event) => event.event === "block:start" && event.block.type === "action",
    );
    expect(actionStart?.event).toBe("block:start");
    if (actionStart?.event !== "block:start" || actionStart.block.type !== "action") {
      throw new Error("Expected bounded OpenCode action block");
    }
    expect(actionStart.block.action.truncation?.omittedBytes).toBeGreaterThan(0);

    const status = events.find((event) => event.event === "block:action:status");
    expect(status?.event).toBe("block:action:status");
    if (status?.event !== "block:action:status") throw new Error("Expected action status");
    expect(status.meta).toMatchObject({ truncated: true });

    const errorStart = events.find(
      (event) => event.event === "block:start" && event.block.type === "error",
    );
    expect(errorStart?.event).toBe("block:start");
    if (errorStart?.event !== "block:start" || errorStart.block.type !== "error") {
      throw new Error("Expected bounded OpenCode error block");
    }
    expect(errorStart.block.truncation?.omittedBytes).toBeGreaterThan(0);
  });
});
