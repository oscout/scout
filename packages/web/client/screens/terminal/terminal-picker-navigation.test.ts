import { describe, expect, test } from "bun:test";

import {
  nextTerminalPickerSource,
  terminalPickerPanelId,
  terminalPickerTabId,
} from "./terminal-picker-navigation.ts";

describe("terminal picker source tabs", () => {
  test("wraps arrow navigation and supports Home and End", () => {
    expect(nextTerminalPickerSource("multiplexer", "ArrowLeft")).toBe("session");
    expect(nextTerminalPickerSource("session", "ArrowRight")).toBe("multiplexer");
    expect(nextTerminalPickerSource("agent", "ArrowDown")).toBe("session");
    expect(nextTerminalPickerSource("agent", "ArrowUp")).toBe("multiplexer");
    expect(nextTerminalPickerSource("session", "Home")).toBe("multiplexer");
    expect(nextTerminalPickerSource("multiplexer", "End")).toBe("session");
    expect(nextTerminalPickerSource("agent", "Enter")).toBeNull();
  });

  test("pairs every tab with a deterministic panel id", () => {
    expect(terminalPickerTabId("agent")).toBe("terminal-picker-tab-agent");
    expect(terminalPickerPanelId()).toBe("terminal-picker-panel");
  });
});
