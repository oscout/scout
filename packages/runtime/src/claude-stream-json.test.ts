import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  buildClaudeStreamJsonSessionSnapshot,
  ensureClaudeStreamJsonAgentOnline,
  invokeClaudeStreamJsonAgent,
  resolveClaudeStreamJsonOutput,
  shutdownClaudeStreamJsonAgent,
} from "./claude-stream-json";

const tempPaths = new Set<string>();
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  delete process.env.OPENSCOUT_CLAUDE_BIN;

  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function writeFakeClaudeExecutable(baseDirectory: string): string {
  const executablePath = join(baseDirectory, "claude");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
let turnIndex = 0;

console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-test-session" }));

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const content = message?.message?.content;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  turnIndex += 1;
  const currentTurn = turnIndex;
  if (currentTurn === 1) {
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  console.log(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: \`draft \${currentTurn}: \${text}\` }] },
  }));
  console.log(JSON.stringify({ type: "result", result: \`reply \${currentTurn}: \${text}\` }));
}
`);
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function writeFakeClaudeExecutableWithResult(baseDirectory: string, resultEvent: Record<string, unknown>): string {
  const executablePath = join(baseDirectory, "claude");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-test-session" }));

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  console.log(JSON.stringify(${JSON.stringify(resultEvent)}));
}
`);
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function writeFakeClaudeExecutableWithStaleResumeRecovery(baseDirectory: string): string {
  const executablePath = join(baseDirectory, "claude");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import readline from "node:readline";

const args = process.argv.slice(2);
const staleResume = args.includes("--resume");
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

if (!staleResume) {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fresh-claude-session" }));
}

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  if (staleResume) {
    console.log(JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["No conversation found with session ID: stale-claude-session"],
    }));
    continue;
  }

  const message = JSON.parse(trimmed);
  const content = message?.message?.content;
  console.log(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: \`recovered: \${content}\` }] },
  }));
  console.log(JSON.stringify({ type: "result", result: \`recovered: \${content}\` }));
}
`);
  chmodSync(executablePath, 0o755);
  return executablePath;
}

describe("resolveClaudeStreamJsonOutput", () => {
  test("prefers the final result payload over earlier assistant text", () => {
    const output = resolveClaudeStreamJsonOutput(
      "Final answer",
      ["Let me research this.", " Interim note."],
    );

    expect(output).toBe("Final answer");
  });

  test("falls back to accumulated assistant text when the result payload is empty", () => {
    const output = resolveClaudeStreamJsonOutput(
      "   ",
      ["First part.", " Second part."],
    );

    expect(output).toBe("First part. Second part.");
  });
});

