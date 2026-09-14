import { expect, test } from "bun:test";
import { createBrokerMessageFanout } from "./broker-message-fanout.ts";
import type { ScoutWatchOptions } from "../../../broker/service.ts";

test("many peers share one stream and the last disconnect releases it", async () => {
  const streams: ScoutWatchOptions[] = [];
  const watch = createBrokerMessageFanout(async (options) => {
    streams.push(options);
    await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
  });
  let received = 0;
  const peers = Array.from({ length: 100 }, () => new AbortController());
  const waits = peers.map((peer) => watch({ allConversations: true, signal: peer.signal, onMessage: () => received++ }));
  await Promise.resolve();
  expect(streams).toHaveLength(1);
  streams[0]!.onMessage({ id: "message" } as never);
  expect(received).toBe(100);
  peers.slice(0, -1).forEach((peer) => peer.abort());
  expect(streams[0]!.signal!.aborted).toBe(false);
  peers.at(-1)!.abort();
  await Promise.all(waits);
  expect(streams[0]!.signal!.aborted).toBe(true);
});

test("an old stream finishing cannot close a replacement stream", async () => {
  const streams: ScoutWatchOptions[] = [];
  const finishes: Array<() => void> = [];
  const watch = createBrokerMessageFanout(async (options) => {
    streams.push(options);
    await new Promise<void>((resolve) => finishes.push(resolve));
  });
  const first = new AbortController();
  const a = watch({ allConversations: true, signal: first.signal, onMessage() {} });
  await Promise.resolve();
  first.abort();
  const second = new AbortController();
  const b = watch({ allConversations: true, signal: second.signal, onMessage() {} });
  await Promise.resolve();
  finishes[0]!();
  await Bun.sleep(0);
  expect(streams[1]!.signal!.aborted).toBe(false);
  second.abort();
  finishes[1]!();
  await Promise.all([a, b]);
});

test("a failing peer does not prevent delivery to healthy peers", async () => {
  let stream: ScoutWatchOptions;
  const watch = createBrokerMessageFanout(async (options) => {
    stream = options;
    await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
  });
  const failed = watch({ allConversations: true, onMessage() { throw new Error("closed socket"); } });
  const rejection = failed.catch((error: Error) => error);
  const controller = new AbortController();
  let received = 0;
  const healthy = watch({ allConversations: true, signal: controller.signal, onMessage() { received++; } });
  await Promise.resolve();
  stream!.onMessage({ id: "message" } as never);
  expect((await rejection as Error).message).toBe("closed socket");
  expect(received).toBe(1);
  controller.abort();
  await healthy;
});
