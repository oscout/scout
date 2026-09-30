import { expect, test } from "bun:test";
import { ChannelInboxCoordinator, InboxChangeSignal } from "./channel-inbox-coordinator.ts";
import { holdChannelInbox } from "./channel-inbox.ts";

test("N held waiters share one projection per channel change, with no idle projection reads", async () => {
  let revision = "initial", reads = 0, checks = 0;
  const coordinator = new ChannelInboxCoordinator<{ messages: string[]; nextCursor: string; hasMore: boolean }>();
  const options = { intervalMs: 10,
    check: async () => { checks++; return revision; },
    load: async () => { reads++; return { messages: revision === "initial" ? [] : ["mention"], nextCursor: revision, hasMore: false }; },
  };
  const leases = Array.from({ length: 20 }, () => coordinator.acquire("broker/channel", options));
  const responses = await Promise.all(leases.map(async lease => {
    let observed = lease.changes.version;
    const initial = await lease.read();
    return holdChannelInbox(new Request("https://example.test"), initial, 20, async () => {
      observed = lease.changes.version;
      return lease.read();
    }, { wait: signal => lease.changes.wait(observed, signal), release: lease.release });
  }));
  await Bun.sleep(55);
  expect(reads).toBe(1);
  expect(checks).toBeLessThan(15); // shared check, not 20 checks every interval
  revision = "changed";
  expect(await Promise.all(responses.map(response => response.json()))).toEqual(Array(20).fill({ messages: ["mention"], nextCursor: "changed", hasMore: false }));
  expect(reads).toBe(2);
  const stoppedChecks = checks;
  await Bun.sleep(25);
  expect(checks).toBe(stoppedChecks);
});

test("revision latch catches changes before registration and removes aborted listeners", async () => {
  const changes = new InboxChangeSignal();
  const controller = new AbortController();
  changes.notify();
  await changes.wait(0, controller.signal);
  const waiting = changes.wait(1, controller.signal);
  controller.abort();
  await waiting;
});

test("source signals trigger one cheap check and shared projection; releasing closes source", async () => {
  let notify = () => {}, closed = 0, position = "a", reads = 0;
  const coordinator = new ChannelInboxCoordinator<string>();
  const lease = coordinator.acquire("broker/channel", { check: async () => position, load: async () => { reads++; return position; },
    subscribe: changed => { notify = changed; return () => { closed++; }; },
  });
  expect(await lease.read()).toBe("a");
  const observed = lease.changes.version;
  position = "b"; notify();
  await lease.changes.wait(observed, new AbortController().signal);
  expect(await lease.read()).toBe("b"); expect(reads).toBe(2);
  lease.release(); expect(closed).toBe(1);
});

test("change-triggered authorization failure errors the stream and releases its lease", async () => {
  const changes = new InboxChangeSignal();
  let released = 0;
  const response = holdChannelInbox(new Request("https://example.test"), { messages: [], nextCursor: null, hasMore: false }, 20,
    async () => { throw new Error("revoked"); },
    { wait: signal => changes.wait(0, signal), release: () => { released++; } });
  const reader = response.body!.getReader(); await reader.read();
  changes.notify();
  await expect(reader.read()).rejects.toThrow("revoked");
  expect(released).toBe(1);
});

test("a covered source mutation invalidates even when the high-water fingerprint is unchanged", async () => {
  let notify = () => {}, body = "before", reads = 0;
  const coordinator = new ChannelInboxCoordinator<string>();
  const lease = coordinator.acquire("broker/channel", { check: async () => "same-id-and-time", load: async () => { reads++; return body; }, subscribe: callback => { notify = callback; return () => {}; } });
  expect(await lease.read()).toBe("before");
  body = "corrected"; notify();
  expect(await lease.read()).toBe("corrected");
  expect(reads).toBe(2); lease.release();
});
