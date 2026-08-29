import { deriveContextBudgetGauge, formatContextTokenCount } from "../../lib/context-budget.ts";
import { isAgentBusy } from "../../lib/agent-state.ts";
import { timeAgo } from "../../lib/time.ts";
import { laneToolArgSnippet } from "../../lib/lane-observe.ts";
import { splitCdPrefix, tildeShortenPath } from "../../lib/bash-format.ts";
import type { ObserveEvent, ObserveFile } from "../../lib/types.ts";
import type { AgentLaneCardModel, LanePopGroup, LanePopRow } from "./AgentLaneCard.tsx";
import { buildAgentLanePreview, filePreviewLabel, hasMeaningfulText } from "./agent-lane-preview.ts";
import { lanePrimaryLabel, type AgentLane } from "./agent-lanes-model.ts";

/** How many rows a tool-use hover popover lists (top-N) before a "+N more" tally. */
const POPOVER_CAP = 14;

/** A compact tool glyph by family, mirroring the trace idiom (no emoji). */
function toolGlyph(tool: string | undefined): string {
  const k = (tool ?? "").toLowerCase();
  if (/bash|shell|exec|run|command|terminal/.test(k)) return "❯";
  if (/edit|write|apply|patch|create|update|str_replace|multiedit/.test(k)) return "✎";
  if (/read|view|cat|open/.test(k)) return "◎";
  if (/grep|search|glob|find|rg|ripgrep/.test(k)) return "⌕";
  if (/fetch|web|browse|url/.test(k)) return "⤓";
  return "▸";
}

/** A recent tool call → a popover row: a family glyph + a tidied arg (or the
 *  tool name when the arg is control/JSON noise). */
function toolRow(event: ObserveEvent): LanePopRow {
  const raw = event.arg?.trim();
  const looksJson = !!raw && (raw.startsWith("{") || raw.startsWith("["));
  let text: string;
  if (!raw || looksJson || raw === "started" || raw === "completed") {
    text = event.tool ?? "tool";
  } else {
    let arg = tildeShortenPath(raw);
    arg = splitCdPrefix(arg).rest || arg;
    text = laneToolArgSnippet(arg, 56);
  }
  return { mark: toolGlyph(event.tool), tone: "tool", text, full: raw || (event.tool ?? text) };
}

/** Last two path segments — "/Users/art/dev/openscout/packages/web" → "packages/web". */
function formatCwd(path: string): string {
  const parts = path.replace(/\/+$/u, "").split(/[\\/]/u).filter(Boolean);
  return parts.length === 0 ? path : parts.slice(-2).join("/");
}

function shortSession(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const leaf = trimmed.split("/").pop() ?? trimmed;
  return leaf.replace(/\.jsonl$/u, "").slice(0, 8);
}

/** Tidy a raw model id into a readable display name.
 *  "claude-opus-5" → "opus-5", "anthropic/claude-sonnet-4-6" → "sonnet-4.6". */
function formatModelName(model: string | null | undefined): string | null {
  const raw = model?.trim();
  if (!raw) return null;
  let m = raw.replace(/^[a-z0-9.]+\//iu, ""); // drop "anthropic/" etc. provider prefix
  m = m.replace(/^(claude|anthropic)-/iu, ""); // drop the claude vendor prefix
  m = m.replace(/-(\d{8})$/u, ""); // drop a trailing yyyymmdd date stamp
  m = m.replace(/-(\d+)-(\d+)(?=$|-)/gu, "-$1.$2"); // "4-8" → "4.8"
  return m || raw;
}

function fileRowState(state: ObserveFile["state"]): "mod" | "new" | "read" {
  if (state === "created") return "new";
  if (state === "read") return "read";
  return "mod";
}

const TOKEN_COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Compact token count for cockpit readouts — "15403083" → "15.4m". */
function fmtCompactTokens(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return TOKEN_COMPACT.format(value).toLowerCase();
}

/** Strip a leading direction arrow (→/←/↳) so it isn't doubled with the card's
 *  own glyph, and trim surrounding space. */
function cleanHeadline(text: string | null | undefined): string {
  return (text ?? "").replace(/^\s*[←→↳⇒➜]+\s*/u, "").trim();
}

/** True when a headline carries no real content — empty, arrow-only, or a bare
 *  "thinking"/"running tool" placeholder — so the status reads as a calm working
 *  state instead of a stray glyph. */
function isPlaceholderHeadline(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[[\]…]/gu, "").trim();
  return t === "" || t === "thinking" || t === "running tool" || t === "turn update";
}

/**
 * Adapt a live AgentLane (+ its preview) into the clean presentational model
 * the AgentLaneCard header / status box render. The trace is handled separately
 * (the card hosts a SessionObserve timeline slot), so this only covers identity,
 * facts, and the current-state summary.
 */
