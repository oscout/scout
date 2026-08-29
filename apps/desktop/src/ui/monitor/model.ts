import type { BlockState, SessionState } from "@openscout/agent-sessions";
import { parseScoutRuntimeSpec } from "@openscout/protocol";
import { stripVTControlCharacters } from "node:util";

export type ScoutTuiCommand = {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
  enabled?: boolean;
};

export type ScoutHarnessCommandDefinition = {
  name: string;
  aliases?: string[];
  usage: string;
  summary: string;
  category: "conversation" | "targets" | "inspect" | "navigate";
};

export const SCOUT_HARNESS_COMMANDS: readonly ScoutHarnessCommandDefinition[] = [
  { name: "help", aliases: ["?"], usage: "/help [command]", summary: "Browse every command or inspect one command.", category: "inspect" },
  { name: "chat", usage: "/chat", summary: "Return to the Scout conversation.", category: "conversation" },
  { name: "ask", usage: "/ask <request>", summary: "Send a request to the active target; plain text does the same.", category: "conversation" },
  { name: "profile", aliases: ["profiles"], usage: "/profile [name]", summary: "Browse runtime profiles, inspect one, or make it the active target.", category: "targets" },
  { name: "runtime", aliases: ["runtimes"], usage: "/runtime [harness[/model[/effort]]]", summary: "Browse live runtime capabilities or select an exact broker-validated runtime.", category: "targets" },
  { name: "agent", aliases: ["agents"], usage: "/agent [name or id]", summary: "Browse live agents or attach this conversation to one exact agent.", category: "targets" },
  { name: "status", usage: "/status", summary: "Inspect broker health, counts, project, and the active target.", category: "inspect" },
  { name: "clear", usage: "/clear", summary: "Clear the local conversation viewport without deleting broker records.", category: "conversation" },
  { name: "fleet", usage: "/fleet", summary: "Open the live fleet view.", category: "navigate" },
  { name: "tail", usage: "/tail", summary: "Open the broker activity tail.", category: "navigate" },
  { name: "new", aliases: ["launch"], usage: "/new", summary: "Compose a new broker command and choose where it runs.", category: "navigate" },
] as const;

export type ScoutHarnessCommand =
  | { kind: "ask"; body: string }
  | { kind: "agent"; query?: string }
  | { kind: "profile"; profile?: string }
  | { kind: "runtime"; runtime?: string }
  | { kind: "status" }
  | { kind: "chat" }
  | { kind: "navigate"; tab: "fleet" | "tail" | "new" }
  | { kind: "clear" }
  | { kind: "help"; query?: string }
  | { kind: "empty" }
  | { kind: "invalid"; message: string };

