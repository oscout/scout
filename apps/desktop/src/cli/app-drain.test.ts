import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ActiveFlight,
  classifyActiveFlights,
  parseDrainTimeout,
  readActiveFlights,
  waitForIdleFleet,
} from "./app-drain.ts";

function flight(id: string, startedAt: number | null, state = "running"): ActiveFlight {
  return { id, targetAgentId: `agent-${id}`, state, startedAt, summary: null };
}

describe("readActiveFlights", () => {
  test("returns waking and running flights, not queued or terminal ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-drain-"));
    try {
      const dbPath = join(dir, "control-plane.sqlite");
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE flights (
        id TEXT PRIMARY KEY, invocation_id TEXT, requester_id TEXT, target_agent_id TEXT,
        state TEXT, summary TEXT, started_at INTEGER, completed_at INTEGER)`);
      const insert = db.prepare(
        "INSERT INTO flights (id, target_agent_id, state, started_at) VALUES (?, ?, ?, ?)",
      );
      insert.run("flt-run", "a", "running", 20);
      insert.run("flt-wake", "b", "waking", 10);
      insert.run("flt-queued", "c", "queued", 5);
      insert.run("flt-done", "d", "completed", 1);
      db.close();

      expect(readActiveFlights(dbPath).map((entry) => entry.id)).toEqual(["flt-wake", "flt-run"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing database has nothing in flight", () => {
    expect(readActiveFlights("/nonexistent/control-plane.sqlite")).toEqual([]);
  });
});

describe("classifyActiveFlights", () => {
  test("flights running past the stale threshold do not block", () => {
    const state = classifyActiveFlights([flight("fresh", 900), flight("old", 0)], 1_000, 500);
    expect(state.blocking.map((entry) => entry.id)).toEqual(["fresh"]);
    expect(state.stale.map((entry) => entry.id)).toEqual(["old"]);
  });
});

describe("waitForIdleFleet", () => {
  test("waits until the running flight finishes", async () => {
    let clock = 0;
    const polls = [[flight("a", 0)], [flight("a", 0)], []];
    const waiting: string[][] = [];
    const result = await waitForIdleFleet({
      readFlights: () => polls.shift() ?? [],
      timeoutMs: 60_000,
      pollMs: 1_000,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      onWaiting: (state) => waiting.push(state.blocking.map((entry) => entry.id)),
    });
    expect(result.idle).toBe(true);
    expect(result.waitedMs).toBe(2_000);
    // Reported once for the unchanged blocking set, not on every poll.
    expect(waiting).toEqual([["a"]]);
  });

  test("gives up at the timeout and names what is still blocking", async () => {
    let clock = 0;
    const result = await waitForIdleFleet({
      readFlights: () => [flight("stuck", 0)],
      timeoutMs: 3_000,
      pollMs: 1_000,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    expect(result.idle).toBe(false);
    expect(result.blocking.map((entry) => entry.id)).toEqual(["stuck"]);
    expect(result.waitedMs).toBe(3_000);
  });
});

describe("parseDrainTimeout", () => {
  test("accepts seconds, minutes, hours, and bare minutes", () => {
    expect(parseDrainTimeout("90s")).toBe(90_000);
    expect(parseDrainTimeout("15m")).toBe(900_000);
    expect(parseDrainTimeout("2h")).toBe(7_200_000);
    expect(parseDrainTimeout("10")).toBe(600_000);
    expect(parseDrainTimeout("soon")).toBeNull();
  });
});
