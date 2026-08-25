import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readManagedInstalls } from "./managed-installs.js";
import { resolveClaudeStatuslineDelegatePath } from "./claude-statusline.js";
import { loadOrCreateStableNodeQualifier } from "./node-identity.js";
import {
  buildRelayAgentInstance,
  clearGitBranchCache,
  initializeOpenScoutSetup,
  installClaudeStatuslineTool,
  installScoutSkillToHarnesses,
  readOpenScoutSettings,
  resolveOpenScoutSetupContextRoot,
  writeOpenScoutSettings,
} from "./setup.js";
import { encodeClaudeProjectsSlug } from "./user-project-hints.js";

const originalHome = process.env.HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalRelayHub = process.env.OPENSCOUT_RELAY_HUB;
const originalSetupCwd = process.env.OPENSCOUT_SETUP_CWD;
const originalSkipUserProjectHints = process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;
const testDirectories = new Set<string>();

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
  if (originalControlHome === undefined) {
    delete process.env.OPENSCOUT_CONTROL_HOME;
  } else {
    process.env.OPENSCOUT_CONTROL_HOME = originalControlHome;
  }
  if (originalRelayHub === undefined) {
    delete process.env.OPENSCOUT_RELAY_HUB;
  } else {
    process.env.OPENSCOUT_RELAY_HUB = originalRelayHub;
  }
  if (originalSetupCwd === undefined) {
    delete process.env.OPENSCOUT_SETUP_CWD;
  } else {
    process.env.OPENSCOUT_SETUP_CWD = originalSetupCwd;
  }
  if (originalSkipUserProjectHints === undefined) {
    delete process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;
  } else {
    process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = originalSkipUserProjectHints;
  }

  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

