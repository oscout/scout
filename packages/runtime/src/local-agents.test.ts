import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CLAUDE_SCOUT_ALLOWED_TOOLS,
  SCOUT_MESSAGE_ATTACHMENTS_CONTEXT_KEY,
  SUPPORTED_LOCAL_AGENT_HARNESSES,
  SUPPORTED_SCOUT_HARNESSES,
  buildAttachedSessionInvocationPrompt,
  buildClaudeEndpointSessionOptions,
  buildCodexEndpointSessionOptions,
  codexHomeForEndpoint,
  buildLocalAgentDirectInvocationPrompt,
  buildLocalAgentNudge,
  buildLocalAgentSystemPrompt,
  buildLocalAgentSystemPromptTemplate,
  clearEndpointFailureMetadata,
  endpointStateAfterSuccessfulSessionWarmup,
  areHarnessBinariesAvailable,
  brokerSnapshotMessages,
  invokeLocalAgentEndpoint,
  listArchivedLocalAgentIds,
  loadRegisteredLocalAgentBindings,
  normalizeClaudeRuntimeLaunchArgs,
  normalizeGrokRuntimeLaunchArgs,
  normalizeLocalAgentSystemPrompt,
  renderLocalAgentSystemPromptTemplate,
  resolveLocalAgentContextWindowUsage,
  stripLocalAgentReplyMetadata,
} from "./local-agents";
import { DEFAULT_BROKER_URL } from "./broker-process-manager";
import { shutdownCodexAppServerAgent } from "./codex-app-server";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scoutCli = `bun ${JSON.stringify(join(repoRoot, "packages", "cli", "bin", "scout.mjs"))}`;
const scoutSkillPath = join(repoRoot, ".agents", "skills", "scout", "SKILL.md");
const originalCodexBin = process.env.OPENSCOUT_CODEX_BIN;
const originalCodeXBin = process.env.CODEX_BIN;
const originalPath = process.env.PATH;
const originalNodeQualifier = process.env.OPENSCOUT_NODE_QUALIFIER;
const originalSupportDirectory = process.env.OPENSCOUT_SUPPORT_DIRECTORY;
const originalOpenScoutHome = process.env.OPENSCOUT_HOME;
const originalOperatorName = process.env.OPENSCOUT_OPERATOR_NAME;
const originalOperatorHandle = process.env.OPENSCOUT_OPERATOR_HANDLE;
const originalCodexHomeSource = process.env.OPENSCOUT_CODEX_HOME_SOURCE;
const tempPaths = new Set<string>();

function useTestOperatorIdentity(name = "operator", handle = "operator"): void {
  const home = mkdtempSync(join(tmpdir(), "openscout-user-config-"));
  tempPaths.add(home);
  process.env.OPENSCOUT_HOME = home;
  process.env.OPENSCOUT_OPERATOR_NAME = name;
  process.env.OPENSCOUT_OPERATOR_HANDLE = handle;
}

beforeEach(() => {
  useTestOperatorIdentity();
});

