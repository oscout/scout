import { describe, expect, test } from "bun:test";
import type { SessionState } from "@openscout/agent-sessions";

import {
  buildScoutTuiLivePaneProjection,
  buildScoutTuiLiveTraceRows,
  clampScoutTuiSelection,
  filterScoutTuiCommands,
  findScoutHarnessAgent,
  findScoutHarnessCommandDefinition,
  findScoutTuiTailSelectionIndex,
  findScoutTuiSelectionIndex,
  moveScoutTuiSelection,
  parseScoutHarnessCommand,
  parseScoutHarnessRuntime,
  tailScoutTuiLiveLogLines,
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

  test("preserves the selected agent by key when fleet ordering changes", () => {
    const selectedKey = "agent-b";
    expect(findScoutTuiSelectionIndex([
      { key: "agent-a" },
      { key: selectedKey },
    ], selectedKey)).toBe(1);
    expect(findScoutTuiSelectionIndex([
      { key: selectedKey },
      { key: "agent-a" },
    ], selectedKey)).toBe(0);
    expect(findScoutTuiSelectionIndex([{ key: "agent-a" }], selectedKey)).toBe(0);
  });

  test("preserves a selected tail event when a live entry is appended", () => {
    const selectedKey = "event-b";
    const before = [{ key: "event-a" }, { key: selectedKey }];
    const after = [...before, { key: "event-c" }];

    expect(findScoutTuiTailSelectionIndex(before, selectedKey)).toBe(1);
    expect(findScoutTuiTailSelectionIndex(after, selectedKey)).toBe(1);
    expect(findScoutTuiTailSelectionIndex(after, null)).toBe(2);
  });
});

describe("Scout TUI live agent logs", () => {
  test("shows the newest non-empty runtime lines", () => {
    expect(tailScoutTuiLiveLogLines("first\n\nsecond\nthird\n", 2)).toEqual([
      "second",
      "third",
    ]);
  });

  test("removes terminal control sequences before rendering", () => {
    expect(tailScoutTuiLiveLogLines("\u001B[32mworking\u001B[0m\n\u0007done", 4)).toEqual([
      "working",
      "done",
    ]);
  });

  test("preserves meaningful log indentation", () => {
    expect(tailScoutTuiLiveLogLines("root\n  child\n", 2)).toEqual([
      "root",
      "  child",
    ]);
  });

  test("returns no rows for an empty or zero-height viewport", () => {
    expect(tailScoutTuiLiveLogLines("", 4)).toEqual([]);
    expect(tailScoutTuiLiveLogLines("one", 0)).toEqual([]);
  });
});

describe("Scout TUI live agent traces", () => {
  test("flattens the newest streaming turn into readable text and tool rows", () => {
    const trace: SessionState = {
      session: {
        id: "session-live",
        name: "Live agent",
        adapterType: "codex",
        status: "active",
      },
      currentTurnId: "turn-live",
      turns: [
        {
          id: "turn-old",
          status: "completed",
          startedAt: 1,
          endedAt: 2,
          blocks: [{
            status: "completed",
            block: {
              id: "old-text",
              turnId: "turn-old",
              type: "text",
              status: "completed",
              index: 0,
              text: "old output",
            },
          }],
        },
        {
          id: "turn-live",
          status: "streaming",
          startedAt: 3,
          blocks: [
            {
              status: "streaming",
              block: {
                id: "thinking",
                turnId: "turn-live",
                type: "reasoning",
                status: "streaming",
                index: 0,
                text: "Inspecting the pane",
              },
            },
            {
              status: "streaming",
              block: {
                id: "command",
                turnId: "turn-live",
                type: "action",
                status: "streaming",
                index: 1,
                action: {
                  kind: "command",
                  status: "running",
                  command: "bun test model.test.ts",
                  output: "\u001B[32mPASS\u001B[0m\nwaiting for final output",
                },
              },
            },
          ],
        },
      ],
    };

    const rows = buildScoutTuiLiveTraceRows(trace, 6);

    expect(rows.map(({ label, text }) => [label, text])).toEqual([
      ["THINK", "Inspecting the pane"],
      ["RUN", "bun test model.test.ts"],
      ["OUT", "PASS"],
      ["", "waiting for final output"],
    ]);
    expect(rows.map((row) => row.live)).toEqual([false, false, false, true]);
    expect(rows.some((row) => row.text === "old output")).toBe(false);
  });

  test("renders a dynamic placeholder before a streaming text block has content", () => {
    const trace: SessionState = {
      session: {
        id: "session-live",
        name: "Live agent",
        adapterType: "claude",
        status: "active",
      },
      currentTurnId: "turn-live",
      turns: [{
        id: "turn-live",
        status: "streaming",
        startedAt: 1,
        blocks: [{
          status: "streaming",
          block: {
            id: "text",
            turnId: "turn-live",
            type: "text",
            status: "streaming",
            index: 0,
            text: "",
          },
        }],
      }],
    };

    expect(buildScoutTuiLiveTraceRows(trace, 3)).toEqual([{
      id: "text:streaming",
      kind: "text",
      label: "TEXT",
      text: "Writing…",
      live: true,
    }]);
  });

  test("tails wrapped streaming prose so a growing one-line block stays visibly live", () => {
    const traceWithText = (text: string): SessionState => ({
      session: {
        id: "session-live",
        name: "Live agent",
        adapterType: "codex",
        status: "active",
      },
      currentTurnId: "turn-live",
      turns: [{
        id: "turn-live",
        status: "streaming",
        startedAt: 1,
        blocks: [{
          status: "streaming",
          block: {
            id: "text",
            turnId: "turn-live",
            type: "text",
            status: "streaming",
            index: 0,
            text,
          },
        }],
      }],
    });

    expect(buildScoutTuiLiveTraceRows(traceWithText("abcdefghijklmnopqrstuvwxyz"), 2, 8)
      .map((row) => row.text)).toEqual(["qrstuvwx", "yz"]);
    expect(buildScoutTuiLiveTraceRows(traceWithText("abcdefghijklmnopqrstuvwxyz1234"), 2, 8)
      .map((row) => row.text)).toEqual(["qrstuvwx", "yz1234"]);
  });

  test("reports whether rows came from a structured trace or a raw log fallback", () => {
    const emptyTrace: SessionState = {
      session: {
        id: "session-live",
        name: "Live agent",
        adapterType: "codex",
        status: "active",
      },
      turns: [],
    };

    expect(buildScoutTuiLivePaneProjection(emptyTrace, "raw fallback", 3, 20)).toEqual({
      source: "trace",
      rows: [],
    });
    expect(buildScoutTuiLivePaneProjection(null, "first\nsecond", 3, 20)).toEqual({
      source: "log",
      rows: [
        {
          id: "debug:0",
          kind: "output",
          label: "LOG",
          text: "first",
          live: false,
        },
        {
          id: "debug:1",
          kind: "output",
          label: "",
          text: "second",
          live: false,
        },
      ],
    });
  });
});
