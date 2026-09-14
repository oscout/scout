import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { MachineRecord } from "@openscout/protocol";

import {
  compareReleaseVersions,
  classifyScoutBridge,
  emptyReading,
  isSettledStatus,
  listUnmanagedScoutProcesses,
  parseReleaseVersion,
  planMachineUpdate,
  readOwnedSuitePids,
  readSuiteStatus,
  readRuntimeIdentityFromDoctorStream,
  readRuntimeIdentityFromScoutdStatus,
  resolveMachineReferences,
  summarizeBridgeClients,
  summarizeMachineUpdateRun,
  type MachineComponentReport,
  type MachineUpdatePlan,
  type MachineSuiteStatus,
  type MachineUpdateReading,
} from "./machine-update.ts";

const NOW = 1_790_000_000_000;

function machine(overrides: Partial<MachineRecord> & { name: string }): MachineRecord {
  return {
    id: `machine-${overrides.name.toLowerCase().replace(/\s+/g, "-")}`,
    displayName: null,
    platform: "macos",
    identityKeys: [],
    isSelf: false,
    hostNames: [],
    addresses: [],
    macAddresses: [],
    capabilities: ["ssh"],
    routes: [],
    evidence: [],
    pinned: false,
    firstSeenAt: NOW - 86_400_000,
    lastSeenAt: NOW - 1_000,
    ...overrides,
  } as MachineRecord;
}

function reading(overrides: Partial<MachineUpdateReading> = {}): MachineUpdateReading {
  return { ...emptyReading(), ...overrides };
}

/** A machine whose app, CLI, and runtime all sit on one version. */
function converged(version: string, overrides: Partial<MachineUpdateReading> = {}): MachineUpdateReading {
  return reading({
    appVersion: version,
    cliVersion: version,
    runtimeVersion: version,
    runtimeIntentional: false,
    unmanagedScoutProcesses: [],
    suite: healthySuite(),
    ...overrides,
  });
}

function healthySuite(): MachineSuiteStatus {
  return {
    running: true,
    missingLayers: [],
    foreign: [],
    problems: [],
    issues: [],
    state: "healthy",
  };
}

/** A synthetic inventory of `count` claude-held mcp bridges. */
function bridgeList(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    pid: 1000 + index,
    ppid: 90001,
    elapsed: "01:00:00",
    command: "bun /Users/o/dev/openscout/packages/cli/bin/scout.mjs mcp",
    bridge: "mcp" as const,
    client: "claude",
    parentCommand: "/Users/o/.local/bin/claude",
    launchdLabel: null,
  }));
}

describe("release version parsing", () => {
  test("accepts release triples and strips a v prefix", () => {
    expect(parseReleaseVersion("0.2.101")).toEqual({
      major: 0,
      minor: 2,
      patch: 101,
      prerelease: null,
    });
    expect(parseReleaseVersion("v1.0.0")).toMatchObject({ major: 1, minor: 0, patch: 0 });
    expect(parseReleaseVersion("0.2.101+build.7")).toMatchObject({ patch: 101, prerelease: null });
  });

  test("rejects anything that is not a release version", () => {
    // A dev checkout has no orderable version. Parsing one lexically is how a
    // working tree gets silently "upgraded" to an older release.
    for (const value of ["dev", "main", "0.2", "0.2.101.1", "1.2.3-", "1.2.3-rc..1", "", null]) {
      expect(parseReleaseVersion(value)).toBeNull();
    }
  });
});

