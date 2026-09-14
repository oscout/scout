import { expect, test } from "bun:test";
import { watchAgentReply, type ReplyWatchState } from "./agent-reply-watch.ts";
import type { Message } from "../../lib/types.ts";

function clock() {
  let now = 0;
  const tasks = new Set<{ at: number; fn: () => void }>();
  return {
    schedule(fn: () => void, delay: number) {
      const task = { at: now + delay, fn };
      tasks.add(task);
      return () => { tasks.delete(task); };
    },
    async advance(ms: number) {
      const until = now + ms;
      while (true) {
        const next = [...tasks].filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        tasks.delete(next);
        next.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = until;
    },
    pending: () => tasks.size,
  };
}
const message = (id: string, createdAt: number, kind = "agent") => ({ id, createdAt, class: kind, body: id }) as Message;

test("selects the earliest eligible reply across both API row orders, including same-millisecond reply", async () => {
  for (const reverse of [false, true]) {
    const c = clock(); const states: ReplyWatchState[] = [];
    const messages = [message("old", 99), message("operator", 101, "human"), message("first", 100), message("later", 103)];
    watchAgentReply(100, async () => reverse ? messages.reverse() : messages, (s) => states.push(s), c.schedule);
    await c.advance(2500);
    expect(states.map((s) => s.status)).toEqual(["waiting", "received"]);
    expect(states.at(-1)?.reply?.id).toBe("first");
    expect(c.pending()).toBe(0);
  }
});

test("transient failure retries, then arrival stops future polling", async () => {
  const c = clock(); let calls = 0; const states: ReplyWatchState[] = [];
  watchAgentReply(0, async () => { if (++calls === 1) throw new Error("offline"); return [message("reply", 1)]; }, (s) => states.push(s), c.schedule);
  await c.advance(300_000);
  expect(calls).toBe(2);
  expect(states.at(-1)?.status).toBe("received");
  expect(c.pending()).toBe(0);
});

test("empty conversation expires after five minutes and stops polling", async () => {
  const c = clock(); const states: ReplyWatchState[] = []; let calls = 0;
  watchAgentReply(0, async () => { calls++; return []; }, (s) => states.push(s), c.schedule);
  await c.advance(299_999);
  expect(states.at(-1)?.status).toBe("waiting");
  await c.advance(1);
  expect(states.at(-1)?.status).toBe("timed-out");
  const before = calls;
  await c.advance(300_000);
  expect(calls).toBe(before);
  expect(c.pending()).toBe(0);
});

test("stalled request expires independently and late completion cannot replace timeout", async () => {
  const c = clock(); const states: ReplyWatchState[] = [];
  let complete!: (messages: Message[]) => void;
  let requestSignal!: AbortSignal;
  watchAgentReply(0, (signal) => new Promise((resolve) => { requestSignal = signal; complete = resolve; }), (s) => states.push(s), c.schedule);
  await c.advance(300_000);
  expect(states.at(-1)?.status).toBe("timed-out");
  expect(requestSignal.aborted).toBe(true);
  complete([message("late", 1)]);
  await Promise.resolve();
  expect(states.map((s) => s.status)).toEqual(["waiting", "timed-out"]);
  expect(c.pending()).toBe(0);
});

test("cancel on close or target change suppresses in-flight replies and clears timers", async () => {
  const c = clock(); const states: ReplyWatchState[] = [];
  let complete!: (messages: Message[]) => void;
  let requestSignal!: AbortSignal;
  const cancel = watchAgentReply(0, (signal) => new Promise((resolve) => { requestSignal = signal; complete = resolve; }), (s) => states.push(s), c.schedule);
  await c.advance(2500);
  expect(requestSignal.aborted).toBe(false);
  cancel();
  expect(requestSignal.aborted).toBe(true);
  complete([message("stale", 1)]);
  await Promise.resolve();
  await c.advance(300_000);
  expect(states.map((s) => s.status)).toEqual(["waiting"]);
  expect(c.pending()).toBe(0);
});
