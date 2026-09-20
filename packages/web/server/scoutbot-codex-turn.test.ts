import { expect, test } from "bun:test";
import { runScoutbotCodexTurn } from "./scoutbot-codex-turn.ts";
import type { CodexAppServerSessionOptions } from "@openscout/agent-sessions/local";

const optionsFor = (id: string, signal: AbortSignal, onDelta: (delta: string) => void): CodexAppServerSessionOptions => ({
  agentName: "mock", sessionId: id, cwd: "/tmp", systemPrompt: "test",
  runtimeDirectory: "/tmp/not-created", logsDirectory: "/tmp/not-created",
  signal, onDelta, sandbox: "read-only", approvalPolicy: "never",
});

for (const outcome of ["success", "failure", "timeout", "abort"] as const) {
  test(`isolated Codex ${outcome} retires its owned client and fences late deltas`, async () => {
    const controller = new AbortController();
    let captured!: CodexAppServerSessionOptions;
    let shutdown = 0;
    const sentences: string[] = [];
    const promise = runScoutbotCodexTurn({ sessionId: "chat", prompt: "test", systemPrompt: "test",
      signal: controller.signal, timeoutMs: 10, onDelta: (s) => sentences.push(s),
    }, optionsFor, (options) => {
      captured = options;
      return {
        invoke: async () => {
          options.onDelta?.("Current. ");
          if (outcome === "success") return { output: "Current.", threadId: "t" };
          if (outcome === "failure") throw new Error("failed");
          return new Promise(() => {});
        },
        shutdown: async (options) => { shutdown++; expect(options?.resetThread).toBe(true); },
      };
    });
    if (outcome === "abort") controller.abort();
    if (outcome === "success") expect((await promise).output).toBe("Current.");
    else if (outcome === "timeout") await expect(promise).rejects.toMatchObject({ code: "REQUESTER_WAIT_TIMEOUT" });
    else await expect(promise).rejects.toThrow();
    captured.onDelta?.("Late. ");
    expect(sentences).toEqual(["Current. "]);
    expect(captured.signal?.aborted).toBe(true);
    expect(shutdown).toBe(1);
  });
}

test("simultaneous calls in a logical chat have separate lifetime signals and IDs", async () => {
  const captured: CodexAppServerSessionOptions[] = [];
  const a = new AbortController();
  let finishB!: () => void;
  const factory = (options: CodexAppServerSessionOptions) => {
    captured.push(options);
    return { invoke: async () => {
      if (captured.length === 1) return new Promise<{ output: string; threadId: string }>(() => {});
      await new Promise<void>((resolve) => { finishB = resolve; });
      return { output: "B", threadId: "b" };
    }, shutdown: async () => {} };
  };
  const first = runScoutbotCodexTurn({ sessionId: "chat", prompt: "A", systemPrompt: "test", signal: a.signal }, optionsFor, factory);
  const second = runScoutbotCodexTurn({ sessionId: "chat", prompt: "B", systemPrompt: "test" }, optionsFor, factory);
  a.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  expect(captured[0]!.sessionId).not.toBe(captured[1]!.sessionId);
  expect(captured[1]!.signal?.aborted).toBe(false);
  finishB();
  expect((await second).output).toBe("B");
});


test("cleanup errors are explicit terminal retirement failures", async () => {
  await expect(runScoutbotCodexTurn({ sessionId: "chat", prompt: "test", systemPrompt: "test" }, optionsFor, () => ({
    invoke: async () => ({ output: "Done.", threadId: "t" }),
    shutdown: async () => { throw new Error("cannot retire"); },
  }))).rejects.toMatchObject({ code: "SCOUTBOT_AGENT_CLEANUP_FAILED" });
});