describe("compareReleaseVersions", () => {
  test("orders release triples numerically, not lexically", () => {
    // The lexical trap: "0.2.9" sorts above "0.2.101" as text.
    expect(compareReleaseVersions("0.2.9", "0.2.101")).toBe(-1);
    expect(compareReleaseVersions("0.2.101", "0.2.9")).toBe(1);
    expect(compareReleaseVersions("0.2.101", "0.2.101")).toBe(0);
    expect(compareReleaseVersions("v0.2.101", "0.2.101")).toBe(0);
    expect(compareReleaseVersions("0.10.0", "0.9.99")).toBe(1);
  });

  test("ranks a prerelease below the release it leads to", () => {
    expect(compareReleaseVersions("0.2.101-rc.1", "0.2.101")).toBe(-1);
    expect(compareReleaseVersions("0.2.101", "0.2.101-rc.1")).toBe(1);
  });

  test("compares prerelease identifiers by semver precedence", () => {
    // Numeric identifiers compare as numbers: rc.9 is older than rc.10.
    expect(compareReleaseVersions("0.2.101-rc.9", "0.2.101-rc.10")).toBe(-1);
    // Numeric identifiers rank below alphanumeric ones.
    expect(compareReleaseVersions("0.2.101-1", "0.2.101-alpha")).toBe(-1);
    // A shorter identifier list ranks lower.
    expect(compareReleaseVersions("0.2.101-rc.1", "0.2.101-rc.1.1")).toBe(-1);
    expect(compareReleaseVersions("0.2.101-rc.1", "0.2.101-rc.1")).toBe(0);
  });

  test("returns null rather than an order when either side is unreadable", () => {
    expect(compareReleaseVersions("dev", "0.2.101")).toBeNull();
    expect(compareReleaseVersions("0.2.101", "main")).toBeNull();
    expect(compareReleaseVersions(null, "0.2.101")).toBeNull();
  });
});

describe("resolveMachineReferences", () => {
  const air = machine({ name: "Air", hostNames: ["air.local"] });
  const mini = machine({ name: "Mini", displayName: "Art's Mini", hostNames: ["mini.local"] });
  const airborne = machine({ name: "Airborne" });
  const fleet = [air, mini, airborne];

  test("honours argv boundaries: two arguments are two machines", () => {
    // `scout update Air Mini`. The shell already grouped these; the planner
    // does not re-guess by joining them back together.
    const resolved = resolveMachineReferences(["Air", "Mini"], fleet);
    expect(resolved.map((entry) => entry.kind)).toEqual(["resolved", "resolved"]);
    expect(resolved.map((entry) => (entry.kind === "resolved" ? entry.machine.name : null)))
      .toEqual(["Air", "Mini"]);
  });

  test("treats a quoted multi-word name as one machine", () => {
    const airMini = machine({ name: "Air Mini" });
    const resolved = resolveMachineReferences(["Air Mini"], [...fleet, airMini]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ kind: "resolved", machine: { name: "Air Mini" } });
  });

  test("never joins arguments back together even when the joined name exists", () => {
    // "Air Mini" is a real machine here, but the operator typed two arguments.
    // Honouring the joined form would silently update a different box.
    const airMini = machine({ name: "Air Mini" });
    const resolved = resolveMachineReferences(["Air", "Mini"], [...fleet, airMini]);
    expect(resolved.map((entry) => (entry.kind === "resolved" ? entry.machine.name : entry.kind)))
      .toEqual(["Air", "Mini"]);
  });

  test("requires an exact name — a prefix is not a target for a mutation", () => {
    const resolved = resolveMachineReferences(["Airb"], fleet);
    expect(resolved[0]).toMatchObject({ kind: "unknown", reference: "Airb" });
    // Exact still wins where the name is a prefix of another machine's name.
    expect(resolveMachineReferences(["Air"], fleet)[0]).toMatchObject({
      kind: "resolved",
      machine: { name: "Air" },
    });
  });

  test("matches an operator-set display name and a hostname", () => {
    expect(resolveMachineReferences(["Art's Mini"], fleet)[0]).toMatchObject({
      kind: "resolved",
      machine: { name: "Mini" },
    });
    expect(resolveMachineReferences(["mini.local"], fleet)[0]).toMatchObject({
      kind: "resolved",
      machine: { name: "Mini" },
    });
  });

  test("reports an unknown name with the candidate list instead of guessing", () => {
    const resolved = resolveMachineReferences(["Studio"], fleet);
    expect(resolved[0]).toMatchObject({ kind: "unknown", reference: "Studio" });
    expect(resolved[0]!.kind === "unknown" && resolved[0]!.candidates)
      .toEqual(["Air", "Airborne", "Art's Mini"]);
  });

  test("collapses two names for the same machine into one target", () => {
    // A second update is not an update, it is a second restart.
    const resolved = resolveMachineReferences(["Mini", "mini.local"], fleet);
    expect(resolved).toHaveLength(1);
  });
});

