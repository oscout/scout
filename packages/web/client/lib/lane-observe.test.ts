import { describe, expect, test } from "bun:test";

import {
  filterObserveDataForHorizon,
  filterObserveDataForHorizonWithFill,
  filterObserveEventsForHorizon,
  filesFromObserveEvents,
  fmtLaneAgeLabel,
  fmtLaneWallGapLabel,
  fmtTraceSpanMs,
  isPlausibleFilePath,
  laneSnippetText,
  laneTextNeedsExpand,
  laneToolArgSnippet,
  laneTraceWindowStats,
  plausibleTouchedFiles,
  observeEventWallMs,
} from "./lane-observe.ts";
import type { ObserveFile } from "./types.ts";

describe("laneSnippetText", () => {
  test("clips long prose to a readable snippet", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega";
    expect(laneSnippetText(text, 40, 2).endsWith("…")).toBe(true);
    expect(laneTextNeedsExpand(text, 40, 2)).toBe(true);
  });
});

describe("filesFromObserveEvents", () => {
  test("infers read paths from shell and read tool args", () => {
    const files = filesFromObserveEvents([
      {
        id: "a",
        t: 1,
        kind: "tool",
        text: "Shell · sed -n '1,220p' packages/web/client/scout/repo-diff/DiffSurface.tsx",
        tool: "Shell",
        arg: "sed -n '1,220p' packages/web/client/scout/repo-diff/DiffSurface.tsx",
      },
      {
        id: "b",
        t: 2,
        kind: "tool",
        text: "Read · README.md",
        tool: "Read",
        arg: "{\"path\":\"README.md\"}",
      },
    ]);

    expect(files.map((file) => file.path)).toEqual([
      "README.md",
      "packages/web/client/scout/repo-diff/DiffSurface.tsx",
    ]);
    expect(files[0]?.state).toBe("read");
  });

  test("infers modified paths from patches and git diff commands", () => {
    const files = filesFromObserveEvents([
      {
        id: "patch",
        t: 4,
        kind: "tool",
        text: "Edit · patch",
        tool: "Edit",
        arg: "patch",
        detail: "*** Begin Patch\n*** Update File: packages/web/client/lib/lane-observe.ts\n@@\n-old\n+new\n*** End Patch",
      },
      {
        id: "diff",
        t: 5,
        kind: "tool",
        text: "Shell · git diff -- packages/web/client/lib/observe-display.ts",
        tool: "Shell",
        arg: "git diff -- packages/web/client/lib/observe-display.ts",
      },
    ]);

    expect(files.map((file) => [file.path, file.state])).toEqual([
      ["packages/web/client/lib/observe-display.ts", "read"],
      ["packages/web/client/lib/lane-observe.ts", "modified"],
    ]);
  });
});

describe("isPlausibleFilePath", () => {
  test("rejects bash-command tokens mis-recorded as read files", () => {
    const garbage = [
      "necho", "nsed", "ngrep", "npython3", "nnpx", "nCHROME=",
      "Google", "n#", "S…", "CHROME=", "echo", "sed", "grep",
      "npx", "python3", "for", "do", "done", "then", "fi",
    ];
    for (const token of garbage) {
      expect(isPlausibleFilePath(token)).toBe(false);
    }
  });

  test("rejects flags, env assignments, JSON fragments, and short/newline tokens", () => {
    expect(isPlausibleFilePath("-n")).toBe(false);
    expect(isPlausibleFilePath("--headless")).toBe(false);
    expect(isPlausibleFilePath("FOO=bar")).toBe(false);
    expect(isPlausibleFilePath('{"path"')).toBe(false);
    expect(isPlausibleFilePath("[1]")).toBe(false);
    expect(isPlausibleFilePath("ab")).toBe(false);
    expect(isPlausibleFilePath("x")).toBe(false);
    expect(isPlausibleFilePath("")).toBe(false);
    expect(isPlausibleFilePath("sed -n run.sh")).toBe(false); // multi-word
    expect(isPlausibleFilePath("run\nsh")).toBe(false); // newline
  });

  test("accepts genuine file paths", () => {
    const paths = [
      "line_strip.png",
      "run.sh",
      "console.css",
      "README.md",
      "ScoutTheme.swift",
      "packages/web/client/lib/lane-observe.ts",
      "docs/design/tokens.md",
      "/Applications/Google Chrome.app/x",
    ];
    for (const path of paths) {
      expect(isPlausibleFilePath(path)).toBe(true);
    }
  });

  test("never drops a token containing a slash", () => {
    expect(isPlausibleFilePath("a/b")).toBe(true);
    expect(isPlausibleFilePath("/dev/null")).toBe(true);
    expect(isPlausibleFilePath("src/echo")).toBe(true);
  });
});

