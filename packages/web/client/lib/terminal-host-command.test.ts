import { describe, expect, test } from "bun:test";
import {
  SCOUT_TERMINAL_SEND_LINE_EVENT,
  terminalHostLineFromEvent,
} from "./terminal-host-command.ts";

describe("terminal host commands", () => {
  test("reads a non-empty line from the macOS host event", () => {
    const event = new CustomEvent(SCOUT_TERMINAL_SEND_LINE_EVENT, {
      detail: { line: "herdr --session scout-herdr-1234" },
    });

    expect(terminalHostLineFromEvent(event)).toBe("herdr --session scout-herdr-1234");
  });

  test("rejects missing, blank, and non-string lines", () => {
    expect(terminalHostLineFromEvent(new CustomEvent(SCOUT_TERMINAL_SEND_LINE_EVENT))).toBeNull();
    expect(terminalHostLineFromEvent(new CustomEvent(SCOUT_TERMINAL_SEND_LINE_EVENT, {
      detail: { line: "   " },
    }))).toBeNull();
    expect(terminalHostLineFromEvent(new CustomEvent(SCOUT_TERMINAL_SEND_LINE_EVENT, {
      detail: { line: 42 },
    }))).toBeNull();
  });
});