describe("readRuntimeIdentityFromScoutdStatus", () => {
  test("reads the runtime version from the real scoutd status contract", () => {
    const payload = JSON.parse(
      readFileSync(new URL("./test-fixtures/scoutd-status-stale.json", import.meta.url), "utf8"),
    );
    expect(readRuntimeIdentityFromScoutdStatus(payload)).toEqual({
      runtimeVersion: "0.2.78",
      runtimeIntentional: false,
      runtimeState: "stale",
      runtimeCommit: "1111111111111111111111111111111111111111",
    });
  });

  test("falls back to scoutdState.runtimeBuild, never to a discovery card", () => {
    // An installed artifact can still advertise `dev` on its card, so the card
    // is not consulted at all.
    const identity = readRuntimeIdentityFromScoutdStatus({
      card: { version: "dev" },
      health: { build: "dev" },
      scoutdState: { runtimeBuild: { version: "0.2.101", commit: "abc123" } },
    });
    expect(identity.runtimeVersion).toBe("0.2.101");
    expect(identity.runtimeCommit).toBe("abc123");
  });

  test("returns nulls for a payload it cannot read", () => {
    expect(readRuntimeIdentityFromScoutdStatus(null)).toEqual({
      runtimeVersion: null,
      runtimeIntentional: null,
      runtimeState: null,
      runtimeCommit: null,
    });
  });
});

describe("readRuntimeIdentityFromDoctorStream", () => {
  test("finds the runtime identity in a real doctor NDJSON stream", () => {
    const stream = readFileSync(
      new URL("./test-fixtures/scout-doctor-stream-pinned.ndjson", import.meta.url),
      "utf8",
    );
    expect(readRuntimeIdentityFromDoctorStream(stream)).toEqual({
      runtimeVersion: "0.2.99",
      runtimeIntentional: true,
      runtimeState: "pinned",
      runtimeCommit: "bd8009027337de5518c45e6c8dc4c3ce003f666e",
    });
  });

  test("skips the trimmed copy that carries no version", () => {
    // The doctor emits a decision-only runtimeFreshness before the full one.
    // Reading that first would report a healthy machine as unreadable.
    const trimmedOnly = JSON.stringify({
      nativeDaemon: { status: { runtimeFreshness: { state: "pinned", intentional: true } } },
    });
    expect(readRuntimeIdentityFromDoctorStream(trimmedOnly).runtimeVersion).toBeNull();
  });

  test("ignores non-JSON noise on the stream", () => {
    const stream = ["Scout doctor", "Discovering projects…", "", '{"phase":"start"}'].join("\n");
    expect(readRuntimeIdentityFromDoctorStream(stream).runtimeVersion).toBeNull();
  });
});

