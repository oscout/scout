import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  linkSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TASK_TAIL_MAX_BYTES,
  DEFAULT_TASK_TAIL_MAX_SCAN_BYTES,
  MAX_TASK_TAIL_BYTES,
  MAX_TASK_TAIL_MESSAGES,
  TaskTailError,
  readTaskTail,
} from "./task-tail.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openscout-task-tail-"));
  tempRoots.add(root);
  return root;
}

function rolloutPath(root: string, taskId: string): string {
  return join(root, `rollout-2026-08-03T12-00-00-${taskId}.jsonl`);
}

function jsonl(records: Array<Record<string, unknown>>): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function sessionMeta(taskId: string): Record<string, unknown> {
  return {
    timestamp: "2026-08-03T12:00:00.000Z",
    type: "session_meta",
    payload: { id: taskId, cwd: "/tmp/project" },
  };
}

function taskStarted(turnId: string, second: number): Record<string, unknown> {
  return {
    timestamp: `2026-08-03T12:00:${String(second).padStart(2, "0")}.000Z`,
    type: "event_msg",
    payload: { type: "task_started", turn_id: turnId },
  };
}

function taskComplete(turnId: string, second: number): Record<string, unknown> {
  return {
    timestamp: `2026-08-03T12:00:${String(second).padStart(2, "0")}.900Z`,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId },
  };
}

function responseMessage(
  id: string,
  role: "user" | "assistant" | "developer" | "system",
  text: string,
  phase?: "commentary" | "final_answer",
): Record<string, unknown> {
  return {
    timestamp: "2026-08-03T12:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      id,
      role,
      content: [
        { type: role === "assistant" ? "output_text" : "input_text", text },
        { type: "input_image", image_url: `data:image/png;base64,${"a".repeat(512)}` },
      ],
      ...(phase ? { phase } : {}),
    },
  };
}

function eventMessage(
  type: "user_message" | "agent_message",
  text: string,
  phase?: "commentary" | "final_answer",
): Record<string, unknown> {
  return {
    timestamp: "2026-08-03T12:00:01.100Z",
    type: "event_msg",
    payload: { type, message: text, ...(phase ? { phase } : {}) },
  };
}

