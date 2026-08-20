import {
  isSyntheticAgentId,
  sessionRefFromSyntheticAgent,
} from "../../lib/synthetic-agent-routing.ts";
import type { Agent, ObserveData, ObserveEvent, Route } from "../../lib/types.ts";

function summarize(text: string, max = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

/**
 * Lifecycle / discovery noise — never a useful home “what's moving” headline.
 * Substring markers plus a few structural patterns (turn N, N tool calls).
 */
const PLACEHOLDER_TEXT_MARKERS = [
  "no session trace",
  "waiting for events",
  "waiting for a live session",
  "transcript discovered",
  "turn complete",
  "turn started",
  "task complete",
  "task started",
  "turn ended",
  "session started",
  "turn aborted",
  "no recent text",
];

const PLACEHOLDER_TEXT_PATTERNS: RegExp[] = [
  /^turn\s+\d+\b/iu,
  /\b\d+\s+tool\s+calls?\b/iu,
  /^\[\s*[a-z0-9]+(?:[_\-.\s][a-z0-9]+)*\s*\]$/iu,
  /^native\s+\w+\s+transcript\b/iu,
];

export function isPlaceholderText(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return true;
  if (PLACEHOLDER_TEXT_MARKERS.some((marker) => normalized.includes(marker))) {
    return true;
  }
  return PLACEHOLDER_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * A bare protocol token like `[turn_ended]` — a raw lifecycle marker that
 * leaked into the trace text. Humanize to calm words, or null if it isn't one.
 */
function humanizeProtocolToken(text: string): string | null {
  const match = text.trim().match(/^\[\s*([a-z0-9]+(?:[_\-.\s][a-z0-9]+)*)\s*\]$/iu);
  if (!match) return null;
  return match[1]!.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim() || null;
}

function basename(path: string | null | undefined): string {
  const trimmed = path?.trim();
  if (!trimmed) return "file";
  const parts = trimmed.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

function hasWord(text: string | null | undefined): boolean {
  return Boolean(text && /[\p{L}\p{N}]/u.test(text));
}

/** True when a tool line is too thin to be a useful scan headline. */
export function isWeakToolHeadline(line: string): boolean {
  const compact = line.replace(/\s+/g, " ").trim();
  if (!compact) return true;
  // Bare tool name with no · arg (e.g. "bash", "Shell", "Read")
  if (!/[·•|]/.test(compact) && compact.split(/\s+/u).length <= 2) {
    if (/^(bash|shell|terminal|sh|zsh|read|write|edit|grep|glob|search|ls|cat)$/iu.test(compact)) {
      return true;
    }
  }
  // "bash ·" with nothing after
  if (/^(bash|shell|terminal)\s*[·•|]\s*$/iu.test(compact)) return true;
  return false;
}

/** Make tool lines scannable (bash/mcp especially). Null when too thin. */
export function prettifyToolLine(tool: string, arg: string | null | undefined): string | null {
  const name = tool.trim();
  if (!name) return null;
  const raw = (arg ?? "").replace(/\s+/g, " ").trim();
  if (!raw) {
    // Bare tool name is rarely useful as a home headline.
    return null;
  }

  // bash · <command> — drop wrapper noise, keep the command head
  if (/^bash$/i.test(name) || /shell|terminal/i.test(name)) {
    const cmd = raw
      .replace(/^const\s+\w+\s*=\s*await\s+/u, "")
      .replace(/^await\s+/u, "")
      .replace(/^\$\s*/u, "");
    const line = `bash · ${summarize(cmd, 96)}`;
    return isWeakToolHeadline(line) ? null : line;
  }

  // MCP / node repl wrappers often bury the intent in JSON
  if (/mcp|node_repl|repl/i.test(name) || /mcp__/i.test(raw)) {
    const title = raw.match(/["']title["']\s*:\s*["']([^"']+)["']/iu)?.[1];
    if (title) return summarize(title, 120);
    const cmd = raw.match(/["'](?:cmd|command|code)["']\s*:\s*["']([^"']+)["']/iu)?.[1];
    if (cmd) return `${name.split(/[_-]/u).slice(-1)[0] ?? name} · ${summarize(cmd, 88)}`;
  }

  // File tools: show basename when the arg is a path
  if (/^(read|write|edit|search|grep|glob|readmediafile)/i.test(name) || /[/\\]/.test(raw)) {
    const pathish = raw.split(/\s+/u)[0] ?? raw;
    if (/[/\\]/.test(pathish) || /\.[a-z0-9]{1,6}$/iu.test(pathish)) {
      return `${name} · ${basename(pathish)}`;
    }
  }

  const line = `${name} · ${summarize(raw, 88)}`;
  return isWeakToolHeadline(line) ? null : line;
}

function formatObserveAction(event: ObserveEvent): string | null {
  if (event.kind === "tool" && event.tool) {
    return prettifyToolLine(event.tool, event.arg);
  }
  if (event.kind === "message" || event.kind === "think" || event.kind === "ask") {
    const text = event.text?.trim();
    if (!text || !hasWord(text) || isPlaceholderText(text)) return null;
    return summarize(text, 120);
  }
  if (event.kind === "note") {
    const text = event.text?.trim();
    if (!text || isPlaceholderText(text)) return null;
    return summarize(text, 120);
  }
  if (event.kind === "system" || event.kind === "boot") {
    // Discovery / boot noise is never a good home headline.
    // Bare protocol tokens are handled separately as last resort.
    const text = event.text?.trim() ?? "";
    if (humanizeProtocolToken(text)) return null;
    if (!text || isPlaceholderText(text)) return null;
    return null;
  }
  return null;
}

/**
 * Build a useful context line when observe only has lifecycle noise
 * (e.g. “Native claude transcript discovered.”).
 */
export function contextActivityLine(input: {
  harness?: string | null;
  project?: string | null;
  branch?: string | null;
  live?: boolean;
  /** true when we only know a session is attached, not what it’s doing */
  attachedOnly?: boolean;
}): string {
  const harness = input.harness?.trim() || "agent";
  const project = input.project?.trim()
    ? input.project.trim().replace(/^~\/?/u, "")
    : null;
  const branch = input.branch?.trim() && input.branch.trim() !== "main"
    ? input.branch.trim()
    : null;
  const where = project
    ? (branch ? `~/${project} · ${branch}` : `~/${project}`)
    : null;

  if (input.attachedOnly) {
    return where
      ? `${harness} session attached · ${where}`
      : `${harness} session attached`;
  }
  if (input.live) {
    return where ? `Watching ${harness} in ${where}` : `Watching ${harness}`;
  }
  return where ? `${harness} in ${where}` : `${harness} session`;
}

/** Most recently touched file from observe inventory, if any. */
export function lastTouchedFileLine(observeData?: ObserveData | null): string | null {
  const files = observeData?.files ?? [];
  if (files.length === 0) return null;
  let best: { path: string; t: number } | null = null;
  for (const file of files) {
    const path = file.path?.trim();
    if (!path) continue;
    const t = typeof file.lastT === "number" ? file.lastT : 0;
    if (!best || t >= best.t) best = { path, t };
  }
  if (!best) return null;
  return `Touched · ${basename(best.path)}`;
}

/**
 * Final gate for any home signal headline. Drops lifecycle noise and thin lines.
 */
export function usefulHeadline(line: string | null | undefined): string | null {
  const text = line?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (isPlaceholderText(text)) return null;
  if (isWeakToolHeadline(text)) return null;
  return summarize(text, 160) || null;
}

export function liveActionSummary(input: {
  observeData?: ObserveData | null;
  checkpoint?: string | null;
  fallbackTask?: string | null;
  observeLive?: boolean;
  /** When true, lifecycle tokens like “turn complete” are never returned. */
  skipLifecycleTokens?: boolean;
}): string | null {
  const checkpoint = usefulHeadline(input.checkpoint);
  if (checkpoint) return summarize(checkpoint, 140);

  const events = input.observeData?.events ?? [];

  // Pass 1: newest → oldest for real work (tools with args, conversation, think).
  // Prefer tools when live so the scan line tracks current activity.
  let bestConversation: string | null = null;
  let bestTool: string | null = null;
  let humanizedToken: string | null = null;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;

    // Capture bare protocol tokens from any kind (incl. system) as last resort.
    const rawText = event.text?.trim() ?? "";
    if (rawText) {
      const token = humanizeProtocolToken(rawText);
      if (token && !humanizedToken) {
        humanizedToken = token;
      }
    }

    const formatted = formatObserveAction(event);
    if (!formatted) continue;
    if (isPlaceholderText(formatted)) continue;
    if (isWeakToolHeadline(formatted)) continue;

    if (event.kind === "tool") {
      if (!bestTool) bestTool = formatted;
      continue;
    }
    if (event.kind === "message" || event.kind === "ask" || event.kind === "think") {
      if (!bestConversation) bestConversation = formatted;
      continue;
    }
    // Non-lifecycle note that survived filters — treat as conversation-ish.
    if (event.kind === "note" && !bestConversation) {
      bestConversation = formatted;
    }
  }

  // Live sessions: current tool beats stale chat. Idle: chat/ask beats old tool.
  if (input.observeLive) {
    if (bestTool) return summarize(bestTool, 140);
    if (bestConversation) return summarize(bestConversation, 140);
  } else {
    if (bestConversation) return summarize(bestConversation, 140);
    if (bestTool) return summarize(bestTool, 140);
  }

  // Bare protocol tokens humanize to calm words ("turn ended") only when the
  // caller wants a last-resort line. Home signal list skips them entirely.
  if (humanizedToken && !input.skipLifecycleTokens) {
    return summarize(humanizedToken, 140);
  }

  const fallback = usefulHeadline(input.fallbackTask);
  if (!fallback) return null;
  return summarize(fallback, 140);
}

export type HomeCardAction = "profile" | "observe" | "peek" | "terminal";

export function homeCardRoute(agent: Agent, action: HomeCardAction): Route {
  if (isSyntheticAgentId(agent.id)) {
    const sessionId = sessionRefFromSyntheticAgent(agent);
    if (sessionId) {
      return { view: "sessions", sessionId };
    }
    return { view: "ops", mode: "lanes" };
  }

  switch (action) {
    case "profile":
      return { view: "agents-v2", agentId: agent.id, tab: "profile" };
    case "observe":
      return { view: "agents-v2", agentId: agent.id, tab: "observe" };
    case "peek":
      return { view: "agents-v2", selectedAgentId: agent.id };
    case "terminal":
      return { view: "terminal", agentId: agent.id, mode: "observe" };
  }
}

export function homeCardPeekEnabled(agent: Agent): boolean {
  return Boolean(agent.terminalSurface?.backend === "tmux" || agent.harnessSessionId);
}

export function homeCardTerminalEnabled(agent: Agent): boolean {
  return Boolean(agent.terminalSurface);
}
