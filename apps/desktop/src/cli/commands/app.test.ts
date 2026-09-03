import { describe, expect, test } from "bun:test";

import type { LifecycleProcess, LifecycleTree } from "../app-lifecycle.ts";
import { lifecycleProblems, selectInstalledAppBundle, startTreeReady } from "./app.ts";

function process(layer: LifecycleProcess["layer"], pid: number): LifecycleProcess {
  return {
    pid,
    ppid: 1,
    command: layer,
    args: layer,
    executable: layer,
    elapsedSeconds: 1,
    layer,
    canonical: true,
    superseded: false,
  };
}

function treeWith(input: {
  owned?: LifecycleProcess[];
  foreign?: LifecycleProcess[];
} = {}): LifecycleTree {
  const layers: LifecycleTree["layers"] = {
    scoutd: [],
    base: [],
    probes: [],
    broker: [],
    edge: [],
    web: [],
    app: [],
    menu: [],
    pairing: [],
  };
  for (const entry of input.owned ?? []) layers[entry.layer].push(entry);
  return {
    layers,
    foreign: input.foreign ?? [],
    expected: {
      appBundlePath: "/repo/Scout.app",
      menuBundlePath: "/repo/ScoutMenu.app",
      appExecutable: "/repo/Scout.app/Scout",
      menuExecutable: "/repo/ScoutMenu.app/ScoutMenu",
      serviceRoot: "/repo",
    },
  };
}

describe("lifecycleProblems", () => {
  test("does not fail stop because a sibling checkout is still running", () => {
    const foreign = { ...process("app", 900), canonical: false };
    expect(lifecycleProblems("stop", "all", treeWith({ foreign: [foreign] }))).toEqual([]);
  });

  test("fails stop when one of our targeted processes survives", () => {
    expect(lifecycleProblems("stop", "all", treeWith({ owned: [process("broker", 300)] })))
      .toEqual(["broker pid 300 is still running after stop"]);
  });

  test("fails stop when an owned service survives after its scoutd root exits", () => {
    const detached = {
      ...process("broker", 301),
      args: "scout-broker run /repo/packages/runtime/bin/openscout-runtime.mjs broker",
      canonical: false,
    };
    expect(lifecycleProblems("stop", "all", treeWith({ foreign: [detached] })))
      .toEqual(["broker pid 301 is still running after stop"]);
  });

  test("apps-only stop ignores intentionally running services", () => {
    expect(lifecycleProblems("stop", "apps", treeWith({ owned: [process("broker", 300)] })))
      .toEqual([]);
  });

  test("status fails for a detached process from this checkout", () => {
    const detached = {
      ...process("broker", 301),
      args: "scout-broker run /repo/packages/runtime/bin/openscout-runtime.mjs broker",
      canonical: false,
    };
    expect(lifecycleProblems("status", "all", treeWith({ foreign: [detached] })))
      .toEqual([
        "broker pid 301 references this checkout but is detached from its expected process tree: broker",
      ]);
  });
});

describe("startTreeReady", () => {
  const supervisedProcesses = [
    process("scoutd", 100),
    process("base", 101),
    process("probes", 102),
    process("broker", 103),
    process("edge", 104),
    process("pairing", 105),
  ];
  const appProcesses = [process("app", 200), process("menu", 201)];

  test("keeps a full start waiting when the web child is still missing", () => {
    expect(startTreeReady(treeWith({
      owned: [...supervisedProcesses, ...appProcesses],
    }), "all")).toBe(false);
  });

  test("accepts a full start only after the complete supervised tree is present", () => {
    expect(startTreeReady(treeWith({
      owned: [...supervisedProcesses, process("web", 106), ...appProcesses],
    }), "all")).toBe(true);
  });

  test("keeps apps-only starts scoped to Scout and its menu helper", () => {
    expect(startTreeReady(treeWith({ owned: appProcesses }), "apps")).toBe(true);
  });
});

describe("selectInstalledAppBundle", () => {
  test("prefers the conventional installed app over Spotlight worktree matches", () => {
    const installed = "/Applications/OpenScout.app";
    const existing = new Set([
      installed,
      "/Users/art/dev/openscout/apps/macos/dist/Scout.app",
    ]);

    expect(selectInstalledAppBundle(
      [...existing].reverse(),
      "/Users/art",
      (path) => existing.has(path),
    )).toBe(installed);
  });

  test("never treats a repo-built Scout.app as an installed fallback", () => {
    const worktreeBuild = "/Users/art/dev/openscout/apps/macos/dist/Scout.app";

    expect(selectInstalledAppBundle(
      [worktreeBuild],
      "/Users/art",
      (path) => path === worktreeBuild,
    )).toBeNull();
  });

  test("accepts a relocated OpenScout.app when no conventional install exists", () => {
    const relocated = "/Volumes/Apps/OpenScout.app";

    expect(selectInstalledAppBundle(
      [relocated],
      "/Users/art",
      (path) => path === relocated,
    )).toBe(relocated);
  });
});
