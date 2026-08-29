import { describe, expect, test } from "bun:test";

import {
  formatSessionRouteRef,
  parseSessionRouteRef,
  sessionHarnessMatches,
} from "./session-route-ref.ts";

describe("session route refs", () => {
  test("formats canonical harness-qualified identities", () => {
    expect(formatSessionRouteRef("codex", "/tmp/native-1.jsonl"))
      .toBe("session:codex:native-1");
    expect(formatSessionRouteRef("claude-code", "native-1"))
      .toBe("session:claude:native-1");
  });

  test("parses qualified and legacy refs without losing opaque suffixes", () => {
    expect(parseSessionRouteRef("session:codex:native:one")).toEqual({
      refId: "native:one",
      harness: "codex",
      qualified: true,
    });
    expect(parseSessionRouteRef("session:native-1")).toEqual({
      refId: "native-1",
      harness: null,
      qualified: false,
    });
  });

  test("normalizes transport aliases when comparing harnesses", () => {
    expect(sessionHarnessMatches("claude", "claude_stream_json")).toBe(true);
    expect(sessionHarnessMatches("codex", "claude")).toBe(false);
  });
});
