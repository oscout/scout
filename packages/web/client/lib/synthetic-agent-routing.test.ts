import { describe, expect, test } from "bun:test";
import {
  isSyntheticAgentId,
  normalizeRoute,
  sessionRefFromSyntheticAgent,
  sessionRefFromSyntheticAgentId,
} from "./synthetic-agent-routing.ts";

describe("synthetic agent routing", () => {
  test("detects synthetic agent ids", () => {
    expect(isSyntheticAgentId("native:claude:abc")).toBe(true);
    expect(isSyntheticAgentId("scope.main")).toBe(false);
  });

  test("extracts session refs from transcript-native ids", () => {
    expect(
      sessionRefFromSyntheticAgentId(
        "native:claude:1e753cef-92ae-4e22-a365-0f5d23a07652",
      ),
    ).toBe("1e753cef-92ae-4e22-a365-0f5d23a07652");
    expect(
      sessionRefFromSyntheticAgentId(
        "native:codex:019efa89-4392-72f1-af6c-860951059bcb:deadbeef",
      ),
    ).toBe("019efa89-4392-72f1-af6c-860951059bcb");
  });

  test("extracts session refs from terminal-native ids", () => {
    expect(sessionRefFromSyntheticAgentId("native:tmux:terminal:sess-42")).toBe("sess-42");
  });

  test("prefers harness session ids when present on the agent", () => {
    expect(
      sessionRefFromSyntheticAgent({
        id: "native:claude:path:deadbeef",
        harnessSessionId: "sess-from-catalog",
      }),
    ).toBe("sess-from-catalog");
  });

  test("redirects broken agents observe routes to session observe", () => {
    expect(
      normalizeRoute({
        view: "agents-v2",
        agentId: "native:claude:1e753cef-92ae-4e22-a365-0f5d23a07652",
        tab: "observe",
      }),
    ).toEqual({
      view: "sessions",
      sessionId: "1e753cef-92ae-4e22-a365-0f5d23a07652",
    });
  });
});