afterEach(() => {
  if (originalCodexBin === undefined) {
    delete process.env.OPENSCOUT_CODEX_BIN;
  } else {
    process.env.OPENSCOUT_CODEX_BIN = originalCodexBin;
  }
  if (originalCodeXBin === undefined) {
    delete process.env.CODEX_BIN;
  } else {
    process.env.CODEX_BIN = originalCodeXBin;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalNodeQualifier === undefined) {
    delete process.env.OPENSCOUT_NODE_QUALIFIER;
  } else {
    process.env.OPENSCOUT_NODE_QUALIFIER = originalNodeQualifier;
  }
  if (originalSupportDirectory === undefined) {
    delete process.env.OPENSCOUT_SUPPORT_DIRECTORY;
  } else {
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = originalSupportDirectory;
  }
  if (originalOpenScoutHome === undefined) {
    delete process.env.OPENSCOUT_HOME;
  } else {
    process.env.OPENSCOUT_HOME = originalOpenScoutHome;
  }
  if (originalCodexHomeSource === undefined) {
    delete process.env.OPENSCOUT_CODEX_HOME_SOURCE;
  } else {
    process.env.OPENSCOUT_CODEX_HOME_SOURCE = originalCodexHomeSource;
  }
  if (originalOperatorName === undefined) {
    delete process.env.OPENSCOUT_OPERATOR_NAME;
  } else {
    process.env.OPENSCOUT_OPERATOR_NAME = originalOperatorName;
  }
  if (originalOperatorHandle === undefined) {
    delete process.env.OPENSCOUT_OPERATOR_HANDLE;
  } else {
    process.env.OPENSCOUT_OPERATOR_HANDLE = originalOperatorHandle;
  }

  for (const tempPath of tempPaths) {
    rmSync(tempPath, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function writeFakeCodexExecutable(directory: string): string {
  const executablePath = join(directory, "codex");
  writeFileSync(executablePath, "#!/bin/sh\necho codex-cli 0.999.0\n", "utf8");
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function writeReplyContextAwareCodexExecutable(directory: string): {
  executablePath: string;
  observedContextPath: string;
} {
  const executablePath = join(directory, "codex-app-server");
  const observedContextPath = join(directory, "observed-reply-context.json");
  writeFileSync(executablePath, `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let activeThreadId = "thread-unknown";

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    console.log(JSON.stringify({ id, result: {} }));
    continue;
  }

  if (method === "thread/resume") {
    activeThreadId = String(params.threadId ?? "thread-unknown");
    const thread = { id: activeThreadId, path: \`/tmp/\${activeThreadId}.jsonl\` };
    console.log(JSON.stringify({ id, result: { thread } }));
    console.log(JSON.stringify({ method: "thread/started", params: { thread } }));
    continue;
  }

  if (method === "turn/start") {
    const contextPath = process.env.OPENSCOUT_REPLY_CONTEXT_FILE ?? "";
    const observed = {
      contextPath,
      exists: contextPath ? existsSync(contextPath) : false,
      context: contextPath && existsSync(contextPath) ? JSON.parse(readFileSync(contextPath, "utf8")) : null,
    };
    writeFileSync(${JSON.stringify(observedContextPath)}, JSON.stringify(observed, null, 2));
    activeThreadId = String(params.threadId ?? activeThreadId);
    console.log(JSON.stringify({ id, result: { turn: { id: "turn-1" } } }));
    console.log(JSON.stringify({ method: "turn/started", params: { threadId: activeThreadId, turn: { id: "turn-1", status: "inProgress", items: [] } } }));
    console.log(JSON.stringify({ method: "item/started", params: { threadId: activeThreadId, turnId: "turn-1", item: { type: "agentMessage", id: "msg-1", text: "" } } }));
    console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: activeThreadId, turnId: "turn-1", itemId: "msg-1", delta: "Reply context observed" } }));
    console.log(JSON.stringify({ method: "item/completed", params: { threadId: activeThreadId, turnId: "turn-1", item: { type: "agentMessage", id: "msg-1", text: "Reply context observed" } } }));
    console.log(JSON.stringify({ method: "turn/completed", params: { threadId: activeThreadId, turn: { id: "turn-1", status: "completed", error: null } } }));
    continue;
  }

  console.log(JSON.stringify({ id, result: {} }));
}
`, "utf8");
  chmodSync(executablePath, 0o755);
  return { executablePath, observedContextPath };
}

describe("local agent prompts", () => {
  test("separates managed background Codex state from the operator foreground store", () => {
    const supportDirectory = mkdtempSync(join(tmpdir(), "openscout-placement-"));
    const operatorCodexHome = join(supportDirectory, "operator-codex");
    tempPaths.add(supportDirectory);
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = supportDirectory;
    process.env.OPENSCOUT_CODEX_HOME_SOURCE = operatorCodexHome;

    const baseEndpoint = {
      id: "endpoint.codex-placement",
      agentId: "session-codex-placement",
      nodeId: "node-1",
      harness: "codex" as const,
      transport: "codex_app_server" as const,
      state: "idle" as const,
      cwd: "/tmp/openscout",
    };
    const backgroundHome = codexHomeForEndpoint({
      ...baseEndpoint,
      metadata: { placement: "background" },
    });
    const foregroundHome = codexHomeForEndpoint({
      ...baseEndpoint,
      metadata: { placement: "foreground" },
    });

    expect(backgroundHome).toBe(join(supportDirectory, "runtime", "codex-background-home"));
    expect(foregroundHome).toBe(operatorCodexHome);
    expect(buildCodexEndpointSessionOptions({
      ...baseEndpoint,
      metadata: { placement: "background" },
    }).env?.CODEX_HOME).toBe(backgroundHome);

    // SCO-098: a thread Scout did not create lives in the operator store, so
    // an external-thread resume overrides background placement — the rollout
    // is not in the background home ("no rollout found" otherwise).
    const externalThreadOptions = buildCodexEndpointSessionOptions({
      ...baseEndpoint,
      metadata: { placement: "background", threadId: "external-thread-1" },
    });
    expect(externalThreadOptions.env?.CODEX_HOME).toBe(operatorCodexHome);
    expect(externalThreadOptions.env?.OPENSCOUT_CODEX_AUTH_SOURCE).toBeUndefined();

    for (const source of [
      "scout-cardless-session",
      "scout-isolated-agent-session",
      "scout-cli",
    ]) {
      const scoutBackgroundOptions = buildCodexEndpointSessionOptions({
        ...baseEndpoint,
        metadata: {
          placement: "background",
          source,
          threadId: `scout-thread-${source}`,
        },
      });
      expect(scoutBackgroundOptions.env?.CODEX_HOME).toBe(backgroundHome);
      expect(scoutBackgroundOptions.env?.OPENSCOUT_CODEX_AUTH_SOURCE)
        .toBe(join(operatorCodexHome, "auth.json"));
    }
  });

  test("applies an attached endpoint's explicit Codex permission boundary", () => {
    const options = buildCodexEndpointSessionOptions({
      id: "endpoint.scoutbot",
      agentId: "scoutbot",
      nodeId: "node-1",
      harness: "codex",
      transport: "codex_app_server",
      state: "waiting",
      cwd: "/tmp/openscout",
      metadata: {
        source: "scoutbot",
        approvalPolicy: "never",
        sandbox: "read-only",
        launchArgs: ["-c", "features.shell_tool=false"],
      },
    });

    expect(options.approvalPolicy).toBe("never");
    expect(options.sandbox).toBe("read-only");
    expect(options.launchArgs).toContain("features.shell_tool=false");
  });

  test("applies an attached Claude endpoint's model and effort metadata to launch args", () => {
    const options = buildClaudeEndpointSessionOptions({
      id: "endpoint.cardless-claude",
      agentId: "session-cardless-claude",
      nodeId: "node-1",
      harness: "claude",
      transport: "claude_stream_json",
      state: "idle",
      cwd: "/tmp/openscout",
      metadata: {
        cardless: true,
        launchArgs: [
          "--model", "stale-model",
          "--reasoning-effort", "low",
          "--allowedTools", "Read,Grep",
        ],
        model: "claude-opus-4-8",
        reasoningEffort: "high",
      },
    });

    expect(options.launchArgs).toEqual([
      "--allowedTools", "Read,Grep",
      "--model", "claude-opus-4-8",
      "--effort", "high",
    ]);
  });

  test("derives context-window usage from observed token metadata", () => {
    expect(resolveLocalAgentContextWindowUsage({
      session: {
        id: "session-1",
        name: "Codex",
        adapterType: "codex",
        status: "active",
        providerMeta: {
          observeUsage: {
            contextInputTokens: 1080,
            totalTokens: 1080,
            contextWindowTokens: 200_000,
          },
        },
      },
      turns: [],
    })).toEqual({
      contextInputTokens: 1080,
      totalTokens: 1080,
      contextWindowTokens: 200_000,
      usedPercent: 1,
    });

    expect(resolveLocalAgentContextWindowUsage({
      session: {
        id: "session-2",
        name: "Codex",
        adapterType: "codex",
        status: "active",
        providerMeta: {
          observeUsage: {
            totalTokens: 42,
          },
        },
      },
      turns: [],
    })).toEqual({
      contextInputTokens: null,
      totalTokens: 42,
      contextWindowTokens: null,
      usedPercent: null,
    });

    expect(resolveLocalAgentContextWindowUsage({
      session: {
        id: "session-3",
        name: "Codex",
        adapterType: "codex",
        status: "active",
        providerMeta: {
          observeUsage: {
            contextInputTokens: 129_200,
            totalTokens: 4_604_127,
            contextWindowTokens: 258_400,
          },
        },
      },
      turns: [],
    })).toEqual({
      contextInputTokens: 129_200,
      totalTokens: 4_604_127,
      contextWindowTokens: 258_400,
      usedPercent: 50,
    });
  });

  test("accepts an explicit Codex executable for app-server warmup even when PATH is empty", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-codex-warmup-"));
    tempPaths.add(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = writeFakeCodexExecutable(tempRoot);
    delete process.env.CODEX_BIN;
    process.env.PATH = "";

    expect(areHarnessBinariesAvailable({
      harness: "codex",
      transport: "codex_app_server",
    })).toBe(true);
  });

  test("clears stale endpoint failure metadata after successful session warmup", () => {
    expect(clearEndpointFailureMetadata({
      source: "scoutbot",
      lastError: "codex_app_server session unavailable: old-thread",
      lastFailedAt: 123,
      threadId: "new-thread",
    })).toEqual({
      source: "scoutbot",
      threadId: "new-thread",
    });
  });

  test("marks warmed local session endpoints idle unless they are active", () => {
    expect(endpointStateAfterSuccessfulSessionWarmup("offline")).toBe("idle");
    expect(endpointStateAfterSuccessfulSessionWarmup("waiting")).toBe("idle");
    expect(endpointStateAfterSuccessfulSessionWarmup("idle")).toBe("idle");
    expect(endpointStateAfterSuccessfulSessionWarmup("active")).toBe("active");
  });

  test("Scout harness attribution accepts Flue without making it a managed local launcher", () => {
    expect(SUPPORTED_SCOUT_HARNESSES).toContain("flue");
    expect(SUPPORTED_LOCAL_AGENT_HARNESSES).not.toContain("flue");
    expect(SUPPORTED_LOCAL_AGENT_HARNESSES).toContain("pi");
    expect(SUPPORTED_LOCAL_AGENT_HARNESSES).toContain("grok");
    expect(SUPPORTED_LOCAL_AGENT_HARNESSES).toContain("grok-acp");
    expect(SUPPORTED_LOCAL_AGENT_HARNESSES).toContain("kimi");
    expect(SUPPORTED_SCOUT_HARNESSES).toContain("kimi");
  });

  test("hydrates persisted Codex thread ids onto local endpoint metadata", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-local-agent-binding-"));
    tempPaths.add(tempRoot);
    const supportDirectory = join(tempRoot, "support");
    const projectRoot = join(tempRoot, "projects", "talkie");
    const actorId = "talkie.test-node";
    const runtimeDirectory = join(supportDirectory, "runtime", "agents", actorId);
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = supportDirectory;
    process.env.OPENSCOUT_NODE_QUALIFIER = "test-node";
    mkdirSync(runtimeDirectory, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(runtimeDirectory, "session-catalog.json"), JSON.stringify({
      activeSessionId: "codex-thread-talkie",
      sessions: [{
        id: "codex-thread-talkie",
        startedAt: Date.now(),
        cwd: projectRoot,
        harness: "codex",
        transport: "codex_app_server",
      }],
    }), "utf8");
    mkdirSync(supportDirectory, { recursive: true });
    writeFileSync(join(supportDirectory, "relay-agents.json"), JSON.stringify({
      version: 1,
      agents: {
        talkie: {
          agentId: "talkie",
          definitionId: "talkie",
          projectName: "talkie",
          projectRoot,
          defaultHarness: "codex",
          runtime: {
            cwd: projectRoot,
            harness: "codex",
            transport: "codex_app_server",
            sessionId: "relay-talkie-codex",
            wakePolicy: "on_demand",
          },
        },
      },
    }), "utf8");

    const [binding] = await loadRegisteredLocalAgentBindings("node.local");

    expect(binding?.agent.id).toBe(actorId);
    expect(binding?.agent.metadata?.brokerRegistered).toBe(true);
    expect(binding?.endpoint.sessionId).toBe("relay-talkie-codex");
    expect(binding?.endpoint.metadata?.externalSessionId).toBe("codex-thread-talkie");
    expect(binding?.endpoint.metadata?.threadId).toBe("codex-thread-talkie");
  });

  test("system prompt composes shared base, project context, and broker-backed protocol", () => {
    process.env.OPENSCOUT_PROJECTS_ROOT = "/Users/arach/dev";
    process.env.OPENSCOUT_RELAY_HUB = "/Users/arach/.openscout/relay";

    const prompt = buildLocalAgentSystemPrompt("shaper", "shaper", "/Users/arach/dev/shaper");

    expect(prompt).toContain('You are "shaper", a relay agent for the shaper project.');
    expect(prompt).toContain("Project context:");
    expect(prompt).toContain("Codebase root: /Users/arach/dev/shaper");
    expect(prompt).toContain("Projects root: /Users/arach/dev");
    expect(prompt).toContain(`${scoutCli} inbox --as shaper --latest 20 --json`);
    expect(prompt).toContain(`${scoutCli} channel <name> --latest 20 --json`);
    expect(prompt).toContain(`${scoutCli} send --to <agent> --as shaper "your message"`);
    expect(prompt).toContain(`${scoutCli} ask --to <agent> --as shaper "your request"`);
    expect(prompt).toContain("prefer `scout search` over grepping");
    expect(prompt).toContain(`${scoutCli} search status`);
    expect(prompt).toContain(`${scoutCli} search index --source sessions`);
    expect(prompt).toContain("Relay protocol:");
    expect(prompt).toContain("Do not use file-backed relay state or side channels directly");
    expect(prompt).toContain("Do not curl broker HTTP endpoints to read messages");
    expect(prompt).toContain("Default Scout loop: resolve identity, resolve one target, choose DM vs explicit channel, keep follow-up in that same venue");
    expect(prompt).toContain("Keep one-to-one handoffs in a DM");
    expect(prompt).toContain("If you need multiple agents, use separate DMs or an explicit channel");
    expect(prompt).toContain("Do not use the shared channel for ordinary delegation or follow-up");
    expect(prompt).toContain("Treat known offline / on-demand agents as wakeable");
    expect(prompt).toContain("Use send only for tells/status where no reply or work is expected");
    expect(prompt).toContain("If the meaning is 'do this and get back to me,' or you are unsure, use ask");
    expect(prompt).toContain(`${scoutCli} ask --notify`);
    expect(prompt).toContain("For substantial reports, specs, code, diffs, logs, or research bundles, create or update a durable file when you have write access");
    expect(prompt).toContain("If you do not have write access, keep the reply useful inline");
    expect(prompt).toContain(scoutSkillPath);
  });

  test("legacy generated node-based prompts normalize away so bun defaults can replace them", () => {
    const legacyPrompt = renderLocalAgentSystemPromptTemplate(
      buildLocalAgentSystemPromptTemplate(),
      {
        agentId: "shaper",
        displayName: "Shaper",
        projectName: "shaper",
        projectPath: "/Users/arach/dev/shaper",
        brokerUrl: DEFAULT_BROKER_URL,
        relayCommand: `node ${JSON.stringify(join(repoRoot, "packages", "cli", "bin", "scout.mjs"))}`,
        projectsRoot: "/Users/arach/dev",
        relayHub: "/Users/arach/.openscout/relay",
        openscoutRoot: repoRoot,
        scoutSkill: scoutSkillPath,
      },
    );

    expect(
      normalizeLocalAgentSystemPrompt("shaper", "shaper", "/Users/arach/dev/shaper", legacyPrompt),
    ).toBeUndefined();
  });

  test("direct claude runtime prompt forbids reply tools for final-response capture", () => {
    process.env.OPENSCOUT_PROJECTS_ROOT = "/Users/arach/dev";
    process.env.OPENSCOUT_RELAY_HUB = "/Users/arach/.openscout/relay";

    const prompt = buildLocalAgentSystemPrompt(
      "shaper",
      "shaper",
      "/Users/arach/dev/shaper",
      { transport: "claude_stream_json" },
    );

    expect(prompt).toContain("OpenScout runtime:");
    expect(prompt).toContain("Do not call Scout reply tools for the final answer in this runtime");
    expect(prompt).toContain("the broker captures your final assistant message");
  });

  test("direct Pi RPC runtime prompt captures final responses through the broker", () => {
    process.env.OPENSCOUT_PROJECTS_ROOT = "/Users/arach/dev";
    process.env.OPENSCOUT_RELAY_HUB = "/Users/arach/.openscout/relay";

    const prompt = buildLocalAgentSystemPrompt(
      "minimax",
      "openscout",
      "/Users/arach/dev/openscout",
      { transport: "pi_rpc" },
    );

    expect(prompt).toContain("OpenScout runtime:");
    expect(prompt).toContain("Do not call Scout reply tools for the final answer in this runtime");
    expect(prompt).toContain("the broker captures your final assistant message");
  });

  test("tmux claude runtime remains the default local agent context", () => {
    process.env.OPENSCOUT_PROJECTS_ROOT = "/Users/arach/dev";
    process.env.OPENSCOUT_RELAY_HUB = "/Users/arach/.openscout/relay";

    const prompt = buildLocalAgentSystemPrompt(
      "shaper",
      "shaper",
      "/Users/arach/dev/shaper",
    );

    expect(prompt).toContain("Relay protocol:");
    expect(prompt).toContain("Use the Scout CLI for broker reads and writes");
    expect(prompt).not.toContain("OpenScout runtime:");
    expect(prompt).not.toContain("the broker captures your final assistant message");
  });

  test("explicit tmux generated prompts normalize away as current defaults", () => {
    process.env.OPENSCOUT_PROJECTS_ROOT = "/Users/arach/dev";
    process.env.OPENSCOUT_RELAY_HUB = "/Users/arach/.openscout/relay";

    const prompt = buildLocalAgentSystemPrompt(
      "shaper",
      "shaper",
      "/Users/arach/dev/shaper",
      { transport: "tmux" },
    );

    expect(
      normalizeLocalAgentSystemPrompt("shaper", "shaper", "/Users/arach/dev/shaper", prompt),
    ).toBeUndefined();
  });

  test("system prompt template renders shared fragments, path aliases, and env variables at wake time", () => {
    process.env.OPENSCOUT_TEST_PROMPT_VAR = "broker-ready";
    process.env.OPENSCOUT_PROJECTS_ROOT = "/Users/arach/dev";
    process.env.OPENSCOUT_RELAY_HUB = "/Users/arach/.openscout/relay";

    const prompt = renderLocalAgentSystemPromptTemplate(
      [
        buildLocalAgentSystemPromptTemplate(),
        "",
        "Base path: {{base_path}}",
        "Workspace root: {{workspace_root}}",
        "Protocol alias:",
        "{{protocol}}",
        "Flag: {{env.OPENSCOUT_TEST_PROMPT_VAR}}",
      ].join("\n"),
      {
        agentId: "shaper",
        displayName: "Shaper",
        projectName: "shaper",
        projectPath: "/Users/arach/dev/shaper",
        brokerUrl: DEFAULT_BROKER_URL,
        relayCommand: "bun relay",
        projectsRoot: "/Users/arach/dev",
        relayHub: "/Users/arach/.openscout/relay",
        openscoutRoot: repoRoot,
        scoutSkill: scoutSkillPath,
      },
    );

    expect(prompt).toContain('You are "shaper", a relay agent for the shaper project.');
    expect(prompt).toContain("Codebase root: /Users/arach/dev/shaper");
    expect(prompt).toContain("Projects root: /Users/arach/dev");
    expect(prompt).toContain("Base path: /Users/arach/dev");
    expect(prompt).toContain("Workspace root: /Users/arach/dev/shaper");
    expect(prompt).not.toContain(`Broker URL: ${DEFAULT_BROKER_URL}`);
    expect(prompt).toContain("Use the Scout CLI for broker reads and writes");
    expect(prompt).toContain("bun relay inbox --as shaper --latest 20 --json");
    expect(prompt).toContain("bun relay channel <name> --latest 20 --json");
    expect(prompt).toContain('bun relay send --to <agent> --as shaper "your message"');
    expect(prompt).toContain('bun relay ask --to <agent> --as shaper "your request"');
    expect(prompt).toContain("Do not curl broker HTTP endpoints to read messages");
    expect(prompt).toContain("Default Scout loop: resolve identity, resolve one target, choose DM vs explicit channel, keep follow-up in that same venue");
    expect(prompt).toContain("Keep one-to-one handoffs in a DM");
    expect(prompt).toContain("If you need multiple agents, use separate DMs or an explicit channel");
    expect(prompt).toContain("Treat known offline / on-demand agents as wakeable");
    expect(prompt).toContain("Use send only for tells/status where no reply or work is expected");
    expect(prompt).toContain("If the meaning is 'do this and get back to me,' or you are unsure, use ask");
    expect(prompt).toContain("bun relay ask --notify");
    expect(prompt).toContain(scoutSkillPath);
    expect(prompt).toContain("Flag: broker-ready");
  });

  test("nudge includes task, context, and relay reply instructions", () => {
    const prompt = buildLocalAgentNudge(
      "shaper",
      {
        id: "inv-1",
        requesterId: "hudson",
        requesterNodeId: "node-1",
        targetAgentId: "shaper",
        action: "consult",
        task: "Find the session restore race.",
        context: {
          file: "ShaperProvider.tsx",
        },
        conversationId: "dm.operator.shaper",
        messageId: "msg-request-1",
        ensureAwake: true,
        stream: false,
        createdAt: 1,
      },
      "flt-1",
    );

    expect(prompt).toContain("Task: Find the session restore race.");
    expect(prompt).toContain('Context: {"file":"ShaperProvider.tsx"}');
    expect(prompt).toContain(`${scoutCli} latest --agent shaper --limit 20`);
    expect(prompt).toContain("Reply in the existing thread, not by addressing @hudson.");
    expect(prompt).toContain(`${scoutCli} send --as shaper --ref msg-request-1 "[ask:flt-1] <your response>"`);
    expect(prompt).not.toContain("@hudson <your response>");
  });

  test("wake nudge delivers direct messages without reply marker instructions", () => {
    const prompt = buildLocalAgentNudge(
      "shaper",
      {
        id: "inv-1",
        requesterId: "hudson",
        requesterNodeId: "node-1",
        targetAgentId: "shaper",
        action: "wake",
        task: "The branch is ready for review.",
        ensureAwake: true,
        stream: false,
        createdAt: 1,
      },
      "flt-1",
    );

    expect(prompt).toContain("New broker message from hudson.");
    expect(prompt).toContain("Message: The branch is ready for review.");
    expect(prompt).toContain("not a reply-required ask");
    expect(prompt).toContain(`${scoutCli} latest --agent shaper --limit 20`);
    expect(prompt).not.toContain("[ask:flt-1]");
    expect(prompt).not.toContain(`${scoutCli} send --as shaper`);
  });

  test("nudge and invocation prompts surface originating message attachments", () => {
    const invocation = {
      id: "inv-1",
      requesterId: "hudson",
      requesterNodeId: "node-1",
      targetAgentId: "shaper",
      action: "wake",
      task: "Can you look at the screenshot?",
      context: {
        [SCOUT_MESSAGE_ATTACHMENTS_CONTEXT_KEY]: [
          {
            id: "att-1",
            mediaType: "image/png",
            fileName: "screenshot.png",
            url: "http://127.0.0.1:3200/api/blobs/blob-1",
          },
        ],
      },
      conversationId: "dm.operator.shaper",
      messageId: "msg-request-1",
      ensureAwake: true,
      stream: false,
      createdAt: 1,
    } as const;

    const nudge = buildLocalAgentNudge("shaper", invocation, "flt-1");
    const directPrompt = buildLocalAgentDirectInvocationPrompt("shaper", invocation);

    for (const prompt of [nudge, directPrompt]) {
      expect(prompt).toContain("Attachments:");
      expect(prompt).toContain("- screenshot.png (image/png): http://127.0.0.1:3200/api/blobs/blob-1");
      expect(prompt).toContain("Fetch/open the attachment URL");
      expect(prompt).not.toContain(SCOUT_MESSAGE_ATTACHMENTS_CONTEXT_KEY);
    }
  });

  test("attachment prompts resolve blobKey via web origin and omit unfetchable locators", () => {
    const previous = process.env.OPENSCOUT_WEB_BUN_URL;
    process.env.OPENSCOUT_WEB_BUN_URL = "http://127.0.0.1:43200";
    try {
      const withBlobKey = {
        id: "inv-blob",
        requesterId: "hudson",
        requesterNodeId: "node-1",
        targetAgentId: "shaper",
        action: "wake" as const,
        task: "Inspect the image",
        context: {
          [SCOUT_MESSAGE_ATTACHMENTS_CONTEXT_KEY]: [
            {
              id: "att-blob",
              mediaType: "image/png",
              fileName: "shot.png",
              blobKey: "blob-42",
            },
            {
              id: "att-relative",
              mediaType: "image/png",
              fileName: "relative.png",
              url: "/api/blobs/blob-rel",
            },
            {
              id: "att-other-path",
              mediaType: "text/plain",
              fileName: "notes.txt",
              url: "/api/other/notes.txt",
            },
          ],
        },
        conversationId: "dm.operator.shaper",
        messageId: "msg-1",
        ensureAwake: true,
        stream: false,
        createdAt: 1,
      };
      const prompt = buildLocalAgentDirectInvocationPrompt("shaper", withBlobKey);
      expect(prompt).toContain("- shot.png (image/png): http://127.0.0.1:43200/api/blobs/blob-42");
      expect(prompt).toContain("- relative.png (image/png): http://127.0.0.1:43200/api/blobs/blob-rel");
      expect(prompt).not.toContain("notes.txt");
      expect(prompt).not.toContain("/api/other/notes.txt");
      expect(prompt).not.toContain("blob:blob-42");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENSCOUT_WEB_BUN_URL;
      } else {
        process.env.OPENSCOUT_WEB_BUN_URL = previous;
      }
    }

    const previousMissing = process.env.OPENSCOUT_WEB_BUN_URL;
    const previousPublic = process.env.OPENSCOUT_WEB_PUBLIC_ORIGIN;
    const previousVite = process.env.OPENSCOUT_WEB_VITE_URL;
    delete process.env.OPENSCOUT_WEB_BUN_URL;
    delete process.env.OPENSCOUT_WEB_PUBLIC_ORIGIN;
    delete process.env.OPENSCOUT_WEB_VITE_URL;
    try {
      const blobOnly = {
        id: "inv-orphan",
        requesterId: "hudson",
        requesterNodeId: "node-1",
        targetAgentId: "shaper",
        action: "wake" as const,
        task: "Inspect the image",
        context: {
          [SCOUT_MESSAGE_ATTACHMENTS_CONTEXT_KEY]: [
            {
              id: "att-orphan",
              mediaType: "image/png",
              blobKey: "blob-missing-origin",
            },
          ],
        },
        conversationId: "dm.operator.shaper",
        messageId: "msg-2",
        ensureAwake: true,
        stream: false,
        createdAt: 1,
      };
      const prompt = buildLocalAgentDirectInvocationPrompt("shaper", blobOnly);
      expect(prompt).not.toContain("Attachments:");
      expect(prompt).not.toContain("blob:blob-missing-origin");
    } finally {
      if (previousMissing === undefined) {
        delete process.env.OPENSCOUT_WEB_BUN_URL;
      } else {
        process.env.OPENSCOUT_WEB_BUN_URL = previousMissing;
      }
      if (previousPublic === undefined) {
        delete process.env.OPENSCOUT_WEB_PUBLIC_ORIGIN;
      } else {
        process.env.OPENSCOUT_WEB_PUBLIC_ORIGIN = previousPublic;
      }
      if (previousVite === undefined) {
        delete process.env.OPENSCOUT_WEB_VITE_URL;
      } else {
        process.env.OPENSCOUT_WEB_VITE_URL = previousVite;
      }
    }
  });

  test("direct invocation prompt starts with a compact Scout title and collapses routing context", () => {
    const prompt = buildLocalAgentDirectInvocationPrompt(
      "ranger",
      {
        id: "inv-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "ranger",
        action: "consult",
        task: "Review how invocation prompt titles should read in Codex conversations.",
        conversationId: "dm.operator.ranger.main.mini",
        messageId: "msg-moi5w7kt-1hjg5e",
        execution: {
          session: "new",
        },
        ensureAwake: true,
        stream: false,
        createdAt: 1,
      },
    );

    expect(prompt.startsWith("⌖ @operator → @ranger · ask:1hjg5e › Review how invocation prompt titles should read in Codex conversations.\ndelivery: waking · session: fresh session\n\n")).toBe(true);
    expect(prompt.replace(/\n/g, "")).toContain("@operator → @ranger · ask:1hjg5e › Review how invocation prompt titles should read in Codex conversations.delivery: waking · session: fresh session");
    expect(prompt).toContain("<!-- SCOUT BROKER REPLY MODE -->");
    expect(prompt).toContain("<!-- SCOUT SESSION SEARCH -->");
    expect(prompt).toContain("prefer `scout search`");
    expect(prompt).toContain("scout search index --source sessions");
    expect(prompt).toContain("<!-- SCOUT ARTIFACT GUIDANCE -->");
    expect(prompt).toContain("For long-form deliverables, prefer a durable file when you have write access");
    expect(prompt).toContain("Inline replies are still valid");
    expect(prompt).toContain("ScoutReplyContext:");
    expect(prompt).toContain("<summary>Scout routing context</summary>");
    expect(prompt).toContain("Do not publish a separate acknowledgement or progress update through Scout for this request.");
    expect(prompt).toContain("Do not call `messages_reply`, `scout_reply`, `scout send`, `messages_send`, or `ask` to answer this request.");
    expect(prompt).toContain('"mode": "broker_reply"');
    expect(prompt).toContain('"fromAgentId": "operator"');
    expect(prompt).toContain('"toAgentId": "ranger"');
    expect(prompt).toContain('"conversationId": "dm.operator.ranger.main.mini"');
    expect(prompt).toContain('"messageId": "msg-moi5w7kt-1hjg5e"');
    expect(prompt).toContain('"replyToMessageId": "msg-moi5w7kt-1hjg5e"');
    expect(prompt).toContain('"replyPath": "final_response"');
    expect(prompt).not.toContain("First, immediately publish a short broker-visible acknowledgement");
    expect(prompt).not.toContain("[scout] @operator asks @ranger");
    expect(prompt).not.toContain("meta: from=operator to=ranger action=consult");
    expect(prompt).not.toContain("ref: convo=dm.operator.ranger.main.mini msg=msg-moi5w7kt-1hjg5e");
    expect(prompt).not.toContain("OpenScout invocation for");
    expect(prompt).not.toContain("Requester:");
    expect(prompt).not.toContain("Action:");
  });

  test("Codex broker invocation writes reply context outside the app-server driver", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-local-codex-reply-context-test-"));
    tempPaths.add(tempRoot);
    const supportDirectory = join(tempRoot, "support");
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = supportDirectory;
    const { executablePath, observedContextPath } = writeReplyContextAwareCodexExecutable(tempRoot);
    process.env.OPENSCOUT_CODEX_BIN = executablePath;

    const agentName = "codex-here";
    const sessionId = "attached-codex-reply-context";
    const cwd = process.cwd();
    const runtimeDirectory = join(supportDirectory, "runtime", "agents", agentName);
    const logsDirectory = join(runtimeDirectory, "logs");

    try {
      const result = await invokeLocalAgentEndpoint(
        {
          agentId: agentName,
          harness: "codex",
          transport: "codex_app_server",
          cwd,
          projectRoot: cwd,
          sessionId,
          metadata: {
            agentName,
            source: "local-session",
            attachedTransport: "codex_app_server",
            threadId: "thread-reply-context-1",
            sessionBacked: true,
          },
        } as any,
        {
          id: "inv-reply-context",
          requesterId: "sender.agent",
          requesterNodeId: "node-1",
          targetAgentId: agentName,
          action: "consult",
          task: "observe reply context",
          conversationId: "dm.sender.codex",
          messageId: "msg-original",
          ensureAwake: true,
          stream: false,
          createdAt: 1,
          timeoutMs: 5_000,
        } as any,
      );

      expect(result.output).toBe("Reply context observed");

      const observed = JSON.parse(readFileSync(observedContextPath, "utf8")) as {
        contextPath?: string;
        exists?: boolean;
        context?: {
          conversationId?: string;
          replyToMessageId?: string;
          replyPath?: string;
        } | null;
      };
      const expectedContextPath = join(runtimeDirectory, "scout-reply-context.json");
      expect(observed.exists).toBe(true);
      expect(observed.contextPath).toBe(expectedContextPath);
      expect(observed.context).toMatchObject({
        conversationId: "dm.sender.codex",
        replyToMessageId: "msg-original",
        replyPath: "final_response",
      });
      expect(existsSync(expectedContextPath)).toBe(false);
    } finally {
      await shutdownCodexAppServerAgent({
        agentName,
        sessionId,
        cwd,
        systemPrompt: "Resume the existing session without changing its identity or prior context.",
        runtimeDirectory,
        logsDirectory,
        threadId: "thread-reply-context-1",
        requireExistingThread: true,
        launchArgs: [],
        env: {
          OPENSCOUT_REPLY_CONTEXT_FILE: join(runtimeDirectory, "scout-reply-context.json"),
        },
      }, { resetThread: true }).catch(() => undefined);
    }
  });

  test("direct wake follow-up prompt does not expose the standing collaboration contract", () => {
    useTestOperatorIdentity("Arach", "arach");

    const prompt = buildLocalAgentDirectInvocationPrompt(
      "openscout-codex.main.arachs-mac-mini-local",
      {
        id: "inv-wake-08vm",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "openscout-codex.main.arachs-mac-mini-local",
        action: "wake",
        task: "hello?",
        messageId: "msg-wake-08vm",
        execution: {
          session: "existing",
        },
        ensureAwake: true,
        stream: false,
        createdAt: 1,
        metadata: {
          requesterDisplayName: "Arach",
        },
      },
    );

    expect(prompt).toBe([
      "⌖ Arach (@arach) → @openscout-codex.main.arachs-mac-mini-local · wake:08vm › hello?",
      "delivery: routed · session: continuing session",
      "",
      "Treat this as a message/update, not a reply-required ask. Continue your current work and reply only if useful.",
      "",
      "Task:",
      "hello?",
    ].join("\n"));
    expect(prompt).not.toContain("Collaboration contract:");
    expect(prompt).not.toContain("Default loop:");
    expect(prompt).not.toContain("Return only the broker-visible reply");
  });

  test("direct invocation prompt shows configured actor display names without losing ids", () => {
    useTestOperatorIdentity("Arach", "arach");
    const prompt = buildLocalAgentDirectInvocationPrompt(
      "ranger",
      {
        id: "inv-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "ranger",
        action: "consult",
        task: "Review the handoff labels.",
        conversationId: "dm.operator.ranger.main.mini",
        messageId: "msg-moi5w7kt-1hjg5e",
        execution: {
          session: "new",
        },
        ensureAwake: true,
        stream: false,
        createdAt: 1,
        metadata: {
          requesterDisplayName: "Arach",
          targetDisplayName: "Ranger",
        },
      },
    );

    expect(prompt.startsWith(
      "⌖ Arach (@arach) → Ranger (@ranger) · ask:1hjg5e › Review the handoff labels.",
    )).toBe(true);
    expect(prompt).toContain('"fromAgentId": "operator"');
    expect(prompt).toContain('"toAgentId": "ranger"');
  });

  test("direct invocation prompt skips fenced protocol blocks when summarizing title text", () => {
    const prompt = buildLocalAgentDirectInvocationPrompt(
      "ranger",
      {
        id: "inv-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "ranger",
        action: "execute",
        task: [
          "```",
          "OpenScout invocation for ranger.",
          "Requester: operator.",
          "```",
          "",
          "Improve the Scout invocation title format.",
        ].join("\n"),
        execution: {
          session: "new",
        },
        ensureAwake: true,
        stream: false,
        createdAt: 1,
      },
    );

    expect(prompt.startsWith("⌖ @operator → @ranger · task:inv-1 › Improve the Scout invocation title format.\ndelivery: waking · session: fresh session\n\n")).toBe(true);
    expect(prompt).toContain("<!-- SCOUT BROKER REPLY MODE -->");
    expect(prompt).not.toContain("meta: from=operator to=ranger action=execute");
  });

  test("direct invocation opener gives sidebar previews a visible payload boundary", () => {
    const prompt = buildLocalAgentDirectInvocationPrompt(
      "ranger",
      {
        id: "inv-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "ranger",
        action: "consult",
        task: "Hey — @arach asked me to verify whether the invocation preview title is coming from a stale Claude session before changing code. Then patch the runtime if needed.",
        conversationId: "dm.operator.ranger.main.mini",
        messageId: "msg-recent-t5if6t",
        execution: {
          session: "new",
        },
        ensureAwake: true,
        stream: false,
        createdAt: 1,
      },
    );

    expect(prompt.startsWith("⌖ @operator → @ranger · ask:t5if6t › Hey — @arach asked me to verify whether the invocation preview title is coming from a stale...\ndelivery: waking · session: fresh session\n\n")).toBe(true);
    expect(prompt).not.toContain("ask:t5if6t\n\nHey");
    expect(prompt).not.toContain("ask:t5if6tHey");
  });

  test("attached session invocation prompt uses the same Scout opener", () => {
    const prompt = buildAttachedSessionInvocationPrompt(
      {
        id: "inv-1",
        requesterId: "operator",
        requesterNodeId: "node-1",
        targetAgentId: "ranger",
        action: "status",
        task: "Check whether the broker reply landed.",
        conversationId: "dm.operator.ranger.main.mini",
        messageId: "msg-attached-abc123",
        execution: {
          session: "existing",
        },
        ensureAwake: true,
        stream: false,
        createdAt: 1,
      },
      "ranger",
    );

    expect(prompt.startsWith("⌖ @operator → @ranger · status:abc123 › Check whether the broker reply landed.\ndelivery: routed · session: continuing session\n\n")).toBe(true);
    expect(prompt).toContain("<!-- SCOUT BROKER REPLY MODE -->");
    expect(prompt).toContain('"conversationId": "dm.operator.ranger.main.mini"');
    expect(prompt).toContain('"replyToMessageId": "msg-attached-abc123"');
    expect(prompt).not.toContain("[scout] @operator checks @ranger");
    expect(prompt).not.toContain("meta: from=operator to=ranger action=status");
    expect(prompt).toContain("Treat this as a direct message to the current session, but return only the broker-visible reply for Scout delivery.");
    expect(prompt).not.toContain("Scout message from");
    expect(prompt).not.toContain("Requested action:");
  });

  test("claude runtime launch args preapprove Scout MCP coordination tools", () => {
    const args = normalizeClaudeRuntimeLaunchArgs(["--model", "sonnet"]);

    expect(args).toEqual([
      "--model",
      "sonnet",
      "--allowedTools",
      DEFAULT_CLAUDE_SCOUT_ALLOWED_TOOLS.join(","),
    ]);
  });

  test("claude runtime launch args preserve explicit allowed tools", () => {
    const args = normalizeClaudeRuntimeLaunchArgs([
      "--allowedTools",
      "Read,Grep",
      "--model",
      "sonnet",
    ]);

    expect(args).toEqual([
      "--allowedTools",
      "Read,Grep",
      "--model",
      "sonnet",
    ]);
  });

  test("grok runtime launch args preapprove Scout MCP coordination tools", () => {
    const args = normalizeGrokRuntimeLaunchArgs(["--model", "grok-4.3"]);

    expect(args).toEqual([
      "--model",
      "grok-4.3",
      "--allowedTools",
      DEFAULT_CLAUDE_SCOUT_ALLOWED_TOOLS.join(","),
    ]);
  });

  test("grok runtime launch args preserve explicit allow rules", () => {
    const args = normalizeGrokRuntimeLaunchArgs([
      "--allow",
      "Read",
      "--model",
      "grok-4.3",
    ]);

    expect(args).toEqual([
      "--allow",
      "Read",
      "--model",
      "grok-4.3",
    ]);
  });
});

describe("local agent reply cleanup", () => {
  test("strips ask ids and asker mentions from replies", () => {
    const cleaned = stripLocalAgentReplyMetadata(
      "[ask:flt-1] @hudson SHAPER_BROKER_OK",
      "flt-1",
      "hudson",
    );

    expect(cleaned).toBe("SHAPER_BROKER_OK");
  });
});

describe("local agent broker snapshots", () => {
  test("treats missing or malformed broker snapshot messages as empty", () => {
    expect(brokerSnapshotMessages(undefined)).toEqual([]);
    expect(brokerSnapshotMessages({})).toEqual([]);
    expect(brokerSnapshotMessages({ messages: null })).toEqual([]);
    expect(brokerSnapshotMessages({ messages: [] })).toEqual([]);
  });

  test("filters malformed broker snapshot messages", () => {
    expect(brokerSnapshotMessages({
      messages: {
        valid: {
          actorId: "agent-1",
          body: "ready",
          createdAt: 123,
        },
        missingBody: {
          actorId: "agent-2",
          createdAt: 124,
        },
        badTimestamp: {
          actorId: "agent-3",
          body: "bad",
          createdAt: "124",
        },
      },
    })).toEqual([
      {
        actorId: "agent-1",
        body: "ready",
        createdAt: 123,
      },
    ]);
  });
});

describe("listArchivedLocalAgentIds", () => {
  function useIsolatedSupportDirectory(): string {
    const dir = mkdtempSync(join(tmpdir(), "openscout-support-"));
    tempPaths.add(dir);
    process.env.OPENSCOUT_SUPPORT_DIRECTORY = dir;
    return dir;
  }

  test("returns an empty list when the registry is missing", async () => {
    useIsolatedSupportDirectory();
    expect(await listArchivedLocalAgentIds()).toEqual([]);
  });

  test("lists archived ids and sees registry rewrites through the memo", async () => {
    const dir = useIsolatedSupportDirectory();
    const registryPath = join(dir, "relay-agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        "alpha.node": { archivedAt: 1_700_000_000_000 },
        "bravo.node": {},
      },
    }), "utf8");

    expect(await listArchivedLocalAgentIds()).toEqual(["alpha.node"]);
    // Warm the memo, then rewrite the registry: the stat key (mtime + size)
    // must drop the cached parse so the new flags are seen.
    expect(await listArchivedLocalAgentIds()).toEqual(["alpha.node"]);
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        "alpha.node": {},
        "bravo.node": { archivedAt: 1_700_000_000_001 },
        "charlie.node": { archivedAt: "not-a-number" },
      },
    }), "utf8");
    expect(await listArchivedLocalAgentIds()).toEqual(["bravo.node"]);
  });
});
