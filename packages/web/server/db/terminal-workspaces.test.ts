import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { terminalWorkspaceLayoutOf } from "@openscout/protocol";

const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const roots = new Set<string>();

// Import after the control home is redirected, so the module's lazy handles
// resolve to a throwaway database and never touch a real control plane.
let mod: typeof import("./terminal-workspaces.ts");
let closeSharedDb: () => void;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "openscout-terminal-workspaces-"));
  roots.add(root);
  process.env.OPENSCOUT_CONTROL_HOME = root;
  ({ closeDb: closeSharedDb } = await import("./internal/db.ts"));
  // The readonly handle is cached per process; drop it so it reopens against
  // this test's throwaway control home.
  closeSharedDb();
  mod = await import(`./terminal-workspaces.ts?home=${encodeURIComponent(root)}`);
});

afterEach(() => {
  mod?.closeTerminalWorkspaceDb();
  closeSharedDb?.();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
  if (originalControlHome === undefined) delete process.env.OPENSCOUT_CONTROL_HOME;
  else process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
});

describe("terminal workspace store", () => {
  test("an install that never authored a workspace reads empty, not an error", () => {
    expect(mod.queryTerminalWorkspaces()).toEqual([]);
    expect(mod.queryTerminalWorkspace("tw.missing")).toBeNull();
  });

  test("round-trips a workspace with the intent each cell needs to be rebuilt", () => {
    const created = mod.upsertTerminalWorkspace({
      name: "Release desk",
      purpose: "Watch the train",
      columns: 3,
      cells: [{
        id: "cell-1",
        surfaceId: "srf1.abc",
        terminalSessionId: "ts.1",
        intent: {
          hostId: "tmux",
          sessionName: "scout-tmux-cell-1",
          cwd: "/repo",
          harness: "claude",
          resumeCommand: "claude --resume abc",
        },
      }],
    });

    expect(created.id).toMatch(/^tw\./);
    expect(created.columns).toBe(3);
    expect(created.cells[0]?.intent.resumeCommand).toBe("claude --resume abc");
    expect(mod.queryTerminalWorkspace(created.id)).toEqual(created);
    expect(mod.queryTerminalWorkspaces()).toEqual([created]);
  });

  test("updating keeps identity and creation time", () => {
    const first = mod.upsertTerminalWorkspace({ name: "Desk" });
    const second = mod.upsertTerminalWorkspace({ id: first.id, name: "Desk renamed", columns: 1 });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(mod.queryTerminalWorkspaces()).toHaveLength(1);
  });

  test("clamps an out-of-range column count", () => {
    expect(mod.upsertTerminalWorkspace({ name: "Wide", columns: 99 }).columns).toBe(6);
    expect(mod.upsertTerminalWorkspace({ name: "Thin", columns: 0 }).columns).toBe(1);
  });

  test("the authored layout survives the round trip, dynamic and all", () => {
    // The reproduced blocker: the table had no layout column and both stores
    // ignored `input.layout`, so `{mode:"lanes",columns:"dynamic"}` came back
    // as null and the client re-inferred a shape from the resolved column
    // count. That fold-forward pins "dynamic" to a number and cannot express a
    // lanes workspace at all past six tiles.
    const created = mod.upsertTerminalWorkspace({
      name: "Release desk",
      columns: 2,
      layout: { mode: "lanes", columns: "dynamic" },
      cells: [],
    });

    expect(created.layout).toEqual({ mode: "lanes", columns: "dynamic" });
    expect(mod.queryTerminalWorkspace(created.id)?.layout).toEqual({ mode: "lanes", columns: "dynamic" });
    expect(mod.queryTerminalWorkspaces()[0]?.layout).toEqual({ mode: "lanes", columns: "dynamic" });
  });

  test("a lanes workspace with more tiles than the column clamp reloads as lanes", () => {
    // Nine tiles, dynamic lanes. `resolveTerminalWorkspaceColumns` clamps the
    // resolved count to six, and six < nine used to re-infer `grid` on read —
    // so the one shape a big workspace was authored in was the one it could
    // never come back as.
    const created = mod.upsertTerminalWorkspace({
      name: "Wide desk",
      columns: 6,
      layout: { mode: "lanes", columns: "dynamic" },
      cells: Array.from({ length: 9 }, (_, index) => ({
        id: `cell-${index}`,
        intent: { hostId: "tmux", sessionName: `scout-tmux-cell-${index}` },
      })),
    });

    const reloaded = mod.queryTerminalWorkspace(created.id)!;
    expect(reloaded.cells).toHaveLength(9);
    expect(terminalWorkspaceLayoutOf({
      layout: reloaded.layout,
      columns: reloaded.columns,
      cellCount: reloaded.cells.length,
    })).toEqual({ mode: "lanes", columns: "dynamic" });
  });

  test("a record written before layouts existed still reads", () => {
    const created = mod.upsertTerminalWorkspace({ name: "Old desk", columns: 2, cells: [] });
    expect(created.layout).toBeUndefined();
    expect(mod.queryTerminalWorkspace(created.id)?.layout).toBeUndefined();
  });

  test("carries workspaces over from the control plane once, including ones that predate layouts", () => {
    // Workspaces used to live in the broker's control-plane database. The
    // web-owned file copies them over on first open; a table from a build
    // before layout_json existed must still come across.
    mod.closeTerminalWorkspaceDb();
    const home = process.env.OPENSCOUT_CONTROL_HOME!;
    rmSync(join(home, "web-state.sqlite"), { force: true });
    const controlPlane = new Database(join(home, "control-plane.sqlite"), { create: true });
    try {
      controlPlane.exec(`CREATE TABLE terminal_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT '',
        columns_count INTEGER NOT NULL DEFAULT 2,
        cells_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`);
      controlPlane.query("INSERT INTO terminal_workspaces (id, name, columns_count, updated_at) VALUES (?, ?, ?, ?)")
        .run("tw.legacy", "Legacy desk", 3, 1);
    } finally {
      controlPlane.close();
    }

    const imported = mod.queryTerminalWorkspace("tw.legacy");
    expect(imported).toEqual(expect.objectContaining({ name: "Legacy desk", columns: 3 }));
    expect(imported?.layout).toBeUndefined();

    // Once: a workspace deleted after the copy stays deleted on reopen.
    expect(mod.deleteTerminalWorkspace("tw.legacy")).toBe(true);
    mod.closeTerminalWorkspaceDb();
    expect(mod.queryTerminalWorkspace("tw.legacy")).toBeNull();

    // And the control plane was only read.
    const reread = new Database(join(home, "control-plane.sqlite"), { readonly: true });
    try {
      expect(reread.query("SELECT count(*) AS count FROM terminal_workspaces").get()).toEqual({ count: 1 });
    } finally {
      reread.close();
    }
  });

  test("refuses to hand back a layout mode that is not a shape", () => {
    const created = mod.upsertTerminalWorkspace({ name: "Desk", cells: [] });
    const database = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "web-state.sqlite"));
    try {
      database.query("UPDATE terminal_workspaces SET layout_json = ? WHERE id = ?")
        .run(JSON.stringify({ mode: "carousel", columns: 4 }), created.id);
    } finally {
      database.close();
    }
    mod.closeTerminalWorkspaceDb();
    expect(mod.queryTerminalWorkspace(created.id)?.layout).toBeUndefined();
  });

  test("delete reports whether anything was removed", () => {
    const record = mod.upsertTerminalWorkspace({ name: "Desk" });
    expect(mod.deleteTerminalWorkspace(record.id)).toBe(true);
    expect(mod.deleteTerminalWorkspace(record.id)).toBe(false);
    expect(mod.queryTerminalWorkspace(record.id)).toBeNull();
  });
});