describe("listing unmanaged Scout bridges", () => {
  // Captured from the 2026-09-14 Air and Mini audits, with the operator's home
  // path neutralised and unrelated session ids replaced. The noise rows are the
  // real ones that inflated the first count: log pipes, tmux, and launch.sh.
  const ps = readFileSync(
    new URL("./test-fixtures/ps-scout-processes.txt", import.meta.url),
    "utf8",
  );

  test("a bridge is a Scout CLI entry with an mcp or channel subcommand", () => {
    expect(classifyScoutBridge("/Users/o/.bun/bin/bun /Users/o/dev/openscout/packages/cli/bin/scout.mjs mcp"))
      .toBe("mcp");
    expect(classifyScoutBridge("bun /Users/o/node_modules/@openscout/scout/bin/scout.mjs channel"))
      .toBe("channel");
    // Mini runs its bridges out of a source checkout, so `.ts` is an entry too.
    expect(classifyScoutBridge("/Users/o/.bun/bin/bun /Users/o/dev/openscout/apps/desktop/bin/scout.ts mcp"))
      .toBe("mcp");
    expect(classifyScoutBridge("/usr/local/bin/node /Users/o/node_modules/@openscout/scout/bin/scout-mcp"))
      .toBe("mcp");
    // A mesh bridge pins its code at launch the same way; the 2026-09-14 fleet
    // ran none, so counting it leaves the audited 18 and 25 unchanged.
    expect(classifyScoutBridge("/Users/o/.bun/bin/bun /Users/o/dev/openscout/apps/desktop/bin/scout.ts mesh bridge"))
      .toBe("mesh");
  });

  test("does not count the app or the menu bar item as a bridge", () => {
    // Their version is already compared as the `app` component; counting them
    // here would report the same stale build twice.
    expect(classifyScoutBridge("/Users/o/dev/openscout/apps/macos/dist/Scout.app/Contents/MacOS/Scout"))
      .toBeNull();
    expect(classifyScoutBridge(
      "/Applications/OpenScout.app/Contents/Library/LoginItems/ScoutMenu.app/Contents/MacOS/ScoutMenu",
    )).toBeNull();
  });

  test("does not count a harness's own plumbing as a bridge", () => {
    // These three shapes are what turned an audited 18 and 25 into 30 and 56:
    // every one of them mentions an openscout path without being a Scout process.
    expect(classifyScoutBridge(
      'sh -c cat >> "/Users/o/Library/Application Support/OpenScout/runtime/agents/s/logs/stdout.log"',
    )).toBeNull();
    expect(classifyScoutBridge(
      'tmux new-session -dP -s s -c /Users/o/dev/linea exec bash "/Users/o/Library/Application Support/OpenScout/runtime/agents/s/launch.sh"',
    )).toBeNull();
    expect(classifyScoutBridge("claude --project /Users/o/dev/openscout")).toBeNull();
    // A Scout entry running something that is not a bridge is not a bridge.
    expect(classifyScoutBridge("bun /Users/o/dev/openscout/packages/cli/bin/scout.mjs app status")).toBeNull();
  });

  test("names each bridge with its pid, parent, age, and owning client", () => {
    const bridges = listUnmanagedScoutProcesses(ps, new Set([46579]));
    expect(bridges).toHaveLength(9);
    // A count cannot tell an operator where to go; the identity of the holder is
    // the whole point of the inventory.
    expect(bridges[0]).toMatchObject({
      pid: 19412,
      ppid: 90001,
      elapsed: "03:40:52",
      bridge: "mcp",
      client: "claude",
    });
    expect(bridges.map((bridge) => bridge.bridge).sort()).toEqual([
      "channel", "channel", "channel", "channel", "mcp", "mcp", "mcp", "mcp", "mesh",
    ]);
    // Mini runs its bridges from a source checkout: `apps/desktop/bin/scout.ts mcp`.
    expect(bridges.find((bridge) => bridge.pid === 11255)!.command)
      .toContain("apps/desktop/bin/scout.ts mcp");
    // The parent's own command rides along, so an unattributed bridge is
    // inspectable without opening an SSH session to go look.
    expect(bridges[0]!.parentCommand).toBe("/Users/operator/.local/bin/claude");
  });

  test("does not list a process the managed suite owns", () => {
    const owned = new Set(listUnmanagedScoutProcesses(ps, new Set()).map((bridge) => bridge.pid));
    expect(listUnmanagedScoutProcesses(ps, owned)).toEqual([]);
  });

  test("groups bridges by the harness holding them", () => {
    const summary = summarizeBridgeClients(listUnmanagedScoutProcesses(ps, new Set([46579])));
    expect(summary).toContain("claude (4:");
    expect(summary).toContain("codex (3:");
    expect(summary).toContain("launchd (1: 995)");
  });

  test("does not infer a launchd job label from ppid 1", () => {
    // pid 995 on arts-mini: ppid 1, in no `scout app status` layer, and neither
    // an install nor `scout app restart` bounces it. Telling an operator to
    // restart the harness session holding it is advice nobody can follow.
    const launchd = listUnmanagedScoutProcesses(ps, new Set([46579]))
      .find((bridge) => bridge.pid === 995)!;
    expect(launchd).toMatchObject({
      ppid: 1,
      bridge: "mesh",
      client: "launchd",
      launchdLabel: null,
    });
  });

  test("matches a client name exactly, so pip is not pi", () => {
    // A prefix match attributes `pip`, `ping`, and `pinentry` to the `pi` harness.
    const bridge = listUnmanagedScoutProcesses(ps, new Set([46579]))
      .find((entry) => entry.pid === 61001)!;
    expect(bridge.client).toBeNull();
    expect(bridge.parentCommand).toBe("/usr/bin/pip");
  });

  test("calls a bridge with no readable parent unknown rather than guessing", () => {
    const orphan = "  777 99999 01:02:03 bun /Users/o/dev/openscout/packages/cli/bin/scout.mjs channel";
    expect(listUnmanagedScoutProcesses(orphan, new Set())[0]).toMatchObject({
      pid: 777,
      client: null,
      parentCommand: null,
      launchdLabel: null,
    });
  });

  test("reads a healthy suite as healthy", () => {
    // Air's real status the night the fleet reached 0.2.101.
    const payload = JSON.parse(readFileSync(
      new URL("./test-fixtures/scout-app-status-healthy.json", import.meta.url),
      "utf8",
    ));
    expect(readSuiteStatus(payload)).toMatchObject({
      running: true,
      state: "healthy",
      issues: [],
      missingLayers: [],
    });
  });

  test("reads a foreign-owned service as a suite problem, and names the owner", () => {
    // Captured live: the app and menu layers are empty while a source build
    // holds both roles. Three current component versions do not describe this.
    const payload = JSON.parse(readFileSync(
      new URL("./test-fixtures/scout-app-status-foreign.json", import.meta.url),
      "utf8",
    ));
    const suite = readSuiteStatus(payload)!;
    expect(suite.state).toBe("service-problems");
    expect(suite.missingLayers.sort()).toEqual(["app", "menu"]);
    expect(suite.foreign.map((entry) => entry.layer).sort()).toEqual(["app", "menu"]);
    expect(suite.issues).toContain("no app process is running");
    // An operator cannot act on "foreign" without knowing what took the role.
    expect(suite.issues.some((issue) => issue.includes("held by a foreign build")
      && issue.includes("dist/Scout.app"))).toBe(true);
    // The suite already complained about both layers; do not say it twice.
    expect(suite.issues.filter((issue) => issue === "no app process is running")).toHaveLength(1);
  });

  test("an unreadable payload is not a healthy suite", () => {
    expect(readSuiteStatus(null)).toBeNull();
    expect(readSuiteStatus({ running: true })).toBeNull();
  });

  test("reads the managed suite's pids out of an app status payload", () => {
    expect([...readOwnedSuitePids({
      action: "status",
      layers: [{ layer: "scoutd", pids: [46579] }, { layer: "base", pids: [46587, 46588] }],
    })].sort()).toEqual([46579, 46587, 46588]);
    expect(readOwnedSuitePids(null).size).toBe(0);
  });
});

