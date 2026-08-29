import { describe, expect, test } from "bun:test";

import { formatTerminalSurfaceId } from "@openscout/protocol";

import {
  createFreshTerminalCell,
  isTerminalWorkspaceCell,
  restoreTerminalWorkspaceDeck,
  terminalCellSessionName,
  terminalWorkspaceLayoutFromRecord,
  terminalWorkspaceRecordInputFromLayout,
} from "./workspace-deck.ts";

/** The relay rejects anything else before it reaches a multiplexer CLI. */
const RELAY_SESSION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/u;

describe("terminalCellSessionName", () => {
  test("is stable for a cell id and safe for the relay validator", () => {
    const name = terminalCellSessionName("tmux", "cell-mabc123-1a2b3c4d", "tw.1");
    expect(name).toBe(terminalCellSessionName("tmux", "cell-mabc123-1a2b3c4d", "tw.1"));
    expect(name).toMatch(RELAY_SESSION_NAME);
    expect(name.startsWith("scout-tmux-cell-mabc123-1a2b3c4d")).toBe(true);
  });

  test("separates backends so replacing a tile does not squat the old name", () => {
    expect(terminalCellSessionName("zellij", "cell-1", "tw.1"))
      .not.toBe(terminalCellSessionName("tmux", "cell-1", "tw.1"));
  });

  test("separates workspaces, because a cell id is only unique inside one", () => {
    // Two workspaces each holding a cell called `slot-1` both used to claim
    // `scout-tmux-slot-1`, so two tiles attached to — and sent control verbs
    // to — the same host session.
    const first = terminalCellSessionName("tmux", "slot-1", "tw.first");
    const second = terminalCellSessionName("tmux", "slot-1", "tw.second");
    expect(first).not.toBe(second);
    expect(first).toMatch(RELAY_SESSION_NAME);
    expect(second).toMatch(RELAY_SESSION_NAME);
  });

  test("distinct ids that sanitize alike still get distinct names", () => {
    // `a:b` and `a b` both scrub to `a-b`. Collapsing them onto one host
    // session is the same collision by another route, so the digest is taken
    // over the raw id, before scrubbing.
    const colon = terminalCellSessionName("tmux", "a:b", "tw.1");
    const space = terminalCellSessionName("tmux", "a b", "tw.1");
    expect(colon).not.toBe(space);
    expect(colon).toMatch(RELAY_SESSION_NAME);
    expect(space).toMatch(RELAY_SESSION_NAME);
  });

  test("scrubs characters a multiplexer target cannot carry", () => {
    for (const cellId of ["weird:id with spaces", "-leading", "::::", "a.b", ""]) {
      const name = terminalCellSessionName("tmux", cellId, "tw.1");
      expect(name).toMatch(RELAY_SESSION_NAME);
      // tmux reads `.` and `:` as target syntax; neither may survive.
      expect(name).not.toContain(":");
      expect(name).not.toContain(".");
    }
    expect(terminalCellSessionName("tmux", "::::", "tw.1").startsWith("scout-tmux-cell-")).toBe(true);
  });
});

describe("createFreshTerminalCell", () => {
  test("mints an id once so the cell keeps its session across entries", () => {
    const first = createFreshTerminalCell("tmux");
    const second = createFreshTerminalCell("tmux");
    expect(first.id).not.toBe(second.id);
    expect(isTerminalWorkspaceCell(first)).toBe(true);
  });
});

describe("isTerminalWorkspaceCell", () => {
  test("rejects cells with no durable id", () => {
    expect(isTerminalWorkspaceCell({ kind: "fresh", backend: "pty", agent: "shell" })).toBe(false);
    expect(isTerminalWorkspaceCell({ id: "  ", kind: "fresh", backend: "pty", agent: "shell" })).toBe(false);
    expect(isTerminalWorkspaceCell({ id: "c1", kind: "fresh", backend: "pty", agent: "shell" })).toBe(true);
    expect(isTerminalWorkspaceCell({ id: "c1", kind: "registered", terminalSessionId: "s", terminalSurfaceKey: "tmux:a" })).toBe(true);
    expect(isTerminalWorkspaceCell({ id: "c1", kind: "unknown" })).toBe(false);
    expect(isTerminalWorkspaceCell(null)).toBe(false);
  });
});

