import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findRecordedLiveMeshBridgePid,
  inspectLaunchdJob,
  isMeshBridgeCommand,
  runLaunchctlProbe,
  legacyMeshBridgeLaunchAgentPath,
  meshBridgeArgs,
  meshBridgeConfigPath,
  meshBridgeStatePath,
  readProcessIdentity,
  resolveMeshBridgeDesiredState,
  resolveMeshBridgeEntrypoint,
  waitForLaunchdJobAbsent,
} from "./mesh-bridge-supervisor.ts";

let root: string;
let supportDirectory: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mesh-bridge-supervisor-"));
  supportDirectory = join(root, "support");
  home = join(root, "home");
  mkdirSync(supportDirectory, { recursive: true });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  writeFileSync(meshBridgeConfigPath(supportDirectory), typeof value === "string" ? value : JSON.stringify(value));
}

describe("resolveMeshBridgeDesiredState", () => {
  test("stays idle without a config", () => {
    expect(resolveMeshBridgeDesiredState({ supportDirectory, env: {}, home })).toEqual({ run: false, reason: "no-config" });
  });

  test("runs when configured", () => {
    writeConfig({ relayUrl: "https://mcp.oscout.net" });
    const desired = resolveMeshBridgeDesiredState({ supportDirectory, env: {}, home });
    expect(desired.run).toBe(true);
    if (desired.run) expect(desired.configPath).toBe(meshBridgeConfigPath(supportDirectory));
  });

  test("honours the env kill switch and enabled:false", () => {
    writeConfig({ relayUrl: "https://mcp.oscout.net" });
    expect(resolveMeshBridgeDesiredState({ supportDirectory, env: { OPENSCOUT_BASE_MESH_BRIDGE_ENABLED: "0" }, home }))
      .toEqual({ run: false, reason: "disabled-by-env" });
    writeConfig({ relayUrl: "https://mcp.oscout.net", enabled: false });
    expect(resolveMeshBridgeDesiredState({ supportDirectory, env: {}, home }))
      .toEqual({ run: false, reason: "disabled-in-config" });
  });

  test("does not run on an unreadable config", () => {
    writeConfig("{not json");
    expect(resolveMeshBridgeDesiredState({ supportDirectory, env: {}, home }))
      .toEqual({ run: false, reason: "invalid-config" });
  });

  test("defers to a still-installed legacy LaunchAgent so two bridges never hold the relay", () => {
    writeConfig({ relayUrl: "https://mcp.oscout.net" });
    writeFileSync(legacyMeshBridgeLaunchAgentPath(home), "<plist/>");
    expect(resolveMeshBridgeDesiredState({ supportDirectory, env: {}, home }))
      .toEqual({ run: false, reason: "legacy-launch-agent" });
  });
});

describe("resolveMeshBridgeEntrypoint", () => {
  const repoRoot = "/repo";
  const source = "/repo/apps/desktop/bin/scout.ts";
  const dist = "/repo/packages/cli/dist/main.mjs";
  const all = (path: string) => [source, dist].includes(path);

  test("dev mode runs the CLI from source, like the broker", () => {
    expect(resolveMeshBridgeEntrypoint({ repoRoot, moduleDirectory: "/repo/packages/runtime/src", serviceMode: "dev", env: {}, home, exists: all }))
      .toBe(source);
  });

  test("other modes prefer the built CLI", () => {
    expect(resolveMeshBridgeEntrypoint({ repoRoot, moduleDirectory: "/repo/packages/runtime/src", serviceMode: "prod", env: {}, home, exists: all }))
      .toBe(dist);
  });

  test("an explicit override wins, and nothing resolvable is null", () => {
    expect(resolveMeshBridgeEntrypoint({
      repoRoot,
      moduleDirectory: "/x",
      serviceMode: "dev",
      env: { OPENSCOUT_MESH_BRIDGE_BIN: "/opt/scout/main.mjs" },
      home,
      exists: (path) => path === "/opt/scout/main.mjs" || all(path),
    })).toBe("/opt/scout/main.mjs");
    expect(resolveMeshBridgeEntrypoint({ repoRoot: null, moduleDirectory: "/x", serviceMode: "dev", env: {}, home, exists: () => false }))
      .toBeNull();
  });

  test("builds the bridge argv", () => {
    expect(meshBridgeArgs(source, "/s/mcp-bridge.json")).toEqual([source, "mesh", "bridge", "--config", "/s/mcp-bridge.json"]);
  });
});

describe("isMeshBridgeCommand", () => {
  test("matches a runtime launching a Scout entrypoint, including spaced paths", () => {
    expect(isMeshBridgeCommand("/Users/o/.bun/bin/bun /repo/apps/desktop/bin/scout.ts mesh bridge --config /s/x.json")).toBe(true);
    expect(isMeshBridgeCommand("bun /Users/o/Library/Application Support/OpenScout/deployments/abc/dist/main.mjs mesh bridge")).toBe(true);
    expect(isMeshBridgeCommand("/Users/o/.bun/bin/scout mesh bridge")).toBe(true);
  });

  test("never matches a prompt or shell line that quotes a bridge command", () => {
    expect(isMeshBridgeCommand("claude --print review mesh bridge shutdown")).toBe(false);
    expect(isMeshBridgeCommand("sh -c echo mesh bridge")).toBe(false);
    expect(isMeshBridgeCommand('claude --prompt "Review /repo/apps/desktop/bin/scout.ts mesh bridge shutdown"')).toBe(false);
    expect(isMeshBridgeCommand("sh -c bun /repo/apps/desktop/bin/scout.ts mesh bridge")).toBe(false);
    expect(isMeshBridgeCommand('bun innocent.ts --prompt "Review /repo/apps/desktop/bin/scout.ts mesh bridge shutdown"')).toBe(false);
    expect(isMeshBridgeCommand("node innocent.mjs Review /repo/apps/desktop/bin/scout.ts mesh bridge")).toBe(false);
    expect(isMeshBridgeCommand("bun -e console.log(1); // /repo/apps/desktop/bin/scout.ts mesh bridge")).toBe(false);
    expect(isMeshBridgeCommand("node --eval=x /repo/apps/desktop/bin/scout.ts mesh bridge")).toBe(false);
    expect(isMeshBridgeCommand("node -p 1 /repo/apps/desktop/bin/scout.ts mesh bridge")).toBe(false);
    expect(isMeshBridgeCommand("bun --smol /repo/apps/desktop/bin/scout.ts mesh bridge")).toBe(true);
  });
});

