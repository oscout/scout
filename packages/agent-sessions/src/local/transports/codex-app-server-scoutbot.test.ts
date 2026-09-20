import { expect, test } from "bun:test";
import { CodexAppServerClient, type CodexAppServerSessionOptions } from "./codex-app-server.ts";

test("active turn deltas keep their owner when queued invocation updates session options", async () => {
  const a: string[] = [], b: string[] = [];
  const options: CodexAppServerSessionOptions = { agentName: "mock", sessionId: "mock", cwd: "/tmp",
    runtimeDirectory: "/tmp/not-created", logsDirectory: "/tmp/not-created", systemPrompt: "test", onDelta: (s) => a.push(s) };
  // Only in-memory transport methods are replaced: never spawn a process.
  const client = new CodexAppServerClient(options) as any;
  client.transport.ensureOnline = async () => {};
  Object.defineProperty(client.transport, "currentThreadId", { get: () => "thread" });
  let count = 0;
  client.transport.startTurn = async () => ({ turn: { id: `t${++count}` } });
  const first = client.invoke("A");
  client.update({ ...options, onDelta: (s: string) => b.push(s) });
  const second = client.invoke("B");
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const delta = (turnId: string, text: string) => client.handleNotification({ method: "item/agentMessage/delta", params: { turnId, itemId: "i", delta: text } });
  const complete = (id: string) => client.handleNotification({ method: "turn/completed", params: { turn: { id, status: "completed" } } });
  await tick(); delta("t1", "A"); complete("t1");
  expect((await first).output).toBe("A");
  await tick(); delta("t2", "B"); complete("t2");
  expect((await second).output).toBe("B");
  expect(a).toEqual(["A"]); expect(b).toEqual(["B"]);
});

test("pre-aborted lifetime never attempts transport startup", async () => {
  const owner = new AbortController(); owner.abort();
  const client = new CodexAppServerClient({ agentName: "mock", sessionId: "mock", cwd: "/tmp",
    runtimeDirectory: "/tmp/not-created", logsDirectory: "/tmp/not-created", systemPrompt: "test", signal: owner.signal }) as any;
  let started = false;
  client.transport.ensureOnline = async () => { started = true; };
  await expect(client.invoke("test")).rejects.toMatchObject({ name: "AbortError" });
  expect(started).toBe(false);
});


test("unstreamed active turn does not borrow a later callback", async () => {
  const seen: string[] = [];
  const options: CodexAppServerSessionOptions = { agentName: "mock", sessionId: "mock", cwd: "/tmp",
    runtimeDirectory: "/tmp/not-created", logsDirectory: "/tmp/not-created", systemPrompt: "test" };
  const client = new CodexAppServerClient(options) as any;
  client.transport.ensureOnline = async () => {};
  Object.defineProperty(client.transport, "currentThreadId", { get: () => "thread" });
  client.transport.startTurn = async () => ({ turn: { id: "t" } });
  const pending = client.invoke("plain");
  client.update({ ...options, onDelta: (s: string) => seen.push(s) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.handleNotification({ method: "item/agentMessage/delta", params: { turnId: "t", itemId: "i", delta: "plain" } });
  client.handleNotification({ method: "turn/completed", params: { turn: { id: "t", status: "completed" } } });
  await pending;
  expect(seen).toEqual([]);
});

test("abort while ensureOnline is pending never starts a turn", async () => {
  const owner = new AbortController();
  const client = new CodexAppServerClient({ agentName: "mock", sessionId: "mock", cwd: "/tmp",
    runtimeDirectory: "/tmp/not-created", logsDirectory: "/tmp/not-created", systemPrompt: "test", signal: owner.signal }) as any;
  let ready!: () => void;
  let started = false;
  client.transport.ensureOnline = () => new Promise<void>((resolve) => { ready = resolve; });
  client.transport.startTurn = async () => { started = true; return { turn: { id: "t" } }; };
  const pending = client.invoke("test");
  await Promise.resolve(); owner.abort(); ready();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(started).toBe(false);
});
