import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type {
  ObservedHarnessAgent,
  ObservedHarnessGroup,
  ObservedHarnessRelationship,
  ObservedHarnessSourceRef,
  ObservedHarnessTask,
  ObservedHarnessTopology,
} from "../../protocol/primitives.js";

export type ClaudeAgentTeamTopologyOptions = {
  homeDir?: string;
  cwd?: string;
  claudeSessionId?: string | null;
  now?: () => Date;
  includeUnmatchedTeams?: boolean;
};

type TeamConfig = {
  teamName: string;
  configPath: string;
  config: Record<string, unknown>;
};

type ParsedTask = ObservedHarnessTask & {
  externalId: string;
  rawAssignee?: string;
  rawDependencies: string[];
};

const TOPOLOGY_SCHEMA_VERSION = "openscout.observed-harness-topology.v1" as const;
const CLAUDE_TOPOLOGY_SOURCE = "claude-code-agent-teams";

const SESSION_ID_KEYS = new Set([
  "sessionid",
  "session_id",
  "session",
  "claudesessionid",
  "claude_session_id",
  "transportsessionid",
  "externalsessionid",
]);

const CWD_KEYS = new Set([
  "cwd",
  "projectcwd",
  "project_cwd",
  "projectroot",
  "project_root",
  "workingdirectory",
  "working_directory",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => stringValue(entry)).filter((entry): entry is string => Boolean(entry));
}

function keyToken(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
}

function stableSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function sourceRefId(kind: string, value: string): string {
  return `${kind}:${stableSegment(value)}`;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

function readTeamConfigs(homeDir: string): TeamConfig[] {
  const teamsRoot = join(homeDir, ".claude", "teams");
  if (!existsSync(teamsRoot) || !statIsDirectory(teamsRoot)) {
    return [];
  }

  const teams: TeamConfig[] = [];
  for (const entry of readdirSync(teamsRoot)) {
    const teamDir = join(teamsRoot, entry);
    if (!statIsDirectory(teamDir)) {
      continue;
    }
    const configPath = join(teamDir, "config.json");
    const config = readJsonObject(configPath);
    if (!config) {
      continue;
    }
    teams.push({
      teamName: stringValue(config.name) ?? stringValue(config.teamName) ?? entry,
      configPath,
      config,
    });
  }
  return teams;
}

function objectContainsKeyedValue(
  value: unknown,
  expected: string,
  keys: Set<string>,
  seen = new Set<unknown>(),
): boolean {
  if (!expected) return false;
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.some((entry) => objectContainsKeyedValue(entry, expected, keys, seen));
  }
  if (!isObject(value)) {
    return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);

  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = keyToken(key);
    if (keys.has(normalizedKey) && stringValue(nested) === expected) {
      return true;
    }
    if (objectContainsKeyedValue(nested, expected, keys, seen)) {
      return true;
    }
  }
  return false;
}

function teamMatches(team: TeamConfig, options: ClaudeAgentTeamTopologyOptions): boolean {
  if (options.includeUnmatchedTeams) {
    return true;
  }

  const claudeSessionId = options.claudeSessionId?.trim();
  if (claudeSessionId && objectContainsKeyedValue(team.config, claudeSessionId, SESSION_ID_KEYS)) {
    return true;
  }

  const cwd = options.cwd?.trim();
  if (cwd && objectContainsKeyedValue(team.config, cwd, CWD_KEYS)) {
    return true;
  }

  return false;
}

function asMemberEntries(value: unknown): Array<{ key: string; value: Record<string, unknown> }> {
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => isObject(entry) ? { key: String(index), value: entry } : null)
      .filter((entry): entry is { key: string; value: Record<string, unknown> } => Boolean(entry));
  }

  if (isObject(value)) {
    return Object.entries(value)
      .map(([key, entry]) => isObject(entry) ? { key, value: entry } : null)
      .filter((entry): entry is { key: string; value: Record<string, unknown> } => Boolean(entry));
  }

  return [];
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function firstStringDeepForKeys(
  value: unknown,
  keys: Set<string>,
  seen = new Set<unknown>(),
): string | undefined {
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    for (const entry of value) {
      const found = firstStringDeepForKeys(entry, keys, seen);
      if (found) return found;
    }
    return undefined;
  }

  if (!isObject(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(keyToken(key))) {
      const direct = stringValue(nested);
      if (direct) return direct;
    }
    const found = firstStringDeepForKeys(nested, keys, seen);
    if (found) return found;
  }
  return undefined;
}

