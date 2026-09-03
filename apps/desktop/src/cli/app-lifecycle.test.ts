import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appBundlePathsForRoot,
  argvZeroIs,
  chooseLaunchdStartMethod,
  classifyProcesses,
  detachedExpectedProcesses,
  isRunning,
  launchAgentPlistPath,
  isSuperseded,
  LAUNCH_SERVICES_LAYERS,
  parseElapsedSeconds,
  parseProcessTable,
  planStop,
  ownedSweepSurvivorPids,
  resolveLaunchdLabel,
  SCOUT_LAUNCHD_LABEL,
  scoutdStartArguments,
  supersessionTarget,
  SUPERVISED_LAYERS,
  verifyTree,
} from "./app-lifecycle.ts";

/**
 * Real checkouts on disk, because ownership of the supervised tree is decided by
 * finding a real `packages/cli/bin/scoutd` under the bundle's root. A fabricated
 * path would silently fall back to the no-service-root rule and the
 * cross-checkout tests would pass for the wrong reason.
 */
function makeCheckout(prefix: string): { root: string; dist: string; scoutd: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "packages", "cli", "bin"), { recursive: true });
  const scoutd = join(root, "packages", "cli", "bin", "scoutd");
  writeFileSync(scoutd, "#!/bin/sh\n");
  // Backdate the binary an hour: a healthy suite is one whose processes started
  // *after* the build they run. Without this the fixture reads as superseded —
  // which it now can, because supersession actually works for these layers.
  const hourAgo = new Date(Date.now() - 3_600_000);
  utimesSync(scoutd, hourAgo, hourAgo);
  return { root, dist: join(root, "apps", "macos", "dist"), scoutd };
}

const OURS = makeCheckout("scout-lifecycle-ours-");
const THEIRS = makeCheckout("scout-lifecycle-theirs-");
const DIST = OURS.dist;
const OTHER_DIST = THEIRS.dist;
const paths = appBundlePathsForRoot(DIST);

/** Renders seconds the way `ps -o etime=` does: `[[dd-]hh:]mm:ss`. */
function etime(totalSeconds: number): string {
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600) % 24;
  const days = Math.floor(totalSeconds / 86_400);
  const base = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  if (days > 0) return `${days}-${String(hours).padStart(2, "0")}:${base}`;
  if (hours > 0) return `${hours}:${base}`;
  return base;
}

/**
 * `pid ppid etime args` — no `comm` column, matching the real invocation. `args`
 * begins with argv[0], which for the supervised services is a rewritten process
 * title (`scout-broker`) rather than a path, exactly as `ps` reports it.
 */
function line(pid: number, ppid: number, args: string, elapsed = 60): string {
  return `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${etime(elapsed).padStart(12)} ${args}`;
}

function healthyTable(root = OURS): string {
  const runtime = `${root.root}/packages/runtime/bin/openscout-runtime.mjs`;
  return [
    line(100, 1, `${root.scoutd} supervise`),
    line(200, 100, `scout-base ${runtime} base`),
    line(201, 100, `${root.scoutd} probes serve`),
    line(300, 200, `scout-broker run ${runtime} broker`),
    // Edge names no file it owns — only a Caddyfile outside the checkout.
    line(301, 200, "scout-edge run --config /Users/dev/.scout/local-edge/Caddyfile --adapter caddyfile"),
    line(650, 200, `${root.root}/pairing-runtime-controller.ts`),
    line(400, 300, `scout-web run ${runtime} web`),
    line(500, 1, `${root.dist}/Scout.app/Contents/MacOS/Scout`),
    line(600, 500, `${root.dist}/Scout.app/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu`),
  ].join("\n");
}