describe("invokeClaudeStreamJsonAgent", () => {
  test("queues a second invocation behind the active stream-json turn", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-claude-queue-test-"));
    tempPaths.add(tempRoot);
    const fakeClaude = writeFakeClaudeExecutable(tempRoot);
    process.env.OPENSCOUT_CLAUDE_BIN = fakeClaude;
    process.env.PATH = [tempRoot, originalPath ?? ""].filter(Boolean).join(delimiter);

    const options = {
      agentName: "hudson-copy-affordances",
      sessionId: "relay-hudson-copy-affordances",
      cwd: process.cwd(),
      systemPrompt: "You are a test Claude relay agent.",
      runtimeDirectory: join(tempRoot, "runtime"),
      logsDirectory: join(tempRoot, "logs"),
      launchArgs: [],
    } as const;

    await ensureClaudeStreamJsonAgentOnline(options);
    const first = invokeClaudeStreamJsonAgent({
      ...options,
      prompt: "first prompt",
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = invokeClaudeStreamJsonAgent({
      ...options,
      prompt: "second prompt",
      timeoutMs: 5_000,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { output: "reply 1: first prompt", sessionId: "claude-test-session" },
      { output: "reply 2: second prompt", sessionId: "claude-test-session" },
    ]);

    await shutdownClaudeStreamJsonAgent(options);
  });

  test("rejects stream-json result errors instead of returning empty output", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-claude-error-test-"));
    tempPaths.add(tempRoot);
    const fakeClaude = writeFakeClaudeExecutableWithResult(tempRoot, {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["No conversation found with session ID: claude-test-session"],
    });
    process.env.OPENSCOUT_CLAUDE_BIN = fakeClaude;
    process.env.PATH = [tempRoot, originalPath ?? ""].filter(Boolean).join(delimiter);

    const options = {
      agentName: "hudson-error-result",
      sessionId: "relay-hudson-error-result",
      cwd: process.cwd(),
      systemPrompt: "You are a test Claude relay agent.",
      runtimeDirectory: join(tempRoot, "runtime"),
      logsDirectory: join(tempRoot, "logs"),
      launchArgs: [],
    } as const;

    await ensureClaudeStreamJsonAgentOnline(options);
    await expect(invokeClaudeStreamJsonAgent({
      ...options,
      prompt: "trigger error",
      timeoutMs: 5_000,
    })).rejects.toThrow("No conversation found with session ID");

    await shutdownClaudeStreamJsonAgent(options);
  });

  test("resets stale Claude resume ids and retries once", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-claude-stale-resume-test-"));
    tempPaths.add(tempRoot);
    const fakeClaude = writeFakeClaudeExecutableWithStaleResumeRecovery(tempRoot);
    process.env.OPENSCOUT_CLAUDE_BIN = fakeClaude;
    process.env.PATH = [tempRoot, originalPath ?? ""].filter(Boolean).join(delimiter);

    const runtimeDirectory = join(tempRoot, "runtime");
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(join(runtimeDirectory, "session-catalog.json"), JSON.stringify({
      activeSessionId: "stale-claude-session",
      sessions: [{ id: "stale-claude-session", startedAt: 1, cwd: process.cwd() }],
    }));

    const options = {
      agentName: "hudson-stale-resume",
      sessionId: "relay-hudson-stale-resume",
      cwd: process.cwd(),
      systemPrompt: "You are a test Claude relay agent.",
      runtimeDirectory,
      logsDirectory: join(tempRoot, "logs"),
      launchArgs: [],
    } as const;

    await expect(invokeClaudeStreamJsonAgent({
      ...options,
      prompt: "retry prompt",
      timeoutMs: 5_000,
    })).resolves.toEqual({
      output: "recovered: retry prompt",
      sessionId: "fresh-claude-session",
    });

    await shutdownClaudeStreamJsonAgent(options);
  });

  test("reset shutdown creates a missing runtime directory catalog", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-claude-missing-runtime-test-"));
    tempPaths.add(tempRoot);
    const runtimeDirectory = join(tempRoot, "missing", "runtime");
    const options = {
      agentName: "hudson-missing-runtime",
      sessionId: "relay-hudson-missing-runtime",
      cwd: process.cwd(),
      systemPrompt: "You are a test Claude relay agent.",
      runtimeDirectory,
      logsDirectory: join(tempRoot, "logs"),
      launchArgs: [],
    } as const;

    await expect(shutdownClaudeStreamJsonAgent(options, { resetSession: true })).resolves.toBeUndefined();

    const catalog = JSON.parse(readFileSync(join(runtimeDirectory, "session-catalog.json"), "utf8")) as {
      activeSessionId?: string | null;
      sessions?: unknown[];
    };
    expect(catalog).toEqual({ activeSessionId: null, sessions: [] });
  });

  test("rejects completed stream-json turns with no visible output", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-claude-empty-test-"));
    tempPaths.add(tempRoot);
    const fakeClaude = writeFakeClaudeExecutableWithResult(tempRoot, {
      type: "result",
      subtype: "success",
      result: "",
    });
    process.env.OPENSCOUT_CLAUDE_BIN = fakeClaude;
    process.env.PATH = [tempRoot, originalPath ?? ""].filter(Boolean).join(delimiter);

    const options = {
      agentName: "hudson-empty-result",
      sessionId: "relay-hudson-empty-result",
      cwd: process.cwd(),
      systemPrompt: "You are a test Claude relay agent.",
      runtimeDirectory: join(tempRoot, "runtime"),
      logsDirectory: join(tempRoot, "logs"),
      launchArgs: [],
    } as const;

    await ensureClaudeStreamJsonAgentOnline(options);
    await expect(invokeClaudeStreamJsonAgent({
      ...options,
      prompt: "trigger empty",
      timeoutMs: 5_000,
    })).rejects.toThrow("completed without broker-visible output");

    await shutdownClaudeStreamJsonAgent(options);
  });
});

