import { plausibleTouchedFiles } from "../../lib/lane-observe.ts";
import { observeToolIsEdit, observeToolIsRead } from "../../lib/tail-display.ts";
import type {
  ObserveData,
  ObserveEvent,
  ObserveFile,
  ObserveUsageMeta,
  PlanDocument,
} from "../../lib/types.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

export type LaneSessionStats = {
  tools: number;
  edits: number;
  reads: number;
  thinks: number;
  files: number;
  events: number;
  model: string | null;
  branch: string | null;
  harness: string | null;
  cwd: string | null;
  sessionId: string | null;
  usage: ObserveUsageMeta | null;
};

export type LaneSessionDocuments = {
  plans: PlanDocument[];
  docs: PlanDocument[];
};

export function buildLaneSessionStats(lane: AgentLane): LaneSessionStats {
  const { agent, observe } = lane;
  const session = observe?.metadata?.session;
  const events = observe?.events ?? [];
  const files = observe?.files ?? [];

  return {
    tools: events.filter((event) => event.kind === "tool").length,
    edits: events.filter(
      (event) => event.kind === "tool" && observeToolIsEdit(event.tool),
    ).length,
    reads: events.filter(
      (event) => event.kind === "tool" && observeToolIsRead(event.tool),
    ).length,
    thinks: events.filter((event) => event.kind === "think").length,
    files: files.length,
    events: events.length,
    model: session?.model ?? agent.model ?? null,
    branch: session?.gitBranch ?? agent.branch ?? null,
    harness: agent.harness ?? session?.adapterType ?? null,
    cwd: session?.cwd ?? agent.cwd ?? agent.projectRoot ?? null,
    sessionId: session?.externalSessionId ?? agent.harnessSessionId ?? null,
    usage: observe?.metadata?.usage ?? null,
  };
}

export function buildLaneTouchedFiles(
  observe: ObserveData | null | undefined,
  limit = 10,
): ObserveFile[] {
  if (!observe || observe.files.length === 0) return [];

  // `observe.files` READ entries can leak mis-recorded bash tokens (e.g. `necho`,
  // `nCHROME=`); gate + dedupe before display so only real paths surface.
  return plausibleTouchedFiles(observe.files)
    .sort((left, right) => {
      const leftChanged = left.state === "read" ? 0 : 1;
      const rightChanged = right.state === "read" ? 0 : 1;
      if (leftChanged !== rightChanged) return rightChanged - leftChanged;
      return right.lastT - left.lastT;
    })
    .slice(0, limit);
}

/* ── Recent shell commands ── */

/** Tool names that are a shell command across both harness idioms (mirrors
 *  SessionObserve's bash family list so the Commands panel reads the same set). */
const BASH_TOOL_NAMES = new Set([
  "bash", "shell", "terminal", "exec", "run", "command",
  "exec_command", "shell_command", "local_shell", "container_exec", "container.exec",
]);

/** A recent shell command pulled from the trace, with its one-line outcome. */
export type LaneCommand = { id: string; command: string; outcome: string | null };

/** Unescape the common JSON string escapes in a value captured by regex (we
 *  can't JSON.parse the whole object when the observe-log preview is truncated). */
function unescapeJsonChunk(value: string): string {
  return value.replace(/\\(["\\/bfnrt])/g, (_match, ch: string) => {
    switch (ch) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      default: return ch; // " \ /
    }
  });
}

/** Codex-style shells pass the command as an argv array like
 *  `["bash","-lc","<script>"]`; show the script (or the joined argv for a bare
 *  `["ls","-la"]`) rather than dumping the raw JSON. */
function unwrapCommandArgv(parts: readonly unknown[]): string {
  const argv = parts.filter((part): part is string => typeof part === "string");
  if (argv.length === 0) return "";
  const shell = argv[0].replace(/^.*\//, "");
  const isShellWrapper =
    argv.length >= 3 &&
    (shell === "bash" || shell === "sh" || shell === "zsh" || shell === "fish") &&
    /^-[a-z]*c$/.test(argv[1]);
  return (isShellWrapper ? argv.slice(2) : argv).join(" ").trim();
}

/** Pull the command string out of a bash tool arg — usually a plain string, but
 *  some harnesses wrap it as `{"command":"…"}` JSON, and some pass the command
 *  as an argv array (which otherwise leaks through as raw JSON). */
function decodeBashArg(arg: string | undefined): string {
  const raw = arg?.trim();
  if (!raw) return "";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const key of ["command", "cmd", "script", "input", "code"]) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (Array.isArray(value)) {
          const unwrapped = unwrapCommandArgv(value);
          if (unwrapped) return unwrapped;
        }
      }
    } catch {
      // Truncated/unparseable JSON — the observe log captures a bounded preview,
      // so the closing quote/brace is often cut. Pull the command value out
      // directly rather than dumping the raw `{"command":…` markup.
      const match = raw.match(/"(?:command|cmd|script|input|code)"\s*:\s*"((?:[^"\\]|\\.)*)/);
      if (match && match[1].trim()) return unescapeJsonChunk(match[1]).trim();
    }
  } else if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const unwrapped = unwrapCommandArgv(parsed);
        if (unwrapped) return unwrapped;
      }
    } catch {
      // fall through to the raw string
    }
  }
  return raw;
}

