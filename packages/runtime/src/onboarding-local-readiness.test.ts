import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep service/install mocks in a child so the normal runtime suite never
// inherits them. The actual catalog still evaluates local evidence there.
if (process.env.OPENSCOUT_ONBOARDING_READINESS_CHILD !== "1") {
  test("setup and its completion read never invoke provider/auth checks", () => {
    const result = spawnSync(process.execPath, ["test", import.meta.filename], {
      env: { ...process.env, OPENSCOUT_ONBOARDING_READINESS_CHILD: "1" }, encoding: "utf8", timeout: 20_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 25_000);
} else {
let subprocessCalls = 0;
const childProcess = await import("node:child_process");
const forbidSubprocess = () => { subprocessCalls += 1; throw new Error("Onboarding readiness started a subprocess"); };
// Deny all launch exports, including the default namespace and fork. Enumerating
// exports avoids the fence mistaking deny-only mock property names for calls.
const launchExport = /^(?:exec|spawn)|^(?:fork|ChildProcess)$/;
const denyLaunches = (exports: object) => Object.fromEntries(Object.entries(exports)
  .map(([name, value]) => [name, launchExport.test(name) ? forbidSubprocess : value]));
const blockedChildProcess = { ...denyLaunches(childProcess), default: denyLaunches(childProcess.default) };
mock.module("node:child_process", () => blockedChildProcess);

test("the subprocess guard traps every launch export and its default namespace", () => {
  expect(() => blockedChildProcess.fork()).toThrow("Onboarding readiness started a subprocess");
  expect(() => blockedChildProcess.default.fork()).toThrow("Onboarding readiness started a subprocess");
  for (const namespace of [blockedChildProcess, blockedChildProcess.default]) {
    for (const [name, value] of Object.entries(namespace)) {
      if (launchExport.test(name)) expect(() => (value as () => unknown)()).toThrow("Onboarding readiness started a subprocess");
    }
  }
  expect(subprocessCalls).toBeGreaterThan(0);
  subprocessCalls = 0;
});
const setup = await import("./setup.js");
const catalog = await import("./harness-catalog.js");
const loadLocalCatalog = catalog.loadHarnessCatalogSnapshot;
const seenOptions: Array<{ localOnly?: boolean }> = [];
let providerChecks = 0;
let serviceStarts = 0;
let brokerReads = 0;
let filesystemHome: string | null = null;
mock.module("./setup.js", () => ({
  ...setup,
  initializeOpenScoutSetup: async () => ({}),
  installScoutSkillToHarnesses: async () => ({}),
  installClaudeStatuslineTool: async () => ({}),
}));
mock.module("./broker-process-manager.js", () => ({
  brokerServiceStatus: async () => { brokerReads += 1; return { reachable: true, brokerUrl: "", health: { ok: true } }; },
  startBrokerService: async () => { serviceStarts += 1; throw new Error("Unexpected service start"); },
}));
mock.module("./harness-catalog.js", () => ({
  ...catalog,
  loadHarnessCatalogSnapshot: async (options: { localOnly?: boolean } = {}) => {
    seenOptions.push(options);
    return loadLocalCatalog({
      ...options,
      ...(filesystemHome ? {
        env: { HOME: filesystemHome, PATH: join(filesystemHome, "bin") },
        executableExists: (path: string) => {
          if (!path.startsWith(`${filesystemHome}/`)) return false;
          try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
        },
      } : {
        env: {}, whichBinary: (binary: string) => binary === "cursor-agent" ? "/test/bin/cursor-agent" : null,
        requirementExists: () => false,
      }),
      runCommand: () => { providerChecks += 1; throw new Error("Unexpected provider/auth status lookup"); },
    });
  },
}));
const { runOpenScoutOnboardingSetup, loadOpenScoutOnboardingState, ensureOpenScoutOnboardingLocalConfig,
  saveOpenScoutOnboardingIdentity, ensureOpenScoutOnboardingCompletion, markOpenScoutOnboardingCommand } = await import("./onboarding.js");

test("setup and its completion read never invoke provider/auth checks", async () => {
  const home = mkdtempSync(join(tmpdir(), "openscout-local-readiness-"));
  const isolatedEnv = {
    HOME: home, OPENSCOUT_HOME: join(home, ".openscout"),
    OPENSCOUT_SUPPORT_DIRECTORY: join(home, "support"), OPENSCOUT_CONTROL_HOME: join(home, "control"),
    OPENSCOUT_RELAY_HUB: join(home, "relay"), OPENSCOUT_SKIP_USER_PROJECT_HINTS: "1",
  };
  const original = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, isolatedEnv);
  const project = join(home, "dev", "alpha");
  mkdirSync(project, { recursive: true });
  try {
    const result = await runOpenScoutOnboardingSetup({ currentDirectory: project, contextRoot: project, sourceRoots: [project], defaultHarness: "cursor" });
    expect(seenOptions.length).toBeGreaterThan(1);
    expect(seenOptions.every((options) => options.localOnly === true)).toBe(true);
    expect(providerChecks).toBe(0);
    expect(subprocessCalls).toBe(0);
    expect(serviceStarts).toBe(0);
    expect(result.state.selectedHarness).toMatchObject({ id: "cursor", state: "configured", ready: false });
    expect(result.state.completedAt).toBeNull();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("fresh polling and completion use filesystem evidence and observe readiness only once per completion", async () => {
  const home = mkdtempSync(join(tmpdir(), "openscout-readiness-observation-"));
  const isolatedEnv = {
    HOME: home, OPENSCOUT_HOME: join(home, ".openscout"), OPENSCOUT_SUPPORT_DIRECTORY: join(home, "support"),
    OPENSCOUT_CONTROL_HOME: join(home, "control"), OPENSCOUT_RELAY_HUB: join(home, "relay"), OPENSCOUT_SKIP_USER_PROJECT_HINTS: "1",
  };
  const original = Object.fromEntries(Object.keys(isolatedEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, isolatedEnv);
  filesystemHome = home;
  const project = join(home, "project");
  const binary = join(home, "bin", "codex");
  mkdirSync(join(project, ".openscout"), { recursive: true });
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, ".codex"));
  // Invalid contents are deliberate: only existence is observed, never auth data.
  writeFileSync(join(home, ".codex", "auth.json"), "not parsed");
  writeFileSync(join(project, ".openscout", "project.json"), JSON.stringify({ version: 1, project: { id: "fixture", name: "Fixture", root: "." } }));
  try {
    await setup.writeOpenScoutSettings({ discovery: { contextRoot: project, workspaceRoots: [project] }, agents: { defaultHarness: "codex" } }, { currentDirectory: project });
    await ensureOpenScoutOnboardingLocalConfig({ currentDirectory: project });
    await saveOpenScoutOnboardingIdentity({ currentDirectory: project, name: "Arach" });
    expect((await loadOpenScoutOnboardingState({ currentDirectory: project })).selectedHarness).toMatchObject({ id: "codex", state: "missing", ready: false });
    writeFileSync(binary, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    const beforeCatalog = seenOptions.length;
    const beforeBroker = brokerReads;
    const completed = await ensureOpenScoutOnboardingCompletion({ currentDirectory: project, now: 42 });
    expect(completed.completedAt).toBe(42);
    expect(seenOptions.length - beforeCatalog).toBe(1);
    expect(brokerReads - beforeBroker).toBe(1);
    const beforeUnavailable = seenOptions.length;
    const beforeUnavailableBroker = brokerReads;
    const unavailable = await loadOpenScoutOnboardingState({ currentDirectory: project, broker: null, catalog: null });
    expect(unavailable.hasReadyRuntime).toBe(false);
    expect(unavailable.brokerReachable).toBe(false);
    expect(seenOptions.length).toBe(beforeUnavailable);
    expect(brokerReads).toBe(beforeUnavailableBroker);
    await setup.writeOpenScoutSettings({ onboarding: { completedAt: null } }, { currentDirectory: project });
    const beforeCommand = seenOptions.length;
    expect((await markOpenScoutOnboardingCommand({ currentDirectory: project, command: "runtimes", now: 43 })).completedAt).toBe(43);
    expect(seenOptions.length - beforeCommand).toBe(1);
    rmSync(binary);
    const fresh = await loadOpenScoutOnboardingState({ currentDirectory: project });
    expect(fresh.selectedHarness).toMatchObject({ id: "codex", state: "missing", ready: false });
    expect(fresh.completedAt).toBe(43); // Returning users remain completed after logout/removal.
    expect(subprocessCalls).toBe(0);
    expect(providerChecks).toBe(0);
  } finally {
    filesystemHome = null;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
}
