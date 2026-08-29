import { describe, expect, test } from "bun:test";

import type { TerminalListItem } from "../../lib/terminal-sessions.ts";
import {
  DEFAULT_TERMINAL_SESSION_SORT,
  TERMINAL_SESSION_INACTIVE_AFTER_MS,
  TERMINAL_SESSION_REVIEW_AFTER_MS,
  inactiveTerminalItemDetail,
  sortTerminalSessionItems,
  terminalSessionActivityAt,
  terminalSessionLifecycle,
  terminalSessionStateLabel,
  terminalSessionStateRank,
  toggleTerminalSessionSort,
} from "./session-table.ts";

function item(input: {
  title: string;
  backend: string;
  state?: "live" | "detached" | "exited";
  attached?: number;
  project?: string;
  origin?: "backend" | "scout";
  startedAt?: number;
  activityAt?: number;
  updatedAt?: number;
  panes?: number;
  cwdLabel?: string;
  lastKnown?: { savedAt?: number; panes?: number; agents?: string[] };
}): TerminalListItem {
  const surfaces = Array.from({ length: input.panes ?? 0 }, (_, index) => ({
    backend: input.backend,
    sessionName: input.title,
    paneId: index === 0 ? null : `%${index}`,
    attachCommand: [],
    observeCommand: null,
    relay: { backend: input.backend, sessionName: input.title },
    state: input.state ?? ("live" as const),
  }));
  return {
    id: input.title,
    key: input.title,
    title: input.title,
    detail: "",
    project: input.project ?? "unscoped",
    contextKind: "source",
    contextValue: input.title,
    cwdLabel: input.cwdLabel ?? "",
    origin: input.origin ?? "scout",
    condition: "",
    searchable: input.title,
    surface: surfaces[0] ?? {
      backend: input.backend,
      sessionName: input.title,
      paneId: null,
      attachCommand: [],
      observeCommand: null,
      relay: { backend: input.backend, sessionName: input.title },
      state: input.state ?? "live",
    },
    session: {
      id: input.title,
      harness: "claude",
      sourceSessionId: input.title,
      cwd: "",
      resumeCommand: "",
      surfaces,
      createdAt: 0,
      updatedAt: input.updatedAt ?? 0,
      metadata: {
        ...(input.attached === undefined ? {} : { attachedClients: input.attached }),
        ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
        ...(input.activityAt === undefined ? {} : { activityAt: input.activityAt }),
        ...(input.lastKnown === undefined ? {} : { lastKnownLayout: input.lastKnown }),
      },
    },
  } as TerminalListItem;
}

describe("terminalSessionStateRank", () => {
  test("ranks by how much is going on, with exited at the bottom", () => {
    expect(terminalSessionStateRank(item({ title: "a", backend: "tmux", attached: 2 }))).toBe(3);
    expect(terminalSessionStateRank(item({ title: "b", backend: "tmux" }))).toBe(2);
    expect(terminalSessionStateRank(item({ title: "c", backend: "herdr", state: "detached" }))).toBe(1);
    expect(terminalSessionStateRank(item({ title: "d", backend: "zellij", state: "exited" }))).toBe(0);
  });

  test("labels the state without inventing an attach count", () => {
    expect(terminalSessionStateLabel(item({ title: "a", backend: "tmux", attached: 2 }))).toBe("2 attached");
    expect(terminalSessionStateLabel(item({ title: "b", backend: "tmux", attached: 0 }))).toBe("live");
    expect(terminalSessionStateLabel(item({ title: "c", backend: "herdr", state: "detached" }))).toBe("detached");
    expect(terminalSessionStateLabel(item({ title: "d", backend: "zellij", state: "exited" }))).toBe("exited");
  });
});

describe("terminalSessionActivityAt", () => {
  test("prefers host activity and falls back to start time", () => {
    expect(terminalSessionActivityAt(item({
      title: "a",
      backend: "tmux",
      activityAt: 2000,
      startedAt: 1000,
      origin: "backend",
    }))).toBe(2000);
    expect(terminalSessionActivityAt(item({ title: "b", backend: "tmux", startedAt: 1000, origin: "backend" })))
      .toBe(1000);
  });

  test("refuses to report a probe timestamp as activity", () => {
    // A discovered record is stamped when it was probed, which is not activity.
    expect(terminalSessionActivityAt(item({ title: "a", backend: "tmux", origin: "backend", updatedAt: 9999 })))
      .toBeNull();
    expect(terminalSessionActivityAt(item({ title: "b", backend: "tmux", origin: "scout", updatedAt: 9999 })))
      .toBe(9999);
  });
});

describe("terminalSessionLifecycle", () => {
  const now = 100 * 24 * 60 * 60 * 1_000;

  test("keeps recent work current and separates inactive from review", () => {
    expect(terminalSessionLifecycle(item({
      title: "current",
      backend: "tmux",
      activityAt: now - TERMINAL_SESSION_INACTIVE_AFTER_MS + 1,
    }), now)).toBe("current");
    expect(terminalSessionLifecycle(item({
      title: "inactive",
      backend: "tmux",
      activityAt: now - TERMINAL_SESSION_INACTIVE_AFTER_MS,
    }), now)).toBe("inactive");
    expect(terminalSessionLifecycle(item({
      title: "review",
      backend: "tmux",
      activityAt: now - TERMINAL_SESSION_REVIEW_AFTER_MS,
    }), now)).toBe("review");
  });

  test("unknown activity is never treated as permission to retire", () => {
    expect(terminalSessionLifecycle(item({ title: "unknown", backend: "zellij", origin: "backend" }), now))
      .toBe("current");
    expect(terminalSessionLifecycle(item({
      title: "old-host",
      backend: "tmux",
      origin: "backend",
      startedAt: now - TERMINAL_SESSION_REVIEW_AFTER_MS,
    }), now)).toBe("current");
  });
});

