import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, relative, sep } from "node:path";
import type {
  ObservedHarnessAgent,
  ObservedHarnessGroup,
  ObservedHarnessRelationship,
  ObservedHarnessSourceRef,
  ObservedHarnessTask,
  ObservedHarnessTopology,
} from "../../protocol/primitives.js";

export type ClaudeWorkflowTopologyOptions = {
  homeDir?: string;
  cwd?: string;
  claudeSessionId?: string | null;
  now?: () => Date;
  maxWorkflowRuns?: number;
  includeUnmatchedWorkflows?: boolean;
};

type DiscoveredWorkflowDir = {
  runId: string;
  workflowDir: string;
  parentSessionId: string;
  parentSessionPath: string;
  projectDir: string;
  mtimeMs: number;
};

type ClaudeJsonEvent = Record<string, unknown>;

type WorkflowLaunch = {
  taskId?: string;
  runId?: string;
  summary?: string;
  transcriptDir?: string;
  scriptPath?: string;
  timestamp?: string;
  cwd?: string;
  inputScript?: string;
  inputArgs?: unknown;
};

type WorkflowScriptMeta = {
  name?: string;
  description?: string;
  phases: Array<{ title: string; detail?: string }>;
  basePath?: string;
  plannedFiles: string[];
  scriptPath?: string;
};

type JournalSummary = {
  events: ClaudeJsonEvent[];
  startedByAgent: Map<string, ClaudeJsonEvent>;
  resultByAgent: Map<string, ClaudeJsonEvent>;
};

type WorkflowAgentRecord = {
  agentId: string;
  agentTopologyId: string;
  sourceRef: string;
  transcriptPath: string;
  metaPath?: string;
  assignedFile?: string;
  relativeFile?: string;
  status: string;
  model?: string;
  cwd?: string;
  externalSessionId?: string;
  latestTimestamp?: string;
  eventCount: number;
  type?: string;
  result?: Record<string, unknown>;
};

type WorkflowRun = DiscoveredWorkflowDir & {
  launch?: WorkflowLaunch;
  script?: WorkflowScriptMeta;
  journal: JournalSummary;
  agents: WorkflowAgentRecord[];
};

const TOPOLOGY_SCHEMA_VERSION = "openscout.observed-harness-topology.v1" as const;
const CLAUDE_WORKFLOW_TOPOLOGY_SOURCE = "claude-code-workflows";
const DEFAULT_MAX_WORKFLOW_RUNS = 20;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function discoverWorkflowDirs(homeDir: string, maxRuns: number): DiscoveredWorkflowDir[] {
  const projectsRoot = join(homeDir, ".claude", "projects");
  if (!existsSync(projectsRoot) || !statIsDirectory(projectsRoot)) {
    return [];
  }

  const discovered: DiscoveredWorkflowDir[] = [];
  for (const projectEntry of readdirSync(projectsRoot).sort()) {
    const projectDir = join(projectsRoot, projectEntry);
    if (!statIsDirectory(projectDir)) continue;

    for (const sessionEntry of readdirSync(projectDir).sort()) {
      const sessionDir = join(projectDir, sessionEntry);
      if (!statIsDirectory(sessionDir)) continue;
      const workflowsRoot = join(sessionDir, "subagents", "workflows");
      if (!statIsDirectory(workflowsRoot)) continue;

      for (const runEntry of readdirSync(workflowsRoot).sort()) {
        if (!runEntry.startsWith("wf_")) continue;
        const workflowDir = join(workflowsRoot, runEntry);
        if (!statIsDirectory(workflowDir)) continue;
        discovered.push({
          runId: runEntry,
          workflowDir,
          parentSessionId: sessionEntry,
          parentSessionPath: join(projectDir, `${sessionEntry}.jsonl`),
          projectDir,
          mtimeMs: statMtimeMs(workflowDir),
        });
      }
    }
  }

  return discovered
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.workflowDir.localeCompare(right.workflowDir))
    .slice(0, Math.max(1, maxRuns));
}

function eventContentStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap(eventContentStrings);
  }
  if (!isObject(value)) return [];
  const direct = stringValue(value.content) ?? stringValue(value.text);
  return direct ? [direct] : [];
}

function eventMessageStrings(event: ClaudeJsonEvent): string[] {
  const message = event.message;
  if (!isObject(message)) return [];
  return eventContentStrings(message.content);
}

function firstWorkflowToolUseInputScript(event: ClaudeJsonEvent): string | undefined {
  const message = event.message;
  if (!isObject(message) || !Array.isArray(message.content)) return undefined;
  for (const block of message.content) {
    if (!isObject(block)) continue;
    if (block.type !== "tool_use" || block.name !== "Workflow" || !isObject(block.input)) continue;
    const script = stringValue(block.input.script);
    if (script) return script;
  }
  return undefined;
}

function firstWorkflowToolUseArgs(event: ClaudeJsonEvent): unknown {
  const message = event.message;
  if (!isObject(message) || !Array.isArray(message.content)) return undefined;
  for (const block of message.content) {
    if (!isObject(block)) continue;
    if (block.type !== "tool_use" || block.name !== "Workflow" || !isObject(block.input)) continue;
    return block.input.args;
  }
  return undefined;
}

function launchFromToolUseResult(event: ClaudeJsonEvent, runId: string): WorkflowLaunch | null {
  const result = event.toolUseResult;
  if (!isObject(result) || stringValue(result.runId) !== runId) return null;
  return {
    taskId: stringValue(result.taskId),
    runId: stringValue(result.runId),
    summary: stringValue(result.summary),
    transcriptDir: stringValue(result.transcriptDir),
    scriptPath: stringValue(result.scriptPath),
    timestamp: stringValue(event.timestamp),
    cwd: stringValue(event.cwd),
  };
}

