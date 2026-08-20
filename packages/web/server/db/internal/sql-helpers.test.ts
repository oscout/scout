import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ACTIVE_FLIGHT_STATES,
  agentFlightPhaseFromFlightState,
  queryAgentFlightPhases,
  summarizeAgentState,
  summarizeAgentStatusLabel,
} from "./sql-helpers.ts";

describe("summarizeAgentState", () => {
  test("defaults to callable when no active flight", () => {
    expect(summarizeAgentState("offline", null)).toBe("available");
    expect(summarizeAgentState("waiting", null)).toBe("available");
    expect(summarizeAgentStatusLabel("offline", null)).toBe("Callable");
  });

  test("surfaces in-flight and in-turn separately", () => {
    expect(summarizeAgentState("offline", "in_flight")).toBe("in_flight");
    expect(summarizeAgentState("idle", "in_turn")).toBe("working");
    expect(summarizeAgentStatusLabel("idle", "in_flight")).toBe("In flight");
    expect(summarizeAgentStatusLabel("idle", "in_turn")).toBe("In turn");
  });

  test("derives flight phase from broker flight state", () => {
    expect(agentFlightPhaseFromFlightState("running")).toBe("in_turn");
    expect(agentFlightPhaseFromFlightState("queued")).toBe("in_flight");
    expect(agentFlightPhaseFromFlightState("completed")).toBeNull();
  });
});

describe("queryAgentFlightPhases", () => {
  test("parameterized active-flight filter avoids row-value IN syntax", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE invocations (
        id TEXT PRIMARY KEY,
        target_agent_id TEXT NOT NULL,
        state TEXT
      );
      INSERT INTO invocations (id, target_agent_id, state) VALUES
        ('i1', 'agent-a', 'running'),
        ('i2', 'agent-b', 'queued'),
        ('i3', 'agent-c', 'completed');
    `);

    const rows = db.prepare(
      `SELECT target_agent_id, state FROM invocations
       WHERE state IN (${ACTIVE_FLIGHT_STATES.map(() => "?").join(", ")})`,
    ).all(...ACTIVE_FLIGHT_STATES) as Array<{ target_agent_id: string; state: string }>;

    const phases = new Map<string, ReturnType<typeof agentFlightPhaseFromFlightState>>();
    for (const row of rows) {
      const phase = agentFlightPhaseFromFlightState(row.state);
      if (phase) phases.set(row.target_agent_id, phase);
    }

    expect(phases.get("agent-a")).toBe("in_turn");
    expect(phases.get("agent-b")).toBe("in_flight");
    expect(phases.has("agent-c")).toBe(false);
    db.close();
  });

  test("queryAgentFlightPhases parses against the control-plane invocations table", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE invocations (
        id TEXT PRIMARY KEY,
        target_agent_id TEXT NOT NULL,
        state TEXT
      );
    `);

    expect(() => queryAgentFlightPhases(db)).not.toThrow();
    db.close();
  });
});
