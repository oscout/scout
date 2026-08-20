import { describe, expect, test } from "bun:test";

import { configureReadonlyDb } from "./db-queries.ts";

describe("web db readonly connection", () => {
  test("uses query_only and a short busy timeout without setting journal_mode", () => {
    const execCalls: string[] = [];
    const fakeDb = {
      exec(sql: string): void {
        execCalls.push(sql);
      },
    };

    configureReadonlyDb(fakeDb as Parameters<typeof configureReadonlyDb>[0]);

    expect(execCalls).toEqual(["PRAGMA busy_timeout = 250", "PRAGMA query_only = ON"]);
    expect(execCalls.some((sql) => sql.includes("journal_mode"))).toBe(false);
  });
});
