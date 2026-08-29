import { describe, expect, test } from "bun:test";

import { BrokerStartupTrafficGate } from "./broker-startup-traffic-gate.js";

describe("BrokerStartupTrafficGate", () => {
  test("allows only recovery-safe reads until the warm boundary is established", () => {
    const gate = new BrokerStartupTrafficGate();

    expect(gate.snapshot()).toEqual({ state: "restoring", mutationsAdmitted: false });
    expect(gate.admits("GET", "/health")).toBe(true);
    expect(gate.admits("GET", "/v1/home")).toBe(true);
    expect(gate.admits("HEAD", "/v1/snapshot?since=1")).toBe(true);
    expect(gate.admits("OPTIONS", "/v1/messages")).toBe(true);
    expect(gate.admits("GET", "/v1/activity")).toBe(false);
    expect(gate.admits("GET", "/v1/thread-events")).toBe(false);
    expect(gate.admits("POST", "/v1/messages")).toBe(false);
    expect(gate.admits("PUT", "/v1/node")).toBe(false);
    expect(gate.admits("DELETE", "/v1/node")).toBe(false);

    gate.admitMutations();

    expect(gate.snapshot()).toEqual({ state: "ready", mutationsAdmitted: true });
    expect(gate.admits("POST", "/v1/messages")).toBe(true);
    expect(gate.admits("GET", "/v1/activity")).toBe(true);
  });
});
