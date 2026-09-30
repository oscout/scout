import { describe, expect, test } from "bun:test";
import {
  stubs,
  createOpenScoutWebServer,
  makeStaticRoot,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: terminals routes", () => {
  test("serves registered terminal sessions", async () => {
    stubs.queryTerminalSessionsResult = [{
      id: "ts.abc",
      harness: "claude",
      sourceSessionId: "claude-session-123",
      cwd: "/tmp/openscout",
      resumeCommand: "claude --resume claude-session-123",
      surfaces: [{
        backend: "zellij",
        sessionName: "scout-zj-demo",
        paneId: "terminal_0",
        attachCommand: ["env", "ZELLIJ_SOCKET_DIR=/tmp/z", "zellij", "attach", "scout-zj-demo"],
        observeCommand: ["env", "ZELLIJ_SOCKET_DIR=/tmp/z", "zellij", "watch", "scout-zj-demo"],
        relay: { backend: "zellij", sessionName: "scout-zj-demo", zellijSession: "scout-zj-demo" },
        state: "live",
        socketDir: "/tmp/z",
      }],
      createdAt: 1,
      updatedAt: 2,
    }];
    stubs.queryDiscoveredTerminalSessionsResult = [{
      id: "discovered.tmux.demo",
      harness: "tmux",
      sourceSessionId: "raw-tmux-demo",
      cwd: "",
      resumeCommand: "tmux attach -t raw-tmux-demo",
      surfaces: [{
        backend: "tmux",
        sessionName: "raw-tmux-demo",
        paneId: null,
        attachCommand: ["tmux", "attach", "-t", "raw-tmux-demo"],
        observeCommand: null,
        relay: { backend: "tmux", sessionName: "raw-tmux-demo", tmuxSession: "raw-tmux-demo" },
        state: "live",
      }],
      createdAt: 3,
      updatedAt: 3,
      metadata: { source: "backend-discovery", registryState: "discovered" },
    }];
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/terminal-sessions?backend=zellij");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      count: 1,
      sessions: stubs.queryTerminalSessionsResult,
    });

    const inventoryResponse = await server.app.request(
      "http://localhost/api/terminal-sessions?includeDiscovered=1",
    );

    expect(inventoryResponse.status).toBe(200);
    await expect(inventoryResponse.json()).resolves.toEqual({
      ok: true,
      count: 2,
      sessions: [...stubs.queryTerminalSessionsResult, ...stubs.queryDiscoveredTerminalSessionsResult],
    });
  });

  test("stores a workspace on the server and reconciles its cells against live hosts", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const created = await server.app.request("http://localhost/api/terminal-workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Release desk",
        purpose: "Watch the train",
        columns: 3,
        cells: [
          { id: "cell-1", intent: { hostId: "tmux", sessionName: "scout-tmux-cell-1", cwd: "/repo" } },
          { id: "cell-2", intent: {} },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const { workspace } = await created.json() as { workspace: { id: string; columns: number } };
    expect(workspace.columns).toBe(3);

    const listed = await server.app.request("http://localhost/api/terminal-workspaces");
    expect(listed.status).toBe(200);
    const payload = await listed.json() as {
      count: number;
      workspaces: Array<{ id: string }>;
      resolutions: Array<{ workspaceId: string; cells: Array<{ cellId: string; status: string; revive: unknown }> }>;
    };
    expect(payload.workspaces.some((entry) => entry.id === workspace.id)).toBe(true);

    const cells = payload.resolutions.find((entry) => entry.workspaceId === workspace.id)!.cells;
    // Nothing is live in a test control home, so a cell with intent is
    // revivable and a cell without one is honestly unavailable.
    expect(cells.find((cell) => cell.cellId === "cell-1")?.status).toBe("revivable");
    expect(cells.find((cell) => cell.cellId === "cell-2")).toMatchObject({
      status: "unavailable",
      revive: null,
    });

    const deleted = await server.app.request(
      `http://localhost/api/terminal-workspaces/${workspace.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true, deleted: true });
  });

  test("a registry record is not proof a session is running", async () => {
    // The registry says this zellij surface is live, because `session intake`
    // wrote `state: "live"` once and never revisited it. Only the discovered
    // tmux session is an actual observation of the host. A workspace holding
    // one of each must not report both as Running.
    stubs.queryTerminalSessionsResult = [{
      id: "ts.recorded",
      harness: "claude",
      sourceSessionId: "claude-session-123",
      cwd: "/tmp/openscout",
      resumeCommand: "claude --resume claude-session-123",
      surfaces: [{
        backend: "zellij",
        sessionName: "scout-zj-demo",
        paneId: null,
        attachCommand: ["zellij", "attach", "scout-zj-demo"],
        observeCommand: null,
        relay: { backend: "zellij", sessionName: "scout-zj-demo" },
        state: "live",
      }],
      createdAt: 1,
      updatedAt: 2,
    }];
    stubs.queryDiscoveredTerminalSessionsResult = [{
      id: "discovered.tmux.demo",
      harness: "",
      sourceSessionId: "raw-tmux-demo",
      cwd: "",
      resumeCommand: "",
      origin: "discovered",
      surfaces: [{
        backend: "tmux",
        sessionName: "raw-tmux-demo",
        paneId: null,
        attachCommand: ["tmux", "attach", "-t", "raw-tmux-demo"],
        observeCommand: null,
        relay: { backend: "tmux", sessionName: "raw-tmux-demo" },
        state: "live",
      }],
      createdAt: 3,
      updatedAt: 3,
      metadata: { source: "backend-discovery", registryState: "discovered" },
    }];

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const created = await server.app.request("http://localhost/api/terminal-workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Mixed desk",
        layout: { mode: "lanes", columns: "dynamic" },
        cells: [
          { id: "recorded", intent: { hostId: "zellij", sessionName: "scout-zj-demo" } },
          { id: "observed", intent: { hostId: "tmux", sessionName: "raw-tmux-demo" } },
        ],
      }),
    });
    const { workspace } = await created.json() as { workspace: { id: string; layout?: unknown } };
    // And the authored layout is stored rather than re-derived from a count.
    expect(workspace.layout).toEqual({ mode: "lanes", columns: "dynamic" });

    const listed = await server.app.request(`http://localhost/api/terminal-workspaces/${workspace.id}`);
    const payload = await listed.json() as {
      workspace: { layout?: unknown };
      resolution: { cells: Array<{ cellId: string; status: string; detail: string }> };
    };
    expect(payload.workspace.layout).toEqual({ mode: "lanes", columns: "dynamic" });

    const cells = payload.resolution.cells;
    expect(cells.find((cell) => cell.cellId === "observed")).toMatchObject({
      status: "live",
      detail: "Running",
    });
    expect(cells.find((cell) => cell.cellId === "recorded")?.status).not.toBe("live");
  });

  test("refuses to revive a cell that was never given anything to rebuild from", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const created = await server.app.request("http://localhost/api/terminal-workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Desk", cells: [{ id: "cell-1", intent: {} }] }),
    });
    const { workspace } = await created.json() as { workspace: { id: string } };

    const revived = await server.app.request(
      `http://localhost/api/terminal-workspaces/${workspace.id}/cells/cell-1/revive`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(revived.status).toBe(409);
    await expect(revived.json()).resolves.toMatchObject({
      status: "unavailable",
      capability: "create",
    });

    const missing = await server.app.request(
      `http://localhost/api/terminal-workspaces/${workspace.id}/cells/nope/revive`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(missing.status).toBe(404);
  });

  test("rejects a nameless workspace instead of storing a blank one", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/terminal-workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(response.status).toBe(400);
  });

  test("publishes what each terminal host can do, so clients stop offering dead actions", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/terminal-hosts");
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      catalogVersion: string;
      ok: boolean;
      hosts: Array<{
        id: string;
        capabilities: { control: string[]; harnessControl: string[]; relayAttach: boolean };
        availability: { installed: boolean };
      }>;
      preferredHostId: string | null;
    };

    expect(payload.ok).toBe(true);
    expect(payload.hosts.map((host) => host.id).sort()).toEqual(["herdr", "tmux", "zellij"]);
    const herdr = payload.hosts.find((host) => host.id === "herdr")!;
    // A herdr session outlives Scout, but that is not something Scout PERFORMS:
    // herdr has no detach verb at all, so the only control here is the
    // Scout-side bridge teardown and the UI draws no detach action.
    expect(herdr.capabilities.control).toEqual(["force-quit-bridge"]);
    expect(herdr.capabilities.harnessControl).toEqual([]);
    expect(herdr.capabilities.relayAttach).toBe(true);
    // A preferred host is only offered when one is actually installed here.
    if (payload.preferredHostId !== null) {
      const preferred = payload.hosts.find((host) => host.id === payload.preferredHostId)!;
      expect(preferred.availability.installed).toBe(true);
      expect(preferred.capabilities.relayAttach).toBe(true);
    }
  });

  test("refuses to start a session on a host Scout does not know, or without a name", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const unknown = await server.app.request("http://localhost/api/terminal-hosts/kitty/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionName: "scout-1" }),
    });
    expect(unknown.status).toBe(404);

    const nameless = await server.app.request("http://localhost/api/terminal-hosts/tmux/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionName: "   " }),
    });
    expect(nameless.status).toBe(400);
  });

  test("refuses a control verb the host cannot perform, naming the host and the verb", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/terminal-sessions/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "zellij", sessionName: "scout-zj-demo", action: "restart-resume" }),
    });

    // 501, not 400: the request is well-formed, the capability is absent.
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({
      error: "zellij does not support restart-resume",
      backend: "zellij",
      action: "restart-resume",
      capability: "control",
    });

    const unknownHost = await server.app.request("http://localhost/api/terminal-sessions/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend: "screen", sessionName: "x", action: "detach" }),
    });
    expect(unknownHost.status).toBe(400);
  });
});