describe("parseProcessTable", () => {
  test("keys identity on argv[0], not the process name", () => {
    const [record] = parseProcessTable(line(42, 1, "/somewhere/Scout.app/Contents/MacOS/Scout --hud", 900));
    expect(record).toMatchObject({
      pid: 42,
      ppid: 1,
      command: "/somewhere/Scout.app/Contents/MacOS/Scout",
      executable: "/somewhere/Scout.app/Contents/MacOS/Scout",
      elapsedSeconds: 900,
    });
  });

  test("identifies argv[0] under a path containing spaces", () => {
    const executable = "/Users/First Last/dev/openscout/apps/macos/dist/Scout.app/Contents/MacOS/Scout";
    const [record] = parseProcessTable(line(42, 1, `${executable} --hud`, 900));
    // Splitting on whitespace truncates to "/Users/First", which is how a user
    // whose home has a space silently lost the ability to stop their own app.
    expect(record!.executable).toBe("/Users/First");
    expect(argvZeroIs(record!, executable)).toBe(true);
    // A different bundle at a similar path is still not a match.
    expect(argvZeroIs(record!, "/Users/First Last/dev/other/Scout.app/Contents/MacOS/Scout")).toBe(false);
  });

  test("classifies an app under a spacey path as ours, not foreign", () => {
    const spacey = makeCheckout("scout lifecycle spaced ");
    const spaceyPaths = appBundlePathsForRoot(spacey.dist);
    const table = line(500, 1, `${spacey.dist}/Scout.app/Contents/MacOS/Scout`);
    const tree = classifyProcesses(parseProcessTable(table), spaceyPaths);
    expect(tree.layers.app.map((entry) => entry.pid)).toEqual([500]);
    expect(tree.foreign).toEqual([]);
  });

  test("skips lines that are not process rows", () => {
    expect(parseProcessTable("PID PPID ELAPSED COMM ARGS\n\n  not a row")).toEqual([]);
  });

  test("reads every etime shape Darwin emits", () => {
    expect(parseElapsedSeconds("20:46")).toBe(20 * 60 + 46);
    expect(parseElapsedSeconds("1:02:03")).toBe(3_723);
    expect(parseElapsedSeconds("06-00:43:00")).toBe(6 * 86_400 + 43 * 60);
    expect(Number.isNaN(parseElapsedSeconds("garbage"))).toBe(true);
  });
});

describe("isSuperseded", () => {
  const binary = join(mkdtempSync(join(tmpdir(), "scout-lifecycle-")), "Scout");

  test("flags a process older than the binary it is running", () => {
    writeFileSync(binary, "#!/bin/sh\n");
    const now = Date.now();
    // Started ten minutes ago; the binary was written just now.
    const record = { ...parseProcessTable(line(1, 1, binary, 600))[0]! };
    expect(isSuperseded(record, binary, now)).toBe(true);
  });

  test("does not flag a process started after its binary was written", () => {
    writeFileSync(binary, "#!/bin/sh\n");
    const now = Date.now() + 600_000;
    const record = { ...parseProcessTable(line(1, 1, binary, 60))[0]! };
    expect(isSuperseded(record, binary, now)).toBe(false);
  });

  test("does not flag a binary it cannot stat", () => {
    const record = { ...parseProcessTable(line(1, 1, "/nope/Scout", 600))[0]! };
    expect(isSuperseded(record, "/nope/Scout", Date.now())).toBe(false);
  });

  // argv[0] for a supervised service is a rewritten title, so statting it
  // resolved against the CLI's cwd and always threw — supersession silently
  // never fired for the layers the check exists for. The entrypoint under the
  // service root is the file that actually changes on a rebuild.
  test("targets the runtime entrypoint for a process-title service", () => {
    const runtime = `${OURS.root}/packages/runtime/bin/openscout-runtime.mjs`;
    const record = parseProcessTable(line(300, 200, `scout-broker run ${runtime} broker`))[0]!;
    expect(record.executable).toBe("scout-broker");
    expect(supersessionTarget(record, null, OURS.root)).toBe(runtime);
  });

  test("claims nothing for a service that names no file it owns", () => {
    const record = parseProcessTable(
      line(301, 200, "scout-edge run --config /Users/dev/.scout/local-edge/Caddyfile"),
    )[0]!;
    // The Caddyfile is not the edge binary; treating a config edit as a stale
    // build would be worse than reporting nothing.
    expect(supersessionTarget(record, null, OURS.root)).toBeNull();
  });
});

