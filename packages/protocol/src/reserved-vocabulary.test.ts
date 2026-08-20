import { describe, expect, test } from "bun:test";

import {
  isScoutReservedAgentName,
  validateScoutAgentNameForWrite,
  validateScoutSessionHandleForWrite,
} from "./reserved-vocabulary.js";

describe("Scout reserved vocabulary", () => {
  test("reserves only words with bare grammar meaning", () => {
    for (const word of ["codex", "opus", "high", "model", "project", "reviewer"]) {
      expect(isScoutReservedAgentName(word)).toBe(true);
    }
    expect(isScoutReservedAgentName("gpt-5.6-sol")).toBe(false);
    expect(isScoutReservedAgentName("sonnet")).toBe(false);
  });

  test("rejects silent rewriting and teaches reserved runtime syntax", () => {
    expect(validateScoutAgentNameForWrite("My Agent")).toEqual(expect.objectContaining({
      ok: false,
      code: "invalid_name",
    }));
    expect(validateScoutAgentNameForWrite("codex")).toEqual(expect.objectContaining({
      ok: false,
      code: "reserved_name",
      message: expect.stringContaining("--harness codex"),
    }));
    expect(validateScoutAgentNameForWrite("hudson")).toEqual({ ok: true, value: "hudson" });
  });

  test("uses a separate opaque session-handle character policy", () => {
    expect(validateScoutSessionHandleForWrite("thread:abc/123")).toEqual({
      ok: true,
      value: "thread:abc/123",
    });
    expect(validateScoutSessionHandleForWrite("codex")).toEqual(expect.objectContaining({
      ok: false,
      code: "reserved_name",
    }));
  });
});