describe("findRecordedLiveMeshBridgePid", () => {
  const bridgeArgs = "bun /repo/apps/desktop/bin/scout.ts mesh bridge";
  const startedAt = "Fri 25 Sep 23:14:23 2026";

  function record(value: Record<string, unknown>): void {
    mkdirSync(join(supportDirectory, "runtime"), { recursive: true });
    writeFileSync(meshBridgeStatePath(supportDirectory), JSON.stringify({ state: "running", ...value }));
  }

  test("returns the recorded bridge while that exact process lives", () => {
    record({ pid: 4242, processStartedAt: startedAt });
    expect(findRecordedLiveMeshBridgePid(supportDirectory, () => ({ args: bridgeArgs, startedAt }))).toBe(4242);
  });

  test("refuses a reused pid even when its args look like a bridge", () => {
    record({ pid: 4242, processStartedAt: startedAt });
    expect(findRecordedLiveMeshBridgePid(supportDirectory, () => ({ args: bridgeArgs, startedAt: "Sat 26 Sep 01:00:00 2026" }))).toBeNull();
    expect(findRecordedLiveMeshBridgePid(supportDirectory, () => ({
      args: 'claude --prompt "Review /repo/apps/desktop/bin/scout.ts mesh bridge shutdown"',
      startedAt,
    }))).toBeNull();
  });

  test("refuses without a recorded start time, a live process, or a record", () => {
    record({ pid: 4242 });
    expect(findRecordedLiveMeshBridgePid(supportDirectory, () => ({ args: bridgeArgs, startedAt }))).toBeNull();
    record({ pid: 4242, processStartedAt: startedAt });
    expect(findRecordedLiveMeshBridgePid(supportDirectory, () => null)).toBeNull();
    rmSync(join(supportDirectory, "runtime"), { recursive: true, force: true });
    expect(findRecordedLiveMeshBridgePid(supportDirectory, () => ({ args: bridgeArgs, startedAt }))).toBeNull();
  });

  test("reads the live identity of this test process", () => {
    const identity = readProcessIdentity(process.pid);
    // Field order is locale-dependent ("Fri 25 Sep" or "Fri Sep 25"); only the
    // five-field shape and time are stable.
    expect(identity?.startedAt.split(/\s+/)).toHaveLength(5);
    expect(identity?.startedAt).toMatch(/\d\d:\d\d:\d\d \d{4}$/);
  });
});

describe("inspectLaunchdJob", () => {
  test("only launchd's explicit not-found counts as absent", () => {
    expect(inspectLaunchdJob("gui/501/x", () => ({ status: 0, output: "state = running" }))).toBe("loaded");
    expect(inspectLaunchdJob("gui/501/x", () => ({ status: 113, output: "Could not find service" }))).toBe("absent");
    expect(inspectLaunchdJob("gui/501/x", () => ({ status: 1, output: "Operation not permitted" }))).toBe("unknown");
    expect(inspectLaunchdJob("gui/501/x", () => ({ status: null, output: "" }))).toBe("unknown");
  });

  test("does not spawn launchctl when process.platform is linux", () => {
    const previous = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, enumerable: true, value: "linux" });
    try {
      let spawned = false;
      const probed = runLaunchctlProbe(["print", "gui/501/app.openscout.mcp-bridge"], () => {
        spawned = true;
        throw new Error("launchctl spawned");
      });
      expect(spawned).toBe(false);
      expect(probed).toEqual({ status: 113, output: "Could not find service" });
      expect(inspectLaunchdJob("gui/501/app.openscout.mcp-bridge")).toBe("absent");
    } finally {
      if (previous) Object.defineProperty(process, "platform", previous);
    }
  });
});

describe("waitForLaunchdJobAbsent", () => {
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }

  test("waits out launchd's asynchronous teardown after bootout", async () => {
    const states: Array<"loaded" | "absent"> = ["loaded", "loaded", "absent"];
    const inspect = () => states.shift() ?? "absent";
    expect(await waitForLaunchdJobAbsent("gui/501/x", { inspect, ...clock() })).toBe("absent");
    expect(states).toHaveLength(0);
  });

  test("reports the last state when the job never goes away", async () => {
    let calls = 0;
    const inspect = () => { calls += 1; return "loaded" as const; };
    expect(await waitForLaunchdJobAbsent("gui/501/x", { inspect, timeoutMs: 1_000, pollMs: 250, ...clock() })).toBe("loaded");
    expect(calls).toBe(5);
    expect(await waitForLaunchdJobAbsent("gui/501/x", { inspect: () => "unknown", timeoutMs: 0, ...clock() })).toBe("unknown");
  });
});