function membersFromConfig(team: TeamConfig, groupId: string, configRefId: string): {
  agents: ObservedHarnessAgent[];
  relationships: ObservedHarnessRelationship[];
  agentByExternal: Map<string, string>;
} {
  const members = asMemberEntries(team.config.members);
  const agents: ObservedHarnessAgent[] = [];
  const relationships: ObservedHarnessRelationship[] = [];
  const agentByExternal = new Map<string, string>();

  for (const [index, member] of members.entries()) {
    const rawId = firstString(member.value, ["agentId", "agentID", "id", "memberId"]) ?? member.key;
    const name = firstString(member.value, ["name", "displayName", "label"]);
    const type = firstString(member.value, ["agentType", "type"]);
    const role = firstString(member.value, ["role"]);
    const status = firstString(member.value, ["status", "state"]);
    const externalSessionId = firstStringDeepForKeys(member.value, SESSION_ID_KEYS);
    const agentId = `claude-agent:${stableSegment(team.teamName)}:${stableSegment(rawId || name || String(index))}`;

    agents.push({
      id: agentId,
      name,
      role,
      type,
      status,
      externalSessionId,
      sourceRef: configRefId,
      providerMeta: {
        claudeAgentId: rawId,
      },
    });

    for (const external of [rawId, name, externalSessionId].filter((value): value is string => Boolean(value))) {
      agentByExternal.set(external, agentId);
    }

    relationships.push({
      id: `claude-rel:${stableSegment(team.teamName)}:${stableSegment(rawId)}:member-of`,
      kind: "member_of",
      fromId: agentId,
      toId: groupId,
      sourceRef: configRefId,
    });
  }

  return { agents, relationships, agentByExternal };
}

function readTaskFiles(tasksRoot: string, teamName: string): string[] {
  const teamTasksRoot = join(tasksRoot, teamName);
  if (!existsSync(teamTasksRoot) || !statIsDirectory(teamTasksRoot)) {
    return [];
  }

  const result: string[] = [];
  const stack = [teamTasksRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statIsDirectory(path)) {
        stack.push(path);
      } else if (statIsFile(path)) {
        result.push(path);
      }
    }
  }
  return result.sort();
}

function inferTaskStateFromPath(taskPath: string): string | undefined {
  const pathParts = taskPath.split(/[\\/]/g).map((part) => part.toLowerCase());
  if (pathParts.includes("pending")) return "pending";
  if (pathParts.includes("in-progress") || pathParts.includes("in_progress")) return "in_progress";
  if (pathParts.includes("completed") || pathParts.includes("done")) return "completed";
  return undefined;
}

