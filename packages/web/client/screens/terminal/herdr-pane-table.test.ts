import { describe, expect, test } from "bun:test";

import type { HerdrPaneProjection } from "@openscout/protocol";

import {
  DEFAULT_HERDR_PANE_SORT,
  herdrPaneDirectory,
  herdrPaneDrift,
  herdrPaneStatusRank,
  lastOutputLine,
  sortHerdrPaneRows,
  toggleHerdrPaneSort,
  type HerdrPaneRow,
} from "./herdr-pane-table.ts";

function pane(input: {
  paneId: string;
  label?: string | null;
  agent?: string | null;
  agentStatus?: HerdrPaneProjection["agentStatus"];
  cwd?: string | null;
  foregroundCwd?: string | null;
  focused?: boolean;
  drift?: number | null;
}): HerdrPaneProjection {
  return {
    paneId: input.paneId,
    terminalId: null,
    tabId: "w1:t1",
    workspaceId: "w1",
    label: input.label ?? null,
    agent: input.agent ?? null,
    agentStatus: input.agentStatus ?? "unknown",
    agentSession: null,
    cwd: input.cwd ?? null,
    foregroundCwd: input.foregroundCwd ?? null,
    focused: input.focused ?? false,
    scroll: input.drift === undefined || input.drift === null
      ? null
      : { maxOffsetFromBottom: 400, offsetFromBottom: input.drift, viewportRows: 60 },
  };
}

function row(input: Parameters<typeof pane>[0] & { tabLabel?: string; output?: string | null }): HerdrPaneRow {
  const { tabLabel, output, ...paneInput } = input;
  return {
    pane: pane(paneInput),
    tabLabel: tabLabel ?? "main",
    output: output ?? null,
  };
}

describe("herdrPaneStatusRank", () => {
  test("orders live work ahead of quiet and unknown panes", () => {
    expect(herdrPaneStatusRank("working")).toBeGreaterThan(herdrPaneStatusRank("blocked"));
    expect(herdrPaneStatusRank("blocked")).toBeGreaterThan(herdrPaneStatusRank("idle"));
    expect(herdrPaneStatusRank("idle")).toBeGreaterThan(herdrPaneStatusRank("done"));
    expect(herdrPaneStatusRank("done")).toBeGreaterThan(herdrPaneStatusRank("unknown"));
  });
});

describe("sortHerdrPaneRows", () => {
  const rows = [
    row({ paneId: "w1:p1", label: "Shell", agentStatus: "unknown", drift: null }),
    row({ paneId: "w1:p2", label: "Claude", agent: "claude", agentStatus: "working", drift: 12 }),
    row({ paneId: "w1:p3", label: "Kimi", agent: "kimi", agentStatus: "idle", drift: 0 }),
  ];

  test("default sort puts working panes first", () => {
    expect(sortHerdrPaneRows(rows, DEFAULT_HERDR_PANE_SORT).map((r) => r.pane.label)).toEqual([
      "Claude",
      "Kimi",
      "Shell",
    ]);
  });

  test("ascending status reverses the ranks but keeps the name tie-break", () => {
    expect(sortHerdrPaneRows(rows, { column: "status", direction: "asc" }).map((r) => r.pane.label)).toEqual([
      "Shell",
      "Kimi",
      "Claude",
    ]);
  });

  test("drift sorts numerically with unreported panes last in both directions", () => {
    const desc = sortHerdrPaneRows(rows, { column: "drift", direction: "desc" }).map((r) => r.pane.label);
    const asc = sortHerdrPaneRows(rows, { column: "drift", direction: "asc" }).map((r) => r.pane.label);
    expect(desc).toEqual(["Claude", "Kimi", "Shell"]);
    expect(asc).toEqual(["Kimi", "Claude", "Shell"]);
  });

  test("output sorts on the last visible line, missing output last", () => {
    const withOutput = [
      row({ paneId: "w1:p1", label: "A", output: "compiling…\nalpha done" }),
      row({ paneId: "w1:p2", label: "B", output: "beta failed" }),
      row({ paneId: "w1:p3", label: "C" }),
    ];
    expect(sortHerdrPaneRows(withOutput, { column: "output", direction: "asc" }).map((r) => r.pane.label))
      .toEqual(["A", "B", "C"]);
  });

  test("directory prefers the foreground cwd", () => {
    expect(herdrPaneDirectory(pane({ paneId: "p", cwd: "/a", foregroundCwd: "/b" }))).toBe("/b");
    expect(herdrPaneDirectory(pane({ paneId: "p", cwd: "/a" }))).toBe("/a");
    expect(herdrPaneDrift(pane({ paneId: "p" }))).toBeNull();
  });
});

describe("lastOutputLine", () => {
  test("returns the last non-empty line, trimmed", () => {
    expect(lastOutputLine("one\ntwo  \n\n")).toBe("two");
    expect(lastOutputLine("  \n\n")).toBeNull();
    expect(lastOutputLine(null)).toBeNull();
    expect(lastOutputLine("")).toBeNull();
  });

  test("strips ANSI escape sequences before judging emptiness", () => {
    expect(lastOutputLine("\x1b[32m✓ ok\x1b[0m\n\x1b[2K")).toBe("✓ ok");
  });
});

describe("toggleHerdrPaneSort", () => {
  test("flips direction on the active column and starts fresh columns at their initial direction", () => {
    expect(toggleHerdrPaneSort(DEFAULT_HERDR_PANE_SORT, "status"))
      .toEqual({ column: "status", direction: "asc" });
    expect(toggleHerdrPaneSort(DEFAULT_HERDR_PANE_SORT, "pane"))
      .toEqual({ column: "pane", direction: "asc" });
    expect(toggleHerdrPaneSort(DEFAULT_HERDR_PANE_SORT, "drift"))
      .toEqual({ column: "drift", direction: "desc" });
  });
});