describe("setup inventory", () => {
  test("configured agent ids use the persisted node qualifier", () => {
    const home = join(tmpdir(), `openscout-stable-node-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const supportDirectory = join(home, "support");
    const projectRoot = join(home, "project");
    testDirectories.add(home);
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    writeFileSync(join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = supportDirectory;

    loadOrCreateStableNodeQualifier("Test-Workstation-372.local", supportDirectory);

    expect(buildRelayAgentInstance("studio", projectRoot)).toMatchObject({
      id: "studio.main.test-workstation-372-local",
      nodeQualifier: "test-workstation-372-local",
    });
  });

  test("reads repository and worktree branches without requiring git probes", () => {
    const home = join(tmpdir(), `openscout-branch-read-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const repoRoot = join(home, "repo");
    const worktreeRoot = join(home, "worktree");
    const worktreeGitDirectory = join(home, "repo-git", "worktrees", "worktree");
    testDirectories.add(home);
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(worktreeGitDirectory, { recursive: true });
    writeFileSync(join(repoRoot, ".git", "HEAD"), "ref: refs/heads/feature/direct-head\n", "utf8");
    writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDirectory}\n`, "utf8");
    writeFileSync(join(worktreeGitDirectory, "HEAD"), "ref: refs/heads/codex/worktree-head\n", "utf8");
    clearGitBranchCache();

    expect(buildRelayAgentInstance("repo-agent", repoRoot)).toMatchObject({
      branch: "feature/direct-head",
      workspaceQualifier: "feature-direct-head",
    });
    expect(buildRelayAgentInstance("worktree-agent", worktreeRoot)).toMatchObject({
      branch: "codex/worktree-head",
      workspaceQualifier: "codex-worktree-head",
    });
  });

  test("reads settings without running the clean-slate migration", async () => {
    const home = join(tmpdir(), `openscout-settings-read-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const supportDirectory = join(home, "Library", "Application Support", "OpenScout");
    const controlHome = join(home, ".openscout", "control-plane");
    const relayHub = join(home, ".openscout", "relay");

    testDirectories.add(home);
    mkdirSync(supportDirectory, { recursive: true });
    mkdirSync(controlHome, { recursive: true });
    mkdirSync(relayHub, { recursive: true });
    writeFileSync(join(controlHome, "keep.txt"), "control\n", "utf8");
    writeFileSync(join(relayHub, "keep.txt"), "relay\n", "utf8");
    writeFileSync(join(supportDirectory, "settings.json"), JSON.stringify({
      version: 1,
      profile: { operatorName: "Existing Operator" },
    }), "utf8");

    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = supportDirectory;
    process.env.OPENSCOUT_CONTROL_HOME = controlHome;
    process.env.OPENSCOUT_RELAY_HUB = relayHub;

    const settings = await readOpenScoutSettings();

    expect(settings.profile.operatorName).toBe("Existing Operator");
    expect(existsSync(join(controlHome, "keep.txt"))).toBe(true);
    expect(existsSync(join(relayHub, "keep.txt"))).toBe(true);
    expect(existsSync(join(supportDirectory, "rpc-runtime-cutover-v1"))).toBe(false);
  });

  test("persists OpenScout Network discovery settings", async () => {
    const home = join(tmpdir(), `openscout-osn-settings-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    testDirectories.add(home);
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
    process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");

    const defaults = await readOpenScoutSettings();
    expect(defaults.network.openScoutNetwork.discoveryEnabled).toBe(false);
    expect(defaults.network.openScoutNetwork.pairingRelayUrl).toBe("wss://mesh.oscout.net/v1/relay");

    const settings = await writeOpenScoutSettings({
      network: {
        openScoutNetwork: {
          discoveryEnabled: true,
          rendezvousUrl: "https://mesh.example.test/",
          keepPairingRelayRunning: false,
        },
      },
    });

    expect(settings.network.openScoutNetwork).toEqual({
      discoveryEnabled: true,
      rendezvousUrl: "https://mesh.example.test",
      pairingRelayUrl: "wss://mesh.oscout.net/v1/relay",
      keepPairingRelayRunning: false,
    });
  });

  test("records installed harness skills in the managed install ledger", async () => {
    const home = join(tmpdir(), `openscout-managed-installs-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    testDirectories.add(home);
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");

    const report = await installScoutSkillToHarnesses();
    expect(report.source).toBeTruthy();

    const installs = await readManagedInstalls();
    const skillInstalls = installs.filter((entry) => entry.name === "scout-skill");
    expect(skillInstalls.map((entry) => entry.harness).filter(Boolean).sort()).toEqual([
      "claude",
      "codex",
      "grok",
      "pi",
    ]);
    expect(
      skillInstalls.some((entry) =>
        entry.metadata?.installTarget === "opencode"
        || entry.targetPath?.includes("/.config/opencode/skills/scout/")
      ),
    ).toBe(true);
    expect(skillInstalls.every((entry) => entry.kind === "skill" && entry.owner === "openscout")).toBe(true);
    expect(skillInstalls.every((entry) => entry.status === "active" && entry.targetPath)).toBe(true);
  });

  test("installs Claude statusline capture and preserves an existing delegate", async () => {
    const home = join(tmpdir(), `openscout-claude-statusline-install-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const settingsPath = join(home, ".claude", "settings.json");

    testDirectories.add(home);
    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: {
        type: "command",
        command: "~/.claude/custom-statusline.sh",
        padding: 2,
        refreshInterval: 30,
      },
    }, null, 2), "utf8");

    const report = await installClaudeStatuslineTool();
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      statusLine: Record<string, unknown>;
    };
    const delegate = JSON.parse(readFileSync(resolveClaudeStatuslineDelegatePath(), "utf8")) as {
      command: string;
      statusLine: Record<string, unknown>;
    };
    const wrapper = readFileSync(report.wrapperPath, "utf8");
    const installs = await readManagedInstalls();
    const statuslineInstall = installs.find((entry) => entry.name === "claude-statusline");

    expect(report.status).toBe("installed");
    expect(settings.statusLine.command).toBe(`'${report.wrapperPath}'`);
    expect(settings.statusLine.padding).toBe(2);
    expect(settings.statusLine.refreshInterval).toBe(30);
    expect(delegate.command).toBe("~/.claude/custom-statusline.sh");
    expect(delegate.statusLine.padding).toBe(2);
    expect(wrapper).toContain("statusline claude --delegate");
    expect(statuslineInstall).toEqual(expect.objectContaining({
      kind: "statusline",
      owner: "openscout",
      status: "active",
      harness: "claude",
    }));
  });

  test("resolves the configured setup context root from persisted settings when no env override is present", async () => {
    const home = join(tmpdir(), `openscout-setup-context-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sourceRoot = join(home, "dev");
    const configuredRoot = join(sourceRoot, "alpha");
    const unrelatedCwd = join(home, "scratch");

    testDirectories.add(home);
    mkdirSync(configuredRoot, { recursive: true });
    mkdirSync(unrelatedCwd, { recursive: true });

    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
    process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
    process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = "1";
    delete process.env.OPENSCOUT_SETUP_CWD;

    await writeOpenScoutSettings({
      discovery: {
        contextRoot: configuredRoot,
        workspaceRoots: [sourceRoot],
        includeCurrentRepo: true,
      },
    }, {
      currentDirectory: configuredRoot,
    });

    expect(resolveOpenScoutSetupContextRoot({ fallbackDirectory: unrelatedCwd })).toBe(configuredRoot);
  });

  test("prefers OPENSCOUT_SETUP_CWD over persisted settings when explicitly provided", async () => {
    const home = join(tmpdir(), `openscout-setup-context-env-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sourceRoot = join(home, "dev");
    const configuredRoot = join(sourceRoot, "alpha");
    const overrideRoot = join(home, "override");

    testDirectories.add(home);
    mkdirSync(configuredRoot, { recursive: true });
    mkdirSync(overrideRoot, { recursive: true });

    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
    process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
    process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = "1";

    await writeOpenScoutSettings({
      discovery: {
        contextRoot: configuredRoot,
        workspaceRoots: [sourceRoot],
        includeCurrentRepo: true,
      },
    }, {
      currentDirectory: configuredRoot,
    });

    process.env.OPENSCOUT_SETUP_CWD = overrideRoot;
    expect(resolveOpenScoutSetupContextRoot()).toBe(overrideRoot);
  });

  test("keeps new Claude project profiles on tmux even with a legacy stream-json default", async () => {
    const home = join(tmpdir(), `openscout-setup-claude-transport-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sourceRoot = join(home, "dev");
    const projectRoot = join(sourceRoot, "legacy-default");

    testDirectories.add(home);
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    writeFileSync(join(projectRoot, "CLAUDE.md"), "# Legacy default\n", "utf8");

    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
    process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
    process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = "1";

    await writeOpenScoutSettings({
      agents: {
        defaultHarness: "claude",
        defaultTransport: "claude_stream_json",
      },
      discovery: {
        workspaceRoots: [sourceRoot],
        includeCurrentRepo: true,
      },
    }, {
      currentDirectory: projectRoot,
    });

    const setup = await initializeOpenScoutSetup({ currentDirectory: projectRoot });
    const manifest = JSON.parse(readFileSync(join(projectRoot, ".openscout", "project.json"), "utf8")) as {
      agent?: {
        runtime?: {
          profiles?: {
            claude?: { transport?: string };
          };
        };
      };
    };

    expect(setup.createdProjectConfig).toBe(true);
    expect(manifest.agent?.runtime?.profiles?.claude?.transport).toBe("tmux");
  });

  test("walks source roots recursively and records harness evidence per project", async () => {
    const home = join(tmpdir(), `openscout-setup-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sourceRoot = join(home, "dev");
    const repoAlpha = join(sourceRoot, "alpha");
    const repoBeta = join(sourceRoot, "group", "beta");
    const repoMono = join(sourceRoot, "mono");
    const nestedPackage = join(repoMono, "packages", "ui");

    testDirectories.add(home);
    mkdirSync(sourceRoot, { recursive: true });

    mkdirSync(join(repoAlpha, ".git"), { recursive: true });
    writeFileSync(join(repoAlpha, "AGENTS.md"), "# Alpha\n", "utf8");
    writeFileSync(join(repoAlpha, "CLAUDE.md"), "# Alpha\n", "utf8");
    mkdirSync(join(repoAlpha, ".codex", "environments"), { recursive: true });
    writeFileSync(
      join(repoAlpha, ".codex", "environments", "environment.toml"),
      [
        "version = 1",
        'name = "Alpha Workspace"',
        "",
        "[setup]",
        'script = "npm install\\nnpm run build"',
        "",
        "[[actions]]",
        'name = "Run"',
        'icon = "play"',
        'command = "npm start"',
        "",
      ].join("\n"),
      "utf8",
    );

    mkdirSync(repoBeta, { recursive: true });
    writeFileSync(join(repoBeta, "AGENTS.md"), "# Beta\n", "utf8");

    mkdirSync(join(repoMono, ".git"), { recursive: true });
    mkdirSync(nestedPackage, { recursive: true });
    writeFileSync(join(nestedPackage, "AGENTS.md"), "# Nested package\n", "utf8");

    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
    process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
    process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = "1";
    mkdirSync(join(home, ".claude", "projects", encodeClaudeProjectsSlug(repoAlpha), "memory"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "projects", encodeClaudeProjectsSlug(repoAlpha), "session.jsonl"),
      `${JSON.stringify({ cwd: join(repoAlpha, "apps", "desktop"), gitBranch: "feature/alpha" })}\n`,
      "utf8",
    );
    writeFileSync(
      join(home, ".claude", "projects", encodeClaudeProjectsSlug(repoAlpha), "memory", "MEMORY.md"),
      "# Alpha memory\n",
      "utf8",
    );

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [sourceRoot],
        includeCurrentRepo: true,
      },
    }, {
      currentDirectory: repoAlpha,
    });

    const setup = await initializeOpenScoutSetup({ currentDirectory: repoAlpha });
    const relativePaths = setup.projectInventory.map((project) => project.relativePath).sort();

    expect(relativePaths).toEqual(["alpha", "group/beta", "mono"]);
    expect(readFileSync(join(repoAlpha, ".gitignore"), "utf8")).toContain(".openscout/project.json");

    const alpha = setup.projectInventory.find((project) => project.relativePath === "alpha");
    expect(alpha?.registrationKind).toBe("configured");
    expect(alpha?.harnesses.map((harness) => harness.harness).sort()).toEqual(["claude", "codex", "grok"]);
    const alphaManifest = JSON.parse(readFileSync(join(repoAlpha, ".openscout", "project.json"), "utf8")) as {
      project: { name: string };
      agent?: {
        runtime?: {
          defaultHarness?: string;
          profiles?: {
            claude?: { transport?: string };
          };
        };
      };
      environment?: {
        setup?: { default?: string };
        actions?: Array<{ name: string; scripts?: { default?: string } }>;
      };
      imports?: {
        codex?: { sourcePath?: string; environment?: { actions?: Array<{ name: string }> } };
        claude?: { sourcePath?: string; memoryPath?: string; gitBranches?: string[] };
      };
    };
    expect(alphaManifest.project.name).toBe("Alpha Workspace");
    expect(alphaManifest.agent?.runtime?.defaultHarness).toBe("claude");
    expect(alphaManifest.agent?.runtime?.profiles?.claude?.transport).toBe("tmux");
    expect(alphaManifest.environment?.setup?.default).toBe("npm install\nnpm run build");
    expect(alphaManifest.environment?.actions?.map((action) => action.name)).toEqual(["Run"]);
    expect(alphaManifest.environment?.actions?.[0]?.scripts?.default).toBe("npm start");
    expect(alphaManifest.imports?.codex?.sourcePath).toBe(join(repoAlpha, ".codex", "environments", "environment.toml"));
    expect(alphaManifest.imports?.codex?.environment?.actions?.map((action) => action.name)).toEqual(["Run"]);
    expect(alphaManifest.imports?.claude?.sourcePath).toBe(join(home, ".claude", "projects", encodeClaudeProjectsSlug(repoAlpha)));
    expect(alphaManifest.imports?.claude?.memoryPath).toBe(
      join(home, ".claude", "projects", encodeClaudeProjectsSlug(repoAlpha), "memory", "MEMORY.md"),
    );
    expect(alphaManifest.imports?.claude?.gitBranches).toEqual(["feature/alpha"]);

    const beta = setup.projectInventory.find((project) => project.relativePath === "group/beta");
    expect(beta?.defaultHarness).toBe("codex");
    expect(beta?.harnesses.map((harness) => harness.harness).sort()).toEqual(["codex", "grok"]);

    const mono = setup.projectInventory.find((project) => project.relativePath === "mono");
    expect(mono).toBeTruthy();
    expect(setup.projectInventory.some((project) => project.relativePath === "mono/packages/ui")).toBe(false);

    await initializeOpenScoutSetup({ currentDirectory: repoAlpha });
    const gitignoreLines = readFileSync(join(repoAlpha, ".gitignore"), "utf8")
      .split(/\r?\n/g)
      .filter((line) => line.trim() === ".openscout/project.json");
    expect(gitignoreLines).toHaveLength(1);
  });

  test("creates a project manifest directly in the explicit Relay context root", async () => {
    const home = join(tmpdir(), `openscout-context-root-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sourceRoot = join(home, "dev");

    testDirectories.add(home);
    mkdirSync(sourceRoot, { recursive: true });

    process.env.HOME = home;
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
    process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
    process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
    process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = "1";

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [sourceRoot],
        includeCurrentRepo: true,
      },
    }, {
      currentDirectory: sourceRoot,
    });

    const setup = await initializeOpenScoutSetup({ currentDirectory: sourceRoot });

    expect(setup.currentProjectConfigPath).toBe(join(sourceRoot, ".openscout", "project.json"));
    const manifest = JSON.parse(readFileSync(join(sourceRoot, ".openscout", "project.json"), "utf8")) as {
      agent?: {
        runtime?: {
          defaultHarness?: string;
          profiles?: {
            claude?: {
              transport?: string;
            };
          };
        };
      };
    };
    expect(manifest.agent?.runtime?.defaultHarness).toBe("claude");
    expect(manifest.agent?.runtime?.profiles?.claude?.transport).toBe("tmux");
    expect(readFileSync(join(sourceRoot, ".gitignore"), "utf8")).toContain(".openscout/project.json");
  });
});
