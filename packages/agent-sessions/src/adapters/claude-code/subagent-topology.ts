import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, normalize, sep } from "node:path";
import type {
  ObservedHarnessAgent,
  ObservedHarnessGroup,
  ObservedHarnessRelationship,
  ObservedHarnessSourceRef,
  ObservedHarnessTask,
  ObservedHarnessTopology,
} from "../../protocol/primitives.js";

export type ClaudeSubagentTopologyOptions = {
  homeDir?: string;
  cwd?: string;
  claudeSessionId?: string | null;
  now?: () => Date;
  maxParentSessions?: number;
  includeUnmatchedSubagents?: boolean;
};

type ClaudeJsonEvent = Record<string, unknown>;

type ParentSessionDir = {
  sessionId: string;
  projectDir: string;
  sessionDir: string;
  parentSessionPath: string;
  subagentsDir: string;
  mtimeMs: number;
};

type ParentToolUse = {
  id: string;
  name?: string;
  input?: Record<string, unknown>;
  timestamp?: string;
};

type ParentToolResult = {
  toolUseId: string;
  content?: unknown;
  isError?: boolean;
  timestamp?: string;
};

type ParentSummary = {
  events: ClaudeJsonEvent[];
  toolUses: Map<string, ParentToolUse>;
  toolResults: Map<string, ParentToolResult>;
  cwd?: string;
};

type SubagentMeta = {
  agentType?: string;
  description?: string;
  toolUseId?: string;
};

type SubagentRecord = {
  agentId: string;
  topologyAgentId: string;
  taskId: string;
  transcriptPath: string;
  metaPath?: string;
  sourceRef: string;
  meta?: SubagentMeta;
  status: string;
  title: string;
  prompt?: string;
  resultPreview?: string;
  model?: string;
  cwd?: string;
  firstTimestamp?: string;
  latestTimestamp?: string;
  eventCount: number;
  parentToolUse?: ParentToolUse;
  parentResult?: ParentToolResult;
};

const TOPOLOGY_SCHEMA_VERSION = "openscout.observed-harness-topology.v1" as const;
const CLAUDE_SUBAGENT_TOPOLOGY_SOURCE = "claude-code-subagents";
const DEFAULT_MAX_PARENT_SESSIONS = 40;
const PREVIEW_LIMIT = 320;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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

function statMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  const raw = readText(path);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonLines(path: string): ClaudeJsonEvent[] {
  const raw = readText(path);
  if (!raw) return [];
  const events: ClaudeJsonEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isObject(parsed)) events.push(parsed);
    } catch {
      /* Claude JSONL can be tailed mid-write; ignore incomplete lines. */
    }
  }
  return events;
}

function projectsRoot(homeDir: string): string {
  return join(homeDir, ".claude", "projects");
}

function discoverParentSessionDirs(
  homeDir: string,
  maxParentSessions: number,
  sessionFilter?: string,
): ParentSessionDir[] {
  const root = projectsRoot(homeDir);
  if (!existsSync(root) || !statIsDirectory(root)) return [];

  const discovered: ParentSessionDir[] = [];
  for (const projectEntry of readdirSync(root).sort()) {
    const projectDir = join(root, projectEntry);
    if (!statIsDirectory(projectDir)) continue;

    for (const sessionEntry of readdirSync(projectDir).sort()) {
      if (sessionFilter && sessionEntry !== sessionFilter) continue;
      const sessionDir = join(projectDir, sessionEntry);
      if (!statIsDirectory(sessionDir)) continue;
      const subagentsDir = join(sessionDir, "subagents");
      if (!statIsDirectory(subagentsDir)) continue;
      const directSubagents = readdirSync(subagentsDir).some((entry) => /^agent-[a-zA-Z0-9]+\.jsonl$/u.test(entry));
      if (!directSubagents) continue;
      const parentSessionPath = join(projectDir, `${sessionEntry}.jsonl`);
      discovered.push({
        sessionId: sessionEntry,
        projectDir,
        sessionDir,
        parentSessionPath,
        subagentsDir,
        mtimeMs: Math.max(statMtimeMs(subagentsDir), statMtimeMs(parentSessionPath)),
      });
    }
  }

  return discovered
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.sessionDir.localeCompare(right.sessionDir))
    .slice(0, sessionFilter ? discovered.length : Math.max(1, maxParentSessions));
}

function eventContentStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(eventContentStrings);
  if (!isObject(value)) return [];
  const direct = stringValue(value.content) ?? stringValue(value.text);
  return direct ? [direct] : [];
}

function eventMessageStrings(event: ClaudeJsonEvent): string[] {
  const message = event.message;
  if (isObject(message)) return eventContentStrings(message.content);
  return eventContentStrings(event.content);
}

function oneLine(text: string, max = PREVIEW_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function resultText(content: unknown): string | undefined {
  const text = eventContentStrings(content).join("\n").trim();
  if (text) return text;
  if (isObject(content)) {
    return stringValue(content.output)
      ?? stringValue(content.result)
      ?? stringValue(content.text)
      ?? stringValue(content.content);
  }
  return undefined;
}

function messageContentBlocks(event: ClaudeJsonEvent): unknown[] {
  const message = event.message;
  const content = isObject(message) ? message.content : event.content;
  return Array.isArray(content) ? content : [];
}

function readParentSummary(parentSessionPath: string): ParentSummary {
  const events = parseJsonLines(parentSessionPath);
  const toolUses = new Map<string, ParentToolUse>();
  const toolResults = new Map<string, ParentToolResult>();
  let cwd: string | undefined;

  for (const event of events) {
    cwd ??= stringValue(event.cwd);
    const timestamp = stringValue(event.timestamp);
    for (const block of messageContentBlocks(event)) {
      if (!isObject(block)) continue;
      if (block.type === "tool_use") {
        const id = stringValue(block.id);
        if (!id) continue;
        const input = isObject(block.input) ? block.input : undefined;
        toolUses.set(id, {
          id,
          name: stringValue(block.name),
          ...(input ? { input } : {}),
          ...(timestamp ? { timestamp } : {}),
        });
      } else if (block.type === "tool_result") {
        const toolUseId = stringValue(block.tool_use_id);
        if (!toolUseId) continue;
        toolResults.set(toolUseId, {
          toolUseId,
          content: block.content,
          isError: booleanValue(block.is_error),
          ...(timestamp ? { timestamp } : {}),
        });
      }
    }
  }

  return { events, toolUses, toolResults, cwd };
}

function firstModel(events: ClaudeJsonEvent[]): string | undefined {
  for (const event of events) {
    const message = event.message;
    if (!isObject(message)) continue;
    const model = stringValue(message.model);
    if (model) return model;
  }
  return undefined;
}

function firstCwd(events: ClaudeJsonEvent[]): string | undefined {
  for (const event of events) {
    const cwd = stringValue(event.cwd);
    if (cwd) return cwd;
  }
  return undefined;
}

function firstTimestamp(events: ClaudeJsonEvent[]): string | undefined {
  for (const event of events) {
    const timestamp = stringValue(event.timestamp);
    if (timestamp) return timestamp;
  }
  return undefined;
}

function latestTimestamp(events: ClaudeJsonEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const timestamp = stringValue(events[index]?.timestamp);
    if (timestamp) return timestamp;
  }
  return undefined;
}

function firstPrompt(events: ClaudeJsonEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "user") continue;
    const text = eventMessageStrings(event).join("\n").trim();
    if (text) return oneLine(text);
  }
  return undefined;
}

function eventHasToolUse(event: ClaudeJsonEvent): boolean {
  return messageContentBlocks(event).some((block) => isObject(block) && block.type === "tool_use");
}

function eventPlainText(event: ClaudeJsonEvent): string | undefined {
  const text = eventMessageStrings(event).join("\n").trim();
  return text ? text : undefined;
}

function latestAssistantText(events: ClaudeJsonEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant") continue;
    const text = eventPlainText(event);
    if (text) return oneLine(text);
  }
  return undefined;
}

function titleFromPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const firstSentence = prompt.split(/[.\n]/u).map((part) => part.trim()).find(Boolean);
  return firstSentence ? oneLine(firstSentence, 120) : undefined;
}

function parseSubagentMeta(path: string): SubagentMeta | undefined {
  const raw = readJsonObject(path);
  if (!raw) return undefined;
  return {
    agentType: stringValue(raw.agentType),
    description: stringValue(raw.description),
    toolUseId: stringValue(raw.toolUseId),
  };
}

function statusFromChildTranscript(events: ClaudeJsonEvent[], result: ParentToolResult | undefined): string {
  if (result?.isError) return "failed";
  if (events.length === 0) return "materialized";
  const latest = events.at(-1);
  if (latest?.type === "assistant" && !eventHasToolUse(latest) && eventPlainText(latest)) {
    return "completed";
  }
  return "running";
}

function isAsyncLaunchResult(result: ParentToolResult | undefined): boolean {
  const text = resultText(result?.content)?.toLowerCase() ?? "";
  return text.includes("async agent launched")
    || text.includes("agent is working in the background")
    || text.includes("you will be notified automatically");
}

function parentToolUseTitle(toolUse: ParentToolUse | undefined): string | undefined {
  if (!toolUse?.input) return undefined;
  return stringValue(toolUse.input.description)
    ?? stringValue(toolUse.input.task)
    ?? stringValue(toolUse.input.title)
    ?? stringValue(toolUse.input.name);
}

function parentToolUsePrompt(toolUse: ParentToolUse | undefined): string | undefined {
  return stringValue(toolUse?.input?.prompt);
}

function readSubagentRecord(parent: ParentSessionDir, parentSummary: ParentSummary, file: string): SubagentRecord | null {
  const match = /^agent-([a-zA-Z0-9]+)\.jsonl$/u.exec(file);
  if (!match?.[1]) return null;
  const agentId = match[1];
  const transcriptPath = join(parent.subagentsDir, file);
  const metaPath = join(parent.subagentsDir, `agent-${agentId}.meta.json`);
  const meta = statIsFile(metaPath) ? parseSubagentMeta(metaPath) : undefined;
  const toolUseId = meta?.toolUseId;
  const parentToolUse = toolUseId ? parentSummary.toolUses.get(toolUseId) : undefined;
  const parentResult = toolUseId ? parentSummary.toolResults.get(toolUseId) : undefined;
  const events = parseJsonLines(transcriptPath);
  const prompt = parentToolUsePrompt(parentToolUse) ?? firstPrompt(events);
  const childResult = latestAssistantText(events);
  const parentResultText = parentResult && !isAsyncLaunchResult(parentResult)
    ? oneLine(resultText(parentResult.content) ?? "") || undefined
    : undefined;
  const resultPreview = childResult ?? parentResultText;
  const title =
    meta?.description
    ?? parentToolUseTitle(parentToolUse)
    ?? titleFromPrompt(prompt)
    ?? `subagent ${agentId.slice(0, 8)}`;
  const sessionSegment = stableSegment(parent.sessionId);
  const agentSegment = stableSegment(agentId);
  const topologyAgentId = `claude-subagent:${sessionSegment}:${agentSegment}`;
  const taskSegment = stableSegment(toolUseId ?? agentId);

  return {
    agentId,
    topologyAgentId,
    taskId: `claude-subagent-task:${sessionSegment}:${taskSegment}`,
    transcriptPath,
    ...(statIsFile(metaPath) ? { metaPath } : {}),
    sourceRef: sourceRefId("claude-subagent-transcript", transcriptPath),
    ...(meta ? { meta } : {}),
    status: statusFromChildTranscript(events, parentResult),
    title,
    ...(prompt ? { prompt } : {}),
    ...(resultPreview ? { resultPreview } : {}),
    model: firstModel(events),
    cwd: firstCwd(events),
    firstTimestamp: firstTimestamp(events),
    latestTimestamp: latestTimestamp(events),
    eventCount: events.length,
    ...(parentToolUse ? { parentToolUse } : {}),
    ...(parentResult ? { parentResult } : {}),
  };
}

