import { describe, expect, test } from "bun:test";

import { StateTracker } from "../../state.js";
import type { AgentSessionStreamEvent } from "../../protocol/primitives.js";
import { createOpenCodeV2EventNormalizer } from "./normalizer.js";
import type { OpenCodeEvent } from "./upstream.js";

const SESSION_ID = "scout-session";
const REMOTE_SESSION_ID = "ses_v2";
const ASSISTANT_MESSAGE_ID = "msg_assistant";

function durableV1(id: string, seq: number) {
  return {
    id,
    created: 1_754_000_000_000 + seq,
    durable: {
      aggregateID: REMOTE_SESSION_ID,
      seq,
      version: 1 as const,
    },
  };
}

function durableV2(id: string, seq: number) {
  return {
    id,
    created: 1_754_000_000_000 + seq,
    durable: {
      aggregateID: REMOTE_SESSION_ID,
      seq,
      version: 2 as const,
    },
  };
}

function createHarness() {
  let replaySequence = 0;
  let generatedId = 0;
  const normalizer = createOpenCodeV2EventNormalizer(
    {
      sessionId: SESSION_ID,
      now: () => "2026-08-11T12:00:00.000Z",
      nextId: (kind) => `${kind}-${++generatedId}`,
    },
    { remoteSessionId: REMOTE_SESSION_ID },
  );
  const tracker = new StateTracker();
  tracker.createSession(SESSION_ID, {
    id: SESSION_ID,
    name: "OpenCode V2 test",
    adapterType: "opencode-v2",
    status: "active",
  });
  const events: AgentSessionStreamEvent[] = [];

  const track = (next: readonly AgentSessionStreamEvent[]) => {
    for (const event of next) {
      events.push(event);
      tracker.trackEvent(SESSION_ID, event);
    }
    return next;
  };

  return {
    normalizer,
    tracker,
    events,
    prompt(turnId = `turn-${generatedId + 1}`) {
      return track(normalizer.ingest({
        source: "adapter_control",
        sequence: replaySequence++,
        event: "prompt_accepted",
        turnId,
        payload: { remoteSessionId: REMOTE_SESSION_ID },
      }));
    },
    native(event: OpenCodeEvent) {
      return track(normalizer.ingest({
        source: "harness",
        sequence: replaySequence++,
        payload: event,
      }));
    },
  };
}

