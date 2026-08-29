import { describe, expect, test } from "bun:test";
import {
  addTerminalWorkspace,
  closeTerminalWorkspace,
  createTerminalWorkspaceDeck,
  emptyTerminalWorkspaceDeck,
  moveTerminalWorkspaceItem,
  normalizeTerminalWorkspaceDeck,
  normalizeTerminalWorkspaceColumns,
  renameTerminalWorkspace,
  resolveTerminalProjectDestinations,
  selectTerminalWorkspace,
  TERMINAL_WORKSPACE_MAX_COLUMNS,
  terminalProjectCdCommand,
  terminalWorkspaceDropPlacement,
  updateActiveTerminalWorkspaceTiles,
  updateTerminalWorkspace,
  upsertTerminalWorkspace,
} from "./terminal-workspace.ts";

const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

const isTile = (value: unknown): value is { id: string } => (
  Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
);

describe("terminal workspace decks", () => {
  test("creates, selects, renames, and closes named workspaces", () => {
    let deck = createTerminalWorkspaceDeck<{ id: string }>();
    deck = updateActiveTerminalWorkspaceTiles(deck, [{ id: "main-tile" }]);
    deck = addTerminalWorkspace(deck, "second");
    expect(deck.activeWorkspaceId).toBe("second");
    expect(deck.workspaces.map((workspace) => workspace.name)).toEqual(["Main", "Workspace 2"]);

    deck = renameTerminalWorkspace(deck, "second", "Infra");
    deck = updateActiveTerminalWorkspaceTiles(deck, [{ id: "infra-tile" }]);
    deck = selectTerminalWorkspace(deck, "main");
    expect(deck.workspaces.find((workspace) => workspace.id === "main")?.tiles).toEqual([{ id: "main-tile" }]);

    deck = closeTerminalWorkspace(deck, "main");
    expect(deck.activeWorkspaceId).toBe("second");
    expect(deck.workspaces).toEqual([{ id: "second", name: "Infra", tiles: [{ id: "infra-tile" }] }]);
  });

  test("normalizes persisted state and removes malformed tiles", () => {
    expect(normalizeTerminalWorkspaceDeck({
      version: 99,
      activeWorkspaceId: "missing",
      workspaces: [
        { id: "main", name: " Main ", tiles: [{ id: "ok" }, { nope: true }] },
        { id: "main", name: "Duplicate", tiles: [] },
        { id: "", name: "Missing id", tiles: [] },
      ],
    }, (value): value is { id: string } => (
      Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
    ))).toEqual({
      version: 1,
      activeWorkspaceId: "main",
      workspaces: [{ id: "main", name: "Main", tiles: [{ id: "ok" }] }],
    });
  });

  test("carries workspace purpose, columns, and updatedAt through normalization", () => {
    const deck = normalizeTerminalWorkspaceDeck({
      version: 1,
      activeWorkspaceId: "desk",
      workspaces: [
        { id: "desk", name: "Release desk", purpose: "  Watch the train  ", columns: 3, updatedAt: 42, tiles: [] },
        { id: "junk", name: "Junk", purpose: "   ", columns: 0, updatedAt: -1, tiles: [] },
        { id: "wide", name: "Wide", columns: 99, tiles: [] },
      ],
    }, isTile);

    expect(deck.workspaces).toEqual([
      { id: "desk", name: "Release desk", purpose: "Watch the train", columns: 3, updatedAt: 42, tiles: [] },
      { id: "junk", name: "Junk", tiles: [] },
      { id: "wide", name: "Wide", columns: TERMINAL_WORKSPACE_MAX_COLUMNS, tiles: [] },
    ]);
  });

  test("returns an empty deck instead of inventing a workspace when asked", () => {
    expect(normalizeTerminalWorkspaceDeck(null, isTile, { allowEmpty: true }))
      .toEqual(emptyTerminalWorkspaceDeck());
    expect(normalizeTerminalWorkspaceDeck(null, isTile))
      .toEqual(createTerminalWorkspaceDeck());
  });

  test("closes the last workspace only when an empty deck is allowed", () => {
    const deck = createTerminalWorkspaceDeck<{ id: string }>();
    expect(closeTerminalWorkspace(deck, "main")).toBe(deck);
    expect(closeTerminalWorkspace(deck, "other", { allowEmpty: true })).toBe(deck);
    expect(closeTerminalWorkspace(deck, "main", { allowEmpty: true })).toEqual(emptyTerminalWorkspaceDeck());
  });

  test("upsert replaces in place, inserts at the front, and always activates", () => {
    let deck = emptyTerminalWorkspaceDeck<{ id: string }>();
    deck = upsertTerminalWorkspace(deck, { id: "one", name: "One", tiles: [] });
    deck = upsertTerminalWorkspace(deck, { id: "two", name: "Two", tiles: [] });
    expect(deck.workspaces.map((workspace) => workspace.id)).toEqual(["two", "one"]);
    expect(deck.activeWorkspaceId).toBe("two");

    deck = upsertTerminalWorkspace(deck, { id: "one", name: "One renamed", columns: 3, tiles: [{ id: "a" }] });
    expect(deck.workspaces.map((workspace) => workspace.id)).toEqual(["two", "one"]);
    expect(deck.activeWorkspaceId).toBe("one");
    expect(deck.workspaces[1]).toEqual({ id: "one", name: "One renamed", columns: 3, tiles: [{ id: "a" }] });
  });

  test("patching a workspace is identity-stable when nothing changes", () => {
    const deck = upsertTerminalWorkspace(
      emptyTerminalWorkspaceDeck<{ id: string }>(),
      { id: "one", name: "One", columns: 2, tiles: [] },
    );
    expect(updateTerminalWorkspace(deck, "one", { columns: 2 })).toBe(deck);
    expect(updateTerminalWorkspace(deck, "missing", { columns: 4 })).toBe(deck);
    expect(updateTerminalWorkspace(deck, "one", { columns: 4 }).workspaces[0]?.columns).toBe(4);
  });

  test("names a new workspace explicitly when a name is given", () => {
    const deck = addTerminalWorkspace(createTerminalWorkspaceDeck<{ id: string }>(), "second", "  Infra  ");
    expect(deck.workspaces.map((workspace) => workspace.name)).toEqual(["Main", "Infra"]);
  });
});

