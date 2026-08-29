import { describe, expect, test } from "bun:test";

import { parseTerminalSurfaceId } from "@openscout/protocol";

import {
  DEFAULT_TERMINAL_HOST_ID,
  describeTerminalHosts,
  hostPerformedControlActions,
  resetTerminalHostAvailabilityCache,
  isKnownTerminalHost,
  probeTerminalHostAvailability,
  relayCarriedTerminalBackend,
  resolveTerminalHostAdapter,
  terminalHostAdapter,
  terminalHostAdapters,
  terminalHostSupportsControl,
  TERMINAL_HOST_ADAPTERS,
} from "./registry.ts";
import { tmuxTerminalHost } from "./tmux.ts";
import type {
  TerminalHostAdapter,
  TerminalHostAvailability,
  TerminalHostControlAction,
} from "./types.ts";

const ALL_ACTIONS: TerminalHostControlAction[] = [
  "interrupt",
  "quit",
  "stop-job",
  "restart-resume",
  "detach",
  "release",
  "force-quit",
  "force-quit-bridge",
];

describe("terminal host registry", () => {
  test("resolves registered hosts and falls back to the declared default", () => {
    expect(terminalHostAdapter("zellij")?.id).toBe("zellij");
    expect(terminalHostAdapter("herdr")?.id).toBe("herdr");
    expect(terminalHostAdapter("nope")).toBeNull();
    expect(terminalHostAdapter(undefined)).toBeNull();
    // Unknown hosts land on a NAMED default, not on whatever the last if/else
    // happened to fall through to.
    expect(resolveTerminalHostAdapter("nope").id).toBe(DEFAULT_TERMINAL_HOST_ID);
    expect(resolveTerminalHostAdapter(null).id).toBe(DEFAULT_TERMINAL_HOST_ID);
  });

  test("every adapter is keyed by its own id", () => {
    for (const [key, adapter] of Object.entries(TERMINAL_HOST_ADAPTERS)) {
      expect(adapter.id).toBe(key);
      expect(isKnownTerminalHost(key)).toBe(true);
    }
  });

  test("an adapter implements exactly the methods its capabilities claim", () => {
    for (const adapter of terminalHostAdapters()) {
      const { capabilities } = adapter;
      expect(typeof adapter.probe).toBe("function");
      expect(typeof adapter.list).toBe("function");
      expect(typeof adapter.surface).toBe("function");
      expect(Boolean(adapter.create)).toBe(capabilities.create);
      expect(Boolean(adapter.capture)).toBe(capabilities.capture);
      expect(Boolean(adapter.observedAgents)).toBe(capabilities.observedAgentState);
      // Only verbs that reach a HOST need a method. `force-quit-bridge` tears
      // down Scout's relay bridge and no adapter implements it, so counting it
      // here would demand a method that does nothing.
      expect(Boolean(adapter.control)).toBe(hostPerformedControlActions(capabilities).length > 0);
      // A verb cannot be claimed twice; "via" must be unambiguous.
      for (const action of capabilities.harnessControl) {
        expect(capabilities.control).not.toContain(action);
      }
    }
  });

  test("the capability matrix is the one the hosts actually implement", () => {
    const matrix = Object.fromEntries(terminalHostAdapters().map((adapter) => [adapter.id, {
      relayAttach: adapter.capabilities.relayAttach,
      capture: adapter.capabilities.capture,
      create: adapter.capabilities.create,
      observedAgentState: adapter.capabilities.observedAgentState,
      control: adapter.capabilities.control,
      harnessControl: adapter.capabilities.harnessControl,
    }]));

    expect(matrix).toEqual({
      tmux: {
        relayAttach: true,
        capture: true,
        create: true,
        observedAgentState: false,
        control: ["interrupt", "quit", "detach", "release", "force-quit-bridge"],
        harnessControl: ["stop-job", "restart-resume", "force-quit"],
      },
      zellij: {
        relayAttach: true,
        capture: true,
        create: true,
        observedAgentState: false,
        control: ["interrupt", "quit", "detach", "force-quit-bridge"],
        harnessControl: [],
      },
      herdr: {
        // The relay overlay spawns the full herdr client in its PTY.
        relayAttach: true,
        capture: true,
        // Scout starts a named session headlessly (`herdr --session X server`)
        // and stops there; herdr still owns workspaces, tabs, and panes.
        create: true,
        // The one host that reports agent state instead of Scout inferring it.
        observedAgentState: true,
        // No detach: `herdr session` is list/attach/stop/delete, and there is
        // no other verb that detaches. It was declared and implemented as
        // `herdr agent focus`, which focuses an agent pane.
        control: ["force-quit-bridge"],
        harnessControl: [],
      },
    });
  });

  test("herdr does not offer a detach it cannot perform", () => {
    const herdr = terminalHostAdapter("herdr")!;
    expect(herdr.capabilities.control).not.toContain("detach");
    // Nothing left for a host-side control method to do, so there is no method
    // to accidentally point at the wrong verb again.
    expect(herdr.control).toBeUndefined();
    // Which is what makes the UI stop drawing "Leave this session running" and
    // the route answer 501 instead of running something else entirely.
    expect(terminalHostSupportsControl("herdr", "detach")).toEqual({ supported: false, via: null });
  });

  test("support answers which route a verb takes, or that there is none", () => {
    expect(terminalHostSupportsControl("tmux", "interrupt")).toEqual({ supported: true, via: "host" });
    expect(terminalHostSupportsControl("tmux", "restart-resume")).toEqual({ supported: true, via: "harness" });
    expect(terminalHostSupportsControl("tmux", "release")).toEqual({ supported: true, via: "host" });
    expect(terminalHostSupportsControl("zellij", "interrupt")).toEqual({ supported: true, via: "host" });
    expect(terminalHostSupportsControl("zellij", "restart-resume")).toEqual({ supported: false, via: null });
    expect(terminalHostSupportsControl("herdr", "force-quit-bridge")).toEqual({ supported: true, via: "host" });
    expect(terminalHostSupportsControl("herdr", "force-quit")).toEqual({ supported: false, via: null });
    expect(terminalHostSupportsControl("nope", "detach")).toEqual({ supported: false, via: null });
  });

  test("the relay bridge is decided by capability, not by a backend list", () => {
    expect(relayCarriedTerminalBackend("tmux")).toBe("tmux");
    expect(relayCarriedTerminalBackend("zellij")).toBe("zellij");
    expect(relayCarriedTerminalBackend("herdr")).toBe("herdr");
    expect(relayCarriedTerminalBackend("nope")).toBeNull();
  });

  test("every host answers every verb without throwing", () => {
    for (const adapter of terminalHostAdapters()) {
      for (const action of ALL_ACTIONS) {
        expect(typeof terminalHostSupportsControl(adapter.id, action).supported).toBe("boolean");
      }
    }
  });
});

