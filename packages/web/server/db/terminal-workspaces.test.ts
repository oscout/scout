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

  test("adds the layout column to a table that predates it", () => {
    // A machine that ran the build which created this table without
    // layout_json gets `CREATE TABLE IF NOT EXISTS`, which is a no-op — the
    // exact reason the field silently failed to persist there. The repair is a
    // guarded ALTER, and it has to be idempotent.
    const database = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
    try {
      database.exec("DROP TABLE IF EXISTS terminal_workspaces");
      database.exec(`CREATE TABLE terminal_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT '',
        columns_count INTEGER NOT NULL DEFAULT 2,
        cells_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`);
    } finally {
      database.close();
    }
    mod.closeTerminalWorkspaceDb();

    const created = mod.upsertTerminalWorkspace({
      name: "Upgraded desk",
      layout: { mode: "grid", columns: 3 },
      cells: [],
    });
    expect(created.layout).toEqual({ mode: "grid", columns: 3 });

    // Reopening must not try to add the column twice.
    mod.closeTerminalWorkspaceDb();
    expect(mod.upsertTerminalWorkspace({ id: created.id, name: "Upgraded desk", layout: { mode: "solo" } }).layout)
      .toEqual({ mode: "solo" });
  });

  test("refuses to hand back a layout mode that is not a shape", () => {
    const created = mod.upsertTerminalWorkspace({ name: "Desk", cells: [] });
    const database = new Database(join(process.env.OPENSCOUT_CONTROL_HOME!, "control-plane.sqlite"));
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