describe("classifyProcesses", () => {
  test("maps a healthy suite onto every layer", () => {
    const tree = classifyProcesses(parseProcessTable(healthyTable()), paths);
    expect(tree.layers.scoutd.map((entry) => entry.pid)).toEqual([100]);
    expect(tree.layers.base.map((entry) => entry.pid)).toEqual([200]);
    expect(tree.layers.probes.map((entry) => entry.pid)).toEqual([201]);
    expect(tree.layers.broker.map((entry) => entry.pid)).toEqual([300]);
    expect(tree.layers.edge.map((entry) => entry.pid)).toEqual([301]);
    expect(tree.layers.web.map((entry) => entry.pid)).toEqual([400]);
    expect(tree.layers.app.map((entry) => entry.pid)).toEqual([500]);
    expect(tree.layers.menu.map((entry) => entry.pid)).toEqual([600]);
    expect(tree.layers.pairing.map((entry) => entry.pid)).toEqual([650]);
    expect(tree.foreign).toEqual([]);
    expect(verifyTree(tree)).toEqual([]);
  });

  test("a Scout from another worktree is foreign, not ours", () => {
    const table = `${healthyTable()}\n${line(900, 1, `${OTHER_DIST}/Scout.app/Contents/MacOS/Scout`)}`;
    const tree = classifyProcesses(parseProcessTable(table), paths);

    expect(tree.layers.app.map((entry) => entry.pid)).toEqual([500]);
    expect(tree.foreign.map((entry) => entry.pid)).toEqual([900]);
    // The whole point: a foreign process is never a stop candidate.
    const stopped = planStop(tree).flatMap((step) => (step.kind === "bootout" ? [] : step.pids));
    expect(stopped).not.toContain(900);
  });

  test("a stale menu from a replaced bundle does not satisfy the menu layer", () => {
    const stale = line(700, 1, `${OTHER_DIST}/Scout.app/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu`,
    );
    const tree = classifyProcesses(parseProcessTable(stale), paths);

    expect(tree.layers.menu).toEqual([]);
    expect(tree.foreign.map((entry) => entry.layer)).toEqual(["menu"]);
    expect(verifyTree(tree).some((problem) => /unexpected bundle/.test(problem.message))).toBe(false);
  });

  test("ignores the iOS simulator's copy of Scout", () => {
    const sim = line(800, 1, "/Users/dev/Library/Developer/CoreSimulator/Devices/ABC/data/Containers/Bundle/Application/X/Scout.app/Scout",
    );
    const tree = classifyProcesses(parseProcessTable(sim), paths);
    expect(tree.layers.app).toEqual([]);
    expect(tree.foreign).toEqual([]);
  });

  test("reports an empty machine as not running", () => {
    expect(isRunning(classifyProcesses([], paths))).toBe(false);
    expect(isRunning(classifyProcesses(parseProcessTable(healthyTable()), paths))).toBe(true);
  });

  // The guarantee the module header makes — "matched by name but not by path is
  // reported, never killed" — used to hold only for the two bundled apps. Every
  // supervised layer was hardcoded canonical, so a sibling checkout's broker and
  // web landed in the sweep and were SIGKILLed by a stop in this checkout.
  test("a sibling checkout's supervised tree is foreign, and never swept", () => {
    const theirRuntime = `${THEIRS.root}/packages/runtime/bin/openscout-runtime.mjs`;
    const table = [
      healthyTable(OURS),
      // A whole second supervised tree, correctly parented within itself.
      line(900, 1, `${THEIRS.scoutd} supervise`),
      line(901, 900, `scout-base ${theirRuntime} base`),
      line(902, 900, `${THEIRS.scoutd} probes serve`),
      line(903, 901, `scout-broker run ${theirRuntime} broker`),
      line(904, 901, "scout-edge run --config /Users/dev/.scout/local-edge/Caddyfile --adapter caddyfile"),
      line(905, 903, `scout-web run ${theirRuntime} web`),
    ].join("\n");
    const tree = classifyProcesses(parseProcessTable(table), paths);

    // Ours, and only ours.
    expect(tree.layers.broker.map((entry) => entry.pid)).toEqual([300]);
    expect(tree.layers.web.map((entry) => entry.pid)).toEqual([400]);
    expect(tree.layers.scoutd.map((entry) => entry.pid)).toEqual([100]);

    const theirs = tree.foreign.map((entry) => entry.pid);
    expect(theirs.length).toBeGreaterThan(0);

    const targeted = planStop(tree).flatMap((step) => (step.kind === "bootout" ? [] : step.pids));
    for (const pid of theirs) expect(targeted).not.toContain(pid);
  });

  test("recognizes an owned service orphaned after its scoutd root exits", () => {
    const runtime = `${OURS.root}/packages/runtime/bin/openscout-runtime.mjs`;
    const tree = classifyProcesses(
      parseProcessTable(line(300, 1, `scout-broker run ${runtime} broker`)),
      paths,
    );

    expect(tree.layers.broker).toEqual([]);
    expect(tree.foreign.map((entry) => entry.pid)).toEqual([300]);
    expect(detachedExpectedProcesses(tree).map((entry) => entry.pid)).toEqual([300]);
  });

  test("edge is ours by descent even though it names no path we own", () => {
    const tree = classifyProcesses(parseProcessTable(healthyTable()), paths);
    // `scout-edge run --config …/Caddyfile` carries nothing identifying; only
    // its parentage puts it in this checkout's tree.
    expect(tree.layers.edge.map((entry) => entry.pid)).toEqual([301]);
  });
});

