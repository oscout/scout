import { describe, expect, test } from "bun:test";

import { parseCursorCliStreamJsonOutput } from "./cli-transport.ts";

describe("parseCursorCliStreamJsonOutput", () => {
  test("extracts final result text and session id from cursor-agent stream-json", () => {
    const raw = [
      "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"chat-1\"}",
      "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"SPI\"}]}}",
      "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"KE_OK\"}]}}",
      "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"SPIKE_OK\",\"session_id\":\"chat-1\"}",
    ].join("\n");

    const parsed = parseCursorCliStreamJsonOutput(raw);
    expect(parsed.outputText).toBe("SPIKE_OK");
    expect(parsed.sessionId).toBe("chat-1");
    expect(parsed.eventCount).toBe(4);
  });
});
