import { describe, expect, test } from "bun:test";

import {
  effectiveInvocationSessionPolicy,
  normalizeInvocationSessionPolicy,
  validateInvocationExecutionPreference,
} from "./invocations";

describe("invocation session policy", () => {
  test("normalizes known policy spellings", () => {
    expect(normalizeInvocationSessionPolicy("new")).toBe("new");
    expect(normalizeInvocationSessionPolicy("reuse")).toBe("reuse");
    expect(normalizeInvocationSessionPolicy("existing")).toBe("existing");
    expect(normalizeInvocationSessionPolicy("fork")).toBe("fork");
    expect(normalizeInvocationSessionPolicy("any")).toBe("any");
    expect(normalizeInvocationSessionPolicy("sticky")).toBeUndefined();
  });

  test("derives effective policy from exact and fork handles", () => {
    expect(effectiveInvocationSessionPolicy(undefined)).toBe("new");
    expect(effectiveInvocationSessionPolicy({ session: "any" })).toBe("reuse");
    expect(effectiveInvocationSessionPolicy({ session: "reuse" })).toBe("reuse");
    expect(effectiveInvocationSessionPolicy({ targetSessionId: "session-1" })).toBe("existing");
    expect(effectiveInvocationSessionPolicy({ forkFromSessionId: "session-1" })).toBe("fork");
    expect(effectiveInvocationSessionPolicy({ forkFromStateId: "state-1" })).toBe("fork");
  });

  test("validates exact continuation and fork source requirements", () => {
    expect(validateInvocationExecutionPreference({ session: "existing" }))
      .toEqual(["session existing requires targetSessionId"]);
    expect(validateInvocationExecutionPreference({ session: "fork" }))
      .toEqual(["session fork requires forkFromStateId or forkFromSessionId"]);
    expect(validateInvocationExecutionPreference({ session: "new", targetSessionId: "session-1" }))
      .toEqual(["session new cannot target an existing session"]);
    expect(validateInvocationExecutionPreference({ session: "fork", forkFromStateId: "state-1" }))
      .toEqual([]);
  });
});