describe("adapter surfaces", () => {
  test("carry an opaque surface id that resolves to their own host", () => {
    for (const adapter of terminalHostAdapters()) {
      const surface = adapter.surface({ name: "scout-example", state: "live" });
      expect(parseTerminalSurfaceId(surface.surfaceId)).toEqual({
        backend: adapter.id,
        hostSession: "scout-example",
        paneId: null,
        nodeId: null,
      });
      expect(surface.attachCommand.length).toBeGreaterThan(0);
      // Server-local socket paths must never ride out on a discovered record.
      expect(JSON.stringify(surface)).not.toContain(".sock");
    }
  });

  test("a host with no read-only view does not advertise an observe command", () => {
    const herdr = terminalHostAdapter("herdr")!;
    expect(herdr.capabilities.observe).toBe(false);
    expect(herdr.surface({ name: "scout-local-1", state: "detached" }).observeCommand).toBeNull();
    expect(terminalHostAdapter("tmux")!.surface({ name: "a", state: "live" }).observeCommand).not.toBeNull();
  });

  test("herdr attaches to the default session without naming it", () => {
    const herdr = terminalHostAdapter("herdr")!;
    expect(herdr.surface({ name: "default", state: "live" }).attachCommand).toEqual(["herdr"]);
    expect(herdr.surface({ name: "scout-local-1", state: "detached" }).attachCommand)
      .toEqual(["herdr", "session", "attach", "scout-local-1"]);
  });
});