describe("sortTerminalSessionItems", () => {
  const rows = [
    item({ title: "zeta", backend: "zellij", state: "detached", project: "beta" }),
    item({ title: "alpha", backend: "tmux", attached: 1, project: "alpha", updatedAt: 10 }),
    item({ title: "mid", backend: "herdr", state: "detached", project: "gamma", updatedAt: 30 }),
    item({ title: "gone", backend: "tmux", state: "exited", project: "alpha" }),
  ];

  test("the default sort puts live work first", () => {
    expect(sortTerminalSessionItems(rows, DEFAULT_TERMINAL_SESSION_SORT).map((row) => row.title))
      .toEqual(["alpha", "mid", "zeta", "gone"]);
  });

  test("sorts by every column, in both directions", () => {
    expect(sortTerminalSessionItems(rows, { column: "name", direction: "asc" }).map((row) => row.title))
      .toEqual(["alpha", "gone", "mid", "zeta"]);
    expect(sortTerminalSessionItems(rows, { column: "name", direction: "desc" }).map((row) => row.title))
      .toEqual(["zeta", "mid", "gone", "alpha"]);
    expect(sortTerminalSessionItems(rows, { column: "host", direction: "asc" }).map((row) => row.surface.backend))
      .toEqual(["herdr", "tmux", "tmux", "zellij"]);
    expect(sortTerminalSessionItems(rows, { column: "project", direction: "asc" }).map((row) => row.project))
      .toEqual(["alpha", "alpha", "beta", "gamma"]);
  });

  test("ties break on the session name, so the order never wobbles", () => {
    const sorted = sortTerminalSessionItems(rows, { column: "host", direction: "asc" });
    expect(sorted.map((row) => row.title)).toEqual(["mid", "alpha", "gone", "zeta"]);
    expect(sortTerminalSessionItems(sorted, { column: "host", direction: "asc" }).map((row) => row.title))
      .toEqual(["mid", "alpha", "gone", "zeta"]);
  });

  test("rows with no reported activity never masquerade as newest", () => {
    const byActivity = sortTerminalSessionItems(rows, { column: "activity", direction: "desc" });
    expect(byActivity[0]?.title).toBe("mid");
    expect(byActivity.slice(-2).map((row) => row.title).sort()).toEqual(["gone", "zeta"]);
  });

  test("does not mutate the input", () => {
    const original = [...rows];
    sortTerminalSessionItems(rows, { column: "name", direction: "desc" });
    expect(rows).toEqual(original);
  });
});

describe("toggleTerminalSessionSort", () => {
  test("flips direction on the active column and uses a sensible start elsewhere", () => {
    expect(toggleTerminalSessionSort({ column: "name", direction: "asc" }, "name"))
      .toEqual({ column: "name", direction: "desc" });
    expect(toggleTerminalSessionSort({ column: "name", direction: "asc" }, "activity"))
      .toEqual({ column: "activity", direction: "desc" });
    expect(toggleTerminalSessionSort({ column: "name", direction: "asc" }, "project"))
      .toEqual({ column: "project", direction: "asc" });
  });
});

describe("inactiveTerminalItemDetail", () => {
  // A realistic epoch — normalizeTimestampMs treats small values as legacy
  // seconds, so a synthetic "now" like 100 days would misread as 1970.
  const now = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1_000;

  test("answers what the session was and how stale it is", () => {
    expect(inactiveTerminalItemDetail(item({
      title: "blink",
      backend: "herdr",
      activityAt: now - 10 * DAY,
      panes: 4,
      cwdLabel: "dev/openscout",
    }), now)).toBe("last active 10d ago · 4 panes · dev/openscout");
  });

  test("omits unknown activity and single-pane counts", () => {
    expect(inactiveTerminalItemDetail(item({
      title: "quiet",
      backend: "tmux",
      origin: "backend",
      updatedAt: now - DAY,
      panes: 1,
      cwdLabel: "dev/hudson",
    }), now)).toBe("dev/hudson");
  });

  test("falls back to the record identity when nothing else is known", () => {
    expect(inactiveTerminalItemDetail(item({ title: "mystery", backend: "tmux", origin: "backend" }), now))
      .toBe("mystery");
  });

  test("a stopped herdr session still answers from its persisted layout", () => {
    // The server is down, so there is no live activity and one discovered
    // surface; session.json on disk is the only honest source of "what was in
    // it" — its mtime stands in for last activity.
    expect(inactiveTerminalItemDetail(item({
      title: "scout-local-1",
      backend: "herdr",
      origin: "backend",
      state: "detached",
      cwdLabel: "dev/talkie",
      lastKnown: { savedAt: now - 23 * DAY, panes: 1, agents: ["claude"] },
    }), now)).toBe("last active 23d ago · 1 pane · claude · dev/talkie");
  });

  test("live activity outranks the persisted layout's saved-at", () => {
    expect(inactiveTerminalItemDetail(item({
      title: "blink",
      backend: "herdr",
      activityAt: now - 2 * DAY,
      lastKnown: { savedAt: now - 23 * DAY, panes: 6, agents: ["codex"] },
    }), now)).toBe("last active 2d ago · 6 panes · codex");
  });
});
