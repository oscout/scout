import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * One door. The Terminals stage owns finding a terminal: the rail has no
 * search box of its own, the picker's field is where "/" lands, and a ranked
 * row keeps the reason the matcher gave it.
 */
describe("terminal find wiring", () => {
  const picker = readFileSync(new URL("./Terminal.tsx", import.meta.url), "utf8");
  const rail = readFileSync(new URL("./left.tsx", import.meta.url), "utf8");

  test("the rail has no search box; the picker field is the one door", () => {
    expect(rail).not.toContain("Search terminals");
    expect(rail).not.toContain("useTerminalScreens");
    expect(picker).toContain("data-terminal-find");
    expect(picker).toContain("useSlashToFocus(");
  });

  test("the picker reads screens for screen: queries and keeps each hit's reason", () => {
    expect(picker).toContain("useTerminalScreens(");
    expect(picker).toContain("<TerminalPickerResults");
    expect(picker).toContain("s-term-picker-item-because");
  });

  test("the picker reads a session's panes for pane: queries, on the same opt-in terms", () => {
    expect(picker).toContain("useTerminalPanes(");
    expect(picker).toContain("terminalSearchNeedsPanes(");
    // Never speculative: both reads are gated on the query asking for them.
    expect(picker).toContain("pickerSearching && terminalSearchNeedsPanes(pickerTerms)");
  });

  test("every agent in the roster searches, with or without a terminal on the host", () => {
    expect(picker).toContain("sortTerminalAgents(agents)");
    expect(picker).toContain("terminalSearchTargetOfAgent(");
  });

  test("sources stay mounted as tabs when idle and become facets while searching", () => {
    expect(picker).not.toContain("hidden={pickerSearching}");
    expect(picker).toContain('className="s-term-picker-facets"');
  });

  test("the field sits in the app's top row and the stage becomes the results page", () => {
    expect(picker).toContain('<TerminalHeaderMount slot="search">');
    expect(picker).toContain('placeholder="Search terminals, agents, panes and screens"');
    expect(picker).toContain('" s-term-picker--results"');
    // The browse section is always on the stage: nothing to hide or show.
    expect(picker).not.toContain("Hide picker");
    expect(picker).not.toContain("pickerVisible,");
  });

  test("the crumb is a strip of workspace tabs; the top-right is New and a menu", () => {
    expect(picker).toContain('<TerminalHeaderMount slot="crumb">');
    expect(picker).toContain('className="s-term-desks" role="tablist"');
    expect(picker).toContain("showWorkspaceMenu");
    expect(picker).toContain('"scout:terminal-focus-toggle"');
    expect(picker).not.toContain(">Open in Scout</span>");
    expect(picker).not.toContain("s-term-topline-context");
  });
});
