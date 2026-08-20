import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadResolvedRelayAgents, writeOpenScoutSettings, type OpenScoutProjectConfig } from "./setup.js";

const originalHome = process.env.HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalRelayHub = process.env.OPENSCOUT_RELAY_HUB;
const originalNodeQualifier = process.env.OPENSCOUT_NODE_QUALIFIER;
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
  if (originalNodeQualifier === undefined) {
    delete process.env.OPENSCOUT_NODE_QUALIFIER;
  } else {
    process.env.OPENSCOUT_NODE_QUALIFIER = originalNodeQualifier;
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

function useIsolatedOpenScoutHome(): string {
  const home = join(tmpdir(), `openscout-lrra-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  testDirectories.add(home);
  process.env.HOME = home;
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
  process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
  process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
  process.env.OPENSCOUT_NODE_QUALIFIER = "test-node";
  process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = "1";
  return home;
}

/**
 * On-disk fixtures mirror common ~/dev layouts: sibling git repos, nested groups,
 * markdown "agent" markers, nested packages inside git monorepos, optional OpenScout
 * manifests, and non-project trees (package.json-only) that should not register.
 */
function writeProjectManifest(projectRoot: string, config: OpenScoutProjectConfig): void {
  const dir = join(projectRoot, ".openscout");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "project.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

describe("loadResolvedRelayAgents (dev-like fixtures)", () => {
  test("suffixes inferred reserved names, quarantines sibling offenders, and rejects the targeted offender", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const inferred = join(dev, "codex");
    const stored = join(dev, "stored");
    mkdirSync(join(inferred, ".git"), { recursive: true });
    writeFileSync(join(inferred, "AGENTS.md"), "# codex\n", "utf8");
    mkdirSync(join(stored, ".git"), { recursive: true });
    writeProjectManifest(stored, {
      version: 1,
      project: { id: "stored", name: "Stored" },
      agent: {
        id: "codex",
        displayName: "Legacy Codex",
        runtime: { defaultHarness: "codex" },
      },
    });
    await writeOpenScoutSettings({
      discovery: { workspaceRoots: [dev], includeCurrentRepo: false },
    });

    const quarantined = await loadResolvedRelayAgents();
    expect(quarantined.discoveredAgents.map((agent) => agent.definitionId)).toEqual(["codex-agent"]);
    expect(quarantined.projectErrors).toEqual([
      expect.objectContaining({
        code: "reserved_name_existing",
        projectRoot: stored,
        message: expect.stringContaining('reserved agent name "codex"'),
      }),
    ]);
    await expect(loadResolvedRelayAgents({ currentDirectory: stored })).rejects.toThrow("reserved_name_existing");

    rmSync(stored, { recursive: true, force: true });
    const setup = await loadResolvedRelayAgents();
    expect(setup.discoveredAgents[0]?.definitionId).toBe("codex-agent");
  });

  test("discovers sibling repos: git boundaries, grouped markdown project, mono root and nested package", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const swiftTool = join(dev, "swift-tool");
    // Not named `vendor` — setup skips that directory when walking workspaces (dependency trees).
    const grouped = join(dev, "third_party", "patch-lib");
    const mono = join(dev, "ts-monorepo");
    const nestedUi = join(mono, "packages", "ui");

    mkdirSync(join(swiftTool, ".git"), { recursive: true });
    writeFileSync(join(swiftTool, "Package.swift"), "// swift\n", "utf8");

    mkdirSync(grouped, { recursive: true });
    writeFileSync(join(grouped, "AGENTS.md"), "# patch-lib\n", "utf8");

    mkdirSync(join(mono, ".git"), { recursive: true });
    mkdirSync(nestedUi, { recursive: true });
    writeFileSync(join(nestedUi, "package.json"), "{}\n", "utf8");
    writeFileSync(join(nestedUi, "CLAUDE.md"), "# ui package\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: false,
      },
    });

    const setup = await loadResolvedRelayAgents();

    const paths = setup.projectInventory.map((p) => p.relativePath).sort();
    expect(paths).toEqual(["swift-tool", "third_party/patch-lib", "ts-monorepo"]);

    const patch = setup.projectInventory.find((p) => p.relativePath === "third_party/patch-lib");
    expect(patch?.source).toBe("inferred");
    expect(patch?.registrationKind).toBe("discovered");
    expect(patch?.defaultHarness).toBe("codex");
    expect(patch?.harnesses.map((h) => h.harness).sort()).toEqual(["codex", "grok"]);

    expect(setup.projectInventory.some((p) => p.relativePath === "ts-monorepo/packages/ui")).toBe(false);
  });

  test("dedupes inventory when two paths resolve to the same directory", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const realRepo = join(home, "actual", "real-app");
    const linkA = join(dev, "w1", "link");
    const linkB = join(dev, "w2", "link");

    mkdirSync(join(realRepo, ".git"), { recursive: true });
    writeFileSync(join(realRepo, "AGENTS.md"), "# same\n", "utf8");
    mkdirSync(join(dev, "w1"), { recursive: true });
    mkdirSync(join(dev, "w2"), { recursive: true });
    symlinkSync(realRepo, linkA);
    symlinkSync(realRepo, linkB);

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: false,
      },
    });

    const setup = await loadResolvedRelayAgents();
    expect(setup.projectInventory).toHaveLength(1);
    const only = setup.projectInventory[0];
    expect([linkA, linkB]).toContain(only.projectRoot);
  });

  test("merges multiple workspace roots (e.g. ~/dev and ~/oss)", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const oss = join(home, "oss");
    const alpha = join(dev, "alpha");
    const beta = join(oss, "beta");

    mkdirSync(join(alpha, ".git"), { recursive: true });
    writeFileSync(join(alpha, "CLAUDE.md"), "# a\n", "utf8");
    mkdirSync(join(beta, ".git"), { recursive: true });
    writeFileSync(join(beta, "AGENTS.md"), "# b\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev, oss],
        includeCurrentRepo: false,
      },
    });

    const setup = await loadResolvedRelayAgents();
    const byRoot = new Map(setup.projectInventory.map((p) => [p.projectRoot, p]));

    expect(byRoot.get(alpha)?.relativePath).toBe("alpha");
    expect(byRoot.get(alpha)?.sourceRoot).toBe(dev);
    expect(byRoot.get(beta)?.relativePath).toBe("beta");
    expect(byRoot.get(beta)?.sourceRoot).toBe(oss);
  });

  test("discovers repos that only expose auxiliary agent markers (cursor, codex doc)", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const cursorApp = join(dev, "cursor-app");
    const codexDoc = join(dev, "codex-readme");

    mkdirSync(join(cursorApp, ".git"), { recursive: true });
    writeFileSync(join(cursorApp, ".cursorrules"), "# cursor\n", "utf8");

    mkdirSync(join(codexDoc, ".git"), { recursive: true });
    writeFileSync(join(codexDoc, "CODEX.md"), "# codex\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: false,
      },
    });

    const setup = await loadResolvedRelayAgents();
    const paths = setup.projectInventory.map((p) => p.relativePath).sort();
    expect(paths).toEqual(["codex-readme", "cursor-app"]);

    const codexRow = setup.projectInventory.find((p) => p.relativePath === "codex-readme");
    expect(codexRow?.harnesses.map((h) => h.harness)).toContain("codex");
    expect(codexRow?.defaultHarness).toBe("codex");
  });

  test("follows symlinked project directories under a workspace root", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const realRepo = join(home, "actual", "real-app");
    const linkPath = join(dev, "linked-app");

    mkdirSync(join(realRepo, ".git"), { recursive: true });
    writeFileSync(join(realRepo, "CLAUDE.md"), "# linked\n", "utf8");
    mkdirSync(dev, { recursive: true });
    symlinkSync(realRepo, linkPath);

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: false,
      },
    });

    const setup = await loadResolvedRelayAgents();
    const linked = setup.projectInventory.find((p) => p.projectRoot === linkPath);
    expect(linked?.relativePath).toBe("linked-app");
    expect(setup.projectInventory.filter((p) => p.displayName.toLowerCase().includes("real")).length).toBeLessThanOrEqual(1);
  });

  test("discovers Go module roots without AI marker files", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const svc = join(dev, "api");

    mkdirSync(svc, { recursive: true });
    writeFileSync(join(svc, "go.mod"), "module example.com/api\n\ngo 1.22\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: false,
      },
    });

    const setup = await loadResolvedRelayAgents();
    expect(setup.projectInventory.map((p) => p.relativePath).sort()).toEqual(["api"]);
  });

  test("does not list package.json-only trees without strong/weak markers", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const orphan = join(dev, "orphan-npm-pkg");

    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "package.json"), '{"name":"orphan"}\n', "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: false,
      },
    });

    const setup = await loadResolvedRelayAgents();
    expect(setup.projectInventory).toEqual([]);
  });

  test("manifest-only project: configured registration and manifest defaultHarness", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const svc = join(dev, "api-service");

    mkdirSync(svc, { recursive: true });
    writeProjectManifest(svc, {
      version: 1,
      project: { id: "api-service", name: "API Service" },
      agent: {
        id: "api-service",
        displayName: "API Service Agent",
        runtime: {
          defaultHarness: "codex",
          profiles: {
            codex: {
              cwd: ".",
              transport: "codex_app_server",
              sessionId: "api-codex",
              launchArgs: [],
            },
          },
        },
      },
    });

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: false,
      },
    });

    const setup = await loadResolvedRelayAgents();
    expect(setup.projectInventory).toHaveLength(1);

    const row = setup.projectInventory[0];
    expect(row.relativePath).toBe("api-service");
    expect(row.definitionId).toBe("api-service");
    expect(row.displayName).toBe("API Service Agent");
    expect(row.source).toBe("manifest");
    expect(row.registrationKind).toBe("configured");
    expect(row.defaultHarness).toBe("codex");
    expect(row.harnesses.some((h) => h.harness === "codex" && h.source === "manifest")).toBe(true);
  });

  test("manifest identity replaces a stale same-manifest registry override", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const svc = join(dev, "openscout");
    const manifestPath = join(svc, ".openscout", "project.json");

    mkdirSync(svc, { recursive: true });
    writeProjectManifest(svc, {
      version: 1,
      project: { id: "openscout", name: "OpenScout" },
      agent: {
        id: "ranger",
        displayName: "Ranger",
        runtime: {
          defaultHarness: "codex",
          profiles: {
            codex: {
              cwd: ".",
              transport: "codex_app_server",
              sessionId: "relay-ranger-codex",
              launchArgs: ["-c", "model=\"gpt-5.4\""],
            },
          },
        },
      },
    });

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: false,
      },
    });

    const supportDir = process.env.OPENSCOUT_SUPPORT_DIRECTORY!;
    mkdirSync(supportDir, { recursive: true });
    writeFileSync(
      join(supportDir, "relay-agents.json"),
      `${JSON.stringify({
        version: 1,
        agents: {
          "openscout.test-node": {
            agentId: "openscout.test-node",
            definitionId: "openscout",
            displayName: "Openscout",
            projectName: "OpenScout",
            projectRoot: svc,
            projectConfigPath: manifestPath,
            source: "manual",
            startedAt: 1,
            defaultHarness: "claude",
            harnessProfiles: {
              claude: {
                cwd: svc,
                transport: "claude_stream_json",
                sessionId: "relay-openscout-claude",
                launchArgs: [],
              },
            },
            runtime: {
              cwd: svc,
              harness: "claude",
              transport: "claude_stream_json",
              sessionId: "relay-openscout-claude",
              wakePolicy: "on_demand",
            },
          },
          "ranger-codex.test-node": {
            agentId: "ranger-codex.test-node",
            definitionId: "ranger-codex",
            displayName: "Ranger Codex",
            projectName: "OpenScout",
            projectRoot: svc,
            source: "manual",
            startedAt: 1,
            defaultHarness: "codex",
            harnessProfiles: {
              codex: {
                cwd: svc,
                transport: "codex_app_server",
                sessionId: "relay-ranger-codex-companion",
                launchArgs: [],
              },
            },
            runtime: {
              cwd: svc,
              harness: "codex",
              transport: "codex_app_server",
              sessionId: "relay-ranger-codex-companion",
              wakePolicy: "on_demand",
            },
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const setup = await loadResolvedRelayAgents();
    expect(setup.agents.map((agent) => agent.definitionId)).toEqual(["ranger"]);
    expect(setup.agents[0]?.displayName).toBe("Ranger");
    expect(setup.agents[0]?.defaultHarness).toBe("codex");

    const registry = JSON.parse(readFileSync(join(supportDir, "relay-agents.json"), "utf8")) as {
      agents: Record<string, { definitionId?: string }>;
    };
    expect(Object.values(registry.agents).map((agent) => agent.definitionId).sort()).toEqual([
      "ranger",
      "ranger-codex",
    ]);
  });

  test("preserves a manually forked project-default agent that is not manifest-owned", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const svc = join(dev, "openscout");
    const manifestPath = join(svc, ".openscout", "project.json");

    mkdirSync(svc, { recursive: true });
    writeProjectManifest(svc, {
      version: 1,
      project: { id: "openscout", name: "OpenScout" },
      agent: {
        id: "ranger",
        displayName: "Ranger",
        runtime: {
          defaultHarness: "codex",
          profiles: {
            codex: {
              cwd: ".",
              transport: "codex_app_server",
              sessionId: "relay-ranger-codex",
              launchArgs: ["-c", "model=\"gpt-5.4\""],
            },
          },
        },
      },
    });

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: false,
      },
    });

    const supportDir = process.env.OPENSCOUT_SUPPORT_DIRECTORY!;
    mkdirSync(supportDir, { recursive: true });
    writeFileSync(
      join(supportDir, "relay-agents.json"),
      `${JSON.stringify({
        version: 1,
        agents: {
          "openscout.test-node": {
            agentId: "openscout.test-node",
            definitionId: "openscout",
            displayName: "OpenScout",
            projectName: "OpenScout",
            projectRoot: svc,
            projectConfigPath: null,
            source: "manual",
            startedAt: 2,
            defaultHarness: "codex",
            harnessProfiles: {
              codex: {
                cwd: svc,
                transport: "codex_app_server",
                sessionId: "relay-openscout-codex",
                launchArgs: ["-c", "model=\"gpt-5.4\""],
              },
            },
            runtime: {
              cwd: svc,
              harness: "codex",
              transport: "codex_app_server",
              sessionId: "relay-openscout-codex",
              wakePolicy: "on_demand",
            },
          },
          "ranger.test-node": {
            agentId: "ranger.test-node",
            definitionId: "ranger",
            displayName: "Ranger",
            projectName: "OpenScout",
            projectRoot: svc,
            projectConfigPath: manifestPath,
            source: "manifest",
            startedAt: 1,
            defaultHarness: "codex",
            harnessProfiles: {
              codex: {
                cwd: svc,
                transport: "codex_app_server",
                sessionId: "relay-ranger-codex",
                launchArgs: ["-c", "model=\"gpt-5.4\""],
              },
            },
            runtime: {
              cwd: svc,
              harness: "codex",
              transport: "codex_app_server",
              sessionId: "relay-ranger-codex",
              wakePolicy: "on_demand",
            },
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const setup = await loadResolvedRelayAgents();
    expect(setup.agents.map((agent) => agent.definitionId)).toEqual(["ranger"]);

    const registry = JSON.parse(readFileSync(join(supportDir, "relay-agents.json"), "utf8")) as {
      agents: Record<string, { definitionId?: string; projectConfigPath?: string | null }>;
    };
    expect(Object.values(registry.agents).map((agent) => agent.definitionId).sort()).toEqual([
      "openscout",
      "ranger",
    ]);
    expect(registry.agents["openscout.test-node"]?.projectConfigPath).toBeNull();
  });

  test("resolves relative runtime cwd against the project root and collapses same-id agents across repos", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const alpha = join(dev, "amplink");
    const beta = join(dev, "plexus");

    mkdirSync(alpha, { recursive: true });
    mkdirSync(beta, { recursive: true });
    execFileSync("git", ["init", "--initial-branch=master", alpha], { stdio: "ignore" });
    execFileSync("git", ["init", "--initial-branch=master", beta], { stdio: "ignore" });

    for (const projectRoot of [alpha, beta]) {
      writeProjectManifest(projectRoot, {
        version: 1,
        project: { id: "amplink", name: "Amplink" },
        agent: {
          id: "amplink",
          displayName: "Amplink",
          runtime: {
            profiles: {
              codex: {
                cwd: ".",
                transport: "codex_app_server",
                sessionId: "relay-amplink",
                launchArgs: [],
              },
            },
          },
        },
      });
    }

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: false,
      },
    });

    const setup = await loadResolvedRelayAgents();
    const agents = setup.agents.filter((agent) => agent.definitionId === "amplink");

    // Two repos with the same definitionId on the same branch collapse into a
    // single FQN (no path fingerprint). One wins deterministically via the
    // dedupe rank; downstream consumers see exactly one owner.
    expect(agents).toHaveLength(1);
    const [agent] = agents;
    expect(agent.instance.workspaceQualifier).toBe("master");
    expect(agent.agentId).toContain(".master.");
    expect(agent.agentId.endsWith(".test-node")).toBe(true);
    expect(agent.runtime.cwd).toBe(agent.projectRoot);
    expect([alpha, beta]).toContain(agent.projectRoot);
  });

  test("includeCurrentRepo adds cwd project when it is outside workspaceRoots", async () => {
    const home = useIsolatedOpenScoutHome();
    const dev = join(home, "dev");
    const scanned = join(dev, "in-workspace");
    const outside = join(home, "scratch", "side-project");

    mkdirSync(join(scanned, ".git"), { recursive: true });
    writeFileSync(join(scanned, "CLAUDE.md"), "# in\n", "utf8");

    mkdirSync(join(outside, ".git"), { recursive: true });
    writeFileSync(join(outside, "AGENTS.md"), "# side\n", "utf8");

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: true,
      },
    });

    const withExtra = await loadResolvedRelayAgents({ currentDirectory: outside });
    const paths = withExtra.projectInventory.map((p) => p.relativePath).sort();
    expect(paths).toContain("in-workspace");
    expect(withExtra.projectInventory.some((p) => p.projectRoot === outside)).toBe(true);

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [dev],
        includeCurrentRepo: false,
      },
    });

    const withoutExtra = await loadResolvedRelayAgents({ currentDirectory: outside });
    expect(withoutExtra.projectInventory.map((p) => p.projectRoot)).toEqual([scanned]);
  });
});