function expectTaskTailCode(action: () => unknown, code: TaskTailError["code"]): void {
  try {
    action();
    throw new Error(`Expected TaskTailError ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(TaskTailError);
    expect((error as TaskTailError).code).toBe(code);
  }
}

describe("readTaskTail", () => {
  test("normalizes canonical Codex messages and excludes mirrors, noise, prompts, and host metadata", () => {
    const root = tempRoot();
    const taskId = "task-normalize";
    const path = rolloutPath(root, taskId);
    const assistantWithHostMetadata = [
      "Done.",
      "",
      '::git-commit{cwd="/tmp/project"}',
      "<oai-mem-citation>",
      "<citation_entries>",
      "MEMORY.md:1-2|note=[hidden]",
      "</citation_entries>",
      "<rollout_ids>",
      taskId,
      "</rollout_ids>",
      "</oai-mem-citation>",
    ].join("\n");
    writeFileSync(path, jsonl([
      sessionMeta(taskId),
      taskStarted("turn-1", 1),
      responseMessage("developer-1", "developer", "Do not show this."),
      responseMessage("system-1", "system", "Do not show this either."),
      responseMessage("injected-1", "user", "<environment_context>hidden</environment_context>"),
      responseMessage("user-1", "user", "Inspect the repository."),
      eventMessage("user_message", "Inspect the repository."),
      eventMessage("agent_message", "Working on it.", "commentary"),
      responseMessage("commentary-1", "assistant", "Working on it.", "commentary"),
      {
        timestamp: "2026-08-03T12:00:02.000Z",
        type: "response_item",
        payload: { type: "reasoning", summary: [{ text: "private reasoning" }] },
      },
      {
        timestamp: "2026-08-03T12:00:03.000Z",
        type: "response_item",
        payload: { type: "function_call_output", output: "raw tool output" },
      },
      {
        timestamp: "2026-08-03T12:00:04.000Z",
        type: "compacted",
        payload: { replacement_history: [{ role: "assistant", text: "replacement secret" }] },
      },
      eventMessage("agent_message", assistantWithHostMetadata, "final_answer"),
      responseMessage("assistant-1", "assistant", assistantWithHostMetadata, "final_answer"),
      taskComplete("turn-1", 5),
    ]));

    const first = readTaskTail({ path, expectedTaskId: taskId });
    const repeated = readTaskTail({ path, expectedTaskId: taskId });

    expect(first.adapterType).toBe("codex");
    expect(first.taskId).toBe(taskId);
    expect(first.messages).toEqual([
      {
        id: "user-1",
        role: "user",
        text: "Inspect the repository.",
        timestamp: "2026-08-03T12:00:01.000Z",
        turnId: "turn-1",
      },
      {
        id: "assistant-1",
        role: "assistant",
        text: "Done.",
        timestamp: "2026-08-03T12:00:01.000Z",
        turnId: "turn-1",
      },
    ]);
    expect(JSON.stringify(first.messages)).not.toContain("base64");
    expect(JSON.stringify(first.messages)).not.toContain("reasoning");
    expect(JSON.stringify(first.messages)).not.toContain("raw tool output");
    expect(JSON.stringify(first.messages)).not.toContain("replacement secret");
    expect(first.cursor).toBe(repeated.cursor);
    expect(first.source.bytesRead).toBeLessThanOrEqual(DEFAULT_TASK_TAIL_MAX_BYTES);
  });

  test("reads only newly completed records from a forward cursor and carries the adjacent turn id", () => {
    const root = tempRoot();
    const taskId = "task-forward";
    const path = rolloutPath(root, taskId);
    writeFileSync(path, jsonl([sessionMeta(taskId)]));
    const initial = readTaskTail({ path, expectedTaskId: taskId });

    const started = `${JSON.stringify(taskStarted("turn-forward", 2))}\n`;
    const partialUser = JSON.stringify(responseMessage("user-forward", "user", "New question."));
    writeFileSync(path, `${started}${partialUser}`, { flag: "a" });

    const partial = readTaskTail({
      path,
      expectedTaskId: taskId,
      cursor: initial.cursor,
    });
    expect(partial.messages).toEqual([]);

    writeFileSync(path, `\n${jsonl([
      eventMessage("user_message", "New question."),
      eventMessage("agent_message", "Final answer.", "final_answer"),
      {
        ...responseMessage("assistant-forward", "assistant", "Final answer.", "final_answer"),
        payload: {
          ...(responseMessage("assistant-forward", "assistant", "Final answer.", "final_answer").payload as Record<string, unknown>),
          internal_chat_message_metadata_passthrough: { turn_id: "turn-forward" },
        },
      },
      taskComplete("turn-forward", 4),
    ])}`, { flag: "a" });

    const next = readTaskTail({
      path,
      expectedTaskId: taskId,
      cursor: partial.cursor,
    });
    expect(next.messages.map((message) => [message.id, message.role, message.text, message.turnId])).toEqual([
      ["user-forward", "user", "New question.", "turn-forward"],
      ["assistant-forward", "assistant", "Final answer.", "turn-forward"],
    ]);

    const empty = readTaskTail({ path, expectedTaskId: taskId, cursor: next.cursor });
    expect(empty.messages).toEqual([]);
    expect(empty.cursor).toBe(next.cursor);
  });

  test("paginates forward messages without advancing past a withheld message", () => {
    const root = tempRoot();
    const taskId = "task-pagination";
    const path = rolloutPath(root, taskId);
    writeFileSync(path, jsonl([sessionMeta(taskId)]));
    const initial = readTaskTail({ path, expectedTaskId: taskId });
    writeFileSync(path, jsonl([
      taskStarted("turn-a", 1),
      responseMessage("user-a", "user", "Question A"),
      responseMessage("assistant-a", "assistant", "Answer A", "final_answer"),
      taskComplete("turn-a", 2),
      taskStarted("turn-b", 3),
      responseMessage("user-b", "user", "Question B"),
      responseMessage("assistant-b", "assistant", "Answer B", "final_answer"),
      taskComplete("turn-b", 4),
    ]), { flag: "a" });

    let cursor = initial.cursor;
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const page = readTaskTail({ path, cursor, expectedTaskId: taskId, maxMessages: 1 });
      expect(page.messages).toHaveLength(1);
      expect(page.truncated).toBe(index < 3);
      ids.push(page.messages[0]!.id);
      cursor = page.cursor;
    }
    expect(ids).toEqual(["user-a", "assistant-a", "user-b", "assistant-b"]);
    expect(readTaskTail({ path, cursor, expectedTaskId: taskId }).messages).toEqual([]);
  });

  test("projects injected app context down to the user's actual request", () => {
    const root = tempRoot();
    const taskId = "task-context";
    const path = rolloutPath(root, taskId);
    writeFileSync(path, jsonl([
      sessionMeta(taskId),
      responseMessage(
        "context-user",
        "user",
        "<environment_context>\n  <current_date>2026-08-03</current_date>\n</environment_context>\nShow the trailing messages.",
      ),
      responseMessage(
        "browser-user",
        "user",
        "# Browser comments:\nUntrusted evidence\n\n## My request for Codex:\nFix the selected control.",
      ),
    ]));

    expect(readTaskTail({ path }).messages.map((message) => message.text)).toEqual([
      "Show the trailing messages.",
      "Fix the selected control.",
    ]);
  });

  test("advances across an oversized non-message record without wedging the cursor", () => {
    const root = tempRoot();
    const taskId = "task-oversized-record";
    const path = rolloutPath(root, taskId);
    writeFileSync(path, jsonl([sessionMeta(taskId)]));
    let page = readTaskTail({ path, maxScanBytes: 64 * 1024 });
    writeFileSync(path, jsonl([
      {
        timestamp: "2026-08-03T12:00:01.000Z",
        type: "response_item",
        payload: { type: "function_call_output", output: "x".repeat(384 * 1024) },
      },
      responseMessage("after-tool", "assistant", "After the tool.", "final_answer"),
    ]), { flag: "a" });

    for (let attempt = 0; attempt < 10 && page.messages.length === 0; attempt += 1) {
      page = readTaskTail({ path, cursor: page.cursor, maxScanBytes: 64 * 1024 });
    }
    expect(page.messages.map((message) => message.id)).toEqual(["after-tool"]);
  });

  test("fails closed for replacement, truncation, task mismatch, corrupt cursors, and invalid offsets", () => {
    const root = tempRoot();
    const taskId = "task-errors";
    const path = rolloutPath(root, taskId);
    writeFileSync(path, jsonl([sessionMeta(taskId), responseMessage("user-1", "user", "Hello") ]));

    expectTaskTailCode(
      () => readTaskTail({ path, expectedTaskId: "wrong-task" }),
      "TASK_MISMATCH",
    );

    const initial = readTaskTail({ path, expectedTaskId: taskId });
    expectTaskTailCode(
      () => readTaskTail({ path, cursor: `${initial.cursor}x` }),
      "CURSOR_INVALID",
    );

    const [prefix, version, body] = initial.cursor.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as Record<string, unknown>;
    payload.offset = 1;
    const tamperedBody = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const checksum = createHash("sha256")
      .update("@openscout/agent-sessions/task-tail-cursor\0")
      .update(tamperedBody)
      .digest("base64url");
    const invalidOffsetCursor = `${prefix}.${version}.${tamperedBody}.${checksum}`;
    expectTaskTailCode(
      () => readTaskTail({ path, cursor: invalidOffsetCursor }),
      "CURSOR_OFFSET_INVALID",
    );

    const hardLinkPath = rolloutPath(root, "different-task");
    linkSync(path, hardLinkPath);
    expectTaskTailCode(
      () => readTaskTail({ path: hardLinkPath, cursor: initial.cursor }),
      "CURSOR_TASK_MISMATCH",
    );

    truncateSync(path, 0);
    expectTaskTailCode(
      () => readTaskTail({ path, cursor: initial.cursor }),
      "SOURCE_TRUNCATED",
    );

    writeFileSync(path, jsonl([sessionMeta(taskId)]));
    const replacementCursor = readTaskTail({ path }).cursor;
    renameSync(path, `${path}.old`);
    writeFileSync(path, jsonl([sessionMeta(taskId)]));
    expectTaskTailCode(
      () => readTaskTail({ path, cursor: replacementCursor }),
      "SOURCE_REPLACED",
    );
  });

  test("rejects unsupported adapters and limits above the hard maxima", () => {
    const root = tempRoot();
    const taskId = "task-limits";
    const path = rolloutPath(root, taskId);
    writeFileSync(path, jsonl([sessionMeta(taskId)]));

    expectTaskTailCode(
      () => readTaskTail({ path, maxMessages: MAX_TASK_TAIL_MESSAGES + 1 }),
      "LIMIT_EXCEEDED",
    );
    expectTaskTailCode(
      () => readTaskTail({ path, maxBytes: MAX_TASK_TAIL_BYTES + 1 }),
      "LIMIT_EXCEEDED",
    );
    expectTaskTailCode(
      () => readTaskTail({ path, adapterType: "claude-code" }),
      "ADAPTER_UNSUPPORTED",
    );
  });

  test("returns a deterministic marked suffix for one final assistant message larger than maxBytes", () => {
    const root = tempRoot();
    const taskId = "task-oversized-message";
    const path = rolloutPath(root, taskId);
    const turnId = "turn-oversized";
    const oversizedText = `BEGIN-${"x".repeat(DEFAULT_TASK_TAIL_MAX_BYTES * 4)}-END`;
    writeFileSync(path, jsonl([
      sessionMeta(taskId),
      taskStarted(turnId, 1),
      {
        timestamp: "2026-08-03T12:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "assistant-oversized",
          role: "assistant",
          content: [{ type: "output_text", text: oversizedText }],
          phase: "final_answer",
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      },
    ]));

    const first = readTaskTail({ path, expectedTaskId: taskId });
    const repeated = readTaskTail({ path, expectedTaskId: taskId });
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({
      role: "assistant",
      turnId,
      truncated: true,
    });
    expect(first.messages[0]!.text.endsWith("-END")).toBe(true);
    expect(first.messages[0]!.text).not.toContain("BEGIN-");
    expect(Buffer.byteLength(first.messages[0]!.text, "utf8")).toBeLessThanOrEqual(
      DEFAULT_TASK_TAIL_MAX_BYTES,
    );
    expect(first.messages).toEqual(repeated.messages);
    expect(first.cursor).toBe(repeated.cursor);
    expect(first.source.bytesRead).toBeLessThanOrEqual(DEFAULT_TASK_TAIL_MAX_SCAN_BYTES + 4 * 1024);
  });

  test("returns the last 20 messages from a synthetic 200 MiB rollout within the source-byte budget", () => {
    const root = tempRoot();
    const taskId = "019fc8ff-1111-7222-8333-444444444444";
    const path = rolloutPath(root, taskId);
    const targetSize = 200 * 1024 * 1024;
    const hugeToolOutputBytes = 3 * 1024 * 1024;
    const records: Array<Record<string, unknown>> = [{
      timestamp: "2026-08-03T12:00:00.500Z",
      type: "compacted",
      payload: { replacement_history: "COMPACTION-MUST-NOT-APPEAR".repeat(2_048) },
    }];
    for (let index = 0; index < 10; index += 1) {
      const turnId = `turn-${index}`;
      const userText = `Question ${index}`;
      const assistantText = `Answer ${index}`;
      records.push(
        taskStarted(turnId, index + 1),
        responseMessage(`user-${index}`, "user", userText),
        eventMessage("user_message", userText),
        eventMessage("agent_message", assistantText, "final_answer"),
        responseMessage(`assistant-${index}`, "assistant", assistantText, "final_answer"),
        taskComplete(turnId, index + 1),
      );
    }
    const tail = Buffer.from(jsonl(records), "utf8");
    const toolPrefix = Buffer.from(
      '{"timestamp":"2026-08-03T11:59:59.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"huge-tool","output":"',
      "utf8",
    );
    const toolSuffix = Buffer.from('"}}\n', "utf8");
    const bodySize = 1 + toolPrefix.length + hugeToolOutputBytes + toolSuffix.length + tail.length;
    const bodyStart = targetSize - bodySize;
    expect(bodyStart).toBeGreaterThan(Buffer.byteLength(JSON.stringify(sessionMeta(taskId)), "utf8"));

    const fd = openSync(path, "w+");
    try {
      writeSync(fd, Buffer.from(`${JSON.stringify(sessionMeta(taskId))}\n`, "utf8"), 0);
      ftruncateSync(fd, bodyStart);
      let position = bodyStart;
      position += writeSync(fd, Buffer.from("\n", "utf8"), 0, 1, position);
      position += writeSync(fd, toolPrefix, 0, toolPrefix.length, position);
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      for (let remaining = hugeToolOutputBytes; remaining > 0;) {
        const length = Math.min(remaining, chunk.length);
        position += writeSync(fd, chunk, 0, length, position);
        remaining -= length;
      }
      position += writeSync(fd, toolSuffix, 0, toolSuffix.length, position);
      position += writeSync(fd, tail, 0, tail.length, position);
      expect(position).toBe(targetSize);
    } finally {
      closeSync(fd);
    }

    const result = readTaskTail({ path, expectedTaskId: taskId });
    const evidence = {
      fileBytes: result.source.fileSize,
      sourceBytesRead: result.source.bytesRead,
      sourceBudget: DEFAULT_TASK_TAIL_MAX_SCAN_BYTES + 4 * 1024,
      messages: result.messages.length,
    };
    console.info(`[bounded-task-tail] ${JSON.stringify(evidence)}`);

    expect(evidence.fileBytes).toBe(targetSize);
    expect(evidence.messages).toBe(20);
    expect(evidence.sourceBytesRead).toBeLessThanOrEqual(evidence.sourceBudget);
    expect(result.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => [`user-${index}`, `assistant-${index}`]).flat(),
    );
    expect(JSON.stringify(result.messages)).not.toContain("COMPACTION-MUST-NOT-APPEAR");
    expect(JSON.stringify(result.messages)).not.toContain("huge-tool");
    expect(result.truncated).toBe(true);
  });
});