describe("herdr topology routes", () => {
  // Hermetic by construction: the session name never exists, so the probe
  // projects running:false whether or not a herdr binary is installed.
  const missing = "scout-test-session-that-never-exists";

  test("projects a stopped or absent herdr session as running:false, not an error", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      `http://localhost/api/terminal-hosts/herdr/sessions/${missing}/topology`,
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      ok: boolean;
      topology: { session: string; running: boolean; workspaces: unknown[]; observedAt: number };
    };
    expect(payload.ok).toBe(true);
    expect(payload.topology.session).toBe(missing);
    expect(payload.topology.running).toBe(false);
    expect(payload.topology.workspaces).toEqual([]);
  });

  test("digests a named herdr session, ranked and honest about not being live", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      `http://localhost/api/terminal-hosts/herdr/workspaces?session=${missing}`,
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      ok: boolean;
      count: number;
      truncated: boolean;
      digests: Array<{
        session: string;
        live: boolean;
        totals: { workspaces: number; tabs: number; panes: number; agents: number };
        needsYou: unknown[];
        groups: unknown[];
        notes: string[];
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.truncated).toBe(false);
    const digest = payload.digests[0]!;
    expect(digest.session).toBe(missing);
    // An absent session is an ordinary empty state, and it is never described
    // as live — the digest carries the caveat with the numbers.
    expect(digest.live).toBe(false);
    expect(digest.totals).toEqual({ workspaces: 0, tabs: 0, panes: 0, agents: 0 });
    expect(digest.needsYou).toEqual([]);
    expect(digest.groups).toEqual([]);
    expect(digest.notes[0]).toContain("persisted last-known layout");
  });

  test("rejects a focus request without a target", async () => {
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request(
      `http://localhost/api/terminal-hosts/herdr/sessions/${missing}/focus`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
    );

    expect(response.status).toBe(400);
  });
});