describe("OpenCodeV2EventNormalizer", () => {
  test("filters other sessions, deduplicates event ids, and does not append a final text snapshot twice", () => {
    const harness = createHarness();
    harness.prompt("turn-text");

    const foreignDelta = {
      id: "evt-foreign",
      created: 1_754_000_000_001,
      type: "session.text.delta",
      data: {
        sessionID: "ses_someone_else",
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        ordinal: 0,
        delta: "not ours",
      },
    } satisfies OpenCodeEvent;
    expect(harness.native(foreignDelta)).toEqual([]);

    const started = {
      ...durableV1("evt-text-started", 1),
      type: "session.text.started",
      data: {
        sessionID: REMOTE_SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        ordinal: 0,
      },
    } satisfies OpenCodeEvent;
    const delta = {
      id: "evt-text-delta",
      created: 1_754_000_000_002,
      type: "session.text.delta",
      data: {
        sessionID: REMOTE_SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        ordinal: 0,
        delta: "Hel",
      },
    } satisfies OpenCodeEvent;
    const ended = {
      ...durableV1("evt-text-ended", 3),
      type: "session.text.ended",
      data: {
        sessionID: REMOTE_SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        ordinal: 0,
        text: "Hello",
      },
    } satisfies OpenCodeEvent;

    harness.native(started);
    harness.native(delta);
    expect(harness.native(delta)).toEqual([]);
    harness.native(ended);
    expect(harness.native(ended)).toEqual([]);

    const succeeded = {
      ...durableV1("evt-execution-succeeded", 4),
      type: "session.execution.succeeded",
      data: { sessionID: REMOTE_SESSION_ID },
    } satisfies OpenCodeEvent;
    harness.native(succeeded);
    expect(harness.native(succeeded)).toEqual([]);

    const lateIdle = {
      id: "evt-late-idle",
      created: 1_754_000_000_005,
      type: "session.idle",
      data: { sessionID: REMOTE_SESSION_ID },
    } satisfies OpenCodeEvent;
    expect(harness.native(lateIdle)).toEqual([]);

    const state = harness.tracker.getSessionState(SESSION_ID);
    const turn = state?.turns[0];
    const textBlock = turn?.blocks.find(({ block }) => block.type === "text")?.block;
    expect(textBlock).toMatchObject({ type: "text", text: "Hello", status: "completed" });
    expect(turn?.status).toBe("completed");
    expect(harness.events.filter((event) => event.event === "turn:end")).toHaveLength(1);
    expect(
      harness.events
        .filter((event) => event.event === "block:delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Hello");
  });

  test("normalizes terminal tools, durable tool output files, and step file paths", () => {
    const harness = createHarness();
    harness.prompt("turn-tool");

    const inputStarted = {
      ...durableV1("evt-tool-input-started", 10),
      type: "session.tool.input.started",
      data: {
        sessionID: REMOTE_SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        id: "tool-1",
        name: "terminal",
      },
    } satisfies OpenCodeEvent;
    const inputDelta = {
      id: "evt-tool-input-delta",
      created: 1_754_000_000_011,
      type: "session.tool.input.delta",
      data: {
        sessionID: REMOTE_SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        id: "tool-1",
        delta: "{\"command\":\"printf hi\"}",
      },
    } satisfies OpenCodeEvent;
    const inputEnded = {
      ...durableV1("evt-tool-input-ended", 12),
      type: "session.tool.input.ended",
      data: {
        sessionID: REMOTE_SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        id: "tool-1",
        text: "{\"command\":\"printf hi\"}",
      },
    } satisfies OpenCodeEvent;
    const called = {
      ...durableV1("evt-tool-called", 13),
      type: "session.tool.called",
      data: {
        sessionID: REMOTE_SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        id: "tool-1",
        input: { command: "printf hi" },
        executed: true,
      },
    } satisfies OpenCodeEvent;
    const progress = {
      id: "evt-tool-progress",
      created: 1_754_000_000_014,
      type: "session.tool.progress",
      data: {
        sessionID: REMOTE_SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        id: "tool-1",
        metadata: { shellID: "shell-1" },
      },
    } satisfies OpenCodeEvent;
    const success = {
      ...durableV2("evt-tool-success", 15),
      type: "session.tool.success",
      data: {
        sessionID: REMOTE_SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        id: "tool-1",
        content: [
          { type: "text", text: "hi" },
          { type: "file", uri: "file:///workspace/output.log", mime: "text/plain", name: "output.log" },
        ],
        metadata: { exitCode: 0 },
        executed: true,
      },
    } satisfies OpenCodeEvent;
    const stepEnded = {
      ...durableV1("evt-step-ended", 16),
      type: "session.step.ended",
      data: {
        sessionID: REMOTE_SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        finish: "stop",
        cost: 0.001,
        tokens: { input: 5, output: 3, reasoning: 0, cache: { read: 1, write: 0 } },
        files: ["src/changed.ts"],
      },
    } satisfies OpenCodeEvent;
    const succeeded = {
      ...durableV1("evt-tool-turn-succeeded", 17),
      type: "session.execution.succeeded",
      data: { sessionID: REMOTE_SESSION_ID },
    } satisfies OpenCodeEvent;

    harness.native(inputStarted);
    harness.native(inputDelta);
    harness.native(inputEnded);
    harness.native(called);
    expect(harness.native(progress)).toEqual([]);
    harness.native(success);
    harness.native(stepEnded);
    harness.native(succeeded);

    const turn = harness.tracker.getSessionState(SESSION_ID)?.turns[0];
    const actionBlock = turn?.blocks.find(({ block }) => block.type === "action")?.block;
    expect(actionBlock).toMatchObject({
      type: "action",
      status: "completed",
      action: {
        kind: "command",
        command: "printf hi",
        status: "completed",
        output: "hi",
      },
    });

    const files = turn?.blocks
      .map(({ block }) => block)
      .filter((block) => block.type === "file");
    expect(files).toEqual([
      expect.objectContaining({
        type: "file",
        name: "output.log",
        mimeType: "text/plain",
        data: "file:///workspace/output.log",
        status: "completed",
      }),
      expect.objectContaining({
        type: "file",
        name: "src/changed.ts",
        mimeType: "application/octet-stream",
        data: "src/changed.ts",
        status: "completed",
      }),
    ]);
    expect(turn?.status).toBe("completed");
  });

  test("maps succeeded, interrupted, failed, and idle terminal edges exactly once", () => {
    const completed = createHarness();
    completed.prompt("turn-completed");
    completed.native({
      ...durableV1("evt-completed", 20),
      type: "session.execution.succeeded",
      data: { sessionID: REMOTE_SESSION_ID },
    } satisfies OpenCodeEvent);
    expect(completed.tracker.getSessionState(SESSION_ID)?.turns[0]?.status).toBe("completed");

    const interrupted = createHarness();
    interrupted.prompt("turn-interrupted");
    const interruptedEvent = {
      ...durableV1("evt-interrupted", 21),
      type: "session.execution.interrupted",
      data: { sessionID: REMOTE_SESSION_ID, reason: "user" },
    } satisfies OpenCodeEvent;
    interrupted.native(interruptedEvent);
    expect(interrupted.native(interruptedEvent)).toEqual([]);
    expect(interrupted.tracker.getSessionState(SESSION_ID)?.turns[0]?.status).toBe("interrupted");

    const failed = createHarness();
    failed.prompt("turn-failed");
    failed.native({
      ...durableV1("evt-failed", 22),
      type: "session.execution.failed",
      data: {
        sessionID: REMOTE_SESSION_ID,
        error: { type: "ProviderError", message: "provider exploded", status: 502 },
      },
    } satisfies OpenCodeEvent);
    const failedTurn = failed.tracker.getSessionState(SESSION_ID)?.turns[0];
    expect(failedTurn?.status).toBe("error");
    expect(failedTurn?.blocks.map(({ block }) => block)).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "provider exploded (ProviderError)",
        status: "completed",
      }),
    );
    expect(failed.events).toContainEqual(expect.objectContaining({
      event: "turn:error",
      message: "provider exploded (ProviderError)",
    }));

    const idle = createHarness();
    idle.prompt("turn-idle-fallback");
    idle.native({
      id: "evt-idle",
      created: 1_754_000_000_023,
      type: "session.idle",
      data: { sessionID: REMOTE_SESSION_ID },
    } satisfies OpenCodeEvent);
    expect(idle.tracker.getSessionState(SESSION_ID)?.turns[0]?.status).toBe("completed");
  });

  test("settles permission replies once and retires the native request mapping", () => {
    const harness = createHarness();
    harness.prompt("turn-permission");
    harness.native({
      id: "evt-permission-asked",
      created: 1_754_000_000_030,
      type: "permission.asked",
      data: {
        id: "permission-1",
        sessionID: REMOTE_SESSION_ID,
        action: "bash",
        resources: ["echo safe"],
        source: { type: "tool", messageID: ASSISTANT_MESSAGE_ID, id: "tool-permission" },
      },
    } satisfies OpenCodeEvent);
    const blockId = harness.normalizer.permissionBlockId("permission-1");
    expect(blockId).toBeTruthy();

    const first = harness.normalizer.resolvePermission("permission-1", "approve");
    expect(first).toContainEqual(expect.objectContaining({
      event: "block:action:status",
      status: "running",
    }));
    expect(harness.normalizer.resolvePermission("permission-1", "approve")).toEqual([]);
    expect(harness.normalizer.permissionRequestForBlock(blockId!)).toBeUndefined();

    expect(harness.native({
      id: "evt-permission-replied",
      created: 1_754_000_000_031,
      type: "permission.replied",
      data: {
        sessionID: REMOTE_SESSION_ID,
        requestID: "permission-1",
        reply: "once",
      },
    } satisfies OpenCodeEvent)).toEqual([]);

    const nextPermission = harness.native({
      id: "evt-permission-asked-again",
      created: 1_754_000_000_032,
      type: "permission.asked",
      data: {
        id: "permission-2",
        sessionID: REMOTE_SESSION_ID,
        action: "bash",
        resources: ["echo again"],
        source: { type: "tool", messageID: ASSISTANT_MESSAGE_ID, id: "tool-permission" },
      },
    } satisfies OpenCodeEvent);
    expect(nextPermission).toContainEqual(expect.objectContaining({
      event: "block:action:approval",
      blockId,
      approval: expect.objectContaining({ version: 2 }),
    }));
  });

  test("keeps a denied permission block open through the durable tool failure", () => {
    const harness = createHarness();
    harness.prompt("turn-permission-denied");
    harness.native({
      id: "evt-permission-denied-asked",
      created: 1_754_000_000_040,
      type: "permission.asked",
      data: {
        id: "permission-denied",
        sessionID: REMOTE_SESSION_ID,
        action: "bash",
        resources: ["dangerous-command"],
        source: {
          type: "tool",
          messageID: ASSISTANT_MESSAGE_ID,
          id: "tool-denied",
        },
      },
    } satisfies OpenCodeEvent);
    const blockId = harness.normalizer.permissionBlockId("permission-denied");
    expect(blockId).toBeTruthy();

    const denied = harness.normalizer.resolvePermission("permission-denied", "deny");
    expect(denied).toContainEqual(expect.objectContaining({
      event: "block:action:status",
      blockId,
      status: "failed",
    }));
    expect(denied.some((event) => event.event === "block:end")).toBe(false);

    const terminal = harness.native({
      ...durableV2("evt-tool-denied-failed", 41),
      type: "session.tool.failed",
      data: {
        sessionID: REMOTE_SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        id: "tool-denied",
        error: { type: "PermissionDenied", message: "operator denied tool" },
        content: [{ type: "text", text: "not executed" }],
        executed: false,
      },
    } satisfies OpenCodeEvent);
    expect(terminal.map((event) => event.event)).toEqual([
      "block:action:output",
      "block:action:status",
      "block:end",
    ]);
    expect(terminal).toContainEqual(expect.objectContaining({
      event: "block:action:output",
      blockId,
      output: "not executed\noperator denied tool (PermissionDenied)",
    }));
  });
});
