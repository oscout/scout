import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const setup = await import("./setup.js");
const catalog = await import("./harness-catalog.js");
const loadLocalCatalog = catalog.loadHarnessCatalogSnapshot;
const seenOptions: Array<{ localOnly?: boolean }> = [];
let providerChecks = 0;
let serviceStarts = 0;
mock.module("./setup.js", () => ({
  ...setup,
  initializeOpenScoutSetup: async () => ({}),
  installScoutSkillToHarnesses: async () => ({}),
  installClaudeStatuslineTool: async () => ({}),
}));
mock.module("./broker-process-manager.js", () => ({
  brokerServiceStatus: async () => ({ reachable: true, brokerUrl: "", health: { ok: true } }),
  startBrokerService: async () => { serviceStarts += 1; throw new Error("Unexpected service start"); },
}));
mock.module("./harness-catalog.js", () => ({
  ...catalog,
  loadHarnessCatalogSnapshot: async (options: { localOnly?: boolean } = {}) => {
    seenOptions.push(options);
    return loadLocalCatalog({
      ...options, env: {}, whichBinary: (binary) => binary === "cursor-agent" ? "/test/bin/cursor-agent" : null,
      requirementExists: () => false,
      runCommand: () => { providerChecks += 1; throw new Error("Unexpected provider/auth status lookup"); },
    });
  },
}));
const { runOpenScoutOnboardingSetup } = await import("./onboarding.js");

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
}