/** A short, single-token outcome for a command row (exit/match/commit count). */
function commandOutcome(event: ObserveEvent): string | null {
  const result = event.result;
  if (result) {
    for (const key of ["status", "exit", "matches", "result", "summary"]) {
      const value = result[key];
      if (value != null && `${value}`.trim()) return `${value}`.trim().slice(0, 24);
    }
  }
  return null;
}

/** The recent shell commands run this session, newest last (trace order). */
export function laneRecentCommands(
  observe: ObserveData | null | undefined,
  limit = 12,
): LaneCommand[] {
  if (!observe) return [];
  const commands: LaneCommand[] = [];
  for (const event of observe.events) {
    if (event.kind !== "tool") continue;
    if (!BASH_TOOL_NAMES.has((event.tool ?? "").trim().toLowerCase())) continue;
    const decoded = decodeBashArg(event.arg);
    if (!decoded || decoded === "started" || decoded === "completed" || decoded.startsWith("[")) continue;
    commands.push({ id: event.id, command: decoded, outcome: commandOutcome(event) });
  }
  return commands.slice(-limit);
}

export function docExcerpt(document: PlanDocument, max = 220): string {
  const source = document.summary?.trim() || document.body.trim() || document.rawText.trim();
  if (!source) return "";
  const normalized = source.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function planBasename(value: string): string {
  const clean = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function planSignificantTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !["plan", "plans", "todo", "work", "task", "docs", "markdown"].includes(token))
    .slice(0, 8);
}

export function scorePlanForLane(document: PlanDocument, lane: AgentLane): number {
  const { agent, observe, source } = lane;
  const session = observe?.metadata?.session;
  const haystack = [
    agent.project,
    agent.name,
    agent.branch,
    agent.harness,
    agent.workspaceQualifier,
    agent.harnessSessionId,
    session?.cwd,
    session?.gitBranch,
    session?.model,
    ...observe?.files.map((file) => file.path) ?? [],
    ...observe?.events.slice(-12).flatMap((event) => [event.arg, event.text, event.detail]) ?? [],
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!haystack) return 0;

  const path = document.path.toLowerCase();
  const file = planBasename(path).toLowerCase();
  const title = document.title.toLowerCase();
  let score = 0;

  if (document.agentId && document.agentId === agent.id) score += 10;
  if (document.agentName && document.agentName === agent.name) score += 6;
  if (document.workspaceName && agent.project && document.workspaceName.toLowerCase() === agent.project.toLowerCase()) {
    score += 5;
  }
  if (path && haystack.includes(path)) score += 8;
  if (file && haystack.includes(file)) score += 6;
  if (title.length > 8 && haystack.includes(title)) score += 6;

  for (const tag of document.tags) {
    if (tag.length >= 3 && haystack.includes(tag.toLowerCase())) score += 2;
  }
  for (const token of planSignificantTokens(document.title)) {
    if (haystack.includes(token)) score += 1;
  }
  for (const step of document.steps.slice(0, 8)) {
    for (const token of planSignificantTokens(step.text).slice(0, 3)) {
      if (haystack.includes(token)) score += 1;
    }
  }

  if (source === "scout" && document.source === "openscout") score += 2;

  return score;
}

function rankedLaneDocuments(
  documents: PlanDocument[],
  lane: AgentLane,
  minimumScore = 4,
) {
  return documents
    .map((document) => ({ document, score: scorePlanForLane(document, lane) }))
    .filter((entry) => entry.score >= minimumScore)
    .sort((left, right) => right.score - left.score || right.document.updatedAt - left.document.updatedAt);
}

export function relatedLanePlans(
  documents: PlanDocument[],
  lane: AgentLane,
  limit = 4,
): PlanDocument[] {
  return rankedLaneDocuments(documents, lane)
    .filter((entry) => entry.document.steps.length > 0)
    .slice(0, limit)
    .map((entry) => entry.document);
}

export function relatedLaneDocs(
  documents: PlanDocument[],
  lane: AgentLane,
  limit = 6,
): PlanDocument[] {
  return rankedLaneDocuments(documents, lane)
    .filter((entry) => entry.document.steps.length === 0)
    .slice(0, limit)
    .map((entry) => entry.document);
}

export function relatedLaneSessionDocuments(
  documents: PlanDocument[],
  lane: AgentLane,
  limits: { plans?: number; docs?: number } = {},
): LaneSessionDocuments {
  return {
    plans: relatedLanePlans(documents, lane, limits.plans ?? 4),
    docs: relatedLaneDocs(documents, lane, limits.docs ?? 6),
  };
}
