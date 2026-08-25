import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrokerServiceStatus } from "./broker-process-manager.js";
import type { HarnessCatalogSnapshot } from "./harness-catalog.js";
import {
  ensureOpenScoutOnboardingLocalConfig,
  loadOpenScoutOnboardingState,
  markOpenScoutOnboardingCommand,
  saveOpenScoutOnboardingIdentity,
  saveOpenScoutOnboardingProject,
} from "./onboarding.js";
import { DEFAULT_OPERATOR_NAME, readOpenScoutSettings, writeOpenScoutSettings } from "./setup.js";
import { resolveOpenScoutSupportPaths } from "./support-paths.js";
import { loadUserConfig } from "./user-config.js";

const originalEnv = {
  HOME: process.env.HOME,
  OPENSCOUT_HOME: process.env.OPENSCOUT_HOME,
  OPENSCOUT_SUPPORT_DIRECTORY: process.env.OPENSCOUT_SUPPORT_DIRECTORY,
  OPENSCOUT_CONTROL_HOME: process.env.OPENSCOUT_CONTROL_HOME,
  OPENSCOUT_RELAY_HUB: process.env.OPENSCOUT_RELAY_HUB,
  OPENSCOUT_SKIP_USER_PROJECT_HINTS: process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS,
};

const testDirectories = new Set<string>();

