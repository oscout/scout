import type {
  ActorIdentity,
  AgentDefinition,
  AgentEndpoint,
  AgentCapability,
} from "@openscout/protocol";
import {
  getLocalAgentConfig,
  SUPPORTED_LOCAL_AGENT_HARNESSES,
  updateLocalAgentConfig,
} from "@openscout/runtime/local-agents";
import type { RuntimeRegistrySnapshot } from "@openscout/runtime/registry";
import { relayAgentLogsDirectory, relayAgentRuntimeDirectory } from "@openscout/runtime/support-paths";

import { loadScoutBrokerContext } from "../../core/broker/service.ts";

export type ScoutDesktopAgentConfigRuntime = {
  cwd: string;
  projectRoot: string | null;
  harness: string;
  transport: string;
  sessionId: string;
  wakePolicy: string;
  source: string | null;
};

export type ScoutDesktopAgentConfigToolUse = {
  launchArgsText: string;
};

export type ScoutDesktopAgentConfigState = {
  agentId: string;
  editable: boolean;
  model: string | null;
  title: string;
  typeLabel: string | null;
  applyModeLabel: string | null;
  note: string | null;
  systemPromptHint: string | null;
  availableHarnesses: string[];
  runtime: ScoutDesktopAgentConfigRuntime;
  systemPrompt: string;
  toolUse: ScoutDesktopAgentConfigToolUse;
  capabilitiesText: string;
};

export type ScoutDesktopUpdateAgentConfigInput = {
  agentId: string;
  model?: string | null;
  runtime: {
    cwd: string;
    harness: string;
    sessionId: string;
    transport?: string;
  };
  systemPrompt: string;
  toolUse: ScoutDesktopAgentConfigToolUse;
  capabilitiesText: string;
};

