import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHerdrAttachCommand,
  buildHerdrCreateAttachCommand,
  buildHerdrStartServerCommand,
  buildHerdrWorkspaceCreateCommand,
  herdrProbeKey,
  parseHerdrAgentList,
  parseHerdrSessionListJson,
  parseHerdrSnapshotLayouts,
  parseHerdrTopology,
  readHerdrSessions,
} from "./herdr.js";

describe("herdr session helpers", () => {
  test("parses herdr session list JSON", () => {
    expect(parseHerdrSessionListJson(JSON.stringify({
      sessions: [
        {
          default: true,
          name: "default",
          running: true,
          session_dir: "/Users/example/.config/herdr",
          socket_path: "/Users/example/.config/herdr/herdr.sock",
        },
        {
          default: false,
          name: "scout-local-1",
          running: false,
        },
      ],
    }))).toEqual([
      { name: "default", isDefault: true, running: true, sessionDir: "/Users/example/.config/herdr" },
      { name: "scout-local-1", isDefault: false, running: false, sessionDir: null },
    ]);
  });

  test("survives an unavailable or unparseable herdr", () => {
    expect(parseHerdrSessionListJson("")).toEqual([]);
    expect(parseHerdrSessionListJson("not json")).toEqual([]);
    expect(parseHerdrSessionListJson(JSON.stringify({ sessions: [{ running: true }] }))).toEqual([]);
  });

  test("builds attach commands without socket paths", () => {
    expect(buildHerdrAttachCommand({ name: "default", isDefault: true })).toEqual(["herdr"]);
    expect(buildHerdrAttachCommand({ name: "scout-local-1", isDefault: false })).toEqual([
      "herdr",
      "session",
      "attach",
      "scout-local-1",
    ]);
    expect(buildHerdrCreateAttachCommand("scout-main-1")).toEqual(["herdr", "--session", "scout-main-1"]);
    expect(buildHerdrCreateAttachCommand("  ")).toEqual(["herdr"]);
  });

  test("keys the probe on the environment, not on caller-supplied input", () => {
    // The key is DERIVED from an environment rather than taken from a caller,
    // which is what keeps a browser from steering the probe at an arbitrary
    // socket — the property the old "always 'default'" key was reaching for. It
    // achieved that by making every environment share one cache entry, so a
    // probe of a PATH with no herdr on it was served the inventory collected
    // for a completely different environment.
    const here = herdrProbeKey({ env: { PATH: "/usr/bin", HOME: "/tmp" } as NodeJS.ProcessEnv });
    const elsewhere = herdrProbeKey({ env: { PATH: "/nowhere", HOME: "/tmp" } as NodeJS.ProcessEnv });
    const otherHome = herdrProbeKey({ env: { PATH: "/usr/bin", HOME: "/other" } as NodeJS.ProcessEnv });
    const otherBin = herdrProbeKey({
      env: { PATH: "/usr/bin", HOME: "/tmp", OPENSCOUT_HERDR_BIN: "/opt/herdr" } as NodeJS.ProcessEnv,
    });

    expect(here).toBe(herdrProbeKey({ env: { PATH: "/usr/bin", HOME: "/tmp" } as NodeJS.ProcessEnv }));
    expect(new Set([here, elsewhere, otherHome, otherBin]).size).toBe(4);
    // No socket path appears in a key, whatever a caller puts in the env.
    expect(here).not.toContain(".sock");
    // A bare string key is still accepted and is not a socket either.
    expect(herdrProbeKey("default")).toBe("default");
    expect(herdrProbeKey(null)).toBe(herdrProbeKey({ env: process.env }));
  });
});

