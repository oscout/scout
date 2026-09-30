import { expect, test } from "bun:test";
import { ChatSendLimiter } from "./chat-send-limiter.ts";
test("bursts recover with time and another actor has an independent allowance", () => {
  let now = 0;
  const limit = new ChatSendLimiter(() => now, 2);
  expect(limit.take("alex")).toBe(0); expect(limit.take("alex")).toBe(0);
  expect(limit.take("alex")).toBe(1); expect(limit.take("maya")).toBe(0);
  now = 500; expect(limit.take("alex")).toBe(1);
  now = 1000; expect(limit.take("alex")).toBe(0);
  now = 900; expect(limit.take("alex")).toBe(1);
  now = 2000; expect(limit.take("alex")).toBe(0);
});
test("identity storage is bounded without evicting active buckets", () => {
  let now = 0;
  const limit = new ChatSendLimiter(() => now, 1, 1000, 1);
  expect(limit.take("alex")).toBe(0); expect(limit.take("maya")).toBe(1);
  expect(limit.take("alex")).toBe(1);
  now = 1000; expect(limit.take("maya")).toBe(0);
});
