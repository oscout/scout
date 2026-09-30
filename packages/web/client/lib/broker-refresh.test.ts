import { describe, expect, test } from "bun:test";

import { createBrokerRefreshController, type BrokerRefreshPolicy } from "./broker-refresh-controller.ts";
import { matchesKinds } from "./broker-event-kinds.ts";
import type { BrokerEvent } from "./sse.ts";

function harness(options: { live?: boolean; active?: boolean } = {}) {
  let now = 1_000_000;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const state = { live: options.live ?? true, active: options.active ?? true, refreshes: 0 };
  const policy: BrokerRefreshPolicy = {
    matches: matchesKinds(["message.posted"]),
    fallbackPollMs: 10_000,
    livePollMs: 60_000,
  };
  const controller = createBrokerRefreshController({
    refresh: () => {
      state.refreshes += 1;
    },
    policy: () => policy,
    isActive: () => state.active,
    isLive: () => state.live,
    scheduler: {
      now: () => now,
      setTimeout: (callback, ms) => {
        const handle = nextHandle++;
        timers.set(handle, { at: now + ms, callback });
        return handle;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(handle);
        timer.callback();
      }
    }
  };
  return { controller, state, advance };
}

const event = (kind: string) => ({ kind }) as BrokerEvent;
const reconcile = { kind: "unknown", payload: { reason: "control_subscription_started" } } as BrokerEvent;

describe("broker refresh controller", () => {
  test("a burst of matching events collapses into one refresh", () => {
    const { controller, state, advance } = harness();
    for (let i = 0; i < 2_000; i += 1) controller.onEvent(event("message.posted"));
    advance(250);
    expect(state.refreshes).toBe(1);
  });

  test("events the policy does not match never refresh", () => {
    const { controller, state, advance } = harness();
    for (let i = 0; i < 2_000; i += 1) controller.onEvent(event("presence.updated"));
    advance(1_000);
    expect(state.refreshes).toBe(0);
  });

  test("a restarted subscription reconciles whatever the matcher says", () => {
    const { controller, state, advance } = harness();
    controller.onEvent(reconcile);
    advance(250);
    expect(state.refreshes).toBe(1);
  });

  test("the timer relaxes to the live rate while the stream is up", () => {
    const { controller, state, advance } = harness({ live: true });
    advance(10_000);
    controller.onTick();
    expect(state.refreshes).toBe(0);
    advance(50_000);
    controller.onTick();
    expect(state.refreshes).toBe(1);
  });

  test("the timer polls at the fallback rate while the stream is down", () => {
    const { controller, state, advance } = harness({ live: false });
    advance(10_000);
    controller.onTick();
    expect(state.refreshes).toBe(1);
  });

  test("a tick that fires slightly early still counts as due", () => {
    const { controller, state, advance } = harness({ live: true });
    advance(59_990);
    controller.onTick();
    expect(state.refreshes).toBe(1);
  });

  test("an event while the surface is inactive refreshes on return, not before", () => {
    const { controller, state, advance } = harness({ active: false });
    controller.onEvent(event("message.posted"));
    advance(250);
    controller.onTick();
    expect(state.refreshes).toBe(0);
    state.active = true;
    controller.onActivated();
    expect(state.refreshes).toBe(1);
  });

  test("returning to a live, untouched surface does not refetch early", () => {
    const { controller, state, advance } = harness({ live: true });
    advance(5_000);
    controller.onActivated();
    expect(state.refreshes).toBe(0);
  });

  test("returning while the stream is down refreshes at once", () => {
    const { controller, state } = harness({ live: false });
    controller.onActivated();
    expect(state.refreshes).toBe(1);
  });

  test("dispose drops a pending refresh", () => {
    const { controller, state, advance } = harness();
    controller.onEvent(event("message.posted"));
    controller.dispose();
    advance(1_000);
    expect(state.refreshes).toBe(0);
  });
});