describe("herdr session creation argv", () => {
  test("starts a named session headlessly rather than launching a client", () => {
    // `herdr --session <name>` needs a TTY; the server half does not.
    expect(buildHerdrStartServerCommand("scout-desk-1")).toEqual(["herdr", "--session", "scout-desk-1", "server"]);
    expect(buildHerdrStartServerCommand("  ")).toEqual(["herdr", "server"]);
  });

  test("creates the first workspace without stealing focus", () => {
    expect(buildHerdrWorkspaceCreateCommand("scout-desk-1", { cwd: "/repo", label: "Scout" }))
      .toEqual(["herdr", "--session", "scout-desk-1", "workspace", "create", "--cwd", "/repo", "--label", "Scout", "--no-focus"]);
    expect(buildHerdrWorkspaceCreateCommand("scout-desk-1"))
      .toEqual(["herdr", "--session", "scout-desk-1", "workspace", "create", "--no-focus"]);
  });
});

describe("parseHerdrAgentList", () => {
  test("reads host-reported agent state from the socket API JSON", () => {
    expect(parseHerdrAgentList(JSON.stringify({
      id: "cli:agent:list",
      result: {
        type: "agent_list",
        agents: [
          { agent_status: "working", cwd: "/repo", name: "claude", pane_id: "w1:p2", terminal_id: "term_a" },
          { agent_status: "idle", name: "codex", pane_id: "w1:p3" },
          { agent_status: "spinning", name: "scratch", terminal_id: "term_c" },
        ],
      },
    }))).toEqual([
      { target: "w1:p2", name: "claude", status: "working", cwd: "/repo" },
      { target: "w1:p3", name: "codex", status: "idle", cwd: null },
      // A status the schema grows later reads as unknown, never as a guess.
      { target: "term_c", name: "scratch", status: "unknown", cwd: null },
    ]);
  });

  test("is empty when the session server is not running", () => {
    expect(parseHerdrAgentList("")).toEqual([]);
    expect(parseHerdrAgentList("Error: Connection refused")).toEqual([]);
    expect(parseHerdrAgentList(JSON.stringify({ result: { agents: [] } }))).toEqual([]);
  });
});

