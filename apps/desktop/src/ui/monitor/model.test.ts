import { describe, expect, test } from "bun:test";

import {
  clampScoutTuiSelection,
  filterScoutTuiCommands,
  findScoutHarnessCommandDefinition,
  findScoutHarnessAgent,
  moveScoutTuiSelection,
  parseScoutHarnessCommand,
  parseScoutHarnessRuntime,
  type ScoutTuiCommand,
} from "./model.ts";

const commands: ScoutTuiCommand[] = [
  { id: "fleet", label: "Show fleet", description: "Return to every agent" },
  { id: "ask", label: "Ask selected agent", description: "Dispatch broker-native work" },
  { id: "refresh", label: "Refresh now", description: "Reload broker state" },
  { id: "offline", label: "Offline action", description: "Unavailable", enabled: false },
];

describe("Scout TUI command palette", () => {
  test("keeps enabled commands in declared order for an empty query", () => {
    expect(filterScoutTuiCommands(commands, "").map((command) => command.id)).toEqual([
      "fleet",
      "ask",
      "refresh",
    ]);
  });

  test("supports contiguous and fuzzy command discovery", () => {
    expect(filterScoutTuiCommands(commands, "ask agent")[0]?.id).toBe("ask");
    expect(filterScoutTuiCommands(commands, "rfsh")[0]?.id).toBe("refresh");
  });

  test("omits disabled and unmatched actions", () => {
    expect(filterScoutTuiCommands(commands, "offline")).toEqual([]);
    expect(filterScoutTuiCommands(commands, "teleport")).toEqual([]);
  });
});

describe("Scout operator harness", () => {
  test("treats plain text and explicit asks as work requests", () => {
    expect(parseScoutHarnessCommand("review the failing build")).toEqual({
      kind: "ask",
      body: "review the failing build",
    });
    expect(parseScoutHarnessCommand("/ask inspect flight 42")).toEqual({
      kind: "ask",
      body: "inspect flight 42",
    });
  });

  test("parses first-class harness navigation and routing commands", () => {
    expect(parseScoutHarnessCommand("/profile kimi")).toEqual({ kind: "profile", profile: "kimi" });
    expect(parseScoutHarnessCommand("/runtime grok/grok-4-fast")).toEqual({
      kind: "runtime",
      runtime: "grok/grok-4-fast",
    });
    expect(parseScoutHarnessCommand("/agent openscout.main")).toEqual({ kind: "agent", query: "openscout.main" });
    expect(parseScoutHarnessCommand("/status")).toEqual({ kind: "status" });
    expect(parseScoutHarnessCommand("/tail")).toEqual({ kind: "navigate", tab: "tail" });
    expect(parseScoutHarnessCommand("/new")).toEqual({ kind: "navigate", tab: "new" });
    expect(parseScoutHarnessCommand("/launch")).toEqual({ kind: "navigate", tab: "new" });
  });

  test("opens interactive inspectors when target commands have no argument", () => {
    expect(parseScoutHarnessCommand("/profile")).toEqual({ kind: "profile" });
    expect(parseScoutHarnessCommand("/profiles")).toEqual({ kind: "profile" });
    expect(parseScoutHarnessCommand("/runtime")).toEqual({ kind: "runtime" });
    expect(parseScoutHarnessCommand("/agents")).toEqual({ kind: "agent" });
    expect(parseScoutHarnessCommand("/help profile")).toEqual({ kind: "help", query: "profile" });
  });

  test("fails closed for incomplete asks and unknown commands", () => {
    expect(parseScoutHarnessCommand("/ask")).toEqual({
      kind: "invalid",
      message: "Usage: /ask <request>",
    });
    expect(parseScoutHarnessCommand("/shell pwd")).toEqual({
      kind: "invalid",
      message: "Unknown harness command: /shell. Try /help.",
    });
  });

  test("expands exact runtimes into broker execution dimensions", () => {
    expect(parseScoutHarnessRuntime("codex/gpt-5.6-sol/xhigh")).toEqual({
      ok: true,
      value: {
        literal: "codex/gpt-5.6-sol/xhigh",
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
      },
    });
    expect(parseScoutHarnessRuntime("codex//xhigh")).toEqual({
      ok: false,
      message: "runtime_spec_invalid: runtime must be <harness>[/<model>[/<effort>]]",
    });
  });

  test("uses the same registry for parsing and detailed help", () => {
    expect(findScoutHarnessCommandDefinition("profile")?.usage).toBe("/profile [name]");
    expect(findScoutHarnessCommandDefinition("/profiles")?.name).toBe("profile");
    expect(findScoutHarnessCommandDefinition("/launch")?.name).toBe("new");
    expect(findScoutHarnessCommandDefinition("missing")).toBeNull();
  });

  test("resolves one agent by exact handle before a partial display name", () => {
    const agents = [
      { id: "openscout.main", title: "OpenScout" },
      { id: "openscout.review", title: "OpenScout Review" },
    ];
    expect(findScoutHarnessAgent(agents, "openscout.review")).toEqual({ kind: "match", index: 1 });
    expect(findScoutHarnessAgent(agents, "review")).toEqual({ kind: "match", index: 1 });
    expect(findScoutHarnessAgent(agents, "missing")).toEqual({ kind: "missing" });
  });

  test("fails closed when an agent name is ambiguous", () => {
    const agents = [
      { id: "openscout.main", title: "OpenScout" },
      { id: "openscout.review", title: "OpenScout" },
    ];
    expect(findScoutHarnessAgent(agents, "OpenScout")).toEqual({
      kind: "ambiguous",
      indices: [0, 1],
    });
    expect(findScoutHarnessAgent(agents, "openscout")).toEqual({
      kind: "ambiguous",
      indices: [0, 1],
    });
  });
});

describe("Scout TUI selection", () => {
  test("clamps selection when the fleet shrinks", () => {
    expect(clampScoutTuiSelection(8, 3)).toBe(2);
    expect(clampScoutTuiSelection(-2, 3)).toBe(0);
    expect(clampScoutTuiSelection(2, 0)).toBe(0);
  });

  test("wraps keyboard navigation across both edges", () => {
    expect(moveScoutTuiSelection(0, -1, 3)).toBe(2);
    expect(moveScoutTuiSelection(2, 1, 3)).toBe(0);
  });
});