describe("host availability", () => {
  /** An adapter whose probe answers whatever the test says next. */
  function fakeAdapter(answers: TerminalHostAvailability[]): TerminalHostAdapter {
    let index = 0;
    return {
      ...tmuxTerminalHost,
      id: "fake-host",
      probe: async () => answers[Math.min(index++, answers.length - 1)]!,
    };
  }

  test("a fresh cached success answers without spawning another probe", async () => {
    resetTerminalHostAvailabilityCache();
    let probes = 0;
    const adapter: TerminalHostAdapter = {
      ...tmuxTerminalHost,
      id: "fake-host",
      probe: async () => {
        probes += 1;
        return { installed: true, version: "tmux 3.5" };
      },
    };

    const first = await probeTerminalHostAvailability(adapter, {}, 1_000);
    expect(first).toMatchObject({ installed: true, version: "tmux 3.5", stale: false, checkedAt: 1_000 });
    expect(probes).toBe(1);

    // Within the TTL the cached success IS the answer — no `--version`
    // shell-out per request for a binary that was just seen.
    const second = await probeTerminalHostAvailability(adapter, {}, 6_000);
    expect(second).toMatchObject({ installed: true, version: "tmux 3.5", stale: false, checkedAt: 1_000 });
    expect(probes).toBe(1);

    // Past the TTL the probe runs again for real.
    const third = await probeTerminalHostAvailability(adapter, {}, 1_000 + 30_001);
    expect(third).toMatchObject({ installed: true, stale: false, checkedAt: 1_000 + 30_001 });
    expect(probes).toBe(2);
  });

  test("a probe that fails while a fresh success exists serves the memory, marked", async () => {
    resetTerminalHostAvailabilityCache();
    // Two overlapping probes: the first succeeds while the second is still in
    // flight, then the second fails. The failing probe must fall back to the
    // fresh success — because a busy machine is not a machine without tmux —
    // but MARKED as the memory it is, so a caller about to shell out can
    // re-probe instead of trusting it.
    let releaseFailure!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    let probes = 0;
    const adapter: TerminalHostAdapter = {
      ...tmuxTerminalHost,
      id: "fake-host",
      probe: async () => {
        probes += 1;
        if (probes === 1) return { installed: true, version: "tmux 3.5" };
        await gate;
        return { installed: false, reason: "timed out" };
      },
    };

    const first = probeTerminalHostAvailability(adapter, {}, 1_000);
    const second = probeTerminalHostAvailability(adapter, {}, 6_000);
    expect(await first).toMatchObject({ installed: true, stale: false, checkedAt: 1_000 });
    releaseFailure();

    const substituted = await second;
    expect(substituted.installed).toBe(true);
    expect(substituted.stale).toBe(true);
    expect(substituted.checkedAt).toBe(1_000);
    expect(substituted.reason).toContain("timed out");
  });

  test("the substitution expires rather than standing forever", async () => {
    resetTerminalHostAvailabilityCache();
    const adapter = fakeAdapter([
      { installed: true, version: "tmux 3.5" },
      { installed: false, reason: "not found" },
    ]);
    await probeTerminalHostAvailability(adapter, {}, 1_000);
    const later = await probeTerminalHostAvailability(adapter, {}, 1_000 + 30_001);
    expect(later.installed).toBe(false);
    expect(later.stale).toBe(false);
  });

  test("one environment's success never answers for another", async () => {
    resetTerminalHostAvailabilityCache();
    // A real probe first, so the cache holds a successful answer for THIS
    // environment. Keyed by host alone, that answer used to be served to a
    // probe of an environment with no terminal hosts on its PATH at all —
    // reporting tmux, zellij, and herdr installed, with versions collected
    // somewhere else entirely.
    const first = await describeTerminalHosts();
    expect(first.some((host) => host.availability.installed)).toBe(true);

    const elsewhere = await describeTerminalHosts({
      env: { ...process.env, PATH: "/nonexistent-scout-probe" },
    });
    expect(elsewhere.every((host) => host.availability.installed)).toBe(false);
    resetTerminalHostAvailabilityCache();
  });

  test("a host that was never reachable is reported as missing", async () => {
    resetTerminalHostAvailabilityCache();
    const hosts = await describeTerminalHosts({ env: { ...process.env, PATH: "/nonexistent-scout-probe" } });
    expect(hosts.every((host) => host.availability.installed)).toBe(false);
    for (const host of hosts) {
      expect(host.availability.reason).toBeTruthy();
    }
    resetTerminalHostAvailabilityCache();
  });
});

describe("host probes", () => {
  test("report a missing binary as not installed rather than throwing", async () => {
    const adapter = terminalHostAdapter("tmux")!;
    const availability = await adapter.probe({
      // An empty PATH makes every host unreachable, which is the state an
      // adapter for a host nobody installed has to survive.
      env: { ...process.env, PATH: "/nonexistent-scout-probe" },
    });
    expect(availability.installed).toBe(false);
    expect(availability.reason).toBeTruthy();
  });

  test("a host with no sessions lists nothing instead of failing", async () => {
    for (const adapter of terminalHostAdapters()) {
      const sessions = await adapter.list({ env: { ...process.env, PATH: "/nonexistent-scout-probe" } });
      expect(Array.isArray(sessions)).toBe(true);
    }
  });
});