describe("planMachineUpdate", () => {
  const target = "0.2.101";

  test("plans a local update it can actually execute", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Studio", isSelf: true }),
      reading: converged("0.2.100"),
      targetVersion: target,
      now: NOW,
    });
    expect(plan).toMatchObject({ state: "update-available", execution: "local-install" });
  });

  test("plans a remote update but refuses to claim it can execute it", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Air" }),
      reading: converged("0.2.100"),
      targetVersion: target,
      now: NOW,
    });
    expect(plan).toMatchObject({ state: "update-available", execution: "planner-only" });
    expect(plan.reason).toContain("cannot execute it");
  });

  test("will not call a machine current while its CLI is behind", () => {
    // The Mini case: app 0.2.100 against a CLI symlinked to 0.2.98. Comparing
    // only the app would report this machine as converged.
    const plan = planMachineUpdate({
      machine: machine({ name: "Mini" }),
      reading: converged(target, { cliVersion: "0.2.98" }),
      targetVersion: target,
      now: NOW,
    });
    expect(plan.state).toBe("update-available");
    expect(plan.reason).toContain("cli 0.2.98");
  });

  test("will not call a machine current while its runtime is behind", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Mini" }),
      reading: converged(target, { runtimeVersion: "0.2.78" }),
      targetVersion: target,
      now: NOW,
    });
    expect(plan.state).toBe("update-available");
    expect(plan.reason).toContain("runtime 0.2.78");
  });

  test("an unreadable component is unknown, not current and not behind", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Mini" }),
      reading: converged(target, { cliVersion: null }),
      targetVersion: target,
      now: NOW,
    });
    expect(plan).toMatchObject({ state: "unreadable", execution: "none" });
    expect(plan.reason).toContain("cli unreadable");
  });

  test("reports every component's verdict separately", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Mini" }),
      reading: converged(target, { cliVersion: "0.2.98", runtimeVersion: "0.2.78" }),
      targetVersion: target,
      now: NOW,
    });
    expect(plan.components).toEqual([
      { name: "app", version: "0.2.101", status: "current" },
      { name: "cli", version: "0.2.98", status: "behind" },
      { name: "runtime", version: "0.2.78", status: "behind" },
    ] satisfies MachineComponentReport[]);
  });

  test("refuses to downgrade a machine that is ahead of the target", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Air", isSelf: true }),
      reading: converged("0.2.102"),
      targetVersion: target,
      now: NOW,
    });
    expect(plan).toMatchObject({ state: "downgrade-blocked", execution: "none" });
  });

  test("holds a source-owned runtime ahead of every version comparison", () => {
    // scoutd says the operator pointed this runtime at a checkout on purpose.
    // Moving it onto a published artifact is their decision, not this command's.
    const plan = planMachineUpdate({
      machine: machine({ name: "Studio", isSelf: true }),
      reading: converged("0.2.78", { runtimeIntentional: true, runtimeState: "pinned" }),
      targetVersion: target,
      now: NOW,
    });
    expect(plan).toMatchObject({ state: "source-owned", execution: "none" });
    expect(plan.reason).toContain("explicit operator decision");
  });

  test("reports an offline machine instead of attempting it", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Air", lastSeenAt: NOW - 86_400_000 }),
      reading: emptyReading("unreachable"),
      targetVersion: target,
      now: NOW,
    });
    expect(plan).toMatchObject({ state: "offline", execution: "none", presence: "offline" });
  });

  test("calls a non-release version unreadable rather than out of date", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Studio", isSelf: true }),
      reading: converged("dev"),
      targetVersion: target,
      now: NOW,
    });
    expect(plan).toMatchObject({ state: "unreadable", execution: "none" });
    expect(plan.reason).toContain("Not a readable release version");
  });

  test("blames an unreadable target rather than the machine's three components", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Air" }),
      reading: converged("0.2.101"),
      targetVersion: null,
      now: NOW,
    });
    expect(plan.state).toBe("unreadable");
    expect(plan.reason).toContain("No readable target release version");
    // The components themselves read fine; nothing is wrong with the machine.
    expect(plan.reason).not.toContain("app");
  });

  test("recognises a machine whose app, CLI, and runtime all match", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Air" }),
      reading: converged(target),
      targetVersion: target,
      now: NOW,
    });
    expect(plan).toMatchObject({ state: "up-to-date", execution: "none" });
  });

  test("will not call a machine up to date while bridges hold old code", () => {
    // Air reached 0.2.101 on all three components with 18 harness-held bridges
    // still running pre-update JavaScript; a broker restart did not replace them.
    const plan = planMachineUpdate({
      machine: machine({ name: "Air" }),
      reading: converged(target, { unmanagedScoutProcesses: bridgeList(18) }),
      targetVersion: target,
      now: NOW,
    });
    expect(plan).toMatchObject({ state: "bridges-pending", execution: "none" });
    expect(plan.reason).toContain("18 Scout processes");
    // The reason carries who holds them, so the operator is not left with a number.
    expect(plan.reason).toContain("claude (18:");
  });

  test("an unread bridge audit stays unverified rather than defaulting to none", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Air" }),
      reading: converged(target, { unmanagedScoutProcesses: null }),
      targetVersion: target,
      now: NOW,
    });
    // Treating null as zero would turn a failed read into a convergence claim.
    expect(plan).toMatchObject({ state: "convergence-unverified", execution: "none" });
    expect(plan.reason).toContain("the bridge audit could not be read");
  });

  test("an unread suite status stays unverified too", () => {
    const plan = planMachineUpdate({
      machine: machine({ name: "Air" }),
      reading: converged(target, { suite: null }),
      targetVersion: target,
      now: NOW,
    });
    expect(plan).toMatchObject({ state: "convergence-unverified", execution: "none" });
    expect(plan.reason).toContain("the managed suite's status could not be read");
  });

  test("will not call a machine up to date while a suite service is missing or foreign", () => {
    const payload = JSON.parse(readFileSync(
      new URL("./test-fixtures/scout-app-status-foreign.json", import.meta.url),
      "utf8",
    ));
    const plan = planMachineUpdate({
      machine: machine({ name: "Air" }),
      reading: converged(target, { suite: readSuiteStatus(payload) }),
      targetVersion: target,
      now: NOW,
    });
    // The three versions are current; the suite is not running them.
    expect(plan).toMatchObject({ state: "suite-problems", execution: "none" });
    expect(plan.reason).toContain("no app process is running");
  });

  test("a broken suite outranks stale bridges in the report", () => {
    const payload = JSON.parse(readFileSync(
      new URL("./test-fixtures/scout-app-status-foreign.json", import.meta.url),
      "utf8",
    ));
    const plan = planMachineUpdate({
      machine: machine({ name: "Air" }),
      reading: converged(target, {
        suite: readSuiteStatus(payload),
        unmanagedScoutProcesses: bridgeList(18),
      }),
      targetVersion: target,
      now: NOW,
    });
    // A missing service means the compared versions are not what runs here at
    // all; stale bridges are the smaller problem and stay in the payload.
    expect(plan.state).toBe("suite-problems");
    expect(plan.reading.unmanagedScoutProcesses).toHaveLength(18);
  });
});

