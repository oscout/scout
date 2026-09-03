import { describe, expect, test } from "bun:test";

import {
  activeSessionRefLookupState,
  brokerEventMayAffectSessionRef,
  createSessionRefLookupCoordinator,
  sessionRefRefreshDelayMs,
  sessionRefsMatch,
  type SessionRefLookupCompletion,
} from "./session-ref-lookup-state.ts";

describe("session-ref lookup state", () => {
  test("debounces the first invalidation and rate-limits a continuing event stream", () => {
    expect(sessionRefRefreshDelayMs({
      nowMs: 100_000,
      lastRefreshAtMs: null,
      debounceMs: 1_000,
      minimumIntervalMs: 10_000,
    })).toBe(1_000);
    expect(sessionRefRefreshDelayMs({
      nowMs: 101_250,
      lastRefreshAtMs: 100_000,
      debounceMs: 1_000,
      minimumIntervalMs: 10_000,
    })).toBe(8_750);
    expect(sessionRefRefreshDelayMs({
      nowMs: 111_000,
      lastRefreshAtMs: 100_000,
      debounceMs: 1_000,
      minimumIntervalMs: 10_000,
    })).toBe(1_000);
  });

  test("matches explicit routes, transcript paths, and bare provider refs", () => {
    expect(sessionRefsMatch(
      "session:codex:642ca306-2d7b-4bd8-a2a7-75e0b27a8006",
      "/tmp/642ca306-2d7b-4bd8-a2a7-75e0b27a8006.jsonl",
    )).toBe(true);
    expect(sessionRefsMatch("session:codex:one", "session:claude:two")).toBe(false);
  });

  test("ignores unrelated broker churn but accepts matching invalidations", () => {
    const refs = ["session:codex:thread-1", "agent-1"];
    expect(brokerEventMayAffectSessionRef({
      kind: "presence.updated",
      payload: { beat: { agentId: "agent-99" } },
    }, refs)).toBe(false);
    expect(brokerEventMayAffectSessionRef({
      kind: "agent.endpoint.upserted",
      payload: { endpoint: { agentId: "agent-1", sessionId: "thread-1" } },
    }, refs)).toBe(true);
    expect(brokerEventMayAffectSessionRef({
      kind: "unknown",
      payload: { reason: "control_subscription_started" },
    }, refs)).toBe(true);
  });

  test("hides the prior writable lookup and ignores deferred A/B results after C wins", async () => {
    const requests = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
    const completions: Array<SessionRefLookupCompletion<string>> = [];
    const coordinator = createSessionRefLookupCoordinator(
      (sessionRef) => {
        const request = Promise.withResolvers<string>();
        requests.set(sessionRef, request);
        return request.promise;
      },
      (completion) => completions.push(completion),
    );

    const a = coordinator.request("session:codex:A");
    const b = coordinator.request("session:codex:B");
    const c = coordinator.request("session:codex:C");

    expect(activeSessionRefLookupState({
      sessionRef: "session:codex:A",
      lookup: "writable A",
      loading: false,
      error: null,
    }, "session:codex:C")).toEqual({
      sessionRef: "session:codex:C",
      lookup: null,
      loading: true,
      error: null,
    });

    requests.get("session:codex:C")!.resolve("writable C");
    await c;
    requests.get("session:codex:A")!.resolve("writable A");
    requests.get("session:codex:B")!.resolve("writable B");
    await Promise.all([a, b]);

    expect(completions).toEqual([{
      sessionRef: "session:codex:C",
      result: { ok: true, lookup: "writable C" },
    }]);
  });
});