function normalizePathForCompare(path: string): string {
  return normalize(path).replace(/[\\/]+$/u, "");
}

function pathContains(left: string, right: string): boolean {
  const a = normalizePathForCompare(left);
  const b = normalizePathForCompare(right);
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

function parentMatchesOptions(
  parent: ParentSessionDir,
  parentSummary: ParentSummary,
  records: SubagentRecord[],
  options: ClaudeSubagentTopologyOptions,
): boolean {
  const sessionId = options.claudeSessionId?.trim();
  if (sessionId && parent.sessionId !== sessionId) return false;

  const cwd = options.cwd?.trim();
  if (!cwd || options.includeUnmatchedSubagents) return true;

  const candidates = [
    parentSummary.cwd,
    ...records.map((record) => record.cwd),
    ...records.map((record) => record.prompt),
  ].filter((value): value is string => Boolean(value));
  return candidates.some((candidate) => pathContains(candidate, cwd));
}

function appendSourceRef(
  sourceRefs: ObservedHarnessSourceRef[],
  seen: Set<string>,
  sourceRef: ObservedHarnessSourceRef,
): void {
  if (seen.has(sourceRef.id)) return;
  seen.add(sourceRef.id);
  sourceRefs.push(sourceRef);
}

function buildTopology(
  parents: Array<{ parent: ParentSessionDir; parentSummary: ParentSummary; records: SubagentRecord[] }>,
  observedAt: string,
): ObservedHarnessTopology | null {
  if (parents.length === 0) return null;

  const groups: ObservedHarnessGroup[] = [];
  const agents: ObservedHarnessAgent[] = [];
  const tasks: ObservedHarnessTask[] = [];
  const relationships: ObservedHarnessRelationship[] = [];
  const sourceRefs: ObservedHarnessSourceRef[] = [];
  const sourceRefIds = new Set<string>();

  for (const { parent, parentSummary, records } of parents) {
    const sessionSegment = stableSegment(parent.sessionId);
    const groupId = `claude-subagents:${sessionSegment}`;
    const parentSessionRefId = sourceRefId("claude-subagent-parent-session", parent.parentSessionPath);
    const leadAgentId = `claude-subagent-lead:${sessionSegment}`;
    const activeCount = records.filter((record) => record.status !== "completed" && record.status !== "failed").length;

    appendSourceRef(sourceRefs, sourceRefIds, {
      id: parentSessionRefId,
      kind: "file",
      ref: parent.parentSessionPath,
      label: `Claude parent session ${parent.sessionId}`,
    });

    groups.push({
      id: groupId,
      kind: "session",
      name: `Claude session ${parent.sessionId.slice(0, 8)} subagents`,
      sourceRef: parentSessionRefId,
      providerMeta: {
        claudeSessionId: parent.sessionId,
        parentSessionId: parent.sessionId,
        subagentCount: records.length,
        activeSubagentCount: activeCount,
      },
    });

    agents.push({
      id: leadAgentId,
      name: "Claude session lead",
      role: "lead",
      type: "parent-session",
      status: activeCount > 0 ? "running" : "completed",
      externalSessionId: parent.sessionId,
      cwd: parentSummary.cwd,
      sourceRef: parentSessionRefId,
      providerMeta: {
        claudeSessionId: parent.sessionId,
        subagentCount: records.length,
        activeSubagentCount: activeCount,
      },
    });
    relationships.push({
      id: `claude-subagent-rel:${sessionSegment}:lead-member-of`,
      kind: "member_of",
      fromId: leadAgentId,
      toId: groupId,
      sourceRef: parentSessionRefId,
    });

    for (const record of records) {
      appendSourceRef(sourceRefs, sourceRefIds, {
        id: record.sourceRef,
        kind: "file",
        ref: record.transcriptPath,
        label: `Claude subagent ${record.agentId}`,
      });
      if (record.metaPath) {
        appendSourceRef(sourceRefs, sourceRefIds, {
          id: sourceRefId("claude-subagent-meta", record.metaPath),
          kind: "file",
          ref: record.metaPath,
          label: `Claude subagent ${record.agentId} metadata`,
        });
      }

      const toolUseId = record.meta?.toolUseId ?? record.parentToolUse?.id;
      agents.push({
        id: record.topologyAgentId,
        name: record.title,
        role: "subagent",
        type: record.meta?.agentType ?? "subagent",
        status: record.status,
        externalSessionId: parent.sessionId,
        cwd: record.cwd,
        model: record.model,
        sourceRef: record.sourceRef,
        providerMeta: {
          claudeSessionId: parent.sessionId,
          claudeAgentId: record.agentId,
          claudeToolUseId: toolUseId,
          agentType: record.meta?.agentType,
          description: record.meta?.description,
          prompt: record.prompt,
          resultPreview: record.resultPreview,
          latestTimestamp: record.latestTimestamp,
          firstTimestamp: record.firstTimestamp,
          eventCount: record.eventCount,
        },
      });

      tasks.push({
        id: record.taskId,
        title: record.title,
        state: record.status,
        assigneeId: record.topologyAgentId,
        sourceRef: record.metaPath ? sourceRefId("claude-subagent-meta", record.metaPath) : record.sourceRef,
        providerMeta: {
          claudeSessionId: parent.sessionId,
          claudeAgentId: record.agentId,
          claudeToolUseId: toolUseId,
          agentType: record.meta?.agentType,
          prompt: record.prompt,
          resultPreview: record.resultPreview,
        },
      });

      relationships.push({
        id: `claude-subagent-rel:${sessionSegment}:${stableSegment(record.agentId)}:member-of`,
        kind: "member_of",
        fromId: record.topologyAgentId,
        toId: groupId,
        sourceRef: record.sourceRef,
      }, {
        id: `claude-subagent-rel:${sessionSegment}:${stableSegment(record.agentId)}:spawned`,
        kind: "spawned",
        fromId: leadAgentId,
        toId: record.topologyAgentId,
        sourceRef: record.sourceRef,
      }, {
        id: `claude-subagent-rel:${sessionSegment}:${stableSegment(record.agentId)}:assigned-to`,
        kind: "assigned_to",
        fromId: record.taskId,
        toId: record.topologyAgentId,
        sourceRef: record.sourceRef,
      });
    }
  }

  return {
    schemaVersion: TOPOLOGY_SCHEMA_VERSION,
    ownership: "harness_observed",
    source: CLAUDE_SUBAGENT_TOPOLOGY_SOURCE,
    observedAt,
    groups,
    agents,
    tasks,
    relationships,
    sourceRefs,
    limitations: [
      "Claude Code subagent transcripts are observed read-only; Scout does not own or mutate subagent state.",
      "Direct subagent completion is inferred from the child transcript's latest assistant step; parent tool_result errors are treated as launch failures.",
      "Direct subagents share the parent Claude session namespace and are not automatically Scout-addressable agents.",
    ],
  };
}

export function readClaudeSubagentTopology(
  options: ClaudeSubagentTopologyOptions = {},
): ObservedHarnessTopology | null {
  const homeDir = options.homeDir ?? homedir();
  const maxParentSessions = options.maxParentSessions ?? DEFAULT_MAX_PARENT_SESSIONS;
  const sessionId = options.claudeSessionId?.trim();
  const parents = discoverParentSessionDirs(homeDir, maxParentSessions, sessionId)
    .map((parent) => {
      const parentSummary = readParentSummary(parent.parentSessionPath);
      const records = readdirSync(parent.subagentsDir)
        .sort()
        .map((file) => readSubagentRecord(parent, parentSummary, file))
        .filter((record): record is SubagentRecord => Boolean(record));
      return { parent, parentSummary, records };
    })
    .filter(({ parent, parentSummary, records }) =>
      records.length > 0 && parentMatchesOptions(parent, parentSummary, records, options)
    );

  return buildTopology(parents, (options.now ?? (() => new Date()))().toISOString());
}
