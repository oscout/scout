import type { ObserveEvent, TailAttribution, TailEvent, TailEventKind } from "./types.ts";

/** Consumer-side tail presentation policy — the firehose stays complete upstream. */
export type TailDisplayMode = "work" | "all";

import { strReplaceFromGrokSummary } from "./lane-edit-display.ts";
import { GROK_LANE_NOISE_PHASES } from "./grok-lane-display.ts";

/** Grok lifecycle phases that flood the tail during streaming without adding signal. */
const GROK_STREAMING_PHASES = GROK_LANE_NOISE_PHASES;

export function shortTailSession(sessionId: string): string {
  if (!sessionId) return "—";
  const head = sessionId.split(":")[0] ?? sessionId;
  const displayId = head.replace(/^session_/u, "");
  return (displayId || head).slice(0, 8);
}

function codexPayloadType(event: TailEvent): string | null {
  const raw = event.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = (raw as Record<string, unknown>).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const type = (payload as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

function isCodexChunkToolResult(summary: string): boolean {
  const trimmed = summary.trim();
  return trimmed.startsWith("-> Chunk ID:")
    || /^->\s+Wall time:/u.test(trimmed);
}

function isCursorProcessSample(event: TailEvent): boolean {
  if (event.source !== "cursor" || event.kind !== "system") return false;
  const summary = event.summary.trim().toLowerCase();
  return summary === "process sample" || summary.startsWith("process sample ·");
}

export function isTailNoiseEvent(event: TailEvent): boolean {
  if (isCursorProcessSample(event)) return true;

  if (event.source === "grok") {
    const summary = event.summary.trim().toLowerCase();
    if (summary === "first token" || summary.startsWith("loop ")) {
      return true;
    }

    if (!summary.startsWith("phase ·")) return false;
    const phase = summary.slice("phase ·".length).trim();
    return GROK_STREAMING_PHASES.has(phase);
  }

  if (event.source !== "codex") return false;

  if (event.kind === "tool-result") {
    const summary = event.summary.trim();
    if (isCodexChunkToolResult(summary)) return true;
    if (/_end ·/u.test(summary)) return true;
    if (summary.startsWith("->")) return true;
  }

  if (event.kind !== "system") return false;

  const summary = event.summary.trim().toLowerCase();
  if (summary === "user_message" || summary === "agent_message") return true;
  if (summary === "[reasoning]") return true;
  if (summary.startsWith("turn context")) return true;
  if (summary.startsWith("tokens ·")) return true;
  if (summary.startsWith("session ")) return true;
  return false;
}

export function tailDisplayModeLabel(mode: TailDisplayMode): string {
  return mode === "work" ? "work" : "all";
}

export function filterTailEventsForDisplay(
  events: TailEvent[],
  mode: TailDisplayMode,
): TailEvent[] {
  if (mode === "all") return events;
  return events.filter((event) => !isTailNoiseEvent(event));
}

export const TAIL_ATTRIBUTION_LABEL: Record<TailAttribution, string> = {
  "scout-managed": "scout",
  "hudson-managed": "hudson",
  unattributed: "native",
};

export function tailAttributionLabel(harness: TailAttribution): string {
  return TAIL_ATTRIBUTION_LABEL[harness] ?? harness;
}

type TailObserveContext = {
  project?: string | null;
  cwd?: string | null;
};

/** Context line for observe/lane traces built from tail events. */
export function tailObserveEventDetail(
  event: Pick<TailEvent, "kind" | "source" | "harness" | "project" | "cwd">,
  context?: TailObserveContext | null,
): string | undefined {
  if (event.kind === "tool" || event.kind === "tool-result") {
    return undefined;
  }

  const workspace = context?.project?.trim()
    || context?.cwd?.trim()
    || event.project?.trim()
    || event.cwd?.trim();
  const origin = tailAttributionLabel(event.harness);
  return workspace ? `${workspace} · ${origin}` : `${event.source} · ${origin}`;
}

export type TailObserveToolFields = {
  tool?: string;
  arg?: string;
  result?: Record<string, string>;
  /** Compact tool-output preview from `res:` or `cmd -> res:` tail lines. */
  stream?: string[];
};

const GROK_TOOL_STARTED = /^([A-Za-z][\w-]*) started$/;
const GROK_TOOL_COMPLETED = /^([A-Za-z][\w-]*) completed(?: · (.+))?$/;
const GROK_TOOL_WITH_ARG = /^([A-Za-z][\w-]*) · (.+?)(?: · (success|error|failed))?$/;
const CODEX_TOOL_CALL = /^([A-Za-z_][\w.-]*)\((.*)\)$/s;

export function observeToolName(tool: string | undefined): string {
  return (tool ?? "").trim().toLowerCase();
}

export function observeToolIsRead(tool: string | undefined): boolean {
  const name = observeToolName(tool);
  return name === "read" || name === "read_file";
}

export function observeToolIsEdit(tool: string | undefined): boolean {
  const name = observeToolName(tool);
  return name === "edit"
    || name === "write"
    || name === "patch"
    || name === "apply_patch";
}

const CODEX_FRIENDLY_TOOL_NAMES: Record<string, string> = {
  exec_command: "Shell",
  apply_patch: "Edit",
  patch_apply: "Edit",
  read_file: "Read",
  write_stdin: "Shell",
  web_search: "Search",
};

function parseCodexToolArguments(rawArg: string | undefined): Record<string, unknown> | null {
  if (!rawArg?.trim()) return null;
  try {
    const parsed = JSON.parse(rawArg) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function codexCommandFromArguments(args: Record<string, unknown> | null): string | undefined {
  if (!args) return undefined;
  if (typeof args.cmd === "string" && args.cmd.trim()) return args.cmd.trim();
  if (typeof args.command === "string" && args.command.trim()) return args.command.trim();
  if (Array.isArray(args.command)) {
    return args.command.filter((part) => typeof part === "string").join(" ").trim() || undefined;
  }
  return undefined;
}

function codexCommandFromRawArg(rawArg: string | undefined): string | undefined {
  const fromJson = codexCommandFromArguments(parseCodexToolArguments(rawArg));
  if (fromJson) return fromJson;
  if (!rawArg?.trim()) return undefined;

  const cmdMatch = rawArg.match(/"cmd"\s*:\s*"((?:\\.|[^"\\])*)"/u);
  if (cmdMatch?.[1]) {
    return cmdMatch[1]
      .replace(/\\n/gu, "\n")
      .replace(/\\t/gu, "\t")
      .replace(/\\"/gu, "\"")
      .replace(/\\\\/gu, "\\")
      .trim();
  }
  return undefined;
}

function codexFriendlyToolName(name: string): string {
  return CODEX_FRIENDLY_TOOL_NAMES[name] ?? name;
}

/** Claude's built-in tool names (lowercased). `formatToolCall` (runtime) prefixes
 *  these to the salient argument as `"<Tool> <arg>"`; shell execs are emitted as
 *  a bare command with no tool name at all. */
const CLAUDE_TOOL_NAMES = new Set([
  "read", "write", "edit", "multiedit", "notebookedit",
  "glob", "grep", "ls", "task", "agent",
  "webfetch", "websearch", "todowrite", "todoread",
  "bashoutput", "killshell", "killbash", "slashcommand",
  "exitplanmode", "bash",
]);

/** Does the first token of a Claude summary name a tool (vs. open a shell
 *  command)? Built-in tools are CapitalCase; MCP/custom tools surface as
 *  `mcp__server__tool`. A leading lowercase word is a shell program, so it falls
 *  through to bash. */
function isClaudeToolName(name: string): boolean {
  const lower = name.toLowerCase();
  if (CLAUDE_TOOL_NAMES.has(lower)) return true;
  if (name.startsWith("mcp__")) return true;
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

const CLAUDE_RESULT_PREFIX = /^res:\s*([\s\S]*)$/;
const CLAUDE_TOOL_CALL = /^([A-Za-z][\w-]*)(?:\s+([\s\S]+))?$/;
/** Runtime `formatToolResult` may fold call + preview into one line. */
export const TOOL_COMBINED_RESULT = /^([\s\S]+?)\s+->\s+res:\s*([\s\S]+)$/;
// Conservative failure signals only — a free-text preview like "0 errors" or
// "no errors" is a SUCCESS, so we never flag the bare word "error(s)".
const CLAUDE_RESULT_ERROR = /\b(?:failed|failure|exception|fatal|denied|traceback)\b|error:/i;

export function parseToolCombinedResult(summary: string): { command: string; preview: string } | null {
  const match = summary.trim().match(TOOL_COMBINED_RESULT);
  if (!match?.[1] || !match[2]) return null;
  return { command: match[1].trim(), preview: match[2].trim() };
}

function toolResultOutcome(preview: string): "success" | "error" {
  return CLAUDE_RESULT_ERROR.test(preview) ? "error" : "success";
}

function bashToolFields(command: string, preview?: string): TailObserveToolFields {
  const fields: TailObserveToolFields = { tool: "bash", arg: command };
  if (preview) {
    fields.result = { outcome: toolResultOutcome(preview) };
    fields.stream = [preview];
  }
  return fields;
}

/** Multi-word shell history lines (sed/git/curl) that are not `Tool(args)` calls. */
function looksLikeBareShellCommand(summary: string): boolean {
  const trimmed = summary.trim();
  if (!trimmed || !/\s/u.test(trimmed)) return false;
  if (TOOL_COMBINED_RESULT.test(trimmed)) return false;
  if (/^res:\s/i.test(trimmed)) return false;
  if (CODEX_TOOL_CALL.test(trimmed)) return false;
  if (/^[A-Za-z_][\w.-]*\(/u.test(trimmed)) return false;
  const head = trimmed.split(/\s+/)[0] ?? "";
  if (/^[A-Z][A-Za-z0-9]*$/.test(head) && isClaudeToolName(head)) return false;
  return true;
}

export function observeKindFromTailEvent(event: TailEvent): ObserveEvent["kind"] {
  if (event.source === "codex") {
    if (event.kind === "system") {
      const summary = event.summary.trim().toLowerCase();
      if (summary === "task started" || summary === "task complete" || summary.startsWith("turn aborted")) {
        return "note";
      }
      if (codexPayloadType(event) === "reasoning" && summary !== "[reasoning]") {
        return "think";
      }
    }
  }

  if (event.source === "grok" && event.kind === "system") {
    if (/^turn \d+/u.test(event.summary.trim())) {
      return "note";
    }
  }

  if (
    event.source === "kimi"
    && event.kind === "system"
    && event.summary.trim().startsWith("[thinking] ")
  ) {
    return "think";
  }

  switch (event.kind) {
    case "assistant":
      return "message";
    case "tool":
    case "tool-result":
      return "tool";
    case "user":
      return "ask";
    case "system":
      return "system";
    default:
      return "note";
  }
}

export function observeTextFromTailEvent(
  event: TailEvent,
  toolFields: TailObserveToolFields,
): string {
  if (event.kind === "tool" || event.kind === "tool-result") {
    if (toolFields.tool && toolFields.arg) {
      return `${toolFields.tool} · ${toolFields.arg}`;
    }
    if (toolFields.tool) return toolFields.tool;
  }

  if (event.source === "codex" && event.kind === "system") {
    const summary = event.summary.trim().toLowerCase();
    if (summary === "task started") return "Turn started";
    if (summary === "task complete") return "Turn complete";
    if (summary.startsWith("turn aborted")) return event.summary.trim();
  }

  if (event.source === "grok" && event.kind === "system") {
    const turn = event.summary.trim().match(/^turn (\d+)(?: · (.+))?$/i);
    if (turn?.[1]) {
      return turn[2]?.trim()
        ? `turn ${turn[1]} · ${turn[2].trim()}`
        : `turn ${turn[1]}`;
    }
  }

  if (event.source === "kimi" && event.kind === "system") {
    const thinking = event.summary.trim().match(/^\[thinking\]\s+([\s\S]+)$/u);
    if (thinking?.[1]) return thinking[1];
  }

  return event.summary;
}

/** Map a tail tool line into observe tool/arg/result fields for lane and mission traces. */
export function observeToolFieldsFromTailEvent(event: TailEvent): TailObserveToolFields {
  if (event.kind !== "tool" && event.kind !== "tool-result") return {};

  const summary = event.summary.trim();
  if (!summary) return {};

  const cleanLogSource = event.source === "claude" || event.source === "kimi";
  const combined = parseToolCombinedResult(summary);
  if (combined) {
    if (cleanLogSource) {
      const call = combined.command.match(CLAUDE_TOOL_CALL);
      if (call && isClaudeToolName(call[1])) {
        const fields: TailObserveToolFields = {
          tool: call[1],
          result: { outcome: toolResultOutcome(combined.preview) },
          stream: [combined.preview],
        };
        const arg = call[2]?.trim();
        if (arg) fields.arg = arg;
        return fields;
      }
    }
    return bashToolFields(combined.command, combined.preview);
  }

  if (event.source === "grok") {
    const strReplace = strReplaceFromGrokSummary(summary);
    if (strReplace) {
      const fields: TailObserveToolFields = {
        tool: "StrReplace",
        arg: strReplace.path,
      };
      if (strReplace.outcome) {
        fields.result = { outcome: strReplace.outcome };
      }
      return fields;
    }
    const enriched = summary.match(GROK_TOOL_WITH_ARG);
    if (enriched?.[1] && enriched[2]) {
      const fields: TailObserveToolFields = { tool: enriched[1], arg: enriched[2] };
      if (enriched[3]) fields.result = { outcome: enriched[3] };
      return fields;
    }
    const started = summary.match(GROK_TOOL_STARTED);
    if (started?.[1]) {
      return { tool: started[1], arg: "started" };
    }
    const completed = summary.match(GROK_TOOL_COMPLETED);
    if (completed?.[1]) {
      const fields: TailObserveToolFields = { tool: completed[1], arg: "completed" };
      if (completed[2]) fields.result = { outcome: completed[2] };
      return fields;
    }
  }

  // Claude and Kimi's `formatToolCall`/`formatToolResult` (runtime tool-format.ts) emit a
  // clean shell-log line — `Read views/scout-tail.tsx`, a bare command for shell
  // execs, and `res: <preview>` for results — rather than codex's `Tool(args)`.
  // Re-extract the tool + salient arg so lane/mission rows show the snippet, not
  // just the bare tool name.
  if (cleanLogSource) {
    const result = summary.match(CLAUDE_RESULT_PREFIX);
    if (result) {
      const preview = result[1].trim();
      const fields: TailObserveToolFields = {
        tool: "res",
        result: { outcome: toolResultOutcome(preview) },
      };
      if (preview) {
        fields.arg = preview;
        fields.stream = [preview];
      }
      return fields;
    }
    const call = summary.match(CLAUDE_TOOL_CALL);
    if (call && isClaudeToolName(call[1])) {
      const arg = call[2]?.trim();
      return arg ? { tool: call[1], arg } : { tool: call[1] };
    }
    // No recognizable tool name → a bare shell command (Bash/exec). Classify as
    // bash so the lane renders it as a terminal line, command intact.
    return { tool: "bash", arg: summary };
  }

  if (event.source === "codex") {
    const lifecycle = summary.match(/^([A-Za-z_][\w.-]*)_(?:start|end) · (.+)$/);
    if (lifecycle?.[1] && lifecycle[2]) {
      const tool = codexFriendlyToolName(lifecycle[1]);
      const arg = lifecycle[2].trim();
      const fields: TailObserveToolFields = {
        tool,
        arg: event.kind === "tool-result" ? "completed" : arg,
      };
      if (event.kind === "tool-result") {
        fields.result = { outcome: /error|failed/u.test(arg) ? "error" : "success" };
      }
      return fields;
    }

    const fnCall = summary.match(CODEX_TOOL_CALL)
      ?? summary.match(/^([A-Za-z_][\w.-]*)\((.*)$/s);
    if (fnCall?.[1]) {
      const rawName = fnCall[1];
      const rawArg = fnCall[2]?.trim();
      const command = codexCommandFromRawArg(rawArg);
      const tool = codexFriendlyToolName(rawName);
      if (command) {
        return { tool, arg: command };
      }
      if (rawName === "apply_patch" || rawName === "patch_apply") {
        return { tool, arg: "patch" };
      }
      return { tool, arg: rawArg || undefined };
    }

    if (looksLikeBareShellCommand(summary)) {
      return bashToolFields(summary);
    }
  }

  const fnCall = summary.match(CODEX_TOOL_CALL)
    ?? summary.match(/^([A-Za-z_][\w.-]*)\((.*)$/s);
  if (fnCall?.[1]) {
    return { tool: fnCall[1], arg: fnCall[2]?.trim() || undefined };
  }

  const dotSep = summary.match(/^([A-Za-z_][\w.-]*) · (.+)$/);
  if (dotSep?.[1]) {
    return { tool: dotSep[1], arg: dotSep[2] };
  }

  if (looksLikeBareShellCommand(summary)) {
    return bashToolFields(summary);
  }

  const first = summary.split(/\s+/)[0];
  if (first && first.toLowerCase() !== event.source.toLowerCase()) {
    return { tool: first };
  }

  return {};
}

export type TailDisplayRow<TMeta = undefined> = {
  event: TailEvent;
  repeatCount: number;
  meta: TMeta;
};

export function collapseTailDisplayRows<TMeta>(
  rows: Array<{ event: TailEvent; meta: TMeta }>,
): TailDisplayRow<TMeta>[] {
  const out: TailDisplayRow<TMeta>[] = [];

  for (const row of rows) {
    const prev = out[out.length - 1];
    if (
      prev
      && prev.event.sessionId === row.event.sessionId
      && prev.event.source === row.event.source
      && prev.event.kind === row.event.kind
      && prev.event.summary === row.event.summary
    ) {
      prev.repeatCount += 1;
      prev.event = row.event;
      prev.meta = row.meta;
      continue;
    }
    out.push({ event: row.event, repeatCount: 1, meta: row.meta });
  }

  return out;
}

/**
 * Row glyph/label dialect for tail lines. Shared so every surface that renders
 * the firehose (the Tail view, the Mission Control wall) reads the same.
 */
export const TAIL_KIND_GLYPH: Record<TailEventKind, string> = {
  user: ">",
  assistant: "<",
  tool: "*",
  "tool-result": "=",
  system: "~",
  other: "·",
};

export const TAIL_KIND_LABEL: Record<TailEventKind, string> = {
  user: "USR",
  assistant: "AST",
  tool: "TOL",
  "tool-result": "OUT",
  system: "SYS",
  other: "EVT",
};
