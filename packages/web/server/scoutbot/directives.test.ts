import { describe, expect, test } from "bun:test";
import { parseScoutbotDirectives, scoutbotDirectiveMetadata } from "./directives.ts";

describe("scoutbot directives", () => {
  test("parses effort and session directives anywhere in the message", () => {
    const parsed = parseScoutbotDirectives("can you /status Hudson eff:low session:3234");

    expect(parsed.command).toEqual({
      name: "status",
      raw: "/status",
      args: "Hudson",
    });
    expect(parsed.directives).toEqual({
      reasoningEffort: "low",
      targetSessionId: "3234",
    });
    expect(parsed.body).toBe("can you Hudson");
    expect(parsed.messageBody).toBe("can you /status Hudson");
  });

  test("normalizes effort aliases and lets the last scalar directive win", () => {
    const parsed = parseScoutbotDirectives("inspect eff:quick session:old eff:med sid:new");

    expect(parsed.directives.reasoningEffort).toBe("medium");
    expect(parsed.directives.targetSessionId).toBe("new");
    expect(parsed.body).toBe("inspect");
  });

  test("preserves the full Codex effort ladder", () => {
    expect(parseScoutbotDirectives("inspect eff:max").directives.reasoningEffort).toBe("max");
    expect(parseScoutbotDirectives("inspect eff:ultra").directives.reasoningEffort).toBe("ultra");
  });

  test("exports flat directive metadata for broker records", () => {
    const parsed = parseScoutbotDirectives("/steer session:abc-123 eff:high");

    expect(scoutbotDirectiveMetadata(parsed)).toEqual({
      scoutbotAction: "steer",
      reasoningEffort: "high",
      targetSessionId: "abc-123",
    });
  });
});