function valueAfterLabel(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:\\s*([^\\n]+)`, "u").exec(text);
  return match?.[1]?.trim();
}

function launchFromText(event: ClaudeJsonEvent, runId: string): WorkflowLaunch | null {
  const text = eventMessageStrings(event).find((entry) => entry.includes(runId));
  if (!text) return null;
  const transcriptDir = valueAfterLabel(text, "Transcript dir");
  const scriptPath = valueAfterLabel(text, "Script file");
  if (!transcriptDir && !scriptPath && !text.includes("Run ID")) return null;
  return {
    taskId: valueAfterLabel(text, "Task ID"),
    runId,
    summary: valueAfterLabel(text, "Summary"),
    transcriptDir,
    scriptPath,
    timestamp: stringValue(event.timestamp),
    cwd: stringValue(event.cwd),
  };
}

function readWorkflowLaunch(parentSessionPath: string, runId: string): WorkflowLaunch | undefined {
  const events = parseJsonLines(parentSessionPath);
  const scriptByAssistantUuid = new Map<string, string>();
  const argsByAssistantUuid = new Map<string, unknown>();

  for (const event of events) {
    const uuid = stringValue(event.uuid);
    if (!uuid) continue;
    const script = firstWorkflowToolUseInputScript(event);
    if (script) scriptByAssistantUuid.set(uuid, script);
    const args = firstWorkflowToolUseArgs(event);
    if (args !== undefined) argsByAssistantUuid.set(uuid, args);
  }

  let launch: WorkflowLaunch | null = null;
  for (const event of events) {
    launch = launchFromToolUseResult(event, runId) ?? launchFromText(event, runId);
    if (!launch) continue;
    const sourceToolAssistantUUID = stringValue(event.sourceToolAssistantUUID);
    if (sourceToolAssistantUUID) {
      launch.inputScript = scriptByAssistantUuid.get(sourceToolAssistantUUID);
      launch.inputArgs = argsByAssistantUuid.get(sourceToolAssistantUUID);
    }
    return launch;
  }

  return undefined;
}

function findGeneratedScriptForRun(homeDir: string, runId: string): string | undefined {
  const projectsRoot = join(homeDir, ".claude", "projects");
  if (!statIsDirectory(projectsRoot)) return undefined;
  const stack: Array<{ path: string; depth: number }> = [{ path: projectsRoot, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > 8) continue;
    for (const entry of readdirSync(current.path).sort()) {
      const fullPath = join(current.path, entry);
      if (statIsDirectory(fullPath)) {
        stack.push({ path: fullPath, depth: current.depth + 1 });
      } else if (statIsFile(fullPath) && entry.endsWith(`${runId}.js`)) {
        return fullPath;
      }
    }
  }
  return undefined;
}

function parseStringArrayLiteral(raw: string): string[] {
  const values: string[] = [];
  const stringRe = /(['"])((?:\\.|(?!\1).)*)\1/gs;
  for (const match of raw.matchAll(stringRe)) {
    const body = match[2];
    if (typeof body === "string") {
      values.push(body.replace(/\\(['"\\])/g, "$1"));
    }
  }
  return values;
}

function parseWorkflowScript(raw: string, scriptPath?: string): WorkflowScriptMeta {
  const metaBlock = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/u.exec(raw)?.[1] ?? raw;
  const name = /name\s*:\s*(['"])(.*?)\1/su.exec(metaBlock)?.[2];
  const description = /description\s*:\s*(['"])(.*?)\1/su.exec(metaBlock)?.[2];
  const basePath = /const\s+BASE\s*=\s*(['"])(.*?)\1/su.exec(raw)?.[2];
  const relBlock = /const\s+REL\s*=\s*\[([\s\S]*?)\]/u.exec(raw)?.[1];
  const plannedFiles = relBlock ? parseStringArrayLiteral(relBlock) : [];
  const phases: Array<{ title: string; detail?: string }> = [];
  const phaseRe = /\{[^}]*title\s*:\s*(['"])(.*?)\1(?:[^}]*detail\s*:\s*(['"])(.*?)\3)?[^}]*\}/gsu;
  for (const match of raw.matchAll(phaseRe)) {
    const title = match[2]?.trim();
    if (!title) continue;
    phases.push({
      title,
      ...(match[4] ? { detail: match[4] } : {}),
    });
  }
  return { name, description, phases, basePath, plannedFiles, scriptPath };
}

function parseInputArgsFiles(inputArgs: unknown): string[] {
  if (Array.isArray(inputArgs)) {
    return inputArgs.map((entry) => stringValue(entry)).filter((entry): entry is string => Boolean(entry));
  }
  const raw = stringValue(inputArgs);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => stringValue(entry)).filter((entry): entry is string => Boolean(entry));
    }
  } catch {
    /* not JSON args */
  }
  return [];
}

function readWorkflowScript(
  homeDir: string,
  launch: WorkflowLaunch | undefined,
  runId: string,
): WorkflowScriptMeta | undefined {
  const scriptPath = launch?.scriptPath && statIsFile(launch.scriptPath)
    ? launch.scriptPath
    : findGeneratedScriptForRun(homeDir, runId);
  const raw = scriptPath ? readText(scriptPath) : launch?.inputScript;
  if (!raw) {
    const plannedFiles = parseInputArgsFiles(launch?.inputArgs);
    return plannedFiles.length > 0 ? { phases: [], plannedFiles } : undefined;
  }
  const parsed = parseWorkflowScript(raw, scriptPath);
  const argsFiles = parseInputArgsFiles(launch?.inputArgs);
  if (parsed.plannedFiles.length === 0 && argsFiles.length > 0) {
    parsed.plannedFiles = argsFiles;
  }
  return parsed;
}

function readJournal(workflowDir: string): JournalSummary {
  const journalPath = join(workflowDir, "journal.jsonl");
  const events = parseJsonLines(journalPath);
  const startedByAgent = new Map<string, ClaudeJsonEvent>();
  const resultByAgent = new Map<string, ClaudeJsonEvent>();
  for (const event of events) {
    const agentId = stringValue(event.agentId);
    if (!agentId) continue;
    if (event.type === "started") startedByAgent.set(agentId, event);
    if (event.type === "result") resultByAgent.set(agentId, event);
  }
  return { events, startedByAgent, resultByAgent };
}

function latestTimestamp(events: ClaudeJsonEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const timestamp = stringValue(events[index]?.timestamp);
    if (timestamp) return timestamp;
  }
  return undefined;
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

function firstExternalSessionId(events: ClaudeJsonEvent[]): string | undefined {
  for (const event of events) {
    const sessionId = stringValue(event.sessionId);
    if (sessionId) return sessionId;
  }
  return undefined;
}

function assignedFileFromEvents(events: ClaudeJsonEvent[]): string | undefined {
  for (const event of events) {
    for (const text of eventMessageStrings(event)) {
      const match = /ASSIGNED FILE[^\n]*\n([^\n]+\.css)/u.exec(text);
      const file = match?.[1]?.trim();
      if (file) return file;
    }
  }
  return undefined;
}

function normalizePathForCompare(path: string): string {
  return normalize(path).replace(/[\\/]+$/u, "");
}

function pathContains(left: string, right: string): boolean {
  const a = normalizePathForCompare(left);
  const b = normalizePathForCompare(right);
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

function stripKnownWebPrefix(value: string): string {
  return value.replace(/^packages\/web\/client\//u, "");
}

function relativeWorkflowFile(value: string | undefined, basePath: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (basePath && raw.startsWith(`${basePath.replace(/\/+$/u, "")}/`)) {
    return stripKnownWebPrefix(relative(basePath, raw));
  }
  if (raw.startsWith("/")) return raw;
  return stripKnownWebPrefix(raw);
}

function workflowFileKey(value: string | undefined, basePath: string | undefined): string | undefined {
  return relativeWorkflowFile(value, basePath)?.replace(/[\\/]+/g, "/");
}

function resultObjectForAgent(journal: JournalSummary, agentId: string): Record<string, unknown> | undefined {
  const resultEvent = journal.resultByAgent.get(agentId);
  const result = resultEvent?.result;
  return isObject(result) ? result : undefined;
}

function statusForAgent(journal: JournalSummary, agentId: string): string {
  const result = resultObjectForAgent(journal, agentId);
  if (result) {
    const status = stringValue(result.status);
    if (status) return status;
    if (stringValue(result.error)) return "failed";
    return "completed";
  }
  if (journal.startedByAgent.has(agentId)) return "running";
  return "materialized";
}

function readWorkflowAgents(run: DiscoveredWorkflowDir, journal: JournalSummary, script: WorkflowScriptMeta | undefined): WorkflowAgentRecord[] {
  const files = statIsDirectory(run.workflowDir) ? readdirSync(run.workflowDir).sort() : [];
  return files
    .map((file) => /^agent-([a-zA-Z0-9]+)\.jsonl$/u.exec(file))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => {
      const agentId = match[1] ?? "unknown";
      const transcriptPath = join(run.workflowDir, `agent-${agentId}.jsonl`);
      const metaPath = join(run.workflowDir, `agent-${agentId}.meta.json`);
      const events = parseJsonLines(transcriptPath);
      const meta = readJsonObject(metaPath);
      const result = resultObjectForAgent(journal, agentId);
      const resultFile = stringValue(result?.file);
      const assignedFile = assignedFileFromEvents(events);
      const relativeFile = workflowFileKey(resultFile ?? assignedFile, script?.basePath);
      const topologyAgentId = `claude-workflow-agent:${stableSegment(run.runId)}:${stableSegment(agentId)}`;
      return {
        agentId,
        agentTopologyId: topologyAgentId,
        sourceRef: sourceRefId("claude-workflow-agent-transcript", transcriptPath),
        transcriptPath,
        ...(statIsFile(metaPath) ? { metaPath } : {}),
        assignedFile,
        relativeFile,
        status: statusForAgent(journal, agentId),
        model: firstModel(events),
        cwd: firstCwd(events),
        externalSessionId: firstExternalSessionId(events),
        latestTimestamp: latestTimestamp(events),
        eventCount: events.length,
        type: stringValue(meta?.agentType) ?? "workflow-subagent",
        result,
      };
    });
}

function readWorkflowRun(homeDir: string, discovered: DiscoveredWorkflowDir): WorkflowRun {
  const launch = readWorkflowLaunch(discovered.parentSessionPath, discovered.runId);
  const script = readWorkflowScript(homeDir, launch, discovered.runId);
  const journal = readJournal(discovered.workflowDir);
  return {
    ...discovered,
    launch,
    script,
    journal,
    agents: readWorkflowAgents(discovered, journal, script),
  };
}

function workflowMatchesOptions(run: WorkflowRun, options: ClaudeWorkflowTopologyOptions): boolean {
  const sessionId = options.claudeSessionId?.trim();
  if (sessionId && run.parentSessionId !== sessionId) return false;

  const cwd = options.cwd?.trim();
  if (!cwd || options.includeUnmatchedWorkflows) return true;

  const candidates = [
    run.launch?.cwd,
    run.script?.basePath,
    ...run.agents.map((agent) => agent.cwd),
    ...run.agents.map((agent) => agent.assignedFile),
    ...run.agents.map((agent) => agent.result ? stringValue(agent.result.file) : undefined),
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

function agentNameForFile(relativeFile: string | undefined, agentId: string): string {
  return relativeFile ? basename(relativeFile) : `workflow ${agentId.slice(0, 8)}`;
}

function plannedFileEntries(run: WorkflowRun): string[] {
  const basePath = run.script?.basePath;
  const planned = run.script?.plannedFiles ?? [];
  const observed = run.agents.map((agent) => agent.relativeFile).filter((entry): entry is string => Boolean(entry));
  const normalized = [
    ...planned.map((file) => workflowFileKey(file, basePath)),
    ...observed,
  ].filter((entry): entry is string => Boolean(entry));
  return [...new Set(normalized)].sort();
}

function taskStateForAgent(agent: WorkflowAgentRecord | undefined): string {
  if (!agent) return "queued";
  if (agent.status === "completed") return "completed";
  if (agent.status === "failed") return "failed";
  return "running";
}

function buildTopologyForRuns(runs: WorkflowRun[], observedAt: string): ObservedHarnessTopology | null {
  if (runs.length === 0) return null;

  const groups: ObservedHarnessGroup[] = [];
  const agents: ObservedHarnessAgent[] = [];
  const tasks: ObservedHarnessTask[] = [];
  const relationships: ObservedHarnessRelationship[] = [];
  const sourceRefs: ObservedHarnessSourceRef[] = [];
  const sourceRefIds = new Set<string>();

  for (const run of runs) {
    const runSegment = stableSegment(run.runId);
    const workflowGroupId = `claude-workflow:${runSegment}`;
    const workflowRefId = sourceRefId("claude-workflow-dir", run.workflowDir);
    const parentSessionRefId = sourceRefId("claude-workflow-parent-session", run.parentSessionPath);
    const journalPath = join(run.workflowDir, "journal.jsonl");
    const journalRefId = sourceRefId("claude-workflow-journal", journalPath);
    const scriptRefId = run.script?.scriptPath
      ? sourceRefId("claude-workflow-script", run.script.scriptPath)
      : undefined;

    appendSourceRef(sourceRefs, sourceRefIds, {
      id: workflowRefId,
      kind: "directory",
      ref: run.workflowDir,
      label: `Claude workflow ${run.runId}`,
    });
    appendSourceRef(sourceRefs, sourceRefIds, {
      id: parentSessionRefId,
      kind: "file",
      ref: run.parentSessionPath,
      label: `Claude parent session ${run.parentSessionId}`,
    });
    if (statIsFile(journalPath)) {
      appendSourceRef(sourceRefs, sourceRefIds, {
        id: journalRefId,
        kind: "file",
        ref: journalPath,
        label: `Claude workflow journal ${run.runId}`,
      });
    }
    if (scriptRefId && run.script?.scriptPath) {
      appendSourceRef(sourceRefs, sourceRefIds, {
        id: scriptRefId,
        kind: "file",
        ref: run.script.scriptPath,
        label: `Claude workflow script ${run.script.name ?? run.runId}`,
      });
    }

    groups.push({
      id: workflowGroupId,
      kind: "workflow",
      name: run.script?.name ?? run.launch?.summary ?? run.runId,
      sourceRef: workflowRefId,
      providerMeta: {
        claudeWorkflowRunId: run.runId,
        claudeTaskId: run.launch?.taskId,
        description: run.script?.description ?? run.launch?.summary,
        parentSessionId: run.parentSessionId,
        transcriptDir: run.launch?.transcriptDir ?? run.workflowDir,
        scriptPath: run.script?.scriptPath,
      },
    });

    const phaseGroups = (run.script?.phases.length ? run.script.phases : [{ title: "Workflow", detail: undefined }])
      .map((phase, index) => {
        const phaseGroupId = `claude-workflow-phase:${runSegment}:${index}`;
        groups.push({
          id: phaseGroupId,
          kind: "workflow_phase",
          name: phase.title,
          sourceRef: scriptRefId ?? workflowRefId,
          providerMeta: {
            detail: phase.detail,
            index,
            workflowRunId: run.runId,
          },
        });
        relationships.push({
          id: `claude-workflow-rel:${runSegment}:phase:${index}:member-of`,
          kind: "member_of",
          fromId: phaseGroupId,
          toId: workflowGroupId,
          sourceRef: scriptRefId ?? workflowRefId,
        });
        return phaseGroupId;
      });
    const defaultPhaseGroupId = phaseGroups[0] ?? workflowGroupId;

    const leadAgentId = `claude-workflow-lead:${runSegment}:${stableSegment(run.parentSessionId)}`;
    const anyOpen = run.agents.some((agent) => agent.status !== "completed" && agent.status !== "failed");
    agents.push({
      id: leadAgentId,
      name: "Claude workflow lead",
      role: "lead",
      type: "workflow-parent-session",
      status: anyOpen ? "running" : "completed",
      externalSessionId: run.parentSessionId,
      cwd: run.launch?.cwd,
      sourceRef: parentSessionRefId,
      providerMeta: {
        claudeSessionId: run.parentSessionId,
        claudeWorkflowRunId: run.runId,
        claudeTaskId: run.launch?.taskId,
      },
    });
    relationships.push({
      id: `claude-workflow-rel:${runSegment}:lead-member-of`,
      kind: "member_of",
      fromId: leadAgentId,
      toId: workflowGroupId,
      sourceRef: parentSessionRefId,
    }, {
      id: `claude-workflow-rel:${runSegment}:lead-leads`,
      kind: "leads",
      fromId: leadAgentId,
      toId: workflowGroupId,
      sourceRef: parentSessionRefId,
    });

    for (const agent of run.agents) {
      appendSourceRef(sourceRefs, sourceRefIds, {
        id: agent.sourceRef,
        kind: "file",
        ref: agent.transcriptPath,
        label: `Claude workflow agent ${agent.agentId}`,
      });
      if (agent.metaPath) {
        appendSourceRef(sourceRefs, sourceRefIds, {
          id: sourceRefId("claude-workflow-agent-meta", agent.metaPath),
          kind: "file",
          ref: agent.metaPath,
          label: `Claude workflow agent ${agent.agentId} metadata`,
        });
      }

      agents.push({
        id: agent.agentTopologyId,
        name: agentNameForFile(agent.relativeFile, agent.agentId),
        role: "subagent",
        type: agent.type,
        status: agent.status,
        externalSessionId: agent.externalSessionId,
        cwd: agent.cwd,
        model: agent.model,
        sourceRef: agent.sourceRef,
        providerMeta: {
          claudeAgentId: agent.agentId,
          claudeWorkflowRunId: run.runId,
          assignedFile: agent.assignedFile,
          relativeFile: agent.relativeFile,
          latestTimestamp: agent.latestTimestamp,
          eventCount: agent.eventCount,
          valuesTokenized: numberValue(agent.result?.valuesTokenized),
          colorsRouted: Array.isArray(agent.result?.colorsRouted) ? agent.result.colorsRouted : undefined,
          flags: Array.isArray(agent.result?.flags) ? agent.result.flags : undefined,
        },
      });
      relationships.push({
        id: `claude-workflow-rel:${runSegment}:${stableSegment(agent.agentId)}:member-of`,
        kind: "member_of",
        fromId: agent.agentTopologyId,
        toId: workflowGroupId,
        sourceRef: agent.sourceRef,
      }, {
        id: `claude-workflow-rel:${runSegment}:${stableSegment(agent.agentId)}:spawned`,
        kind: "spawned",
        fromId: leadAgentId,
        toId: agent.agentTopologyId,
        sourceRef: agent.sourceRef,
      });
    }

    const agentByFile = new Map<string, WorkflowAgentRecord>();
    for (const agent of run.agents) {
      if (agent.relativeFile) agentByFile.set(agent.relativeFile, agent);
    }

    for (const file of plannedFileEntries(run)) {
      const assignedAgent = agentByFile.get(file);
      const taskId = `claude-workflow-task:${runSegment}:${stableSegment(file)}`;
      const taskSourceRef = assignedAgent?.sourceRef ?? scriptRefId ?? workflowRefId;
      tasks.push({
        id: taskId,
        title: file,
        state: taskStateForAgent(assignedAgent),
        assigneeId: assignedAgent?.agentTopologyId,
        sourceRef: taskSourceRef,
        providerMeta: {
          claudeWorkflowRunId: run.runId,
          file,
          valuesTokenized: numberValue(assignedAgent?.result?.valuesTokenized),
        },
      });
      relationships.push({
        id: `claude-workflow-rel:${runSegment}:task:${stableSegment(file)}:member-of-phase`,
        kind: "member_of",
        fromId: taskId,
        toId: defaultPhaseGroupId,
        sourceRef: taskSourceRef,
      });
      if (assignedAgent) {
        relationships.push({
          id: `claude-workflow-rel:${runSegment}:task:${stableSegment(file)}:assigned-to:${stableSegment(assignedAgent.agentId)}`,
          kind: "assigned_to",
          fromId: taskId,
          toId: assignedAgent.agentTopologyId,
          sourceRef: assignedAgent.sourceRef,
        });
      }
    }
  }

  return {
    schemaVersion: TOPOLOGY_SCHEMA_VERSION,
    ownership: "harness_observed",
    source: CLAUDE_WORKFLOW_TOPOLOGY_SOURCE,
    observedAt,
    groups,
    agents,
    tasks,
    relationships,
    sourceRefs,
    limitations: [
      "Claude Code dynamic workflow files are observed read-only; Scout does not own or mutate workflow state.",
      "Queued workflow tasks are inferred from the generated workflow script when available.",
      "Workflow subagents share the parent Claude session transcript namespace and are not automatically Scout-addressable agents.",
    ],
  };
}

export function readClaudeWorkflowTopology(
  options: ClaudeWorkflowTopologyOptions = {},
): ObservedHarnessTopology | null {
  const homeDir = options.homeDir ?? homedir();
  const maxRuns = options.maxWorkflowRuns ?? DEFAULT_MAX_WORKFLOW_RUNS;
  const sessionId = options.claudeSessionId?.trim();
  const runs = discoverWorkflowDirs(homeDir, maxRuns)
    .filter((workflowDir) => !sessionId || workflowDir.parentSessionId === sessionId)
    .map((workflowDir) => readWorkflowRun(homeDir, workflowDir))
    .filter((run) => workflowMatchesOptions(run, options));

  return buildTopologyForRuns(runs, (options.now ?? (() => new Date()))().toISOString());
}