describe("plausibleTouchedFiles", () => {
  test("filters garbage and dedupes by normalized path", () => {
    const files: ObserveFile[] = [
      { path: "necho", state: "read", touches: 1, lastT: 1 },
      { path: "nCHROME=", state: "read", touches: 1, lastT: 2 },
      { path: "Google", state: "read", touches: 1, lastT: 3 },
      { path: "run.sh", state: "read", touches: 1, lastT: 4 },
      { path: "run.sh ", state: "read", touches: 2, lastT: 6 },
      { path: "line_strip.png", state: "read", touches: 1, lastT: 5 },
    ];

    const result = plausibleTouchedFiles(files);
    expect(result.map((file) => file.path).sort()).toEqual([
      "line_strip.png",
      "run.sh",
    ]);
    const runSh = result.find((file) => file.path === "run.sh");
    expect(runSh?.touches).toBe(3);
    expect(runSh?.lastT).toBe(6);
  });

  test("promotes state when merging duplicate entries", () => {
    const files: ObserveFile[] = [
      { path: "router.ts", state: "read", touches: 1, lastT: 1 },
      { path: "router.ts", state: "modified", touches: 1, lastT: 2 },
    ];
    const [merged] = plausibleTouchedFiles(files);
    expect(merged?.state).toBe("modified");
  });
});

describe("filterObserveEventsForHorizon", () => {
  const NOW = 1_700_000_000_000;
  const sessionStart = NOW - 60 * 60_000;

  test("keeps only events inside the selected wall-clock window", () => {
    const events = [
      { id: "old", t: 600, at: NOW - 50 * 60_000, kind: "tool" as const, text: "old tool", tool: "Shell" },
      { id: "mid", t: 2400, at: NOW - 20 * 60_000, kind: "tool" as const, text: "mid tool", tool: "Shell" },
      { id: "new", t: 3540, at: NOW - 5 * 60_000, kind: "message" as const, text: "recent reply" },
    ];

    const filtered = filterObserveEventsForHorizon(
      events,
      sessionStart,
      NOW,
      30 * 60_000,
    );

    expect(filtered.map((event) => event.id)).toEqual(["mid", "new"]);
  });

  test("drops events without a resolvable wall time when filtering", () => {
    const filtered = filterObserveEventsForHorizon(
      [{ id: "orphan", t: 7200, kind: "tool", text: "merge_pull_request", tool: "merge_pull_request" }],
      undefined,
      NOW,
      30 * 60_000,
    );

    expect(filtered).toHaveLength(0);
  });
});

describe("observeEventWallMs", () => {
  test("normalizes direct and derived observe timestamps to epoch milliseconds", () => {
    expect(observeEventWallMs(
      { id: "direct", t: 10, at: 1_700_000_000, kind: "tool", text: "direct", tool: "Shell" },
      undefined,
    )).toBe(1_700_000_000_000);

    expect(observeEventWallMs(
      { id: "derived", t: 45, kind: "tool", text: "derived", tool: "Shell" },
      1_700_000_000,
    )).toBe(1_700_000_045_000);
  });
});

describe("filterObserveDataForHorizon", () => {
  const NOW = 1_700_000_000_000;
  const sessionStart = NOW - 60 * 60_000;

  test("filters observe files along with events", () => {
    const filtered = filterObserveDataForHorizon({
      events: [
        { id: "old", t: 600, kind: "tool", text: "old", tool: "Shell" },
        { id: "new", t: 3540, kind: "tool", text: "new", tool: "Shell" },
      ],
      files: [
        { path: "old.ts", state: "read", touches: 1, lastT: 600 },
        { path: "new.ts", state: "modified", touches: 1, lastT: 3540 },
      ],
      live: false,
      metadata: { session: { sessionStart } },
    }, NOW, 30 * 60_000);

    expect(filtered?.events.map((event) => event.id)).toEqual(["new"]);
    expect(filtered?.files.map((file) => file.path)).toEqual(["new.ts"]);
  });
});