describe("parseHerdrTopology", () => {
  // Fixtures mirror herdr 0.7.3 CLI output verbatim (`{id, result:{...}}`).
  const workspaceList = JSON.stringify({
    id: "cli:workspace:list",
    result: {
      type: "workspace_list",
      workspaces: [
        {
          active_tab_id: "w2:t1",
          agent_status: "working",
          focused: true,
          label: "OpenScout · herd",
          number: 1,
          pane_count: 4,
          tab_count: 2,
          workspace_id: "w2",
        },
      ],
    },
  });
  const tabList = JSON.stringify({
    id: "cli:tab:list",
    result: {
      type: "tab_list",
      tabs: [
        { agent_status: "working", focused: true, label: "herd", number: 1, pane_count: 3, tab_id: "w2:t1", workspace_id: "w2" },
        { agent_status: "unknown", focused: false, label: "ops", number: 2, pane_count: 1, tab_id: "w2:t2", workspace_id: "w2" },
      ],
    },
  });
  const paneList = JSON.stringify({
    id: "cli:pane:list",
    result: {
      type: "pane_list",
      panes: [
        {
          agent: "claude",
          agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "0a7c0c5c-c3f0-4c50-b141-9d6993c8da75" },
          agent_status: "idle",
          cwd: "/Users/example/dev/openscout",
          focused: false,
          foreground_cwd: "/Users/example/dev/openscout",
          label: "Claude · primary",
          pane_id: "w2:p2",
          scroll: { max_offset_from_bottom: 42, offset_from_bottom: 0, viewport_rows: 69 },
          tab_id: "w2:t1",
          terminal_id: "term_659403fc6aa9f1",
          workspace_id: "w2",
        },
        {
          agent: "kimi",
          agent_status: "working",
          cwd: "/Users/example/dev/openscout",
          focused: true,
          foreground_cwd: "/Users/example/.kimi-code/plugins/managed/action-browser",
          label: "Kimi · K2",
          pane_id: "w2:p5",
          tab_id: "w2:t1",
          terminal_id: "term_659403fc6c5e33",
          workspace_id: "w2",
        },
        {
          agent_status: "unknown",
          cwd: "/Users/example/dev/openscout",
          focused: false,
          foreground_cwd: "/Users/example/dev/openscout",
          label: "scout shell",
          pane_id: "w2:p6",
          tab_id: "w2:t2",
          terminal_id: "term_659403fc6d1694",
          workspace_id: "w2",
        },
      ],
    },
  });

  test("builds the workspace/tab/pane tree from the three list payloads", () => {
    const workspaces = parseHerdrTopology({ workspaceList, tabList, paneList });
    expect(workspaces).toHaveLength(1);
    const [workspace] = workspaces;
    expect(workspace).toMatchObject({
      workspaceId: "w2",
      label: "OpenScout · herd",
      focused: true,
      activeTabId: "w2:t1",
      agentStatus: "working",
    });
    expect(workspace.tabs.map((tab) => tab.label)).toEqual(["herd", "ops"]);

    const [herd, ops] = workspace.tabs;
    expect(herd.panes.map((pane) => [pane.label, pane.agent, pane.agentStatus])).toEqual([
      ["Claude · primary", "claude", "idle"],
      ["Kimi · K2", "kimi", "working"],
    ]);
    expect(herd.panes[1]).toMatchObject({ focused: true, foregroundCwd: "/Users/example/.kimi-code/plugins/managed/action-browser" });
    // Scroll state projects when herdr reports it, and reads as null when the
    // host (or an older herdr) does not.
    expect(herd.panes[0]?.scroll).toEqual({ maxOffsetFromBottom: 42, offsetFromBottom: 0, viewportRows: 69 });
    expect(herd.panes[1]?.scroll).toBeNull();
    expect(ops.panes).toHaveLength(1);
    expect(ops.panes[0]).toMatchObject({ label: "scout shell", agent: null, agentStatus: "unknown" });
  });

  test("carries the agent session reference opaquely", () => {
    const [workspace] = parseHerdrTopology({ workspaceList, tabList, paneList });
    expect(workspace.tabs[0]?.panes[0]?.agentSession).toEqual({
      agent: "claude",
      kind: "id",
      source: "herdr:claude",
      value: "0a7c0c5c-c3f0-4c50-b141-9d6993c8da75",
    });
  });

  // Mirrors `herdr --session <n> api snapshot` output verbatim.
  const snapshot = JSON.stringify({
    id: "cli:api:snapshot",
    result: {
      snapshot: {
        focused_pane_id: "w2:p5",
        focused_tab_id: "w2:t1",
        focused_workspace_id: "w2",
        layouts: [
          {
            area: { height: 138, width: 251, x: 22, y: 1 },
            focused_pane_id: "w2:p5",
            panes: [
              { focused: false, pane_id: "w2:p2", rect: { height: 69, width: 126, x: 22, y: 1 } },
              { focused: false, pane_id: "w2:p4", rect: { height: 69, width: 126, x: 22, y: 70 } },
              { focused: true, pane_id: "w2:p5", rect: { height: 138, width: 125, x: 148, y: 1 } },
            ],
            splits: [
              { direction: "right", id: "split_0_root", ratio: 0.5, rect: { height: 138, width: 251, x: 22, y: 1 } },
              { direction: "down", id: "split_1_0", ratio: 0.5, rect: { height: 138, width: 126, x: 22, y: 1 } },
            ],
            tab_id: "w2:t1",
            workspace_id: "w2",
            zoomed: false,
          },
        ],
      },
    },
  });

  test("attaches per-tab layout geometry from the api snapshot", () => {
    const [workspace] = parseHerdrTopology({ workspaceList, tabList, paneList, snapshot });
    const [herd, ops] = workspace.tabs;
    expect(herd.layout).toEqual({
      tabId: "w2:t1",
      workspaceId: "w2",
      area: { x: 22, y: 1, width: 251, height: 138 },
      focusedPaneId: "w2:p5",
      zoomed: false,
      panes: [
        { paneId: "w2:p2", focused: false, rect: { x: 22, y: 1, width: 126, height: 69 } },
        { paneId: "w2:p4", focused: false, rect: { x: 22, y: 70, width: 126, height: 69 } },
        { paneId: "w2:p5", focused: true, rect: { x: 148, y: 1, width: 125, height: 138 } },
      ],
      splits: [
        { id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 22, y: 1, width: 251, height: 138 } },
        { id: "split_1_0", direction: "down", ratio: 0.5, rect: { x: 22, y: 1, width: 126, height: 138 } },
      ],
    });
    // A tab the snapshot does not cover projects without geometry, not dropped.
    expect(ops.layout).toBeNull();
  });

  test("tolerates missing or unparseable snapshots", () => {
    expect(parseHerdrSnapshotLayouts("").size).toBe(0);
    expect(parseHerdrSnapshotLayouts("not json").size).toBe(0);
    expect(parseHerdrSnapshotLayouts(JSON.stringify({ result: { snapshot: {} } })).size).toBe(0);
    const [workspace] = parseHerdrTopology({ workspaceList, tabList, paneList, snapshot: "junk" });
    expect(workspace.tabs.every((tab) => tab.layout === null)).toBe(true);
  });

  test("drops entries without ids and reads unknown statuses as unknown", () => {
    const workspaces = parseHerdrTopology({
      workspaceList,
      tabList: JSON.stringify({ result: { tabs: [{ label: "no ids" }] } }),
      paneList: JSON.stringify({ result: { panes: [{ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2", agent_status: "spinning" }] } }),
    });
    // The id-less tab is dropped; the pane's tab no longer exists, so it lands nowhere.
    expect(workspaces[0]?.tabs).toEqual([]);
  });

  test("is empty for stopped sessions and unparseable output", () => {
    expect(parseHerdrTopology({})).toEqual([]);
    expect(parseHerdrTopology({ workspaceList: "Error: Connection refused", tabList: "", paneList: "not json" })).toEqual([]);
  });
});

describe("readHerdrSessions environment", () => {
  // Regression: the probe used to force XDG_CONFIG_HOME=HOME when the probed
  // environment had none. herdr resolves its config as $XDG_CONFIG_HOME/herdr
  // and only falls back to ~/.config when XDG is unset, so discovery listed a
  // phantom default under ~/herdr and hid every session the user actually had.
  function stubHerdr(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "herdr-probe-"));
    const bin = join(dir, "herdr-stub");
    writeFileSync(
      bin,
      "#!/bin/sh\nprintf '{\"sessions\":[{\"name\":\"xdg-%s\",\"running\":true}]}' \"${XDG_CONFIG_HOME:-unset}\"\n",
    );
    chmodSync(bin, 0o755);
    return {
      env: { PATH: "/usr/bin:/bin", HOME: dir, OPENSCOUT_HERDR_BIN: bin } as NodeJS.ProcessEnv,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("leaves XDG_CONFIG_HOME unset when the probed environment has none", async () => {
    const { env, cleanup } = stubHerdr();
    try {
      const sessions = await readHerdrSessions({ env });
      expect(sessions.map((session) => session.name)).toEqual(["xdg-unset"]);
    } finally {
      cleanup();
    }
  });

  test("forwards XDG_CONFIG_HOME only when the probed environment sets it", async () => {
    const { env, cleanup } = stubHerdr();
    try {
      const sessions = await readHerdrSessions({
        env: { ...env, XDG_CONFIG_HOME: "/tmp/xdg-elsewhere" },
      });
      expect(sessions.map((session) => session.name)).toEqual(["xdg-/tmp/xdg-elsewhere"]);
    } finally {
      cleanup();
    }
  });
});