describe("restoreTerminalWorkspaceDeck", () => {
  test("folds the v1 array forward and keys legacy cells by workspace slot", () => {
    const deck = restoreTerminalWorkspaceDeck([
      {
        id: "workspace-a",
        name: "Release desk",
        purpose: "Watch the train",
        columns: 3,
        updatedAt: 7,
        cells: [
          { kind: "fresh", backend: "tmux", agent: "shell" },
          { kind: "registered", terminalSessionId: "ts.1", terminalSurfaceKey: "tmux:relay-main" },
        ],
      },
    ]);

    expect(deck).toEqual({
      version: 1,
      activeWorkspaceId: "workspace-a",
      workspaces: [{
        id: "workspace-a",
        name: "Release desk",
        purpose: "Watch the train",
        columns: 3,
        updatedAt: 7,
        tiles: [
          { id: "workspace-a-0", kind: "fresh", backend: "tmux", agent: "shell" },
          { id: "workspace-a-1", kind: "registered", terminalSessionId: "ts.1", terminalSurfaceKey: "tmux:relay-main" },
        ],
      }],
    });
  });

  test("is idempotent, so an upgraded workspace keeps its session names", () => {
    const legacy = [{ id: "w", name: "W", columns: 2, cells: [{ kind: "fresh", backend: "tmux", agent: "shell" }] }];
    const once = restoreTerminalWorkspaceDeck(legacy);
    expect(restoreTerminalWorkspaceDeck(once)).toEqual(once);
    const workspace = once.workspaces[0]!;
    expect(terminalCellSessionName("tmux", workspace.tiles[0]!.id, workspace.id))
      .toBe(terminalCellSessionName("tmux", "w-0", "w"));
  });

  test("keeps a fresh install empty instead of inventing a workspace", () => {
    expect(restoreTerminalWorkspaceDeck(undefined).workspaces).toEqual([]);
    expect(restoreTerminalWorkspaceDeck([]).workspaces).toEqual([]);
    expect(restoreTerminalWorkspaceDeck([{ name: "no id" }]).workspaces).toEqual([]);
  });
});

