import { describe, expect, test } from "bun:test";
import { rankScoutbotFileMatches } from "./scoutbot-file-lookup.ts";

describe("rankScoutbotFileMatches", () => {
  const files = [
    "docs/live-voice-lifecycle.md",
    "docs/design/voice-turn-liveness-evidence.md",
    "packages/web/server/scoutbot-assistant.ts",
    "DEV_INSTRUCTIONS.md",
  ];

  test("ranks name matches first and ignores filler words", () => {
    expect(rankScoutbotFileMatches("show me the live voice lifecycle doc", files)[0]).toBe("docs/live-voice-lifecycle.md");
    expect(rankScoutbotFileMatches("the dev instructions", files)).toEqual(["DEV_INSTRUCTIONS.md"]);
  });

  test("returns nothing for a query of only filler words", () => {
    expect(rankScoutbotFileMatches("open the doc", files)).toEqual([]);
  });
});
