import { expect, test } from "bun:test";
import { LiveDelegationContext, boundedLiveCommentary } from "./live-delegation.ts";

const pause = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
test("notice before split transcript waits and preserves assistant clarification context", async () => {
  const tasks: string[] = [];
  const context = new LiveDelegationContext(async task => { tasks.push(task.request); }, () => {});
  try {
    context.transcript("assistant", "Should I open Blink?", 0, 100);
    context.delegation("opaque/one", 140);
    await pause(50);
    context.transcript("user", "Yes, ", 100, 160);
    await pause(100);
    context.transcript("user", "open it.", 160, 220);
    await pause();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toContain("Should I open Blink?");
    expect(tasks[0]).toContain("Yes, open it.");
    context.delegation("opaque/two", 230);
    await pause(); expect(tasks).toHaveLength(1);
  } finally { context.stop(); }
});

test("correction and stop invalidate in-flight work and prevent queued actions", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active: (() => boolean) | undefined;
  let signal: AbortSignal | undefined;
  let effects = 0;
  const context = new LiveDelegationContext(async task => {
    active = task.isCurrent; signal = task.signal; await gate;
    if (task.isCurrent()) effects++;
  }, () => {});
  context.transcript("user", "Ask A to deploy", 0, 100);
  context.delegation("first", 100); await pause();
  expect(active?.()).toBe(true);
  context.transcript("user", "Cancel that", 100, 200);
  expect(signal?.aborted).toBe(true); expect(active?.()).toBe(false);
  context.delegation("second", 200); context.stop(); release(); await pause();
  expect(effects).toBe(0);
});

test("byte ceiling preserves failure outcome before long multilingual content", () => {
  const failure = "Delivery failed. Check the activity log. ";
  const content = boundedLiveCommentary(failure + "中文🙂".repeat(1000));
  expect(content.startsWith(failure)).toBe(true);
  expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(400);
  expect(content).not.toContain("�");
});

test("two fresh requests get distinct revisions and do not reuse old request text as new", async () => {
  const tasks: string[] = [];
  const context = new LiveDelegationContext(async task => { tasks.push(task.request); }, () => {});
  try {
    context.transcript("user","Open project A",0,100); context.delegation("one",100); await pause();
    context.transcript("assistant","Project A is open",100,200);
    context.transcript("user","Now show project B",200,300); context.delegation("two",300); await pause();
    expect(tasks).toHaveLength(2);
    expect(tasks[1]?.split("Latest unhandled user speech (only this may request new work):\n")[1]).toBe("Now show project B");
  } finally { context.stop(); }
});
