import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("terminal picker accessibility wiring", () => {
  const terminalSource = readFileSync(new URL("./Terminal.tsx", import.meta.url), "utf8");

  test("uses tabs with roving focus and a labelled panel", () => {
    expect(terminalSource).toContain('role="tablist"');
    expect(terminalSource).toContain('role="tab"');
    expect(terminalSource).toContain("aria-controls={terminalPickerPanelId()}");
    expect(terminalSource).toContain("tabIndex={pickerSource === source ? 0 : -1}");
    expect(terminalSource).toContain('role="tabpanel"');
    expect(terminalSource).toContain("aria-labelledby={terminalPickerTabId(pickerSource)}");
  });

  test("keeps row actions outside a dedicated selection button", () => {
    expect(terminalSource).toContain('role="list" aria-label="Managed multiplexers"');
    expect(terminalSource).toContain('className="s-term-picker-item-summary s-term-picker-item-select"');
    expect(terminalSource).toContain("aria-pressed={selected}");
    expect(terminalSource).not.toContain('role="listbox"');
    expect(terminalSource).not.toContain('role={onSelect ? "option"');
  });
});