describe("resolveLaunchdLabel", () => {
  test("defaults to the standard label", () => {
    expect(resolveLaunchdLabel({})).toBe(SCOUT_LAUNCHD_LABEL);
  });

  // Booting out a label that is not loaded reports "No such process", which is
  // treated as already-unloaded — so the real job stayed up and the sweep then
  // fought its supervisor.
  test("honours an explicit label so bootout targets the job that is loaded", () => {
    expect(resolveLaunchdLabel({ OPENSCOUT_SERVICE_LABEL: "app.openscout.custom" }))
      .toBe("app.openscout.custom");
    expect(resolveLaunchdLabel({ OPENSCOUT_BROKER_SERVICE_MODE: "custom" }))
      .toBe("app.openscout.custom");
  });
});

describe("planStop", () => {
  test("stops LaunchServices apps before booting out the supervised tree", () => {
    const tree = classifyProcesses(parseProcessTable(healthyTable()), paths);
    const steps = planStop(tree);

    expect(steps.map((step) => (step.kind === "signal" ? step.layer : step.kind))).toEqual([
      ...LAUNCH_SERVICES_LAYERS,
      "bootout",
      "sweep",
    ]);

    const signalled = steps.flatMap((step) => (step.kind === "signal" ? [{ layer: step.layer, pids: step.pids }] : []));
    expect(signalled[0]).toEqual({ layer: "menu", pids: [600] });
    expect(signalled[1]).toEqual({ layer: "app", pids: [500] });
    expect(steps.at(-1)).toMatchObject({ kind: "sweep", pids: expect.arrayContaining([650]) });
  });

  test("never signals supervised layers before the bootout", () => {
    const tree = classifyProcesses(parseProcessTable(healthyTable()), paths);
    const steps = planStop(tree);
    const bootoutIndex = steps.findIndex((step) => step.kind === "bootout");
    const supervisedPids = new Set(SUPERVISED_LAYERS.flatMap((layer) => tree.layers[layer].map((e) => e.pid)));

    for (const step of steps.slice(0, bootoutIndex)) {
      if (step.kind === "signal") {
        for (const pid of step.pids) expect(supervisedPids.has(pid)).toBe(false);
      }
    }

    const bootout = steps[bootoutIndex];
    expect(bootout).toEqual({ kind: "bootout", label: SCOUT_LAUNCHD_LABEL });
  });

  test("sweeps supervised stragglers only after the bootout", () => {
    const tree = classifyProcesses(parseProcessTable(healthyTable()), paths);
    const steps = planStop(tree);
    const sweep = steps.at(-1);
    expect(sweep?.kind).toBe("sweep");
    if (sweep?.kind === "sweep") {
      expect(sweep.pids.sort()).toEqual([100, 200, 201, 300, 301, 400, 650]);
    }
  });

  test("rechecks ownership before signalling a planned supervised straggler", () => {
    const initial = classifyProcesses(parseProcessTable(healthyTable()), paths);
    const sweep = planStop(initial).find((step) => step.kind === "sweep");
    expect(sweep?.kind).toBe("sweep");
    if (sweep?.kind !== "sweep") return;

    const runtime = `${OURS.root}/packages/runtime/bin/openscout-runtime.mjs`;
    const afterBootout = classifyProcesses(parseProcessTable([
      line(100, 1, `${OURS.scoutd} supervise`),
      line(200, 100, `scout-base ${runtime} base`),
      line(300, 200, `scout-broker run ${runtime} broker`),
      line(999, 300, `scout-web run ${runtime} web`),
    ].join("\n")), paths);

    // PIDs 100/200/300 are true survivors. PID 999 appeared after the captured
    // tree and must not be killed by a stale stop plan.
    expect(ownedSweepSurvivorPids(sweep, afterBootout).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  test("keeps planned checkout services eligible after bootout reparents them", () => {
    const initial = classifyProcesses(parseProcessTable(healthyTable()), paths);
    const sweep = planStop(initial).find((step) => step.kind === "sweep");
    expect(sweep?.kind).toBe("sweep");
    if (sweep?.kind !== "sweep") return;

    const ourRuntime = `${OURS.root}/packages/runtime/bin/openscout-runtime.mjs`;
    const theirRuntime = `${THEIRS.root}/packages/runtime/bin/openscout-runtime.mjs`;
    const afterBootout = classifyProcesses(parseProcessTable([
      // launchd has removed scoutd, so its surviving children have been
      // reparented to pid 1 and no longer classify through the ownership tree.
      line(200, 1, `scout-base ${ourRuntime} base`),
      line(300, 1, `scout-broker run ${ourRuntime} broker`),
      // Even reuse of a PID captured in the stop plan is insufficient without
      // this checkout's exact service-root argument.
      line(100, 1, `scout-base ${theirRuntime} base`),
      line(999, 1, `scout-broker run ${theirRuntime} broker`),
    ].join("\n")), paths);

    expect(afterBootout.layers.base).toEqual([]);
    expect(afterBootout.layers.broker).toEqual([]);
    expect(ownedSweepSurvivorPids(sweep, afterBootout).sort((a, b) => a - b)).toEqual([200, 300]);
  });

  test("plans nothing for a machine with nothing running", () => {
    expect(planStop(classifyProcesses([], paths))).toEqual([]);
  });

  test("the apps scope never touches the launchd tree", () => {
    const tree = classifyProcesses(parseProcessTable(healthyTable()), paths);
    const steps = planStop(tree, "apps");

    expect(steps.every((step) => step.kind === "signal")).toBe(true);
    expect(steps.map((step) => (step.kind === "signal" ? step.layer : step.kind))).toEqual(["menu", "app"]);
    // A rebuild must not bounce the services every agent is connected through.
    expect(steps.some((step) => step.kind === "bootout" || step.kind === "sweep")).toBe(false);
  });
});

describe("chooseLaunchdStartMethod", () => {
  // `bootout` unloads the job from the domain, so the start half of a stop/start
  // cycle has to bootstrap from the plist. Kickstarting a booted-out job fails
  // with "Could not find service ... in domain for user" and leaves the whole
  // supervised tree down.
  test("bootstraps after a bootout, because the job is no longer loaded", () => {
    expect(chooseLaunchdStartMethod({ loaded: false, plistExists: true })).toBe("bootstrap");
  });

  test("kickstarts a job that is still loaded", () => {
    expect(chooseLaunchdStartMethod({ loaded: true, plistExists: true })).toBe("kickstart");
  });

  test("uses the checkout scoutd when a loaded job may point somewhere stale", () => {
    expect(chooseLaunchdStartMethod({
      loaded: true,
      plistExists: true,
      scoutdPath: "/repo/bin/scoutd",
    })).toBe("scoutd");
  });

  test("reports unavailable rather than pretending when there is no plist", () => {
    expect(chooseLaunchdStartMethod({ loaded: false, plistExists: false })).toBe("unavailable");
  });

  // Raw launchctl only loads whatever plist is already on disk. scoutd's own
  // start renders the LaunchAgent from current config first and boots out the
  // legacy job, both of which were lost when this replaced `scoutd restart`.
  test("prefers scoutd over a bare bootstrap so the plist is regenerated", () => {
    expect(chooseLaunchdStartMethod({ loaded: false, plistExists: true, scoutdPath: "/repo/bin/scoutd" }))
      .toBe("scoutd");
    expect(chooseLaunchdStartMethod({ loaded: false, plistExists: false, scoutdPath: "/repo/bin/scoutd" }))
      .toBe("scoutd");
  });

  test("resolves the LaunchAgents plist path", () => {
    expect(launchAgentPlistPath("app.openscout", "/Users/dev")).toBe(
      "/Users/dev/Library/LaunchAgents/app.openscout.plist",
    );
  });
});

describe("scoutdStartArguments", () => {
  test("keeps direct scoutd starts health-blocking by default", () => {
    expect(scoutdStartArguments()).toEqual(["start"]);
  });

  test("lets the app lifecycle own readiness after launchd accepts the start", () => {
    expect(scoutdStartArguments({ waitForHealth: false })).toEqual(["start", "--no-wait"]);
  });
});

describe("verifyTree", () => {
  const RUNTIME = `${OURS.root}/packages/runtime/bin/openscout-runtime.mjs`;

  test("flags a duplicate broker", () => {
    const table = `${healthyTable()}\n${line(302, 200, `scout-broker run ${RUNTIME} broker`)}`;
    const tree = classifyProcesses(parseProcessTable(table), paths);
    expect(verifyTree(tree).some((problem) => problem.layer === "broker" && /found 2/.test(problem.message))).toBe(true);
  });

  test("flags a broker that is not owned by base", () => {
    // Reparented under scoutd, so it is still ours by descent — the point is
    // that ownership and *correct* ownership are different questions.
    const table = healthyTable().replace(
      line(300, 200, `scout-broker run ${RUNTIME} broker`),
      line(300, 100, `scout-broker run ${RUNTIME} broker`),
    );
    const tree = classifyProcesses(parseProcessTable(table), paths);
    expect(verifyTree(tree).some((problem) => /owned by pid 100, expected 200/.test(problem.message))).toBe(true);
  });

  test("fails closed when web is orphaned from the broker", () => {
    const table = healthyTable().replace(
      line(400, 300, `scout-web run ${RUNTIME} web`),
      line(400, 200, `scout-web run ${RUNTIME} web`),
    );
    const tree = classifyProcesses(parseProcessTable(table), paths);
    expect(verifyTree(tree).some((problem) =>
      problem.layer === "web" && /owned by pid 200, expected 300/.test(problem.message)
    )).toBe(true);
  });

  test("flags scoutd that launchd does not own", () => {
    const table = healthyTable().replace(
      line(100, 1, `${OURS.scoutd} supervise`),
      line(100, 55, `${OURS.scoutd} supervise`),
    );
    const tree = classifyProcesses(parseProcessTable(table), paths);
    expect(verifyTree(tree).some((problem) => /not owned by launchd/.test(problem.message))).toBe(true);
  });

  test("flags a missing pairing controller", () => {
    const table = healthyTable().replace(
      line(650, 200, `${OURS.root}/pairing-runtime-controller.ts`),
      "",
    );
    const tree = classifyProcesses(parseProcessTable(table), paths);
    expect(verifyTree(tree).some((problem) =>
      problem.layer === "pairing" && /no pairing process is running/.test(problem.message)
    )).toBe(true);
  });

  test("flags a pairing controller not owned by base", () => {
    const table = healthyTable().replace(
      line(650, 200, `${OURS.root}/pairing-runtime-controller.ts`),
      line(650, 600, `${OURS.root}/pairing-runtime-controller.ts`),
    );
    const tree = classifyProcesses(parseProcessTable(table), paths);
    expect(verifyTree(tree).some((problem) =>
      problem.layer === "pairing" && /owned by pid 600, expected 200/.test(problem.message)
    )).toBe(true);
  });

  test("accepts menu ownership only when the base supervisor is unavailable", () => {
    const table = [
      line(500, 1, `${OURS.dist}/Scout.app/Contents/MacOS/Scout`),
      line(600, 500, `${OURS.dist}/Scout.app/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu`),
      line(650, 600, `${OURS.root}/pairing-runtime-controller.ts`),
    ].join("\n");
    const tree = classifyProcesses(parseProcessTable(table), paths);
    expect(verifyTree(tree).filter((problem) => problem.layer === "pairing")).toEqual([]);
  });

  test("does not treat duplicate base supervisors as fallback eligibility", () => {
    const runtime = `${OURS.root}/packages/runtime/bin/openscout-runtime.mjs`;
    const table = `${healthyTable().replace(
      line(650, 200, `${OURS.root}/pairing-runtime-controller.ts`),
      line(650, 600, `${OURS.root}/pairing-runtime-controller.ts`),
    )}\n${line(202, 100, `scout-base ${runtime} base`)}`;
    const tree = classifyProcesses(parseProcessTable(table), paths);
    expect(verifyTree(tree).some((problem) =>
      problem.layer === "pairing" && /owned by pid 600, expected 200/.test(problem.message)
    )).toBe(true);
  });

  test("keeps a sibling checkout informational rather than failing our tree", () => {
    const table = `${healthyTable()}\n${line(900, 1, `${OTHER_DIST}/Scout.app/Contents/MacOS/Scout`)}`;
    const tree = classifyProcesses(parseProcessTable(table), paths);

    expect(tree.foreign.map((entry) => entry.pid)).toEqual([900]);
    expect(verifyTree(tree)).toEqual([]);
  });
});
