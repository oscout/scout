import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  ObservedHarnessAgent,
  ObservedHarnessGroup,
  ObservedHarnessRelationship,
  ObservedHarnessSourceRef,
  ObservedHarnessTask,
  ObservedHarnessTopology,
} from "../../protocol/primitives.js";

export type CodexObservedTopologyOptions = {
  cwd?: string;
  homeDir?: string;
  threadId?: string | null;
  threadPath?: string | null;
  sessionName?: string;
  now?: () => Date;
};

const TOPOLOGY_SCHEMA_VERSION = "openscout.observed-harness-topology.v1" as const;
const CODEX_TOPOLOGY_SOURCE = "codex-subagents";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stableSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function sourceRefId(kind: string, value: string): string {
  return `${kind}:${stableSegment(value)}`;
}

function statIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function stripTomlComment(line: string): string {
  let inQuote = false;
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === "\"" || char === "'") && line[index - 1] !== "\\") {
      if (!inQuote) {
        inQuote = true;
        quote = char;
      } else if (quote === char) {
        inQuote = false;
        quote = "";
      }
    }
    if (char === "#" && !inQuote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlScalar(value: string): string | number | boolean | string[] {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1)
      .split(",")
      .map((entry) => String(parseTomlScalar(entry.trim())))
      .filter(Boolean);
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  return trimmed;
}

function parseTomlKeyValues(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let activeMultilineKey: string | null = null;
  let activeMultilineValue: string[] = [];

  for (const originalLine of raw.split(/\r?\n/)) {
    if (activeMultilineKey) {
      const endIndex = originalLine.indexOf('"""');
      if (endIndex === -1) {
        activeMultilineValue.push(originalLine);
        continue;
      }
      activeMultilineValue.push(originalLine.slice(0, endIndex));
      result[activeMultilineKey] = activeMultilineValue.join("\n");
      activeMultilineKey = null;
      activeMultilineValue = [];
      continue;
    }

    const line = stripTomlComment(originalLine).trim();
    if (!line || line.startsWith("[")) {
      continue;
    }

    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    if (rawValue.startsWith('"""')) {
      const afterStart = rawValue.slice(3);
      const endIndex = afterStart.indexOf('"""');
      if (endIndex === -1) {
        activeMultilineKey = key;
        activeMultilineValue = [afterStart];
      } else {
        result[key] = afterStart.slice(0, endIndex);
      }
      continue;
    }

    result[key] = parseTomlScalar(rawValue);
  }

  return result;
}

