import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrokerServiceStatus } from "./broker-process-manager.js";
import { loadHarnessCatalogSnapshot, type HarnessCatalogSnapshot } from "./harness-catalog.js";
import {
  ensureOpenScoutOnboardingCompletion,
  ensureOpenScoutOnboardingLocalConfig,
  loadOpenScoutOnboardingState,
  markOpenScoutOnboardingCommand,
  ONBOARDING_HARNESS_CHOICES,
  OnboardingHarnessError,
  parseOnboardingHarness,
  onboardingHarnessObservations,
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

describe("onboarding harness choices", () => {
  // Settings writes take seconds on a cold disk; a timed-out write would leak into the next test.
  const SETTINGS_WRITE_TIMEOUT_MS = 30_000;
  const EXPECTED_TRANSPORTS = {
    claude: "tmux",
    codex: "codex_app_server",
    "grok-acp": "grok_acp",
    kimi: "kimi_acp",
    cursor: "cursor_acp",
    opencode: "opencode_acp",
    pi: "pi_rpc",
    devin: "devin_acp",
  } as const;

  test("the choices are the runtime catalog's enabled, listed, managed harnesses", () => {
    expect([...ONBOARDING_HARNESS_CHOICES]).toEqual(["claude", "codex", "grok-acp", "kimi", "cursor", "opencode", "pi", "devin"]);
  });

  test("parsing keeps supported values, resolves catalog aliases, and rejects the rest", () => {
    for (const id of ONBOARDING_HARNESS_CHOICES) expect(parseOnboardingHarness(id)).toBe(id);
    expect(parseOnboardingHarness(" Kimi ")).toBe("kimi");
    expect(parseOnboardingHarness("grok")).toBe("grok-acp");
    expect(parseOnboardingHarness("flue")).toBeNull();
    expect(parseOnboardingHarness("gpt")).toBeNull();
    expect(parseOnboardingHarness("")).toBeNull();
  });

  for (const [harness, transport] of Object.entries(EXPECTED_TRANSPORTS)) {
    test(`${harness} round-trips through settings with the ${transport} transport`, async () => {
      const home = prepareHome(`roundtrip-${harness}`);
      const repo = join(home, "dev", "alpha");
      mkdirSync(repo, { recursive: true });

      const state = await saveOpenScoutOnboardingProject({
        currentDirectory: repo,
        contextRoot: repo,
        sourceRoots: [repo],
        defaultHarness: harness,
        now: 31,
      });

      const settings = await readOpenScoutSettings({ currentDirectory: repo });
      expect(settings.agents.defaultHarness).toBe(harness);
      expect(settings.agents.defaultTransport).toBe(transport);
      expect(state.defaultHarness).toBe(harness);
    }, SETTINGS_WRITE_TIMEOUT_MS);
  }

  test("an unknown harness is rejected and nothing is written", async () => {
    const home = prepareHome("unknown-harness");
    const repo = join(home, "dev", "alpha");
    mkdirSync(repo, { recursive: true });
    await saveOpenScoutOnboardingProject({ currentDirectory: repo, contextRoot: repo, sourceRoots: [repo], defaultHarness: "kimi", now: 41 });

    await expect(saveOpenScoutOnboardingProject({
      currentDirectory: repo,
      contextRoot: repo,
      sourceRoots: [repo],
      defaultHarness: "flue",
      now: 42,
    })).rejects.toBeInstanceOf(OnboardingHarnessError);

    const settings = await readOpenScoutSettings({ currentDirectory: repo });
    expect(settings.agents.defaultHarness).toBe("kimi");
    expect(settings.agents.defaultTransport).toBe("kimi_acp");
    expect(settings.onboarding.harnessChosenAt).toBe(41);
  }, SETTINGS_WRITE_TIMEOUT_MS);

  test("existing configurations keep their harness and stored transport", async () => {
    const home = prepareHome("legacy-transport");
    const repo = join(home, "dev", "alpha");
    mkdirSync(repo, { recursive: true });
    await writeOpenScoutSettings({
      agents: { defaultHarness: "claude", defaultTransport: "claude_stream_json" },
    }, { currentDirectory: repo });

    await saveOpenScoutOnboardingProject({ currentDirectory: repo, contextRoot: repo, sourceRoots: [repo], now: 51 });

    const settings = await readOpenScoutSettings({ currentDirectory: repo });
    expect(settings.agents.defaultHarness).toBe("claude");
    expect(settings.agents.defaultTransport).toBe("claude_stream_json");
  }, SETTINGS_WRITE_TIMEOUT_MS);

  test("a saved grok-acp or kimi default is no longer read back as Claude", async () => {
    const home = prepareHome("settings-read");
    const repo = join(home, "dev", "alpha");
    mkdirSync(repo, { recursive: true });
    for (const [harness, transport] of [["grok-acp", "grok_acp"], ["kimi", "kimi_acp"], ["devin", "devin_acp"], ["opencode", "opencode_acp"]] as const) {
      // Transport omitted on disk: the read path must derive it from the harness.
      await writeOpenScoutSettings({ agents: { defaultHarness: harness } }, { currentDirectory: repo });
      const settings = await readOpenScoutSettings({ currentDirectory: repo });
      expect(settings.agents.defaultHarness).toBe(harness);
      expect(settings.agents.defaultTransport).toBe(transport);
    }
  }, SETTINGS_WRITE_TIMEOUT_MS);

  async function localSnapshot(home: string, binaries: string[], env: Record<string, string> = {}) {
    return loadHarnessCatalogSnapshot({
      localOnly: true,
      overridePath: join(home, "no-overrides.json"),
      env,
      whichBinary: (binary) => (binaries.includes(binary) ? `/bin/${binary}` : null),
      requirementExists: () => false,
      runCommand: (command) => {
        throw new Error(`setup readiness ran a command: ${command}`);
      },
    });
  }

  test("state exposes the catalog's choices with the readiness the read observed, run locally", async () => {
    const home = prepareHome("observations");
    const catalog = await localSnapshot(home, ["claude", "cursor-agent", "codex"], { ANTHROPIC_API_KEY: "x" });
    const observed = onboardingHarnessObservations(catalog);
    expect(observed.map((option) => option.id)).toEqual([...ONBOARDING_HARNESS_CHOICES]);
    const byId = Object.fromEntries(observed.map((option) => [option.id, option]));
    expect(byId.claude).toMatchObject({ label: "Claude Code", state: "ready", ready: true });
    // Installed, but sign-in is only knowable by asking Cursor: unverified, not ready.
    expect(byId.cursor).toMatchObject({ state: "configured", ready: false });
    expect(byId.codex).toMatchObject({ state: "installed", ready: false });
    expect(byId.kimi).toMatchObject({ state: "missing", ready: false });

    const state = await loadOpenScoutOnboardingState({ currentDirectory: home, broker: fakeBroker(false), catalog });
    expect(state.harnesses).toEqual(observed);
  });

  test("a logged-out Cursor-only Mac never completes setup from the binary alone", async () => {
    const home = prepareHome("cursor-only");
    const repo = join(home, "dev", "alpha");
    mkdirSync(repo, { recursive: true });
    writeProjectConfig(repo);
    await ensureOpenScoutOnboardingLocalConfig({ currentDirectory: repo, now: 10 });
    await saveOpenScoutOnboardingIdentity({ currentDirectory: repo, name: "Ada", now: 11 });
    const catalog = await localSnapshot(home, ["cursor-agent"]);

    // The canonical GET path (`/api/onboarding/state`) and the runtimes command.
    const polled = await ensureOpenScoutOnboardingCompletion({ currentDirectory: repo, broker: fakeBroker(true), catalog, now: 12 });
    expect(polled.hasLocalConfig && polled.hasOperatorName && polled.hasProjectConfig && polled.brokerReachable).toBe(true);
    expect(polled.hasReadyRuntime).toBe(false);
    expect(polled.readyRuntimeCount).toBe(0);
    expect(polled.completedAt).toBeNull();
    expect(polled.needed).toBe(true);
    expect(polled.harnesses?.find((option) => option.id === "cursor")).toMatchObject({ state: "configured", ready: false });

    const marked = await markOpenScoutOnboardingCommand({ command: "runtimes", currentDirectory: repo, broker: fakeBroker(true), catalog, now: 13 });
    expect(marked.completedAt).toBeNull();
    expect((await readOpenScoutSettings({ currentDirectory: repo })).onboarding.completedAt).toBeNull();

    // A runtime with real local evidence does complete it.
    const withClaude = await localSnapshot(home, ["cursor-agent", "claude"], { ANTHROPIC_API_KEY: "x" });
    const done = await ensureOpenScoutOnboardingCompletion({ currentDirectory: repo, broker: fakeBroker(true), catalog: withClaude, now: 14 });
    expect(done.completedAt).toBe(14);
  }, SETTINGS_WRITE_TIMEOUT_MS);
});