function firstMarkdownTitle(raw: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^#+\s*/, "");
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseTaskFile(
  taskPath: string,
  teamName: string,
  tasksRoot: string,
  sourceRef: string,
): ParsedTask | null {
  let raw: string;
  try {
    raw = readFileSync(taskPath, "utf8");
  } catch {
    return null;
  }

  const relativePath = relative(join(tasksRoot, teamName), taskPath);
  const fallbackId = relativePath.replace(/\.[^.]+$/u, "");
  const fallbackTitle = firstMarkdownTitle(raw) ?? basename(fallbackId);
  const inferredState = inferTaskStateFromPath(dirname(relativePath));

  let parsed: Record<string, unknown> | null = null;
  try {
    const json = JSON.parse(raw) as unknown;
    parsed = isObject(json) ? json : null;
  } catch {
    parsed = null;
  }

  const externalId = parsed
    ? firstString(parsed, ["id", "taskId", "taskID", "name"]) ?? fallbackId
    : fallbackId;
  const title = parsed
    ? firstString(parsed, ["title", "summary", "description", "task"]) ?? fallbackTitle
    : fallbackTitle;
  const state = parsed
    ? firstString(parsed, ["state", "status"]) ?? inferredState
    : inferredState;
  const rawAssignee = parsed
    ? firstString(parsed, ["assigneeId", "assignee", "owner", "ownerId", "agentId", "assignedTo"])
    : undefined;
  const rawDependencies = parsed
    ? [
        ...stringArray(parsed.dependencies),
        ...stringArray(parsed.dependsOn),
        ...stringArray(parsed.blockedBy),
      ]
    : [];

  return {
    id: `claude-task:${stableSegment(teamName)}:${stableSegment(externalId)}`,
    externalId,
    title,
    state,
    rawAssignee,
    rawDependencies,
    sourceRef,
    providerMeta: {
      claudeTaskId: externalId,
    },
  };
}

function tasksFromFiles(
  homeDir: string,
  teamName: string,
  agentByExternal: Map<string, string>,
): {
  tasks: ObservedHarnessTask[];
  relationships: ObservedHarnessRelationship[];
  sourceRefs: ObservedHarnessSourceRef[];
} {
  const tasksRoot = join(homeDir, ".claude", "tasks");
  const taskFiles = readTaskFiles(tasksRoot, teamName);
  const sourceRefs: ObservedHarnessSourceRef[] = [];
  const parsedTasks: ParsedTask[] = [];

  for (const taskPath of taskFiles) {
    const refId = sourceRefId("claude-task-file", `${teamName}:${relative(tasksRoot, taskPath)}`);
    const task = parseTaskFile(taskPath, teamName, tasksRoot, refId);
    if (!task) continue;
    parsedTasks.push(task);
    sourceRefs.push({
      id: refId,
      kind: "file",
      ref: taskPath,
      label: `Claude task ${task.externalId}`,
    });
  }

  const taskByExternal = new Map(parsedTasks.map((task) => [task.externalId, task.id]));
  const relationships: ObservedHarnessRelationship[] = [];

  for (const task of parsedTasks) {
    const assigneeId = task.rawAssignee ? agentByExternal.get(task.rawAssignee) : undefined;
    const dependencyIds = task.rawDependencies
      .map((dependency) => taskByExternal.get(dependency) ?? `claude-task:${stableSegment(teamName)}:${stableSegment(dependency)}`);

    if (assigneeId) {
      task.assigneeId = assigneeId;
      relationships.push({
        id: `claude-rel:${stableSegment(teamName)}:${stableSegment(task.externalId)}:assigned-to:${stableSegment(assigneeId)}`,
        kind: "assigned_to",
        fromId: task.id,
        toId: assigneeId,
        sourceRef: task.sourceRef,
      });
    }

    if (dependencyIds.length > 0) {
      task.dependencyIds = dependencyIds;
      for (const dependencyId of dependencyIds) {
        relationships.push({
          id: `claude-rel:${stableSegment(teamName)}:${stableSegment(task.externalId)}:depends-on:${stableSegment(dependencyId)}`,
          kind: "depends_on",
          fromId: task.id,
          toId: dependencyId,
          sourceRef: task.sourceRef,
        });
      }
    }
  }

  return {
    tasks: parsedTasks.map(({ externalId: _externalId, rawAssignee: _rawAssignee, rawDependencies: _rawDependencies, ...task }) => task),
    relationships,
    sourceRefs,
  };
}

function leaderAgentForTeam(
  team: TeamConfig,
  groupId: string,
  configRefId: string,
  options: ClaudeAgentTeamTopologyOptions,
): { agent: ObservedHarnessAgent; relationships: ObservedHarnessRelationship[] } | null {
  const claudeSessionId = options.claudeSessionId?.trim();
  if (!claudeSessionId) {
    return null;
  }

  const agentId = `claude-agent:${stableSegment(team.teamName)}:lead:${stableSegment(claudeSessionId)}`;
  return {
    agent: {
      id: agentId,
      name: "Claude team lead",
      role: "lead",
      externalSessionId: claudeSessionId,
      cwd: options.cwd,
      sourceRef: configRefId,
      providerMeta: {
        claudeSessionId,
      },
    },
    relationships: [
      {
        id: `claude-rel:${stableSegment(team.teamName)}:lead-member-of`,
        kind: "member_of",
        fromId: agentId,
        toId: groupId,
        sourceRef: configRefId,
      },
      {
        id: `claude-rel:${stableSegment(team.teamName)}:lead-leads`,
        kind: "leads",
        fromId: agentId,
        toId: groupId,
        sourceRef: configRefId,
      },
    ],
  };
}

export function readClaudeAgentTeamTopology(
  options: ClaudeAgentTeamTopologyOptions = {},
): ObservedHarnessTopology | null {
  const homeDir = options.homeDir ?? homedir();
  const teams = readTeamConfigs(homeDir).filter((team) => teamMatches(team, options));
  if (teams.length === 0) {
    return null;
  }

  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const groups: ObservedHarnessGroup[] = [];
  const agents: ObservedHarnessAgent[] = [];
  const tasks: ObservedHarnessTask[] = [];
  const relationships: ObservedHarnessRelationship[] = [];
  const sourceRefs: ObservedHarnessSourceRef[] = [];

  for (const team of teams) {
    const groupId = `claude-team:${stableSegment(team.teamName)}`;
    const configRefId = sourceRefId("claude-team-config", team.configPath);

    sourceRefs.push({
      id: configRefId,
      kind: "file",
      ref: team.configPath,
      label: `Claude team ${team.teamName} config`,
    });

    groups.push({
      id: groupId,
      kind: "team",
      name: team.teamName,
      sourceRef: configRefId,
      providerMeta: {
        claudeTeamName: team.teamName,
      },
    });

    const leader = leaderAgentForTeam(team, groupId, configRefId, options);
    if (leader) {
      agents.push(leader.agent);
      relationships.push(...leader.relationships);
    }

    const members = membersFromConfig(team, groupId, configRefId);
    agents.push(...members.agents);
    relationships.push(...members.relationships);

    if (leader) {
      for (const agent of members.agents) {
        relationships.push({
          id: `claude-rel:${stableSegment(team.teamName)}:${stableSegment(leader.agent.id)}:leads:${stableSegment(agent.id)}`,
          kind: "leads",
          fromId: leader.agent.id,
          toId: agent.id,
          sourceRef: configRefId,
        });
      }
    }

    const parsedTasks = tasksFromFiles(homeDir, team.teamName, members.agentByExternal);
    tasks.push(...parsedTasks.tasks);
    relationships.push(...parsedTasks.relationships);
    sourceRefs.push(...parsedTasks.sourceRefs);
  }

  return {
    schemaVersion: TOPOLOGY_SCHEMA_VERSION,
    ownership: "harness_observed",
    source: CLAUDE_TOPOLOGY_SOURCE,
    observedAt,
    groups,
    agents,
    tasks,
    relationships,
    sourceRefs,
    limitations: [
      "Claude Code agent teams are experimental and their local file shapes may change.",
      "Scout reads Claude-owned topology as source material and does not write or repair Claude team state.",
    ],
  };
}