export function parseScoutHarnessCommand(value: string): ScoutHarnessCommand {
  const input = value.trim();
  if (!input) return { kind: "empty" };
  if (!input.startsWith("/")) return { kind: "ask", body: input };

  const firstSpace = input.indexOf(" ");
  const token = (firstSpace < 0 ? input : input.slice(0, firstSpace)).toLowerCase();
  const argument = firstSpace < 0 ? "" : input.slice(firstSpace + 1).trim();
  const rawName = token.slice(1);
  const definition = SCOUT_HARNESS_COMMANDS.find((candidate) => (
    candidate.name === rawName || candidate.aliases?.includes(rawName)
  ));
  const name = definition?.name ?? rawName;
  switch (name) {
    case "ask":
      return argument
        ? { kind: "ask", body: argument }
        : { kind: "invalid", message: "Usage: /ask <request>" };
    case "agent":
      return argument ? { kind: "agent", query: argument } : { kind: "agent" };
    case "profile":
      return argument ? { kind: "profile", profile: argument } : { kind: "profile" };
    case "runtime":
      return argument ? { kind: "runtime", runtime: argument } : { kind: "runtime" };
    case "status":
      return { kind: "status" };
    case "chat":
      return { kind: "chat" };
    case "fleet":
      return { kind: "navigate", tab: "fleet" };
    case "tail":
      return { kind: "navigate", tab: "tail" };
    case "new":
      return { kind: "navigate", tab: "new" };
    case "clear":
      return { kind: "clear" };
    case "help":
      return argument ? { kind: "help", query: argument.replace(/^\//, "") } : { kind: "help" };
    default:
      return { kind: "invalid", message: `Unknown harness command: ${token}. Try /help.` };
  }
}

export function findScoutHarnessCommandDefinition(
  query: string,
): ScoutHarnessCommandDefinition | null {
  const needle = query.trim().toLowerCase().replace(/^\//, "");
  if (!needle) return null;
  return SCOUT_HARNESS_COMMANDS.find((candidate) => (
    candidate.name === needle || candidate.aliases?.includes(needle)
  )) ?? null;
}

export function parseScoutHarnessRuntime(value: string) {
  const literal = value.trim();
  const parsed = parseScoutRuntimeSpec(literal);
  if (!parsed.ok) {
    return {
      ok: false as const,
      message: `runtime_spec_invalid: ${parsed.error}`,
    };
  }
  return {
    ok: true as const,
    value: {
      literal,
      ...parsed.value,
    },
  };
}

export type ScoutHarnessAgentMatch =
  | { kind: "match"; index: number }
  | { kind: "ambiguous"; indices: number[] }
  | { kind: "missing" };

export function findScoutHarnessAgent(
  agents: Array<{ id: string; title: string }>,
  query: string,
): ScoutHarnessAgentMatch {
  const needle = query.trim().toLowerCase();
  if (!needle) return { kind: "missing" };

  const exactId = agents.findIndex((agent) => agent.id.toLowerCase() === needle);
  if (exactId >= 0) return { kind: "match", index: exactId };

  const exactTitles = agents.flatMap((agent, index) => (
    agent.title.toLowerCase() === needle ? [index] : []
  ));
  if (exactTitles.length === 1) return { kind: "match", index: exactTitles[0]! };
  if (exactTitles.length > 1) return { kind: "ambiguous", indices: exactTitles };

  const partials = agents.flatMap((agent, index) => (
    agent.id.toLowerCase().includes(needle) || agent.title.toLowerCase().includes(needle)
      ? [index]
      : []
  ));
  if (partials.length === 1) return { kind: "match", index: partials[0]! };
  if (partials.length > 1) return { kind: "ambiguous", indices: partials };
  return { kind: "missing" };
}

function fuzzyScore(value: string, query: string): number | null {
  const haystack = value.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  const contiguousIndex = haystack.indexOf(needle);
  if (contiguousIndex >= 0) {
    return contiguousIndex * 2 + Math.max(0, haystack.length - needle.length) * 0.01;
  }

  let score = 0;
  let cursor = 0;
  let previousMatch = -2;
  for (const character of needle) {
    const match = haystack.indexOf(character, cursor);
    if (match < 0) return null;
    score += match - cursor;
    if (match === previousMatch + 1) score -= 0.5;
    previousMatch = match;
    cursor = match + 1;
  }
  return score + haystack.length * 0.01;
}

export function filterScoutTuiCommands(
  commands: ScoutTuiCommand[],
  query: string,
): ScoutTuiCommand[] {
  return commands
    .filter((command) => command.enabled !== false)
    .map((command, index) => ({
      command,
      index,
      score: fuzzyScore(`${command.label} ${command.description} ${command.id}`, query),
    }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.command);
}

export function clampScoutTuiSelection(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(Math.max(0, index), itemCount - 1);
}

export function findScoutTuiSelectionIndex(
  items: Array<{ key: string }>,
  selectedKey: string | null,
): number {
  if (items.length === 0 || !selectedKey) return 0;
  const index = items.findIndex((item) => item.key === selectedKey);
  return index >= 0 ? index : 0;
}

/**
 * Tail follows the newest entry until the operator chooses one. Once chosen,
 * its content identity wins over its offset from the end as live entries arrive.
 */
export function findScoutTuiTailSelectionIndex(
  items: Array<{ key: string }>,
  selectedKey: string | null,
): number {
  if (items.length === 0) return 0;
  if (selectedKey) {
    const index = items.findIndex((item) => item.key === selectedKey);
    if (index >= 0) return index;
  }
  return items.length - 1;
}

export function moveScoutTuiSelection(
  index: number,
  direction: -1 | 1,
  itemCount: number,
): number {
  if (itemCount <= 0) return 0;
  return (clampScoutTuiSelection(index, itemCount) + direction + itemCount) % itemCount;
}

const LOG_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/g;

export type ScoutTuiLiveTraceRow = {
  id: string;
  kind: "text" | "reasoning" | "action" | "output" | "file" | "error" | "question";
  label: string;
  text: string;
  live: boolean;
};

function cleanScoutTuiLiveLogLines(body: string): string[] {
  return stripVTControlCharacters(body)
    .split(/\r?\n/)
    .map((line) => line.replaceAll("\t", "  ").replace(LOG_CONTROL_PATTERN, "").trimEnd())
    .filter((line) => line.trim().length > 0);
}

export function tailScoutTuiLiveLogLines(
  body: string,
  limit: number,
  width = Number.POSITIVE_INFINITY,
): string[] {
  if (!body || limit <= 0) return [];
  const cleanLines = cleanScoutTuiLiveLogLines(body);
  if (!Number.isFinite(width)) return cleanLines.slice(-limit);

  const lineWidth = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  const append = (text: string) => {
    if (rows.length === limit) rows.shift();
    rows.push(text);
  };
  for (const line of cleanLines) {
    for (let offset = 0; offset < line.length; offset += lineWidth) {
      append(line.slice(offset, offset + lineWidth));
    }
  }
  return rows;
}

function scoutTuiActionLabel(status: Extract<BlockState["block"], { type: "action" }>["action"]["status"]): string {
  switch (status) {
    case "pending":
    case "running":
      return "RUN";
    case "awaiting_approval":
      return "WAIT";
    case "failed":
      return "FAIL";
    case "completed":
      return "DONE";
  }
}

function scoutTuiActionTitle(block: Extract<BlockState["block"], { type: "action" }>): string {
  const { action } = block;
  const value = action.kind === "command"
    ? action.command
    : action.kind === "tool_call"
      ? action.toolName
      : action.kind === "file_change"
        ? action.path
        : action.agentName ?? action.agentId;
  return cleanScoutTuiLiveLogLines(value).join(" ").trim() || "Agent action";
}

function scoutTuiTraceBlockRows(
  state: BlockState,
  turnLive: boolean,
  limit: number,
  width: number,
): ScoutTuiLiveTraceRow[] {
  const { block } = state;
  const live = turnLive && (
    state.status === "streaming"
    || block.status === "started"
    || block.status === "streaming"
    || (block.type === "action" && ["pending", "running", "awaiting_approval"].includes(block.action.status))
  );

  switch (block.type) {
    case "text":
    case "reasoning": {
      const lines = tailScoutTuiLiveLogLines(block.text, limit, width);
      const kind = block.type;
      const label = block.type === "reasoning" ? "THINK" : "TEXT";
      if (lines.length === 0 && live) {
        return [{
          id: `${block.id}:streaming`,
          kind,
          label,
          text: block.type === "reasoning" ? "Thinking…" : "Writing…",
          live: true,
        }];
      }
      return lines.map((text, index) => ({
        id: `${block.id}:${index}`,
        kind,
        label: index === 0 ? label : "",
        text,
        live: live && index === lines.length - 1,
      }));
    }
    case "action": {
      const outputLimit = Math.max(0, Math.min(3, limit - 1));
      const outputLines = tailScoutTuiLiveLogLines(block.action.output, outputLimit, width);
      const rows: ScoutTuiLiveTraceRow[] = [{
        id: `${block.id}:action`,
        kind: "action",
        label: scoutTuiActionLabel(block.action.status),
        text: scoutTuiActionTitle(block),
        live: live && outputLines.length === 0,
      }];
      for (const [index, text] of outputLines.entries()) {
        rows.push({
          id: `${block.id}:output:${index}`,
          kind: "output",
          label: index === 0 ? "OUT" : "",
          text,
          live: live && index === outputLines.length - 1,
        });
      }
      return rows;
    }
    case "file":
      return [{
        id: `${block.id}:file`,
        kind: "file",
        label: "FILE",
        text: block.name || block.mimeType,
        live,
      }];
    case "error":
      return [{
        id: `${block.id}:error`,
        kind: "error",
        label: "ERR",
        text: block.code ? `${block.code} · ${block.message}` : block.message,
        live: false,
      }];
    case "question":
      return [{
        id: `${block.id}:question`,
        kind: "question",
        label: block.questionStatus === "awaiting_answer" ? "ASK" : "ANSWER",
        text: block.header ? `${block.header} · ${block.question}` : block.question,
        live: block.questionStatus === "awaiting_answer",
      }];
  }
}

export function buildScoutTuiLiveTraceRows(
  trace: SessionState | null,
  limit: number,
  width = Number.POSITIVE_INFINITY,
): ScoutTuiLiveTraceRow[] {
  if (!trace || limit <= 0) return [];
  const turn = trace.turns.at(-1);
  if (!turn) return [];
  const turnLive = trace.currentTurnId === turn.id || turn.status === "streaming";
  const rows = turn.blocks.flatMap((state) => scoutTuiTraceBlockRows(state, turnLive, limit, width));
  const tail = rows.slice(-limit);
  let liveIndex = -1;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    if (tail[index]?.live) {
      liveIndex = index;
      break;
    }
  }
  return tail.map((row, index) => row.live && index !== liveIndex
    ? { ...row, live: false }
    : row);
}

export type ScoutTuiLivePaneProjection = {
  source: "trace" | "log" | null;
  rows: ScoutTuiLiveTraceRow[];
};

export function buildScoutTuiLivePaneProjection(
  trace: SessionState | null,
  body: string,
  limit: number,
  width = Number.POSITIVE_INFINITY,
): ScoutTuiLivePaneProjection {
  if (trace) {
    return {
      source: "trace",
      rows: buildScoutTuiLiveTraceRows(trace, limit, width),
    };
  }
  if (!body || limit <= 0) {
    return { source: null, rows: [] };
  }
  return {
    source: "log",
    rows: tailScoutTuiLiveLogLines(body, limit, width).map((text, index) => ({
      id: `debug:${index}`,
      kind: "output",
      label: index === 0 ? "LOG" : "",
      text,
      live: false,
    })),
  };
}
