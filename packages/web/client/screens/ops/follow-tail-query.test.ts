import { expect, mock, test } from "bun:test";
import type * as ReactModule from "react";
// @ts-expect-error -- use real runtime React rather than the type-only tsconfig alias.
const React = (await import("../../../node_modules/react/index.js")) as typeof ReactModule;
mock.module("react", () => React);
const { resolvedFollowTailQuery } = await import("./follow-tail-query.ts");
import type { FollowTarget } from "../../lib/types.ts";

const flightTarget: FollowTarget = {
  flightId: "flt-123", invocationId: "inv-123", conversationId: null,
  workId: null, targetAgentId: "agent-123", sessionId: "harness-session-456",
};

test("public flight/invocation follow responses filter Tail by resolved sessionId", () => {
  expect(resolvedFollowTailQuery(flightTarget)).toBe("harness-session-456");
});

test("newer explicit harness id takes precedence over Scout session id", () => {
  expect(resolvedFollowTailQuery({ ...flightTarget, harnessSessionId: " harness-789 " }))
    .toBe("harness-789");
});

test("empty explicit id falls back to public resolved session; no ids preserve caller query", () => {
  expect(resolvedFollowTailQuery({ ...flightTarget, harnessSessionId: "  " }))
    .toBe("harness-session-456");
  expect(resolvedFollowTailQuery({ ...flightTarget, sessionId: null })).toBeUndefined();
});