function restoreEnvKey(key: keyof typeof originalEnv): void {
  const value = originalEnv[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of Object.keys(originalEnv) as Array<keyof typeof originalEnv>) {
    restoreEnvKey(key);
  }
  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

function prepareHome(name: string): string {
  const home = join(tmpdir(), `openscout-onboarding-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  testDirectories.add(home);
  process.env.HOME = home;
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
  process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
  process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
  process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = "1";
  const settingsPath = resolveOpenScoutSupportPaths().settingsPath;
  if (!settingsPath.startsWith(home)) {
    throw new Error(`Test isolation failed: settings would write to ${settingsPath}`);
  }
  return home;
}

function writeProjectConfig(projectRoot: string): void {
  mkdirSync(join(projectRoot, ".openscout"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".openscout", "project.json"),
    JSON.stringify({
      version: 1,
      project: { id: "alpha", name: "Alpha", root: "." },
    }, null, 2),
    "utf8",
  );
}

function fakeBroker(reachable: boolean): BrokerServiceStatus {
  return {
    label: "test",
    mode: "dev",
    launchAgentPath: "/tmp/test.plist",
    bootoutCommand: "launchctl bootout test",
    brokerUrl: "http://127.0.0.1:43110/",
    brokerSocketPath: "/tmp/test.sock",
    supportDirectory: "/tmp/support",
    runtimeDirectory: "/tmp/runtime",
    controlHome: "/tmp/control",
    stdoutLogPath: "/tmp/stdout.log",
    stderrLogPath: "/tmp/stderr.log",
    installed: reachable,
    loaded: reachable,
    pid: reachable ? 123 : null,
    launchdState: null,
    lastExitStatus: null,
    usesLaunchAgent: reachable,
    reachable,
    health: {
      reachable,
      ok: reachable,
      checkedAt: 1,
    },
    lastLogLine: null,
  };
}

function fakeCatalog(ready: boolean): HarnessCatalogSnapshot {
  return {
    version: 1,
    generatedAt: 1,
    entries: ready
      ? [
          {
            name: "claude",
            harness: "claude",
            label: "Claude Code",
            description: "test",
            tags: [],
            support: {
              install: true,
              workspace: true,
              collaboration: true,
              browser: false,
              files: false,
              tunnels: false,
              onboarding: true,
            },
            capabilities: ["chat"],
            source: "builtin",
            readinessReport: {
              state: "ready",
              installed: true,
              configured: true,
              ready: true,
              detail: "ready",
              missing: [],
              binaryPath: "/usr/bin/claude",
              loginCommand: null,
            },
          },
        ]
      : [],
  };
}

describe("OpenScout onboarding contract", () => {
  test("does not count a plain repo root as project config", async () => {
    const home = prepareHome("project-config");
    const repo = join(home, "dev", "alpha");
    mkdirSync(join(repo, ".git"), { recursive: true });

    const withoutConfig = await loadOpenScoutOnboardingState({
      currentDirectory: repo,
      broker: fakeBroker(false),
      catalog: fakeCatalog(false),
    });
    expect(withoutConfig.hasProjectConfig).toBe(false);
    expect(withoutConfig.projectConfigPath).toBeNull();

    writeProjectConfig(repo);
    const withConfig = await loadOpenScoutOnboardingState({
      currentDirectory: repo,
      broker: fakeBroker(false),
      catalog: fakeCatalog(false),
    });
    expect(withConfig.hasProjectConfig).toBe(true);
    expect(withConfig.projectConfigPath).toBe(join(repo, ".openscout", "project.json"));
  });

  test("saving identity updates user config and shared settings", async () => {
    const home = prepareHome("identity");
    const repo = join(home, "dev", "alpha");
    mkdirSync(repo, { recursive: true });

    const state = await saveOpenScoutOnboardingIdentity({
      currentDirectory: repo,
      name: "Ada Lovelace",
      now: 42,
    });

    expect(state.hasOperatorName).toBe(true);
    expect(state.operatorName).toBe("Ada Lovelace");
    expect(loadUserConfig().name).toBe("Ada Lovelace");
    const settings = await readOpenScoutSettings({ currentDirectory: repo });
    expect(settings.profile.operatorName).toBe("Ada Lovelace");
    expect(settings.onboarding.operatorAnsweredAt).toBe(42);
  });

  test("accepted suggested operator name is shown after answering", async () => {
    const home = prepareHome("accepted-suggested-identity");
    const repo = join(home, "dev", "alpha");
    mkdirSync(repo, { recursive: true });
    await writeOpenScoutSettings({
      profile: {
        operatorName: DEFAULT_OPERATOR_NAME,
      },
      onboarding: {
        operatorAnsweredAt: 42,
      },
    }, {
      currentDirectory: repo,
    });

    const state = await loadOpenScoutOnboardingState({
      currentDirectory: repo,
      broker: fakeBroker(false),
      catalog: fakeCatalog(false),
    });

    expect(state.hasOperatorName).toBe(true);
    expect(state.operatorName).toBe(DEFAULT_OPERATOR_NAME);
    expect(state.operatorNameSource).toBe("settings");
  });

  test("environment operator name counts as explicit CLI identity", async () => {
    const home = prepareHome("env-identity");
    const repo = join(home, "dev", "alpha");
    mkdirSync(repo, { recursive: true });
    process.env.OPENSCOUT_OPERATOR_NAME = "Env Ada";
    await writeOpenScoutSettings({
      profile: {
        operatorName: "Settings Ada",
      },
    }, {
      currentDirectory: repo,
    });

    const state = await loadOpenScoutOnboardingState({
      currentDirectory: repo,
      broker: fakeBroker(false),
      catalog: fakeCatalog(false),
    });

    expect(state.hasOperatorName).toBe(true);
    expect(state.operatorName).toBe("Env Ada");
    expect(state.operatorNameSource).toBe("env");
  });

  test("saving a Codex project keeps the Codex transport", async () => {
    const home = prepareHome("codex-transport");
    const repo = join(home, "dev", "alpha");
    mkdirSync(repo, { recursive: true });

    await saveOpenScoutOnboardingProject({
      currentDirectory: repo,
      contextRoot: repo,
      sourceRoots: [join(home, "dev")],
      defaultHarness: "codex",
      now: 17,
    });

    const settings = await readOpenScoutSettings({ currentDirectory: repo });
    expect(settings.agents.defaultHarness).toBe("codex");
    expect(settings.agents.defaultTransport).toBe("codex_app_server");
  });

  test("saving project roots without a harness preserves the current default harness", async () => {
    const home = prepareHome("preserve-harness");
    const repo = join(home, "dev", "alpha");
    mkdirSync(repo, { recursive: true });

    await saveOpenScoutOnboardingProject({
      currentDirectory: repo,
      contextRoot: repo,
      sourceRoots: [join(home, "dev")],
      defaultHarness: "codex",
      now: 21,
    });
    await saveOpenScoutOnboardingProject({
      currentDirectory: repo,
      contextRoot: repo,
      sourceRoots: [repo],
      now: 22,
    });

    const settings = await readOpenScoutSettings({ currentDirectory: repo });
    expect(settings.agents.defaultHarness).toBe("codex");
    expect(settings.agents.defaultTransport).toBe("codex_app_server");
    expect(settings.discovery.workspaceRoots).toEqual([repo]);
  });

  test("changing only the harness keeps the configured project roots", async () => {
    const home = prepareHome("harness-only-rerun");
    const repo = join(home, "dev", "alpha");
    const oss = join(home, "oss");
    mkdirSync(repo, { recursive: true });
    mkdirSync(oss, { recursive: true });

    await saveOpenScoutOnboardingProject({
      currentDirectory: repo,
      contextRoot: repo,
      sourceRoots: [join(home, "dev"), oss],
      defaultHarness: "codex",
      now: 31,
    });

    // `scout setup --default-harness claude` with no --source-root: the CLI
    // resolves roots to [] because they are already configured. That must not
    // read as "clear them" — the read path would then re-seed a plausible
    // default and the curated list would vanish with no error.
    await saveOpenScoutOnboardingProject({
      currentDirectory: repo,
      contextRoot: repo,
      sourceRoots: [],
      defaultHarness: "claude",
      now: 32,
    });

    const settings = await readOpenScoutSettings({ currentDirectory: repo });
    expect(settings.discovery.workspaceRoots).toEqual([join(home, "dev"), oss]);
    expect(settings.agents.defaultHarness).toBe("claude");
    // The operator answered at 31 and was never re-asked; keep the answer so
    // setup does not re-arm its first-run project-root prompt.
    expect(settings.onboarding.sourceRootsAnsweredAt).toBe(31);
  });

  test("runtimes command completes only when a runtime is ready", async () => {
    const home = prepareHome("runtime-complete");
    const repo = join(home, "dev", "alpha");
    mkdirSync(repo, { recursive: true });
    writeProjectConfig(repo);
    await ensureOpenScoutOnboardingLocalConfig({ currentDirectory: repo, now: 10 });
    await saveOpenScoutOnboardingIdentity({ currentDirectory: repo, name: "Ada", now: 11 });

    const missing = await markOpenScoutOnboardingCommand({
      command: "runtimes",
      currentDirectory: repo,
      broker: fakeBroker(true),
      catalog: fakeCatalog(false),
      now: 12,
    });
    expect(missing.completedAt).toBeNull();
    expect(missing.hasReadyRuntime).toBe(false);

    const ready = await markOpenScoutOnboardingCommand({
      command: "runtimes",
      currentDirectory: repo,
      broker: fakeBroker(true),
      catalog: fakeCatalog(true),
      now: 13,
    });
    expect(ready.completedAt).toBe(13);
    expect(ready.hasReadyRuntime).toBe(true);
  });
});
