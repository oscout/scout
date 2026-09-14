import { describe, expect, test } from "bun:test";

import { terminalAppOwnsMouse } from "./terminal-input-modes.ts";

describe("terminalAppOwnsMouse", () => {
  test("a plain shell leaves right-click to Scout", () => {
    expect(terminalAppOwnsMouse({ modes: { mouseTrackingMode: "none" } })).toBe(false);
  });

  test("every mouse-reporting mode claims the click", () => {
    for (const mode of ["x10", "vt200", "drag", "any"] as const) {
      expect(terminalAppOwnsMouse({ modes: { mouseTrackingMode: mode } })).toBe(true);
    }
  });

  test("a terminal that never reported ready, or an xterm without modes, stays with Scout", () => {
    expect(terminalAppOwnsMouse(null)).toBe(false);
    expect(terminalAppOwnsMouse({})).toBe(false);
    expect(terminalAppOwnsMouse({ modes: {} })).toBe(false);
  });
});