function readTomlKeyValues(path: string): Record<string, unknown> | null {
  try {
    return parseTomlKeyValues(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function readAgentDefinitions(
  root: string,
  scope: "project" | "user",
): {
  agents: ObservedHarnessAgent[];
  sourceRefs: ObservedHarnessSourceRef[];
} {
  const agentsDir = join(root, ".codex", "agents");
  if (!existsSync(agentsDir) || !statIsDirectory(agentsDir)) {
    return { agents: [], sourceRefs: [] };
  }

  const agents: ObservedHarnessAgent[] = [];
  const sourceRefs: ObservedHarnessSourceRef[] = [];
  for (const entry of readdirSync(agentsDir).sort()) {
    if (!entry.endsWith(".toml")) continue;
    const path = join(agentsDir, entry);
    if (!statIsFile(path)) continue;
    const parsed = readTomlKeyValues(path);
    if (!parsed) continue;

    const name = firstString(parsed, ["name"]) ?? basename(entry, ".toml");
    const description = firstString(parsed, ["description"]);
    const model = firstString(parsed, ["model"]);
    const sandboxMode = firstString(parsed, ["sandbox_mode", "sandbox"]);
    const reasoningEffort = firstString(parsed, ["model_reasoning_effort", "reasoning_effort"]);
    const refId = sourceRefId("codex-agent-definition", `${scope}:${path}`);

    sourceRefs.push({
      id: refId,
      kind: "file",
      ref: path,
      label: `Codex ${scope} agent ${name}`,
    });
    agents.push({
      id: `codex-agent-definition:${scope}:${stableSegment(name)}`,
      name,
      role: "definition",
      type: "custom_agent",
      status: "available",
      model,
      sourceRef: refId,
      providerMeta: {
        scope,
        description,
        sandboxMode,
        reasoningEffort,
      },
    });
  }

  return { agents, sourceRefs };
}

function readProjectAgentsConfig(cwd: string | undefined): {
  group?: ObservedHarnessGroup;
  sourceRef?: ObservedHarnessSourceRef;
} {
  if (!cwd) return {};
  const configPath = join(cwd, ".codex", "config.toml");
  if (!existsSync(configPath) || !statIsFile(configPath)) {
    return {};
  }

  const parsed = readTomlKeyValues(configPath);
  if (!parsed) return {};

  const refId = sourceRefId("codex-config", configPath);
  return {
    sourceRef: {
      id: refId,
      kind: "file",
      ref: configPath,
      label: "Codex project config",
    },
    group: {
      id: `codex-agent-config:${stableSegment(cwd)}`,
      kind: "agent_config",
      name: "Codex agent configuration",
      sourceRef: refId,
      providerMeta: {
        maxThreads: numberValue(parsed.max_threads),
        maxDepth: numberValue(parsed.max_depth),
      },
    },
  };
}

function agentIdForThread(threadId: string): string {
  return `codex-thread-agent:${stableSegment(threadId)}`;
}

function taskStateFromStatus(value: unknown, fallback = "running"): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isObject(value)) {
    const nested = stringValue(value.type) ?? stringValue(value.status);
    if (nested) return nested;
  }
  return fallback;
}

function itemString(item: Record<string, unknown>, keys: string[]): string | undefined {
  return firstString(item, keys);
}

export class CodexObservedTopologyTracker {
  private threadId: string | null;
  private threadPath: string | null;
  private cwd: string | undefined;
  private sessionName: string | undefined;
  private readonly homeDir: string;
  private readonly now: () => Date;
  private readonly liveAgents = new Map<string, ObservedHarnessAgent>();
  private readonly liveTasks = new Map<string, ObservedHarnessTask>();
  private readonly liveRelationships = new Map<string, ObservedHarnessRelationship>();
  private readonly liveSourceRefs = new Map<string, ObservedHarnessSourceRef>();

  constructor(options: CodexObservedTopologyOptions = {}) {
    this.threadId = options.threadId?.trim() || null;
    this.threadPath = options.threadPath?.trim() || null;
    this.cwd = options.cwd;
    this.sessionName = options.sessionName;
    this.homeDir = options.homeDir ?? homedir();
    this.now = options.now ?? (() => new Date());
  }

  updateThread(thread: Record<string, unknown>): void {
    const threadId = stringValue(thread.id);
    const threadPath = stringValue(thread.path);
    const cwd = stringValue(thread.cwd);
    const name = stringValue(thread.name);
    if (threadId) this.threadId = threadId;
    if (threadPath) this.threadPath = threadPath;
    if (cwd) this.cwd = cwd;
    if (name) this.sessionName = name;
  }

  observeItem(item: Record<string, unknown>, phase: "started" | "completed"): boolean {
    const type = stringValue(item.type);
    if (!type) return false;

    if (type === "subagent") {
      this.observeSubagentItem(item, phase);
      return true;
    }

    if (type === "collabToolCall") {
      this.observeCollabToolCall(item, phase);
      return true;
    }

    return false;
  }

  private ensureThreadAgent(threadId: string, name?: string, sourceRef?: string): string {
    const id = agentIdForThread(threadId);
    if (!this.liveAgents.has(id)) {
      this.liveAgents.set(id, {
        id,
        name,
        role: threadId === this.threadId ? "lead" : "subagent",
        type: "thread",
        status: "observed",
        externalSessionId: threadId,
        cwd: this.cwd,
        sourceRef,
      });
    }
    return id;
  }

  private observeSubagentItem(item: Record<string, unknown>, phase: "started" | "completed"): void {
    const itemId = itemString(item, ["id"]) ?? crypto.randomUUID();
    const itemSourceRef = `codex-item:${stableSegment(itemId)}`;
    this.liveSourceRefs.set(itemSourceRef, {
      id: itemSourceRef,
      kind: "event",
      ref: itemId,
      label: "Codex subagent item",
    });
    const rawAgentId = itemString(item, ["agentId", "agent_id"]) ?? itemId;
    const agentName = itemString(item, ["agentName", "agent_name", "name"]);
    const prompt = itemString(item, ["prompt", "description"]);
    const agentId = `codex-subagent:${stableSegment(rawAgentId)}`;
    const leadId = this.threadId ? this.ensureThreadAgent(this.threadId, this.sessionName) : null;

    this.liveAgents.set(agentId, {
      id: agentId,
      name: agentName,
      role: "subagent",
      type: itemString(item, ["agentType", "agent_type"]) ?? "subagent",
      status: phase === "completed" ? "completed" : taskStateFromStatus(item.status),
      externalSessionId: itemString(item, ["threadId", "newThreadId", "receiverThreadId"]),
      sourceRef: itemSourceRef,
      providerMeta: {
        codexAgentId: rawAgentId,
      },
    });

    const taskId = `codex-task:${stableSegment(itemId)}`;
    this.liveTasks.set(taskId, {
      id: taskId,
      title: prompt ?? agentName ?? "Codex subagent task",
      state: phase === "completed" ? "completed" : taskStateFromStatus(item.status),
      assigneeId: agentId,
      sourceRef: itemSourceRef,
      providerMeta: {
        codexItemId: itemId,
      },
    });

    if (leadId) {
      this.liveRelationships.set(`${leadId}->${agentId}:spawned`, {
        id: `codex-rel:${stableSegment(leadId)}:spawned:${stableSegment(agentId)}`,
        kind: "spawned",
        fromId: leadId,
        toId: agentId,
      });
    }
    this.liveRelationships.set(`${taskId}->${agentId}:assigned`, {
      id: `codex-rel:${stableSegment(taskId)}:assigned-to:${stableSegment(agentId)}`,
      kind: "assigned_to",
      fromId: taskId,
      toId: agentId,
    });
  }

  private observeCollabToolCall(item: Record<string, unknown>, phase: "started" | "completed"): void {
    const itemId = itemString(item, ["id"]) ?? crypto.randomUUID();
    const itemSourceRef = `codex-item:${stableSegment(itemId)}`;
    this.liveSourceRefs.set(itemSourceRef, {
      id: itemSourceRef,
      kind: "event",
      ref: itemId,
      label: "Codex collaboration item",
    });
    const senderThreadId = itemString(item, ["senderThreadId", "sender_thread_id"]) ?? this.threadId ?? "unknown";
    const receiverThreadId = itemString(item, ["receiverThreadId", "receiver_thread_id", "newThreadId", "new_thread_id"]);
    const senderId = this.ensureThreadAgent(senderThreadId, senderThreadId === this.threadId ? this.sessionName : undefined);
    const receiverId = receiverThreadId ? this.ensureThreadAgent(receiverThreadId) : undefined;
    const taskId = `codex-task:${stableSegment(itemId)}`;
    const prompt = itemString(item, ["prompt", "description"]);

    if (receiverId) {
      this.liveRelationships.set(`${senderId}->${receiverId}:spawned`, {
        id: `codex-rel:${stableSegment(senderId)}:spawned:${stableSegment(receiverId)}`,
        kind: "spawned",
        fromId: senderId,
        toId: receiverId,
      });
    }

    this.liveTasks.set(taskId, {
      id: taskId,
      title: prompt ?? itemString(item, ["tool"]) ?? "Codex collaboration task",
      state: phase === "completed" ? "completed" : taskStateFromStatus(item.agentStatus ?? item.status),
      assigneeId: receiverId,
      sourceRef: itemSourceRef,
      providerMeta: {
        codexItemId: itemId,
        tool: itemString(item, ["tool"]),
      },
    });

    if (receiverId) {
      this.liveRelationships.set(`${taskId}->${receiverId}:assigned`, {
        id: `codex-rel:${stableSegment(taskId)}:assigned-to:${stableSegment(receiverId)}`,
        kind: "assigned_to",
        fromId: taskId,
        toId: receiverId,
      });
    }
  }

  toTopology(): ObservedHarnessTopology | null {
    const groups: ObservedHarnessGroup[] = [];
    const sourceRefs: ObservedHarnessSourceRef[] = [...this.liveSourceRefs.values()];
    const relationships: ObservedHarnessRelationship[] = [...this.liveRelationships.values()];

    const projectConfig = readProjectAgentsConfig(this.cwd);
    if (projectConfig.group) groups.push(projectConfig.group);
    if (projectConfig.sourceRef) sourceRefs.push(projectConfig.sourceRef);

    const projectDefinitions = this.cwd ? readAgentDefinitions(this.cwd, "project") : { agents: [], sourceRefs: [] };
    const userDefinitions = readAgentDefinitions(this.homeDir, "user");
    const hasObservedTopology = Boolean(
      projectConfig.group
      || projectDefinitions.agents.length > 0
      || userDefinitions.agents.length > 0
      || this.liveAgents.size > 0
      || this.liveTasks.size > 0
      || this.liveRelationships.size > 0
    );

    if (!hasObservedTopology) {
      return null;
    }

    if (this.threadId) {
      const threadGroupId = `codex-thread:${stableSegment(this.threadId)}`;
      groups.unshift({
        id: threadGroupId,
        kind: "thread",
        name: this.sessionName,
        providerMeta: {
          threadId: this.threadId,
          threadPath: this.threadPath,
        },
      });
      const leadId = this.ensureThreadAgent(this.threadId, this.sessionName);
      relationships.push({
        id: `codex-rel:${stableSegment(leadId)}:member-of:${stableSegment(threadGroupId)}`,
        kind: "member_of",
        fromId: leadId,
        toId: threadGroupId,
      });
    }

    const agents = [
      ...this.liveAgents.values(),
      ...projectDefinitions.agents,
      ...userDefinitions.agents,
    ];
    sourceRefs.push(...projectDefinitions.sourceRefs, ...userDefinitions.sourceRefs);

    return {
      schemaVersion: TOPOLOGY_SCHEMA_VERSION,
      ownership: "harness_observed",
      source: CODEX_TOPOLOGY_SOURCE,
      observedAt: this.now().toISOString(),
      groups,
      agents,
      tasks: [...this.liveTasks.values()],
      relationships,
      sourceRefs,
      limitations: [
        "Codex subagent and collaboration topology is observed from app-server events and Codex-owned config.",
        "Scout reads Codex-owned topology as source material and does not write or repair Codex agent state.",
      ],
    };
  }
}
