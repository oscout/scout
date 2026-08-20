import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getLocalAgentConfig,
  inferLocalAgentBinding,
  listLocalAgents,
  loadRegisteredLocalAgentBindings,
  pruneOneTimeLocalAgentCards,
  retireLocalAgent,
  retireConsumedOneTimeLocalAgentCards,
  resolveLocalAgentByName,
  resolveLocalAgentIdentity,
  startLocalAgent,
  updateLocalAgentCard,
  updateLocalAgentConfig,
} from "./local-agents.js";
import {
  buildRelayAgentInstance,
  readRelayAgentOverrides,
  writeOpenScoutSettings,
  writeRelayAgentOverrides,
  type OpenScoutProjectConfig,
} from "./setup.js";
import { configuredOperatorActorIds } from "./conversations/legacy-ids.js";

const originalHome = process.env.HOME;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const originalControlHome = process.env.OPENSCOUT_CONTROL_HOME;
const originalRelayHub = process.env.OPENSCOUT_RELAY_HUB;
const originalNodeQualifier = process.env.OPENSCOUT_NODE_QUALIFIER;
const originalSkipUserProjectHints = process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS;
const originalOpenScoutHome = process.env.OPENSCOUT_HOME;
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
  if (originalOpenScoutHome === undefined) {
    delete process.env.OPENSCOUT_HOME;
  } else {
    process.env.OPENSCOUT_HOME = originalOpenScoutHome;
  }

  for (const directory of testDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  testDirectories.clear();
});

function useIsolatedOpenScoutHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openscout-local-agents-"));
  testDirectories.add(home);
  process.env.HOME = home;
  process.env.OPENSCOUT_SUPPORT_DIRECTORY = join(home, "Library", "Application Support", "OpenScout");
  process.env.OPENSCOUT_CONTROL_HOME = join(home, ".openscout", "control-plane");
  process.env.OPENSCOUT_HOME = join(home, ".openscout");
  process.env.OPENSCOUT_RELAY_HUB = join(home, ".openscout", "relay");
  process.env.OPENSCOUT_NODE_QUALIFIER = "test-node";
  process.env.OPENSCOUT_SKIP_USER_PROJECT_HINTS = "1";
  return home;
}