describe("buildClaudeStreamJsonSessionSnapshot", () => {
  test("projects reasoning and pending AskUserQuestion blocks from stream-json history", () => {
    const raw = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-session-1",
        cwd: "/repo",
        model: "claude-sonnet-4-6",
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-session-1",
        event: {
          type: "message_start",
          message: { id: "msg-1" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-session-1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-session-1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Need an answer." },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-session-1",
        event: { type: "content_block_stop", index: 0 },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-session-1",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_question_1",
            name: "AskUserQuestion",
            input: {},
          },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-session-1",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: "{\"questions\":[{\"header\":\"Mode\",\"question\":\"Choose one\",\"options\":[{\"label\":\"Ship\"},{\"label\":\"Wait\"}],\"multiSelect\":false}]}",
          },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-session-1",
        event: { type: "content_block_stop", index: 1 },
      }),
    ].join("\n");

    const snapshot = buildClaudeStreamJsonSessionSnapshot(raw, {
      agentName: "reviewer",
      sessionId: "relay-reviewer",
      cwd: "/repo",
    }, "claude-session-1");

    expect(snapshot).not.toBeNull();
    expect(snapshot?.session.model).toBe("claude-sonnet-4-6");
    expect(snapshot?.turns).toHaveLength(1);
    expect(snapshot?.turns[0]?.blocks).toHaveLength(2);
    expect(snapshot?.turns[0]?.blocks[0]?.block.type).toBe("reasoning");
    expect(snapshot?.turns[0]?.blocks[0]?.block.type === "reasoning" && snapshot.turns[0].blocks[0].block.text).toBe("Need an answer.");
    expect(snapshot?.turns[0]?.blocks[1]?.block.type).toBe("question");
    if (snapshot?.turns[0]?.blocks[1]?.block.type === "question") {
      expect(snapshot.turns[0].blocks[1].block.id).toBe("toolu_question_1");
      expect(snapshot.turns[0].blocks[1].block.questionStatus).toBe("awaiting_answer");
      expect(snapshot.turns[0].blocks[1].block.options.map((option) => option.label)).toEqual(["Ship", "Wait"]);
    }
  });

  test("ignores non-global history lines without a session id after the target session is known", () => {
    const raw = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-session-1",
        cwd: "/repo",
        model: "claude-sonnet-4-6",
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "wrong session bleed" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-session-1",
        event: {
          type: "message_start",
          message: { id: "msg-1" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-session-1",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "kept" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-session-1",
        event: {
          type: "content_block_stop",
          index: 0,
        },
      }),
    ].join("\n");

    const snapshot = buildClaudeStreamJsonSessionSnapshot(raw, {
      agentName: "reviewer",
      sessionId: "relay-reviewer",
      cwd: "/repo",
    }, "claude-session-1");

    expect(snapshot).not.toBeNull();
    expect(snapshot?.turns).toHaveLength(1);
    expect(snapshot?.turns[0]?.blocks).toHaveLength(1);
    expect(snapshot?.turns[0]?.blocks[0]?.block.type).toBe("text");
    expect(snapshot?.turns[0]?.blocks[0]?.block.type === "text" && snapshot.turns[0].blocks[0].block.text).toBe("kept");
  });
});