function compactHomePath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const home = process.env.HOME ?? "";
  return home && value.startsWith(home) ? value.replace(home, "~") : value;
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function splitDelimitedTokens(value: string): string[] {
  return value
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeLocalAgentHarness(value: string): string {
  const trimmed = value.trim();
  return SUPPORTED_LOCAL_AGENT_HARNESSES.includes(trimmed as (typeof SUPPORTED_LOCAL_AGENT_HARNESSES)[number])
    ? trimmed
    : "claude";
}

function activeEndpoint(snapshot: RuntimeRegistrySnapshot, agentId: string): AgentEndpoint | null {
  const candidates = Object.values(snapshot.endpoints as Record<string, AgentEndpoint>).filter(
    (endpoint) => endpoint.agentId === agentId,
  );
  const rank = (state: string | undefined) => {
    switch (state) {
      case "active":
        return 0;
      case "idle":
        return 1;
      case "waiting":
        return 2;
      case "offline":
        return 5;
      default:
        return 4;
    }
  };

  return [...candidates].sort((left, right) => rank(left.state) - rank(right.state))[0] ?? null;
}

function agentTypeLabel(agent: AgentDefinition | null | undefined): string {
  if (!agent) {
    return "Agent";
  }
  if (agent.agentClass === "system") {
    return "System";
  }
  if (agent.metadata?.source === "relay-agent-registry") {
    return "Agent";
  }
  return "Built-in Role";
}

function buildUnavailableAgentState(agentId: string): ScoutDesktopAgentConfigState {
  return {
    agentId,
    editable: false,
    model: null,
    title: agentId,
    typeLabel: "Agent",
    applyModeLabel: null,
    note: "The selected agent is not currently present in the broker snapshot.",
    systemPromptHint: null,
    availableHarnesses: [...SUPPORTED_LOCAL_AGENT_HARNESSES],
    runtime: {
      cwd: "",
      projectRoot: null,
      harness: "",
      transport: "",
      sessionId: "",
      wakePolicy: "",
      source: null,
    },
    systemPrompt: "Agent system prompt unavailable.",
    toolUse: {
      launchArgsText: "",
    },
    capabilitiesText: "",
  };
}

function buildLocalAgentConfigState(
  agentId: string,
  agentConfig: NonNullable<Awaited<ReturnType<typeof getLocalAgentConfig>>>,
): ScoutDesktopAgentConfigState {
  const runtimeDirectory = relayAgentRuntimeDirectory(agentId);
  const logsDirectory = relayAgentLogsDirectory(agentId);

  return {
    agentId,
    editable: agentConfig.editable,
    model: agentConfig.model,
    title: agentId,
    typeLabel: "Agent",
    applyModeLabel: "Save changes, then restart to apply runtime, prompt, and capability updates.",
    note: `Stored in the canonical agent registry. Runtime files live at ${compactHomePath(runtimeDirectory) ?? runtimeDirectory} and logs at ${compactHomePath(logsDirectory) ?? logsDirectory}.`,
    systemPromptHint: agentConfig.templateHint,
    availableHarnesses: [...SUPPORTED_LOCAL_AGENT_HARNESSES],
    runtime: {
      cwd: compactHomePath(agentConfig.runtime.cwd) ?? agentConfig.runtime.cwd,
      projectRoot: compactHomePath(agentConfig.runtime.cwd),
      harness: agentConfig.runtime.harness,
      transport: agentConfig.runtime.transport,
      sessionId: agentConfig.runtime.sessionId,
      wakePolicy: agentConfig.runtime.wakePolicy,
      source: "relay-agent-registry",
    },
    systemPrompt: agentConfig.systemPrompt,
    toolUse: {
      launchArgsText: agentConfig.launchArgs.join("\n"),
    },
    capabilitiesText: agentConfig.capabilities.join(", "),
  };
}

function buildBrokerAgentConfigState(
  agentId: string,
  snapshot: RuntimeRegistrySnapshot,
): ScoutDesktopAgentConfigState {
  const agent = snapshot.agents[agentId] as AgentDefinition | undefined;
  const endpoint = activeEndpoint(snapshot, agentId);

  if (!agent) {
    return buildUnavailableAgentState(agentId);
  }

  const role = typeof agent.metadata?.role === "string" ? String(agent.metadata.role) : "Not reported";
  const summary = typeof agent.metadata?.summary === "string" ? String(agent.metadata.summary) : "Not reported";
  const capabilities = Array.isArray(agent.capabilities) && agent.capabilities.length > 0
    ? agent.capabilities.join(", ")
    : "Not reported";

  return {
    agentId,
    editable: false,
    model: typeof endpoint?.metadata?.model === "string"
      ? String(endpoint.metadata.model)
      : typeof agent.metadata?.model === "string"
        ? String(agent.metadata.model)
        : null,
    title: agent.displayName ?? agentId,
    typeLabel: agentTypeLabel(agent),
    applyModeLabel: null,
    note: "Built-in role agents are not editable yet.",
    systemPromptHint: null,
    availableHarnesses: [...SUPPORTED_LOCAL_AGENT_HARNESSES],
    runtime: {
      cwd: compactHomePath(endpoint?.cwd) ?? "",
      projectRoot: compactHomePath(endpoint?.projectRoot ?? endpoint?.cwd),
      harness: endpoint?.harness ?? "",
      transport: endpoint?.transport ?? "",
      sessionId: endpoint?.sessionId ?? "",
      wakePolicy: agent.wakePolicy ?? "",
      source: typeof agent.metadata?.source === "string" ? String(agent.metadata.source) : null,
    },
    systemPrompt: [
      `Display name: ${agent.displayName ?? agentId}`,
      `Class: ${agent.agentClass ?? "Not reported"}`,
      `Role: ${role}`,
      `Summary: ${summary}`,
      `Capabilities: ${capabilities}`,
    ].join("\n"),
    toolUse: {
      launchArgsText: "",
    },
    capabilitiesText: Array.isArray(agent.capabilities) ? agent.capabilities.join(", ") : "",
  };
}

export async function getScoutDesktopAgentConfig(agentId: string): Promise<ScoutDesktopAgentConfigState> {
  const agentConfig = await getLocalAgentConfig(agentId);
  if (agentConfig) {
    return buildLocalAgentConfigState(agentId, agentConfig);
  }

  const broker = await loadScoutBrokerContext();
  if (!broker) {
    return buildUnavailableAgentState(agentId);
  }

  return buildBrokerAgentConfigState(agentId, broker.snapshot);
}

export async function updateScoutDesktopAgentConfig(
  input: ScoutDesktopUpdateAgentConfigInput,
): Promise<ScoutDesktopAgentConfigState> {
  const nextConfig = await updateLocalAgentConfig(input.agentId, {
    runtime: {
      cwd: input.runtime.cwd,
      harness: normalizeLocalAgentHarness(input.runtime.harness),
      sessionId: input.runtime.sessionId,
      transport: input.runtime.transport,
    },
    systemPrompt: input.systemPrompt,
    launchArgs: splitLines(input.toolUse.launchArgsText),
    model: input.model,
    capabilities: splitDelimitedTokens(input.capabilitiesText) as AgentCapability[],
  });

  if (!nextConfig) {
    throw new Error(`Agent ${input.agentId} is not an editable relay agent.`);
  }

  return buildLocalAgentConfigState(input.agentId, nextConfig);
}