export function agentLaneToCardModel(
  lane: AgentLane,
  opts: { isLive: boolean; nowMs: number },
): AgentLaneCardModel {
  const { agent, observe, source, facts } = lane;
  const preview = buildAgentLanePreview(observe, agent, { isLive: opts.isLive });
  const session = observe?.metadata?.session;

  const cwdRaw = facts?.cwd ?? agent.cwd ?? agent.projectRoot ?? null;
  const cwd = cwdRaw ? formatCwd(cwdRaw) : null;
  const sessionIdFull = agent.harnessSessionId?.trim() || null;
  const authority = agent.agentClass === "operator"
    ? {
        label: "operator",
        title: [
          agent.role ? `Role: ${agent.role}` : "Privileged operator agent",
          agent.authorityProfile
            ? `Reads: ${agent.authorityProfile.readTools.join(", ") || "none"}`
            : null,
          agent.authorityProfile
            ? `Writes: ${agent.authorityProfile.writeTools.join(", ") || "none"}`
            : null,
          agent.authorityProfile
            ? `Shell: ${agent.authorityProfile.shell ? "allowed" : "blocked"}; code writes: ${agent.authorityProfile.codebaseWrites ? "allowed" : "blocked"}`
            : null,
          agent.runtimePolicy?.sandbox ? `Sandbox: ${agent.runtimePolicy.sandbox}` : null,
        ].filter(Boolean).join(" · "),
      }
    : null;

  // The card no longer lists files inline; instead each tool-use pill reveals its
  // own top-N inventory on hover — tools → recent tool calls, edits → files
  // written, reads → files read, files → everything touched.
  const sourceFiles = facts?.touchedFiles.length ? facts.touchedFiles : preview?.files ?? [];
  const meaningfulFiles = sourceFiles.filter((file) => hasMeaningfulText(filePreviewLabel(file)));
  const fileRow = (file: ObserveFile): LanePopRow => {
    const tone = fileRowState(file.state);
    return { mark: tone, tone, text: filePreviewLabel(file), full: file.path };
  };
  const fileGroup = (files: ObserveFile[]): LanePopGroup => {
    const rows = files.map(fileRow);
    return { rows: rows.slice(0, POPOVER_CAP), more: Math.max(0, rows.length - POPOVER_CAP) };
  };
  const toolEvents = (observe?.events ?? []).filter((event) => event.kind === "tool");
  const toolRows = toolEvents.slice(-POPOVER_CAP).reverse().map(toolRow);
  const pops = {
    tools: { rows: toolRows, more: Math.max(0, toolEvents.length - toolRows.length) },
    edits: fileGroup(meaningfulFiles.filter((file) => file.state !== "read")),
    reads: fileGroup(meaningfulFiles.filter((file) => file.state === "read")),
    files: fileGroup(meaningfulFiles),
  };

  // Cockpit session-context instruments — context-window %, context token count, turn.
  const usage = facts?.usage ?? observe?.metadata?.usage ?? null;
  const contextGauge = deriveContextBudgetGauge(usage, {
    model: facts?.model ?? preview?.model ?? agent.model ?? session?.model ?? null,
    adapterType: agent.harness ?? preview?.harness ?? session?.adapterType ?? null,
  });
  const context = contextGauge ? Math.min(100, contextGauge.pct) : null;
  const tokens = contextGauge?.usedLabel ?? formatContextTokenCount(usage?.contextInputTokens);
  const turns = facts?.turn?.index ?? session?.turnCount ?? null;

  const tokenDials = usage
    ? [
        { label: "in", value: usage.inputTokens },
        { label: "out", value: usage.outputTokens },
        { label: "cache rd", value: usage.cacheReadInputTokens },
        { label: "cache wr", value: usage.cacheCreationInputTokens },
        { label: "total", value: usage.totalTokens },
        { label: "reasoning", value: usage.reasoningOutputTokens },
      ].filter((entry): entry is { label: string; value: number } => typeof entry.value === "number")
    : [];
  const tokenUsage: AgentLaneCardModel["tokenUsage"] = tokenDials.length > 0
    ? {
        total: typeof usage?.totalTokens === "number" ? usage.totalTokens : null,
        dials: tokenDials,
      }
    : null;

  const working = isAgentBusy(agent.state ?? null, agent);

  // The status line shows the last known step. When the current event carries no
  // real content (empty/arrow-only, or a bare "thinking"), render a calm state
  // rather than a stray `❯ →`.
  const headDir: "to" | "from" | null =
    preview?.headlineFrom === "user" ? "from" : preview?.headlineFrom === "agent" ? "to" : null;
  const headText = cleanHeadline(preview?.headline);
  const headPlaceholder = !preview || isPlaceholderHeadline(headText);
  const head = {
    dir: headPlaceholder ? null : headDir,
    text: headPlaceholder ? (working ? "thinking…" : "idle") : headText,
    full:
      headPlaceholder || !preview || preview.headFull === preview.headline
        ? null
        : cleanHeadline(preview.headFull),
    placeholder: headPlaceholder,
  };

  return {
    name: lanePrimaryLabel(agent, source),
    authority,
    harness: agent.harness ?? preview?.harness ?? session?.adapterType ?? null,
    model: formatModelName(facts?.model ?? preview?.model ?? agent.model ?? session?.model ?? null),
    effort: facts?.effort ?? session?.effort ?? null,
    cwd,
    cwdFull: cwdRaw,
    branch: facts?.branch ?? preview?.branch ?? agent.branch ?? null,
    sessionId: shortSession(agent.harnessSessionId),
    sessionIdFull,
    parentSessionId: facts?.parentSessionId ?? null,
    parentSessionLabel: facts?.parentSessionId
      ? [facts.parentAgentName, shortSession(facts.parentSessionId)].filter(Boolean).join(" · ")
      : null,
    time: lane.lastActiveAt ? timeAgo(lane.lastActiveAt, opts.nowMs) : null,
    working,
    head,
    stats: {
      tools: preview?.stats.tools ?? 0,
      edits: preview?.stats.edits ?? 0,
      reads: preview?.stats.reads ?? 0,
      files: preview?.stats.files ?? 0,
    },
    context,
    tokens,
    turns,
    tokenUsage,
    pops,
  };
}