describe("server workspace projections", () => {
  test("a fresh cell round-trips through the record with the intent needed to rebuild it", () => {
    const layout = {
      id: "tw.1",
      name: "Release desk",
      purpose: "Watch the train",
      columns: 3,
      updatedAt: 7,
      tiles: [
        { id: "cell-1", kind: "fresh" as const, backend: "tmux" as const, agent: "shell" as const },
        { id: "cell-2", kind: "fresh" as const, backend: "pty" as const, agent: "shell" as const },
      ],
    };

    const input = terminalWorkspaceRecordInputFromLayout(layout);
    expect(input.cells?.[0]?.intent).toEqual({
      hostId: "tmux",
      sessionName: terminalCellSessionName("tmux", "cell-1", "tw.1"),
    });
    // A disposable shell has nothing to reattach to; promising a revive would
    // be a lie.
    expect(input.cells?.[1]?.intent).toEqual({ hostId: "pty", sessionName: null });

    const record = {
      id: input.id,
      name: input.name,
      purpose: input.purpose ?? "",
      columns: input.columns ?? 2,
      cells: input.cells ?? [],
      createdAt: 1,
      updatedAt: 7,
    };
    expect(terminalWorkspaceLayoutFromRecord(record)).toEqual(layout);
  });

  test("a registered cell keeps its surface handle across the round trip", () => {
    const surfaceId = formatTerminalSurfaceId({ backend: "tmux", hostSession: "relay-main" });
    const layout = {
      id: "tw.2",
      name: "Desk",
      columns: 2,
      updatedAt: 3,
      tiles: [{
        id: "cell-1",
        kind: "registered" as const,
        terminalSessionId: "ts.1",
        terminalSurfaceKey: surfaceId,
      }],
    };
    const input = terminalWorkspaceRecordInputFromLayout(layout);
    expect(input.cells?.[0]).toEqual({
      id: "cell-1",
      surfaceId,
      terminalSessionId: "ts.1",
      // Not `{}`. The handle itself names a host and a session, so a registered
      // tile whose host restarted is revivable rather than "saved without
      // enough detail to reopen it".
      intent: { hostId: "tmux", sessionName: "relay-main" },
    });
    expect(terminalWorkspaceLayoutFromRecord({
      id: input.id,
      name: input.name,
      purpose: "",
      columns: 2,
      cells: input.cells ?? [],
      createdAt: 1,
      updatedAt: 3,
    })).toEqual(layout);
  });

  test("a registered cell saves the directory and resume command its record knows", () => {
    const surfaceId = formatTerminalSurfaceId({ backend: "tmux", hostSession: "relay-main" });
    const input = terminalWorkspaceRecordInputFromLayout({
      id: "tw.6",
      name: "Desk",
      columns: 2,
      updatedAt: 3,
      tiles: [{
        id: "cell-1",
        kind: "registered" as const,
        terminalSessionId: "ts.1",
        terminalSurfaceKey: surfaceId,
      }],
    }, {
      sessions: [{
        id: "ts.1",
        harness: "claude",
        sourceSessionId: "abc",
        cwd: "/Users/art/dev/openscout",
        resumeCommand: "claude --resume abc",
        surfaces: [],
        createdAt: 1,
        updatedAt: 2,
      }],
    });

    expect(input.cells?.[0]?.intent).toEqual({
      hostId: "tmux",
      sessionName: "relay-main",
      cwd: "/Users/art/dev/openscout",
      harness: "claude",
      resumeCommand: "claude --resume abc",
    });
  });

  test("keeps a host the browser cannot render, rather than silently downgrading it", () => {
    // Scout still owns the herdr session; the tile says where to use it.
    const layout = terminalWorkspaceLayoutFromRecord({
      id: "tw.3",
      name: "Desk",
      purpose: "",
      columns: 2,
      cells: [{ id: "cell-1", intent: { hostId: "herdr", sessionName: "scout-local-1" } }],
      createdAt: 1,
      updatedAt: 2,
    });
    expect(layout.tiles[0]).toEqual({ id: "cell-1", kind: "fresh", backend: "herdr", agent: "shell" });
  });

  test("a record naming a host Scout does not know falls back to a shell tile", () => {
    const layout = terminalWorkspaceLayoutFromRecord({
      id: "tw.4",
      name: "Desk",
      purpose: "",
      columns: 2,
      cells: [{ id: "cell-1", intent: { hostId: "kitty", sessionName: "whatever" } }],
      createdAt: 1,
      updatedAt: 2,
    });
    expect(layout.tiles[0]).toEqual({ id: "cell-1", kind: "fresh", backend: "pty", agent: "shell" });
  });

  test("carries the layout mode through the round trip", () => {
    const layout = {
      id: "tw.5",
      name: "Desk",
      columns: 3,
      layout: { mode: "lanes" as const, columns: "dynamic" as const },
      updatedAt: 3,
      tiles: [
        { id: "c1", kind: "fresh" as const, backend: "tmux" as const, agent: "shell" as const },
        { id: "c2", kind: "fresh" as const, backend: "tmux" as const, agent: "shell" as const },
      ],
    };
    const input = terminalWorkspaceRecordInputFromLayout(layout);
    expect(input.layout).toEqual({ mode: "lanes", columns: "dynamic" });
    // The resolved count is stored too, for clients that only read `columns`.
    expect(input.columns).toBe(2);
  });
});
