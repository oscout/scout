import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { nextRightPanelToggle } from "./right-panel-toggle.ts";

describe("nextRightPanelToggle", () => {
  test("exits terminal focus and opens the inspector", () => {
    expect(nextRightPanelToggle({
      available: true,
      terminalFocusActive: true,
      lanesContextRoute: false,
      lanesContextEmpty: false,
      lanesContextForceOpen: false,
      rightCollapsed: true,
    })).toEqual({
      terminalFocusActive: false,
      lanesContextForceOpen: false,
      rightCollapsed: false,
    });
  });

  test("uses the route-scoped force-open state for empty agent lanes", () => {
    expect(nextRightPanelToggle({
      available: true,
      terminalFocusActive: false,
      lanesContextRoute: true,
      lanesContextEmpty: true,
      lanesContextForceOpen: false,
      rightCollapsed: false,
    })).toEqual({
      terminalFocusActive: false,
      lanesContextForceOpen: true,
      rightCollapsed: false,
    });
  });

  test("does nothing when the route has no inspector", () => {
    expect(nextRightPanelToggle({
      available: false,
      terminalFocusActive: false,
      lanesContextRoute: false,
      lanesContextEmpty: false,
      lanesContextForceOpen: false,
      rightCollapsed: false,
    })).toBeNull();
  });

  test("keeps the chrome button, shortcut, and command on the same callback", () => {
    const shellSource = readFileSync(
      new URL("../../OpenScoutAppShell.tsx", import.meta.url),
      "utf8",
    );

    expect(shellSource).toContain("action: toggleRightPanel");
    expect(shellSource).toContain("onClick={toggleRightPanel}");
    expect(shellSource).toMatch(
      /if \(\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === "]"\)[\s\S]{0,300}?toggleRightPanel\(\);/,
    );
  });
});