describe("normalizeTerminalWorkspaceColumns", () => {
  test("clamps to a usable range and rejects non-counts", () => {
    expect(normalizeTerminalWorkspaceColumns(3)).toBe(3);
    expect(normalizeTerminalWorkspaceColumns(2.7)).toBe(2);
    expect(normalizeTerminalWorkspaceColumns(0)).toBeNull();
    expect(normalizeTerminalWorkspaceColumns(Number.NaN)).toBeNull();
    expect(normalizeTerminalWorkspaceColumns("3")).toBeNull();
    expect(normalizeTerminalWorkspaceColumns(99)).toBe(TERMINAL_WORKSPACE_MAX_COLUMNS);
  });
});

describe("moveTerminalWorkspaceItem", () => {
  test("moves a tile before an earlier tile", () => {
    expect(moveTerminalWorkspaceItem(items, "d", "b", "before").map((item) => item.id))
      .toEqual(["a", "d", "b", "c"]);
  });

  test("moves a tile after a later tile", () => {
    expect(moveTerminalWorkspaceItem(items, "a", "c", "after").map((item) => item.id))
      .toEqual(["b", "c", "a", "d"]);
  });

  test("leaves the order unchanged for missing or identical ids", () => {
    expect(moveTerminalWorkspaceItem(items, "a", "a", "after")).toEqual(items);
    expect(moveTerminalWorkspaceItem(items, "missing", "b", "before")).toEqual(items);
  });
});

describe("terminalWorkspaceDropPlacement", () => {
  const bounds = { left: 100, top: 200, width: 400, height: 300 };

  test("uses top and bottom halves for a single-column grid", () => {
    expect(terminalWorkspaceDropPlacement({ x: 490, y: 220 }, bounds, 1))
      .toEqual({ axis: "vertical", edge: "before" });
    expect(terminalWorkspaceDropPlacement({ x: 110, y: 480 }, bounds, 1))
      .toEqual({ axis: "vertical", edge: "after" });
  });

  test("uses left and right halves for a multi-column grid", () => {
    expect(terminalWorkspaceDropPlacement({ x: 120, y: 480 }, bounds, 2))
      .toEqual({ axis: "horizontal", edge: "before" });
    expect(terminalWorkspaceDropPlacement({ x: 480, y: 220 }, bounds, 2))
      .toEqual({ axis: "horizontal", edge: "after" });
  });
});

describe("resolveTerminalProjectDestinations", () => {
  test("keeps configured projects canonical and ranks active roots first", () => {
    const destinations = resolveTerminalProjectDestinations(
      [
        { id: "alpha", title: "Alpha", root: "/Users/art/dev/alpha" },
        { id: "scout", title: "OpenScout", root: "/Users/art/dev/openscout/" },
      ],
      [
        {
          id: "agent-1",
          name: "Scout agent",
          project: "stale label",
          projectRoot: "~/dev/openscout",
          cwd: "~/dev/openscout/packages/web",
          updatedAt: 200,
        },
      ],
    );

    expect(destinations).toEqual([
      {
        id: "configured:scout",
        label: "OpenScout",
        path: "/Users/art/dev/openscout",
        source: "configured",
      },
      {
        id: "configured:alpha",
        label: "Alpha",
        path: "/Users/art/dev/alpha",
        source: "configured",
      },
    ]);
  });

  test("falls back to recent agent workspaces and rejects unsafe paths", () => {
    const destinations = resolveTerminalProjectDestinations([], [
      {
        id: "older",
        name: "Older",
        project: null,
        projectRoot: "/Users/art/dev/older",
        cwd: null,
        updatedAt: 10,
      },
      {
        id: "unsafe",
        name: "Unsafe",
        project: "Unsafe",
        projectRoot: "/Users/art/dev/unsafe\nrm -rf ~",
        cwd: null,
        updatedAt: 30,
      },
      {
        id: "newer",
        name: "Newer",
        project: "Newest",
        projectRoot: null,
        cwd: "/Users/art/dev/newer",
        updatedAt: 20,
      },
    ]);

    expect(destinations.map(({ label, path }) => ({ label, path }))).toEqual([
      { label: "Newest", path: "/Users/art/dev/newer" },
      { label: "older", path: "/Users/art/dev/older" },
    ]);
  });
});

describe("terminalProjectCdCommand", () => {
  test("quotes spaces and embedded single quotes for the shell", () => {
    expect(terminalProjectCdCommand("/Users/art/dev/My Project's app"))
      .toBe("cd -- '/Users/art/dev/My Project'\\''s app'");
  });

  test("keeps the home shortcut expandable", () => {
    expect(terminalProjectCdCommand("~/dev/My Project"))
      .toBe("cd -- ~/'dev/My Project'");
  });
});
