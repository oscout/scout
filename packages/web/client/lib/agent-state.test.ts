import { describe, expect, test } from "bun:test";
import {
  agentStateLabel,
  agentStateRank,
  isAgentOnline,
  normalizeAgentState,
} from "./agent-state.ts";

describe("normalizeAgentState", () => {
  test("treats cold endpoint states as callable", () => {
    for (const state of ["offline", "waiting", "idle", "available", null, ""]) {
      expect(normalizeAgentState(state)).toBe("callable");
    }
  });

  test("maps harness and broker busy states", () => {
    expect(normalizeAgentState("working")).toBe("in_turn");
    expect(normalizeAgentState("running")).toBe("in_turn");
    expect(normalizeAgentState("in_flight")).toBe("in_flight");
    expect(normalizeAgentState("queued")).toBe("in_flight");
    expect(normalizeAgentState("waking")).toBe("in_flight");
    expect(normalizeAgentState("needs_attention")).toBe("needs_attention");
  });

  test("marks retired or superseded agents blocked", () => {
    expect(normalizeAgentState("available", { retiredFromFleet: true, staleLocalRegistration: false }))
      .toBe("blocked");
    expect(normalizeAgentState("offline", { retiredFromFleet: false, staleLocalRegistration: true }))
      .toBe("blocked");
  });

  test("ranks busy agents above callable", () => {
    expect(agentStateRank("needs_attention")).toBeLessThan(agentStateRank("in_turn"));
    expect(agentStateRank("in_turn")).toBeLessThan(agentStateRank("in_flight"));
    expect(agentStateRank("in_flight")).toBeLessThan(agentStateRank("callable"));
    expect(agentStateRank("callable")).toBeLessThan(agentStateRank("blocked"));
  });

  test("labels match the callable-first model", () => {
    expect(agentStateLabel("offline")).toBe("Callable");
    expect(agentStateLabel("working")).toBe("In turn");
    expect(agentStateLabel("in_flight")).toBe("In flight");
    expect(agentStateLabel("needs_attention")).toBe("Needs attention");
    expect(isAgentOnline("needs_attention")).toBe(true);
    expect(isAgentOnline("offline")).toBe(true);
    expect(isAgentOnline("offline", { retiredFromFleet: true })).toBe(false);
  });
});