describe("filterObserveDataForHorizonWithFill", () => {
  const NOW = 1_700_000_000_000;
  const sessionStart = NOW - 60 * 60_000;

  test("tops up a sparse window to the trailing fill minimum", () => {
    const filtered = filterObserveDataForHorizonWithFill({
      events: [
        { id: "old-a", t: 300, kind: "tool", text: "old-a", tool: "Shell" },
        { id: "old-b", t: 600, kind: "tool", text: "old-b", tool: "Shell" },
        { id: "new", t: 3540, kind: "tool", text: "new", tool: "Shell" },
      ],
      files: [
        { path: "old.ts", state: "read", touches: 1, lastT: 600 },
        { path: "new.ts", state: "modified", touches: 1, lastT: 3540 },
      ],
      live: false,
      metadata: { session: { sessionStart } },
    }, NOW, 30 * 60_000, 2);

    // Window alone keeps just "new"; the fill floor of 2 pulls "old-b" back
    // in, and the fill path keeps the whole touched-files inventory.
    expect(filtered?.events.map((event) => event.id)).toEqual(["old-b", "new"]);
    expect(filtered?.files.map((file) => file.path)).toEqual(["old.ts", "new.ts"]);
  });

  test("stays window-only when the window meets the fill minimum", () => {
    const filtered = filterObserveDataForHorizonWithFill({
      events: [
        { id: "old", t: 600, kind: "tool", text: "old", tool: "Shell" },
        { id: "new-a", t: 3480, kind: "tool", text: "new-a", tool: "Shell" },
        { id: "new-b", t: 3540, kind: "tool", text: "new-b", tool: "Shell" },
      ],
      files: [],
      live: false,
      metadata: { session: { sessionStart } },
    }, NOW, 30 * 60_000, 2);

    expect(filtered?.events.map((event) => event.id)).toEqual(["new-a", "new-b"]);
  });
});

describe("fmtLaneAgeLabel", () => {
  const NOW = 1_700_000_000_000;

  test("reads as wall-clock age, not session elapsed", () => {
    expect(fmtLaneAgeLabel(NOW - 12 * 60_000, NOW)).toBe("12m ago");
    expect(fmtLaneAgeLabel(NOW - 3_000, NOW)).toBe("now");
  });
});

describe("fmtLaneWallGapLabel", () => {
  test("shows meaningful wall-clock gaps only", () => {
    expect(fmtLaneWallGapLabel(45_000)).toBeNull();
    expect(fmtLaneWallGapLabel(18 * 60_000)).toBe("18m gap");
    expect(fmtLaneWallGapLabel(2 * 60 * 60_000 + 15 * 60_000)).toBe("2h 15m gap");
  });
});

describe("laneTraceWindowStats", () => {
  const NOW = 1_700_000_000_000;
  const windowMs = 30 * 60_000;

  test("summarizes visible span inside the horizon", () => {
    const stats = laneTraceWindowStats([
      { id: "a", t: 0, at: NOW - 29 * 60_000, kind: "tool", text: "a", tool: "Shell" },
      { id: "b", t: 1, at: NOW - 5 * 60_000, kind: "tool", text: "b", tool: "Shell" },
    ], NOW - 29 * 60_000, NOW, windowMs);

    expect(stats.eventCount).toBe(2);
    expect(stats.spanMs).toBe(24 * 60_000);
    expect(fmtTraceSpanMs(stats.spanMs)).toBe("24m");
    expect(stats.truncatedBefore).toBe(false);
  });

  test("flags when the oldest loaded event starts after the horizon cutoff", () => {
    const stats = laneTraceWindowStats([
      { id: "recent", t: 0, at: NOW - 10 * 60_000, kind: "tool", text: "recent", tool: "Shell" },
    ], NOW - 10 * 60_000, NOW, windowMs);

    expect(stats.truncatedBefore).toBe(true);
  });
});

describe("laneToolArgSnippet", () => {
  test("shortens long shell commands for lane headers", () => {
    const snippet = laneToolArgSnippet(
      "rg -n \"Line context|selectionContextFromWindow\" packages/web/client/scout/repo-diff/DiffSurface.tsx packages/web/client/scout/repo-diff/repo-diff.css",
    );
    expect(snippet.endsWith("…")).toBe(true);
  });
});
