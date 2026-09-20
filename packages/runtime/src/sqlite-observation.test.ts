import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { observeSqliteDatabase, type SlowSqliteEvent } from "./sqlite-observation.js";

describe("slow SQLite observation", () => {
  test("native statements, binding, transaction variants and rollback keep their behavior", () => {
    const raw = new Database(":memory:");
    const db = observeSqliteDatabase(raw, { database: "runtime", thresholdMs: 1_000_000 });
    try {
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)");
      const insert = db.prepare("INSERT INTO items VALUES (?, ?)");
      db.transaction(() => insert.run(1, "private body")).immediate();
      expect(db.query("SELECT body FROM items WHERE id = ?").get(1)).toEqual({ body: "private body" });
      expect(db.query("SELECT body FROM items").values()).toEqual([["private body"]]);
      expect(() => db.transaction(() => { insert.run(2, "discard"); throw new Error("rollback"); })()).toThrow("rollback");
      expect(db.query("SELECT id FROM items").all()).toEqual([{ id: 1 }]);
      expect(db.query("SELECT id FROM items")).toBe(db.query("SELECT id FROM items"));
      expect(db instanceof Database).toBe(true);
    } finally { db.close(); }
  });

  test("only slow calls emit and SQL, values and errors never enter events", () => {
    let clock = 0;
    let slow = false;
    const events: SlowSqliteEvent[] = [];
    const failure = new Error("sensitive error message");
    const raw = {
      query(_sql: string) {
        return {
          get(_secret: string) { clock += slow ? 120 : 1; return { secret: "sensitive result" }; },
          run() { clock += 150; throw failure; },
        };
      },
    };
    const db = observeSqliteDatabase(raw, { database: "runtime", thresholdMs: 100, now: () => clock, emit: e => events.push(e) });
    const statement = db.query("SELECT 'sensitive literal' WHERE id = ?");
    expect(statement.get("sensitive binding")).toEqual({ secret: "sensitive result" });
    expect(events).toHaveLength(0);
    slow = true;
    statement.get("sensitive binding");
    try { statement.run(); } catch (e) { expect(e).toBe(failure); }
    expect(events.map(e => [e.operation, e.durationMs, e.outcome])).toEqual([["get", 120, "ok"], ["run", 150, "error"]]);
    expect(events[0]!.queryId).toBe(events[1]!.queryId);
    expect(JSON.stringify(events)).not.toContain("sensitive");
    expect(events[0]!.caller.length).toBeGreaterThan(0);
  });

  test("bounds log volume and reports suppressed calls on the next window", () => {
    let clock = 0;
    const events: SlowSqliteEvent[] = [];
    const db = observeSqliteDatabase({ exec(_sql: string) { clock += 150; } }, {
      database: "web-control-plane", thresholdMs: 100, now: () => clock, emit: e => events.push(e),
    });
    for (let i = 0; i < 13; i++) db.exec("SELECT 1");
    expect(events).toHaveLength(10);
    clock += 60_000;
    db.exec("SELECT 1");
    expect(events).toHaveLength(11);
    expect(events[10]!.suppressed).toBe(3);
  });

  test("logger failure cannot change a database result or exception", () => {
    let clock = 0;
    const original = new Error("database error");
    const db = observeSqliteDatabase({ exec(sql: string) { clock += 150; if (sql === "fail") throw original; return 42; } }, {
      database: "runtime", thresholdMs: 100, now: () => clock, emit: () => { throw new Error("logger error"); },
    });
    expect(db.exec("ok")).toBe(42);
    try { db.exec("fail"); throw new Error("expected failure"); } catch (e) { expect(e).toBe(original); }
  });

  test("zero disables instrumentation entirely", () => {
    const raw = { exec() {} };
    expect(observeSqliteDatabase(raw, { database: "runtime", thresholdMs: 0 })).toBe(raw);
  });

  test("statement preparation is measured even when it fails", () => {
    let clock = 0;
    const events: SlowSqliteEvent[] = [];
    const db = observeSqliteDatabase({ prepare(_sql: string) { clock += 200; throw new Error("bad sql"); } }, {
      database: "runtime", thresholdMs: 100, now: () => clock, emit: e => events.push(e),
    });
    expect(() => db.prepare("private SQL")).toThrow("bad sql");
    expect(events[0]!.operation).toBe("prepare.prepare");
    expect(events[0]!.outcome).toBe("error");
  });
});
