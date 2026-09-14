import { describe, expect, test } from "bun:test";

import { BrokerStartupTrafficGate } from "./broker-startup-traffic-gate.js";

describe("BrokerStartupTrafficGate", () => {
  test("allows only recovery-safe reads until the warm boundary is established", () => {
    const gate = new BrokerStartupTrafficGate();

    expect(gate.snapshot()).toEqual({ state: "restoring", mutationsAdmitted: false });
    expect(gate.admits("GET", "/health")).toBe(true);
    expect(gate.admits("GET", "/v1/home")).toBe(true);
    expect(gate.admits("HEAD", "/v1/snapshot?since=1")).toBe(true);
    expect(gate.admits("GET", "/v1/web/status")).toBe(true);
    expect(gate.admits("POST", "/v1/web/start")).toBe(true);
    expect(gate.admits("OPTIONS", "/v1/messages")).toBe(true);
    expect(gate.admits("GET", "/v1/activity")).toBe(false);
    expect(gate.admits("GET", "/v1/thread-events")).toBe(false);
    expect(gate.admits("POST", "/v1/web/restart")).toBe(false);
    expect(gate.admits("POST", "/v1/messages")).toBe(false);
    expect(gate.admits("PUT", "/v1/node")).toBe(false);
    expect(gate.admits("DELETE", "/v1/node")).toBe(false);

    gate.admitMutations();

    expect(gate.snapshot()).toEqual({ state: "ready", mutationsAdmitted: true });
    expect(gate.admits("POST", "/v1/messages")).toBe(true);
    expect(gate.admits("GET", "/v1/activity")).toBe(true);
  });
});

test("progressive coverage admits registration without certifying missing history", () => {
  const gate = new BrokerStartupTrafficGate(true);
  expect(gate.admits("GET", "/v1/snapshot")).toBe(false);
  gate.markListening();
  gate.admitCore();
  for (const path of ["/v1/actors", "/v1/agents", "/v1/endpoints"]) expect(gate.admits("POST", path)).toBe(true);
  expect(gate.admits("GET", "/v1/snapshot?scope=agents")).toBe(true);
  for (const path of ["/v1/snapshot", "/v1/home", "/v1/messages/missing", "/trpc"]) expect(gate.admits("GET", path)).toBe(false);
  expect(gate.admits("POST", "/v1/messages")).toBe(false);
  expect(gate.snapshot()).toMatchObject({ state: "restoring", phase: "history", coreReady: true, historyReady: false });
  gate.admitHistory();
  expect(gate.admits("GET", "/v1/snapshot")).toBe(true);
  expect(gate.admits("POST", "/v1/invocations")).toBe(false);
  gate.restoringSessions();
  gate.fail(new Error("coverage failed"));
  expect(gate.snapshot()).toMatchObject({ phase: "failed", error: "coverage failed", mutationsAdmitted: false });
  expect(gate.admits("POST", "/v1/messages")).toBe(false);
});


test("degraded projection keeps canonical coverage and safe registration only", () => {
  const gate = new BrokerStartupTrafficGate(true);
  gate.admitCore();
  gate.admitHistory();
  gate.degradeProjection(new Error("derived store unavailable"));
  expect(gate.snapshot()).toMatchObject({ state: "degraded", phase: "degraded", coreReady: true, historyReady: true, mutationsAdmitted: false });
  for (const path of ["/health", "/v1/node", "/v1/snapshot", "/v1/snapshot?scope=agents"]) expect(gate.admits("GET", path)).toBe(true);
  for (const path of ["/v1/actors", "/v1/agents", "/v1/endpoints"]) expect(gate.admits("POST", path)).toBe(true);
  for (const path of ["/v1/messages", "/v1/invocations", "/trpc"]) expect(gate.admits("POST", path)).toBe(false);
  for (const path of ["/v1/activity", "/v1/home", "/v1/thread-events"]) expect(gate.admits("GET", path)).toBe(false);
});

test("conversation title mutation remains gated until startup is fully ready", () => {
  const path = "/v1/conversations/conversation-rename/title";
  const gate = new BrokerStartupTrafficGate(true);
  expect(gate.admits("POST", path)).toBe(false);
  gate.admitCore();
  expect(gate.admits("POST", path)).toBe(false);
  gate.admitHistory();
  expect(gate.admits("POST", path)).toBe(false);
  gate.restoringSessions();
  expect(gate.admits("POST", path)).toBe(false);
  gate.degradeProjection(new Error("projection unavailable"));
  expect(gate.admits("POST", path)).toBe(false);

  const ready = new BrokerStartupTrafficGate(true);
  ready.admitCore();
  ready.admitHistory();
  ready.admitMutations();
  expect(ready.admits("POST", path)).toBe(true);
});