function writeProjectManifest(projectRoot: string, config: OpenScoutProjectConfig): void {
  const manifestDir = join(projectRoot, ".openscout");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "project.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

describe("local agent lifecycle", () => {
  test("loads agents from the relay-agent file and resolves bindings from disk", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const alphaRoot = join(workspaceRoot, "alpha");
    const betaRoot = join(workspaceRoot, "beta");

    mkdirSync(alphaRoot, { recursive: true });
    mkdirSync(betaRoot, { recursive: true });

    await writeOpenScoutSettings({
      discovery: {
        workspaceRoots: [workspaceRoot],
        includeCurrentRepo: false,
      },
    });

    await writeRelayAgentOverrides({
      alpha: {
        agentId: "alpha",
        definitionId: "alpha",
        displayName: "Alpha Agent",
        projectName: "Alpha",
        projectRoot: alphaRoot,
        source: "manual",
        runtime: {
          cwd: alphaRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "alpha-codex",
          wakePolicy: "on_demand",
        },
      },
      beta: {
        agentId: "beta",
        definitionId: "beta",
        displayName: "Beta Agent",
        projectName: "Beta",
        projectRoot: betaRoot,
        source: "manual",
        runtime: {
          cwd: betaRoot,
          harness: "claude",
          transport: "claude_stream_json",
          sessionId: "beta-claude",
          wakePolicy: "on_demand",
        },
      },
    });

    const statuses = await listLocalAgents();
    expect(statuses.map((status) => status.definitionId)).toEqual(["alpha", "beta"]);
    expect(statuses.map((status) => status.projectRoot)).toEqual([alphaRoot, betaRoot]);
    expect(statuses.map((status) => status.source)).toEqual(["manual", "manual"]);
    expect(statuses.map((status) => status.harness)).toEqual(["codex", "claude"]);
    expect(statuses.map((status) => status.transport)).toEqual(["codex_app_server", "claude_stream_json"]);
    expect(statuses.every((status) => status.isOnline === false)).toBe(true);

    const resolvedByProject = await resolveLocalAgentByName("beta");
    expect(resolvedByProject).toMatchObject({
      definitionId: "beta",
      projectRoot: betaRoot,
    });

    const binding = await inferLocalAgentBinding(statuses[0]!.agentId, "node-1");
    expect(binding).toMatchObject({
      actor: {
        id: statuses[0]!.agentId,
        displayName: "Alpha",
      },
      agent: {
        id: statuses[0]!.agentId,
        definitionId: "alpha",
        homeNodeId: "node-1",
      },
      endpoint: {
        agentId: statuses[0]!.agentId,
        nodeId: "node-1",
        harness: "codex",
        transport: "codex_app_server",
      },
    });
  });

  test("updates model as first-class config without duplicating launch args", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const rangerRoot = join(workspaceRoot, "openscout");

    mkdirSync(rangerRoot, { recursive: true });

    await writeRelayAgentOverrides({
      ranger: {
        agentId: "ranger",
        definitionId: "ranger",
        displayName: "Ranger",
        projectName: "OpenScout",
        projectRoot: rangerRoot,
        source: "manual",
        launchArgs: ["--color", "never", "--model", "gpt-5.3-codex"],
        runtime: {
          cwd: rangerRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "ranger-codex",
          wakePolicy: "on_demand",
        },
      },
    });

    const agentId = buildRelayAgentInstance("ranger", rangerRoot).id;
    const initial = await getLocalAgentConfig(agentId);
    expect(initial?.model).toBe("gpt-5.3-codex");

    const updated = await updateLocalAgentConfig(agentId, {
      runtime: initial!.runtime,
      systemPrompt: "Custom Ranger prompt",
      launchArgs: initial!.launchArgs,
      model: "gpt-5.4-mini",
      capabilities: initial!.capabilities,
    });

    expect(updated?.model).toBe("gpt-5.4-mini");
    expect(updated?.systemPrompt).toBe("Custom Ranger prompt");
    expect(updated?.launchArgs.join("\n")).toContain("gpt-5.4-mini");
    expect(updated?.launchArgs.join("\n")).not.toContain("gpt-5.3-codex");

    const cleared = await updateLocalAgentConfig(agentId, {
      runtime: updated!.runtime,
      systemPrompt: updated!.systemPrompt,
      launchArgs: updated!.launchArgs,
      model: null,
      capabilities: updated!.capabilities,
    });

    expect(cleared?.model).toBeNull();
    expect(cleared?.launchArgs.join("\n")).not.toContain("gpt-5.4-mini");
  });

  test("updates and retires an existing card through the local registry", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const talkieRoot = join(workspaceRoot, "talkie");

    mkdirSync(talkieRoot, { recursive: true });

    await writeRelayAgentOverrides({
      "talkie-drift-investigator": {
        agentId: "talkie-drift-investigator",
        definitionId: "talkie-drift-investigator",
        displayName: "Talkie Drift Investigator",
        projectName: "Talkie",
        projectRoot: talkieRoot,
        source: "manual",
        launchArgs: ["--model", "gpt-5.4-mini"],
        runtime: {
          cwd: talkieRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "talkie-drift-codex",
          wakePolicy: "on_demand",
        },
      },
    });

    const agentId = buildRelayAgentInstance("talkie-drift-investigator", talkieRoot).id;
    const updated = await updateLocalAgentCard(agentId, {
      harness: "claude",
      model: "claude-opus-4-7",
    });

    expect(updated).toMatchObject({
      agentId,
      model: "claude-opus-4-7",
      runtime: {
        harness: "claude",
        transport: "tmux",
      },
    });
    expect(updated?.runtime.sessionId).toContain("claude");
    expect(updated?.launchArgs.join("\n")).toContain("claude-opus-4-7");
    expect(updated?.launchArgs.join("\n")).not.toContain("gpt-5.4-mini");

    const retired = await retireLocalAgent(agentId);
    expect(retired?.agentId).toBe(agentId);
    expect(await getLocalAgentConfig(agentId)).toBeNull();
    expect(Object.keys(await readRelayAgentOverrides())).not.toContain(agentId);
  });

  test("does not treat a project name as an agent name unless explicitly requested", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const openscoutRoot = join(workspaceRoot, "openscout");

    mkdirSync(openscoutRoot, { recursive: true });

    await writeRelayAgentOverrides({
      "smoke.main.mini": {
        agentId: "smoke.main.mini",
        definitionId: "smoke",
        displayName: "Smoke",
        projectName: "Openscout",
        projectRoot: openscoutRoot,
        source: "manual",
        runtime: {
          cwd: openscoutRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "relay-openscout.main.mini-codex",
          wakePolicy: "on_demand",
        },
      },
    });

    const concreteAgentId = buildRelayAgentInstance("smoke", openscoutRoot).id;

    expect(await resolveLocalAgentByName(concreteAgentId)).toMatchObject({
      agentId: concreteAgentId,
      definitionId: "smoke",
      projectRoot: openscoutRoot,
    });
    expect(await resolveLocalAgentByName("smoke")).toMatchObject({
      agentId: concreteAgentId,
      definitionId: "smoke",
      projectRoot: openscoutRoot,
    });
    expect(await resolveLocalAgentByName("openscout")).toBeNull();
    expect(await resolveLocalAgentByName("openscout", { matchProjectName: true })).toMatchObject({
      agentId: concreteAgentId,
      definitionId: "smoke",
      projectRoot: openscoutRoot,
    });
  });

  test("reuses an existing agent identity for subdirectories under the same project root", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const alphaRoot = join(workspaceRoot, "alpha");
    const nestedDirectory = join(alphaRoot, "apps", "desktop");

    mkdirSync(join(alphaRoot, ".git"), { recursive: true });
    mkdirSync(nestedDirectory, { recursive: true });

    await writeRelayAgentOverrides({
      alpha: {
        agentId: "alpha",
        definitionId: "alpha",
        displayName: "Alpha Agent",
        projectName: "Alpha",
        projectRoot: alphaRoot,
        source: "manual",
        defaultHarness: "codex",
        runtime: {
          cwd: alphaRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "alpha-codex",
          wakePolicy: "on_demand",
        },
      },
    });

    const resolved = await resolveLocalAgentIdentity({
      projectPath: nestedDirectory,
    });

    expect(resolved).toMatchObject({
      definitionId: "alpha",
      displayName: "Alpha Agent",
      harness: "codex",
      projectRoot: alphaRoot,
      projectName: "Alpha",
      source: "existing",
    });
    expect(resolved.instanceId).toContain("alpha");
    expect(resolved.instanceId).toContain("test-node");
  });

  test("seeds a new agent identity from the project manifest when no relay-agent file exists", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "gamma");

    mkdirSync(projectRoot, { recursive: true });
    writeProjectManifest(projectRoot, {
      version: 1,
      project: {
        id: "gamma",
        name: "Gamma",
      },
      agent: {
        id: "build-master",
        displayName: "Build Master",
        runtime: {
          defaultHarness: "codex",
          profiles: {
            codex: {
              cwd: ".",
              transport: "codex_app_server",
              sessionId: "gamma-codex",
              launchArgs: ["--model", "gpt-5"],
            },
          },
        },
      },
    });

    const resolved = await resolveLocalAgentIdentity({
      projectPath: projectRoot,
    });

    expect(resolved).toMatchObject({
      definitionId: "build-master",
      displayName: "Build Master",
      harness: "codex",
      projectRoot,
      projectName: "gamma",
      source: "config",
    });
    expect(resolved.instanceId).toContain("build-master");
    expect(resolved.instanceId).toContain("test-node");
  });

  test("starts a new Claude local agent with tmux as the default transport", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "gamma");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    const status = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "gamma",
      harness: "claude",
      ensureOnline: false,
    });
    const overrides = await readRelayAgentOverrides();
    const override = overrides[status.agentId];

    expect(status).toMatchObject({
      definitionId: "gamma",
      harness: "claude",
      transport: "tmux",
      isOnline: false,
    });
    expect(override?.runtime).toMatchObject({
      harness: "claude",
      transport: "tmux",
    });
    expect(override?.runtime?.sessionId).not.toContain(".");
    expect(override?.harnessProfiles?.claude?.transport).toBe("tmux");
    expect(override?.harnessProfiles?.claude?.sessionId).not.toContain(".");
  });

  test("starts a new Grok local agent with tmux as the default transport", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "gamma");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    const status = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "gamma-grok",
      harness: "grok",
      model: "grok-4.3",
      ensureOnline: false,
    });
    const overrides = await readRelayAgentOverrides();
    const override = overrides[status.agentId];

    expect(status).toMatchObject({
      definitionId: "gamma-grok",
      harness: "grok",
      transport: "tmux",
      isOnline: false,
    });
    expect(override?.runtime).toMatchObject({
      harness: "grok",
      transport: "tmux",
    });
    expect(override?.harnessProfiles?.grok?.transport).toBe("tmux");
    expect(override?.harnessProfiles?.grok?.launchArgs).toEqual([
      "--allowedTools",
      expect.stringContaining("mcp__scout__ask"),
      "--model",
      "grok-4.3",
    ]);
  });

  test("registers a Grok ACP local agent without falling back to tmux", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "gamma");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    const status = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "gamma-grok-acp",
      harness: "grok-acp",
      ensureOnline: false,
    });
    const overrides = await readRelayAgentOverrides();
    const override = overrides[status.agentId];

    expect(status).toMatchObject({
      definitionId: "gamma-grok-acp",
      harness: "grok-acp",
      transport: "grok_acp",
    });
    expect(override?.runtime).toMatchObject({
      harness: "grok-acp",
      transport: "grok_acp",
    });
    expect(override?.harnessProfiles?.["grok-acp"]?.transport).toBe("grok_acp");
  });

  test("registers a Kimi ACP local agent without falling back to tmux", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "gamma");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    const status = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "gamma-kimi",
      harness: "kimi",
      ensureOnline: false,
    });
    const overrides = await readRelayAgentOverrides();
    const override = overrides[status.agentId];

    expect(status).toMatchObject({
      definitionId: "gamma-kimi",
      harness: "kimi",
      transport: "kimi_acp",
    });
    expect(override?.runtime).toMatchObject({
      harness: "kimi",
      transport: "kimi_acp",
    });
    expect(override?.harnessProfiles?.kimi?.transport).toBe("kimi_acp");
  });

  test("starts a new Pi local agent with RPC as the default transport", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "gamma");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    const status = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "gamma-pi",
      harness: "pi",
      provider: "minimax",
      model: "MiniMax-M3",
      reasoningEffort: "low",
    });
    const overrides = await readRelayAgentOverrides();
    const override = overrides[status.agentId];

    expect(status).toMatchObject({
      definitionId: "gamma-pi",
      harness: "pi",
      transport: "pi_rpc",
      isOnline: false,
    });
    expect(override?.runtime).toMatchObject({
      harness: "pi",
      transport: "pi_rpc",
    });
    expect(override?.harnessProfiles?.pi?.transport).toBe("pi_rpc");
    expect(override?.harnessProfiles?.pi?.launchArgs).toEqual([
      "--model",
      "MiniMax-M3",
      "--provider",
      "minimax",
      "--thinking",
      "low",
    ]);
  });

  test("normalizes Pi none reasoning requests to thinking off", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "gamma");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    const status = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "gamma-grok",
      harness: "pi",
      provider: "grok",
      model: "grok-4.3",
      reasoningEffort: "none",
    });
    const overrides = await readRelayAgentOverrides();
    const override = overrides[status.agentId];

    expect(override?.harnessProfiles?.pi?.launchArgs).toEqual([
      "--model",
      "grok-4.3",
      "--provider",
      "xai",
      "--thinking",
      "off",
    ]);
  });

  test("explicit Pi startup migrates an existing Pi tmux profile to RPC", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "gamma");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    await writeRelayAgentOverrides({
      "gamma-pi.test-node": {
        agentId: "gamma-pi.test-node",
        definitionId: "gamma-pi",
        displayName: "Gamma Pi",
        projectName: "Gamma",
        projectRoot,
        source: "manual",
        defaultHarness: "pi",
        harnessProfiles: {
          pi: {
            cwd: projectRoot,
            transport: "tmux",
            sessionId: "relay-gamma-pi",
            launchArgs: ["--model", "MiniMax-M2.7"],
          },
        },
        runtime: {
          cwd: projectRoot,
          harness: "pi",
          transport: "tmux",
          sessionId: "relay-gamma-pi",
          wakePolicy: "on_demand",
        },
      },
    });

    const status = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "gamma-pi",
      harness: "pi",
      provider: "minimax",
      model: "MiniMax-M3",
    });
    const overrides = await readRelayAgentOverrides();
    const override = overrides[status.agentId];

    expect(status.transport).toBe("pi_rpc");
    expect(override?.runtime?.transport).toBe("pi_rpc");
    expect(override?.harnessProfiles?.pi?.transport).toBe("pi_rpc");
    expect(override?.harnessProfiles?.pi?.launchArgs).toEqual([
      "--model",
      "MiniMax-M3",
      "--provider",
      "minimax",
    ]);
  });

  test("preserves explicit Claude stream-json configuration for specialized agents", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "batch-runner");

    mkdirSync(projectRoot, { recursive: true });
    await writeRelayAgentOverrides({
      "batch-runner": {
        agentId: "batch-runner",
        definitionId: "batch-runner",
        displayName: "Batch Runner",
        projectName: "Batch Runner",
        projectRoot,
        source: "manual",
        defaultHarness: "claude",
        runtime: {
          cwd: projectRoot,
          harness: "claude",
          transport: "claude_stream_json",
          sessionId: "batch-runner-claude",
          wakePolicy: "on_demand",
        },
      },
    });

    const statuses = await listLocalAgents();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      definitionId: "batch-runner",
      harness: "claude",
      transport: "claude_stream_json",
    });

    const [binding] = await loadRegisteredLocalAgentBindings("test-node", { ensureOnline: false });
    expect(binding?.endpoint.transport).toBe("claude_stream_json");
    expect(binding?.endpoint.metadata).toMatchObject({
      runtimeMode: "stream_json_worker",
      transportLabel: "Claude stream-json worker",
      interactiveTerminal: false,
      terminalSurface: null,
    });
    expect(binding?.endpoint.metadata?.tmuxSession).toBeUndefined();
    expect(binding?.endpoint.metadata?.runtimeInstanceId).toBe("batch-runner-claude");
  });

  test("forks a new same-project Claude agent with tmux even when sibling used stream-json", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "preframe");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    await writeRelayAgentOverrides({
      "preframe.test-node": {
        agentId: "preframe.test-node",
        definitionId: "preframe",
        displayName: "Preframe",
        projectName: "Preframe",
        projectRoot,
        source: "manual",
        defaultHarness: "claude",
        harnessProfiles: {
          claude: {
            cwd: projectRoot,
            transport: "claude_stream_json",
            sessionId: "relay-preframe-claude",
            launchArgs: [],
          },
        },
        runtime: {
          cwd: projectRoot,
          harness: "claude",
          transport: "claude_stream_json",
          sessionId: "relay-preframe-claude",
          wakePolicy: "on_demand",
        },
      },
    });

    const status = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "preframux",
      harness: "claude",
      ensureOnline: false,
    });
    const overrides = await readRelayAgentOverrides();
    const override = overrides[status.agentId];

    expect(status).toMatchObject({
      definitionId: "preframux",
      harness: "claude",
      transport: "tmux",
    });
    expect(override?.runtime?.transport).toBe("tmux");
    expect(override?.runtime?.sessionId).not.toContain(".");
    expect(override?.harnessProfiles?.claude?.transport).toBe("tmux");
    expect(override?.harnessProfiles?.claude?.sessionId).not.toContain(".");
    expect(overrides["preframe.test-node"]?.runtime?.transport).toBe("claude_stream_json");
  });

  test("forks a same-root probe without replacing the configured main agent", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "openscout");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    await writeRelayAgentOverrides({
      ranger: {
        agentId: "ranger",
        definitionId: "ranger",
        displayName: "Ranger",
        projectName: "OpenScout",
        projectRoot,
        source: "manual",
        defaultHarness: "codex",
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "relay-ranger-codex",
          wakePolicy: "on_demand",
        },
      },
    });

    const probe = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "ranger-probe",
      displayName: "Ranger Probe",
      harness: "codex",
      model: "gpt-5.4-mini",
      ensureOnline: false,
    });

    expect(probe.definitionId).toBe("ranger-probe");
    expect(await resolveLocalAgentByName("ranger")).toMatchObject({
      definitionId: "ranger",
      projectRoot,
    });
    expect(await resolveLocalAgentByName("ranger-probe")).toMatchObject({
      definitionId: "ranger-probe",
      projectRoot,
    });
    expect((await listLocalAgents()).map((agent) => agent.definitionId).sort()).toEqual([
      "ranger",
      "ranger-probe",
    ]);
  });

  test("forks a manually named codex agent outside the Ranger manifest identity", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "openscout");
    const manifestPath = join(projectRoot, ".openscout", "project.json");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    writeProjectManifest(projectRoot, {
      version: 1,
      project: {
        id: "openscout",
        name: "OpenScout",
      },
      agent: {
        id: "ranger",
        displayName: "Ranger",
      },
    });

    await writeRelayAgentOverrides({
      "ranger.test-node": {
        agentId: "ranger.test-node",
        definitionId: "ranger",
        displayName: "Ranger",
        projectName: "OpenScout",
        projectRoot,
        projectConfigPath: manifestPath,
        source: "manifest",
        defaultHarness: "codex",
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "relay-ranger-codex",
          wakePolicy: "on_demand",
        },
      },
    });

    const fieldAgent = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "field-agent",
      displayName: "Field Agent",
      harness: "codex",
      model: "gpt-5.4",
      ensureOnline: false,
    });

    const overrides = await readRelayAgentOverrides();
    expect(fieldAgent.definitionId).toBe("field-agent");
    expect(overrides[fieldAgent.agentId]).toMatchObject({
      definitionId: "field-agent",
      displayName: "Field Agent",
      projectRoot,
      projectConfigPath: null,
      source: "manual",
      defaultHarness: "codex",
    });
    expect(overrides[fieldAgent.agentId]?.runtime?.sessionId).toContain("field-agent");
    expect(overrides[fieldAgent.agentId]?.runtime?.sessionId).not.toBe("relay-ranger-codex");
    expect(overrides[fieldAgent.agentId]?.systemPrompt).toBeUndefined();
    expect(overrides["ranger.test-node"]).toMatchObject({
      definitionId: "ranger",
      projectConfigPath: manifestPath,
    });
  });

  test("applies the generic operator augment prompt to the configured handle-ai agent", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "home");

    mkdirSync(join(home, ".openscout"), { recursive: true });
    writeFileSync(
      join(home, ".openscout", "user.json"),
      `${JSON.stringify({ name: "Scout Human", handle: "@pilot" }, null, 2)}\n`,
      "utf8",
    );
    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    const status = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "pilot-ai",
      harness: "codex",
      model: "gpt-5.5",
      ensureOnline: false,
    });
    const overrides = await readRelayAgentOverrides();
    const override = overrides[status.agentId];

    expect(status.definitionId).toBe("pilot-ai");
    expect(override?.systemPrompt).toContain("human Scout operator @pilot");
    expect(override?.systemPrompt).toContain("@pilot-ai is the AI-augmented looper");
    expect(override?.systemPrompt).toContain("When to invoke @pilot:");
    expect(override?.systemPrompt).not.toContain("@arach");
    expect(configuredOperatorActorIds()).toEqual(["operator", "Scout Human", "pilot"]);
  });

  test("applies the operator augment prompt when forking from an existing same-root agent", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "home");

    mkdirSync(join(home, ".openscout"), { recursive: true });
    writeFileSync(
      join(home, ".openscout", "user.json"),
      `${JSON.stringify({ name: "Scout Human", handle: "@pilot" }, null, 2)}\n`,
      "utf8",
    );
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    await writeRelayAgentOverrides({
      "home.test-node": {
        agentId: "home.test-node",
        definitionId: "home",
        displayName: "Home",
        projectName: "Home",
        projectRoot,
        source: "manual",
        defaultHarness: "codex",
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "relay-home-codex",
          wakePolicy: "on_demand",
        },
      },
    });

    const status = await startLocalAgent({
      projectPath: projectRoot,
      agentName: "operator-ai",
      harness: "codex",
      ensureOnline: false,
    });
    const overrides = await readRelayAgentOverrides();
    const override = overrides[status.agentId];

    expect(status.definitionId).toBe("operator-ai");
    expect(override?.systemPrompt).toContain("human Scout operator @pilot");
    expect(override?.systemPrompt).toContain("@operator-ai is the AI-augmented looper");
    expect(overrides["home.test-node"]?.systemPrompt).toBeUndefined();
  });

  test("prunes expired and overflowing one-time agent cards", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "openscout");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    await writeRelayAgentOverrides({
      "review-old.test-node": {
        agentId: "review-old.test-node",
        definitionId: "review-old",
        displayName: "Review Old",
        projectName: "OpenScout",
        projectRoot,
        source: "manual",
        card: {
          kind: "one_time",
          createdAt: 1_000,
          createdById: "operator",
          expiresAt: 2_000,
          maxUses: 1,
        },
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "review-old-codex",
          wakePolicy: "on_demand",
        },
      },
      "review-overflow.test-node": {
        agentId: "review-overflow.test-node",
        definitionId: "review-overflow",
        displayName: "Review Overflow",
        projectName: "OpenScout",
        projectRoot,
        source: "manual",
        card: {
          kind: "one_time",
          createdAt: 3_000,
          createdById: "operator",
          maxUses: 1,
        },
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "review-overflow-codex",
          wakePolicy: "on_demand",
        },
      },
      "review-new.test-node": {
        agentId: "review-new.test-node",
        definitionId: "review-new",
        displayName: "Review New",
        projectName: "OpenScout",
        projectRoot,
        source: "manual",
        card: {
          kind: "one_time",
          createdAt: 9_000,
          createdById: "operator",
          maxUses: 1,
        },
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "review-new-codex",
          wakePolicy: "on_demand",
        },
      },
      "ranger.test-node": {
        agentId: "ranger.test-node",
        definitionId: "ranger",
        displayName: "Ranger",
        projectName: "OpenScout",
        projectRoot,
        source: "manual",
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "ranger-codex",
          wakePolicy: "on_demand",
        },
      },
    });

    const result = await pruneOneTimeLocalAgentCards({
      now: 10_000,
      maxAgeMs: 100_000,
      maxCount: 1,
      createdById: "operator",
      projectRoot,
    });

    expect(result.retired.map((agent) => agent.definitionId).sort()).toEqual([
      "review-old",
      "review-overflow",
    ]);
    expect(result.remaining).toBe(1);
    expect(Object.keys(await readRelayAgentOverrides()).sort()).toEqual([
      "ranger.test-node",
      "review-new.test-node",
    ]);
  });

  test("keeps unexpired ephemeral cards when cleanup has no explicit count limit", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "openscout");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    await writeRelayAgentOverrides(Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => {
        const id = `review-${String(index).padStart(2, "0")}.test-node`;
        return [id, {
          agentId: id,
          definitionId: `review-${String(index).padStart(2, "0")}`,
          displayName: `Review ${String(index).padStart(2, "0")}`,
          projectName: "OpenScout",
          projectRoot,
          source: "manual",
          card: {
            kind: "one_time",
            createdAt: 1_000 + index,
            createdById: "operator",
            expiresAt: 100_000,
            maxUses: 1,
          },
          runtime: {
            cwd: projectRoot,
            harness: "codex",
            transport: "codex_app_server",
            sessionId: `review-${index}-codex`,
            wakePolicy: "on_demand",
          },
        }];
      }),
    ));

    const result = await pruneOneTimeLocalAgentCards({
      now: 10_000,
      maxAgeMs: 100_000,
      createdById: "operator",
      projectRoot,
    });

    expect(result.retired).toEqual([]);
    expect(result.remaining).toBe(30);
    expect(Object.keys(await readRelayAgentOverrides())).toHaveLength(30);
  });

  test("keeps ephemeral cards after peer coordination messages", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "openscout");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    await writeRelayAgentOverrides({
      "review-reply.test-node": {
        agentId: "review-reply.test-node",
        definitionId: "review-reply",
        displayName: "Review Reply",
        projectName: "OpenScout",
        projectRoot,
        source: "manual",
        card: {
          kind: "one_time",
          createdAt: 1_000,
          createdById: "operator",
          inboxConversationId: "dm.operator.review-reply.test-node",
          maxUses: 1,
        },
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "review-reply-codex",
          wakePolicy: "on_demand",
        },
      },
      "target.test-node": {
        agentId: "target.test-node",
        definitionId: "target",
        displayName: "Target",
        projectName: "OpenScout",
        projectRoot,
        source: "manual",
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "target-codex",
          wakePolicy: "on_demand",
        },
      },
    });

    expect(
      await retireConsumedOneTimeLocalAgentCards({
        conversationId: "dm.operator.review-reply.test-node",
        actorId: "operator",
        participantIds: ["operator", "review-reply.test-node"],
      }),
    ).toEqual([]);
    expect(Object.keys(await readRelayAgentOverrides()).sort()).toEqual([
      "review-reply.test-node",
      "target.test-node",
    ]);

    expect(
      await retireConsumedOneTimeLocalAgentCards({
        conversationId: "dm.operator.review-reply.test-node",
        actorId: "review-reply.test-node",
        participantIds: ["operator", "review-reply.test-node"],
      }),
    ).toEqual([]);

    expect(Object.keys(await readRelayAgentOverrides()).sort()).toEqual([
      "review-reply.test-node",
      "target.test-node",
    ]);

    const retired = await retireConsumedOneTimeLocalAgentCards({
      conversationId: "dm.operator.review-reply.test-node",
      actorId: "review-reply.test-node",
      participantIds: ["operator", "review-reply.test-node"],
      targetAgentId: "review-reply.test-node",
    });

    expect(retired.map((agent) => agent.agentId)).toEqual(["review-reply.test-node"]);
    expect(Object.keys(await readRelayAgentOverrides()).sort()).toEqual([
      "target.test-node",
    ]);
  });

  test("does not consume a one-time card from an unrelated conversation", async () => {
    const home = useIsolatedOpenScoutHome();
    const workspaceRoot = join(home, "dev");
    const projectRoot = join(workspaceRoot, "openscout");

    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    await writeRelayAgentOverrides({
      "review-reply.test-node": {
        agentId: "review-reply.test-node",
        definitionId: "review-reply",
        displayName: "Review Reply",
        projectName: "OpenScout",
        projectRoot,
        source: "manual",
        card: {
          kind: "one_time",
          createdAt: 1_000,
          createdById: "operator",
          inboxConversationId: "dm.operator.review-reply.test-node",
          maxUses: 1,
        },
        runtime: {
          cwd: projectRoot,
          harness: "codex",
          transport: "codex_app_server",
          sessionId: "review-reply-codex",
          wakePolicy: "on_demand",
        },
      },
    });

    const retired = await retireConsumedOneTimeLocalAgentCards({
      conversationId: "dm.review-reply.test-node.target.test-node",
      actorId: "target.test-node",
      participantIds: ["review-reply.test-node", "target.test-node"],
      targetAgentId: "review-reply.test-node",
    });

    expect(retired).toEqual([]);
    expect(Object.keys(await readRelayAgentOverrides()).sort()).toEqual([
      "review-reply.test-node",
    ]);
  });
});