describe("summarizeMachineUpdateRun", () => {
  function plan(overrides: Partial<MachineUpdatePlan>): MachineUpdatePlan {
    return {
      machineId: "m1",
      label: "Air",
      isSelf: false,
      presence: "online",
      state: "up-to-date",
      execution: "none",
      components: [],
      reading: emptyReading(),
      targetVersion: "0.2.101",
      reason: "",
      ...overrides,
    };
  }

  test("a requested update that only produced a plan is `planned` and exits nonzero", () => {
    // The whole point: a check must never be printed or scripted as a
    // completed update.
    const result = summarizeMachineUpdateRun(
      [plan({ state: "update-available", execution: "planner-only" })],
      { check: false },
    );
    expect(result).toMatchObject({ status: "planned", exitCode: 1 });
  });

  test("a local install that converged reports `components-updated`, scoped to what it read", () => {
    const result = summarizeMachineUpdateRun(
      [plan({ label: "Studio", isSelf: true, state: "up-to-date" })],
      { check: false, installed: ["Studio"] },
    );
    expect(result).toMatchObject({ status: "components-updated", exitCode: 0 });
  });

  test("a local install that did not converge is `partial`, never updated", () => {
    // Running the installer moves the app. The CLI and the runtime are separate
    // packages, and a machine that still reports one behind has not converged.
    const result = summarizeMachineUpdateRun(
      [plan({ label: "Studio", isSelf: true, state: "update-available", execution: "local-install" })],
      { check: false, installed: ["Studio"] },
    );
    expect(result).toMatchObject({ status: "partial", exitCode: 1 });
  });

  test("never emits a bare `current` or `updated`, because bridges are unread", () => {
    // Air and Mini carried app, CLI, and runtime 0.2.101 while 18 and 25 MCP and
    // channel bridges were still old processes. The status word has to say which
    // question it answered.
    const settled = summarizeMachineUpdateRun([plan({ state: "up-to-date" })], { check: false });
    expect(settled.status).toBe("components-current");
    const done = summarizeMachineUpdateRun(
      [plan({ label: "Studio", isSelf: true, state: "up-to-date" })],
      { check: false, installed: ["Studio"] },
    );
    expect(done.status).toBe("components-updated");
    expect([settled.status, done.status]).not.toContain("current");
  });

  test("exit 0 means settled, in check mode as much as any other", () => {
    // One rule: `components-current` and `held` exit 0; everything else — work
    // due, work unfinished, or a reading that failed — is nonzero. A check that
    // exits 0 while bridges hold old code is the same false complete, moved
    // from the status word to the exit code.
    const cases: [string, Partial<MachineUpdatePlan>, number][] = [
      ["planned", { state: "update-available", execution: "planner-only" }, 1],
      ["bridges-pending", { state: "bridges-pending" }, 1],
      ["suite-problems", { state: "suite-problems" }, 1],
      ["convergence-unverified", { state: "convergence-unverified" }, 1],
      ["blocked", { state: "offline" }, 1],
      ["held", { state: "source-owned" }, 0],
      ["components-current", { state: "up-to-date" }, 0],
    ];
    for (const [status, overrides, exitCode] of cases) {
      expect(summarizeMachineUpdateRun([plan(overrides)], { check: true }))
        .toMatchObject({ status, exitCode });
    }
  });

  test("isSettledStatus is the single source the table and the code share", () => {
    expect(isSettledStatus("components-current")).toBe(true);
    expect(isSettledStatus("held")).toBe(true);
    for (const status of ["bridges-pending", "suite-problems", "convergence-unverified",
      "planned", "partial", "blocked", "components-updated"] as const) {
      expect(isSettledStatus(status)).toBe(false);
    }
  });

  test("a blocked machine fails the run in both modes", () => {
    for (const check of [true, false]) {
      const result = summarizeMachineUpdateRun([plan({ state: "offline" })], { check });
      expect(result).toMatchObject({ status: "blocked", exitCode: 1 });
    }
  });

  test("a held source-owned runtime is `held`, not `current`, and is not a failure", () => {
    // A machine deliberately kept on 0.2.78 is not a failure, but calling the
    // run `current` would claim it sits on the target.
    const result = summarizeMachineUpdateRun([plan({ state: "source-owned" })], { check: false });
    expect(result).toMatchObject({ status: "held", exitCode: 0 });
    expect(result.summary).toContain("source-owned and held");
    expect(summarizeMachineUpdateRun([plan({ state: "source-owned" })], { check: true }).status)
      .toBe("held");
  });
});
