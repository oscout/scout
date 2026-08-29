import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, ChevronUp, ExternalLink, MessageCircle, Tag, Wrench } from "lucide-react";

import type {
  ObserveData,
  ObserveEvent,
  ObserveFile,
  ObserveMetadata,
  ObserveSessionMeta,
  ObserveUsageMeta,
  SessionCatalogWithResume,
} from "../../lib/types.ts";
import {
  collapseObserveDisplayRows,
  collapseTechnicalObserveDisplayRows,
  isSimpleLaneToolEvent,
  type ObserveDisplayRow,
  type ObserveTechnicalSummary,
} from "../../lib/observe-display.ts";
import {
  grokLaneGutterLabel,
  humanizeGrokLanePhase,
  parseGrokLaneSystemText,
} from "../../lib/grok-lane-display.ts";
import { laneDisplayPath } from "../../lib/lane-edit-display.ts";
import { fmtLaneSessionOffset } from "../../lib/lane-tool-detail.ts";
import {
  useLaneToolHoverCard,
  type LaneToolHoverBindings,
} from "./LaneToolHoverCard.tsx";
import { formatBashLine, type PowerlineMode } from "../../lib/bash-format.ts";
import {
  countObserveEventsBeforeHorizon,
  filterObserveEventsForHorizon,
  fmtLaneAgeLabel,
  fmtLaneAgeTitle,
  fmtLaneWallGapLabel,
  fmtTraceSpanMs,
  LANE_TRACE_FILL_MIN,
  laneSnippetText,
  laneTextNeedsExpand,
  laneToolArgSnippet,
  laneTraceWindowStats,
  observeEventWallMs,
} from "../../lib/lane-observe.ts";
import { buildLaneAskDisplay } from "../../lib/lane-ask-display.ts";
import { actorColor } from "../../lib/colors.ts";
import { api } from "../../lib/api.ts";
import { renderWithMentions } from "../../lib/mentions.tsx";
import {
  formatClockTimestamp,
  formatDurationClock,
  fullTimestamp,
  normalizeTimestampMs,
  timeAgo,
  timeAgoWithSuffix,
} from "../../lib/time.ts";
import { MessageMarkup } from "../../lib/message-markup.tsx";
import {
  describeObserveEvidence,
  type ObserveEvidenceFidelity,
  type ObserveEvidenceSource,
} from "../../lib/observe-fidelity.ts";
import { queueTakeover } from "../../lib/terminal-takeover.ts";
import {
  invokeSession,
  resumableHarnessFromAdapterType,
  resumeAgentSession,
} from "../../lib/session-start.ts";
import { useScout } from "../../scout/Provider.tsx";
import { openContent } from "../../scout/slots/openContent.ts";
import { ObservedTopologyPanel } from "../../components/ObservedTopologyPanel.tsx";
import { MessageComposer } from "../../components/MessageComposer/index.ts";
import {
  ObserveReasoningDisclosure,
  ObserveStreamCursor,
} from "./ObserveTextFlow.tsx";
import { SessionObserveReceiptView } from "./SessionObserveEvidence.tsx";

import "./session-observe.css";

async function revealLocalPath(input: {
  path: string;
  basePath?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
}) {
  await api<{ ok: true; path: string }>("/api/local-path/reveal", {
    method: "POST",
    body: JSON.stringify({
      path: input.path,
      ...(input.basePath ? { basePath: input.basePath } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }),
  });
}

export type SessionEvent = ObserveEvent;
export type SessionFile = ObserveFile;
export type SessionObserveData = ObserveData;

/* ── Constants ── */

const KIND_COLOR: Record<string, string> = {
  think: "var(--dim)",
  tool: "var(--accent)",
  ask: "var(--amber)",
  message: "var(--muted)",
  note: "var(--green)",
  system: "var(--dim)",
  boot: "var(--dim)",
};

const TOOL_GLYPH: Record<string, string> = {
  read: "◎",
  edit: "✎",
  bash: "$",
  grep: "⌕",
  write: "✎",
  think: "∿",
};

const LIVE_EDGE_WINDOW_SECONDS = 20;
const GROUPED_NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

type ObserveDetailTone = "default" | "accent" | "good" | "warn";
type ObserveDetailRow = {
  label: string;
  value: string;
  /** Optional shortened render (e.g. a path basename); copy + tooltip keep `value`. */
  display?: string;
  title?: string;
  tone?: ObserveDetailTone;
  wrap?: boolean;
  actionPath?: string;
  actionBasePath?: string | null;
};

/** Compact elapsed label for lane trace rows (avoids clock-like H:MM:SS). */
function fmtElapsed(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) {
    return "0s";
  }
  const totalSeconds = Math.floor(sec);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  if (totalSeconds < 3_600) {
    return `${Math.floor(totalSeconds / 60)}m`;
  }
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

function fmtPreciseElapsed(sec: number): string {
  return formatDurationClock(sec * 1000) || "0:00";
}

function fmtGap(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0s";
  }
  return fmtElapsed(seconds);
}

function laneEventWallMs(
  event: Pick<ObserveEvent, "t" | "at">,
  sessionStartMs: number | undefined,
): number | null {
  return observeEventWallMs(event as ObserveEvent, sessionStartMs);
}

function fmtLaneRowTime(
  event: Pick<ObserveEvent, "t" | "at">,
  sessionStartMs: number | undefined,
  nowMs: number,
  preferWallAge = false,
): { label: string; title?: string } {
  const wallMs = laneEventWallMs(event, sessionStartMs);

  if (wallMs !== null) {
    return preferWallAge
      ? { label: fmtLaneAgeLabel(wallMs, nowMs), title: fmtLaneAgeTitle(wallMs) }
      : { label: timeAgo(wallMs, nowMs), title: fmtLaneAgeTitle(wallMs) };
  }
  if (preferWallAge) {
    return { label: "" };
  }
  return { label: fmtElapsed(event.t) };
}

function fmtObserveRowTime(
  event: Pick<ObserveEvent, "t" | "at">,
  sessionStartMs: number | undefined,
): { label: string; title?: string } {
  const wallMs = laneEventWallMs(event, sessionStartMs);
  const elapsed = fmtPreciseElapsed(event.t);

  if (wallMs !== null) {
    return {
      label: formatClockTimestamp(wallMs) || fmtElapsed(event.t),
      title: `${fullTimestamp(wallMs)} · elapsed ${elapsed}`,
    };
  }

  return {
    label: fmtElapsed(event.t),
    title: `Elapsed ${elapsed} from session start`,
  };
}

function isCursorAtLiveEdge(cursor: number, duration: number): boolean {
  return cursor >= Math.max(0, duration - LIVE_EDGE_WINDOW_SECONDS);
}

function fmtGroupedNumber(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return GROUPED_NUMBER_FORMAT.format(value);
}

function fmtCompactNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  if (Math.abs(value) < 1_000) {
    return GROUPED_NUMBER_FORMAT.format(value);
  }

  return COMPACT_NUMBER_FORMAT.format(value).toLowerCase();
}

function fmtWindowSpan(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const wholeSeconds = Math.round(seconds);
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes >= 10 || remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function hasObserveRows(value: ObserveMetadata | ObserveSessionMeta | ObserveUsageMeta | undefined): boolean {
  return !!value && Object.keys(value).length > 0;
}

function definedObserveRows(rows: Array<ObserveDetailRow | null | undefined>): ObserveDetailRow[] {
  return rows.filter((row): row is ObserveDetailRow => Boolean(row));
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function revealPath(input: {
  path: string;
  basePath?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
}) {
  void revealLocalPath(input).catch((error) => {
    console.warn("Failed to reveal local path", error);
  });
}

/* ── Copy helper ── */

function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const value = text;
      const finish = () => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1100);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(value).then(finish).catch(() => {
          fallbackCopy(value);
          finish();
        });
      } else {
        fallbackCopy(value);
        finish();
      }
    },
    [text],
  );

  return (
    <button
      type="button"
      className={`s-observe-copy-btn${copied ? " s-observe-copy-btn--copied" : ""}${className ? ` ${className}` : ""}`}
      onClick={handleCopy}
      aria-label={label}
      title={copied ? "Copied" : label}
    >
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 5.5l2.4 2.4L9 3.4" />
        </svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
          <rect x="3.4" y="3.4" width="6.1" height="6.1" rx="1.2" />
          <path d="M7.6 3.4V2.2a.8.8 0 0 0-.8-.8H2.2a.8.8 0 0 0-.8.8v4.6a.8.8 0 0 0 .8.8h1.2" />
        </svg>
      )}
    </button>
  );
}

function fallbackCopy(value: string): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch (error) {
    console.warn("Clipboard copy failed", error);
  }
}

function buildToolCopyText(event: SessionEvent): string {
  const lines: string[] = [];
  const head = [event.tool, event.arg].filter(Boolean).join(" ");
  if (head) lines.push(head);
  if (event.result) {
    lines.push(
      Object.entries(event.result)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" · "),
    );
  }
  if (event.diff) {
    lines.push(`+${event.diff.add}${event.diff.del > 0 ? ` -${event.diff.del}` : ""}`);
    if (event.diff.preview) lines.push(event.diff.preview);
  }
  if (event.stream && event.stream.length > 0) {
    lines.push(event.stream.join("\n"));
  }
  return lines.join("\n");
}

/* ── Event blocks ── */

function LaneExpandToggle({
  expanded,
  onToggle,
  label,
}: {
  expanded: boolean;
  onToggle: () => void;
  label?: string;
}) {
  const text = expanded ? "less" : (label ?? "more");
  return (
    <button
      type="button"
      className="s-observe-lane-expand"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? "Show less" : "Show more"}
    >
      {expanded ? (
        <ChevronUp size={11} strokeWidth={2} aria-hidden="true" />
      ) : (
        <ChevronDown size={11} strokeWidth={2} aria-hidden="true" />
      )}
      <span>{text}</span>
    </button>
  );
}

function LaneExpandableText({
  text,
  className,
  laneMode = false,
  live = false,
  renderExpanded,
  renderCollapsed,
}: {
  text: string;
  className: string;
  laneMode?: boolean;
  live?: boolean;
  renderExpanded?: (value: string) => ReactNode;
  renderCollapsed?: (value: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const normalized = text.trim();
  if (!laneMode) {
    return (
      <div className={className}>
        {renderExpanded ? renderExpanded(normalized) : normalized}
        {live && <ObserveStreamCursor text={normalized} />}
      </div>
    );
  }

  const needsExpand = laneTextNeedsExpand(normalized);
  const snippet = laneSnippetText(normalized);
  const body = expanded
    ? (renderExpanded ? renderExpanded(normalized) : normalized)
    : (renderCollapsed ? renderCollapsed(snippet) : snippet);

  return (
    <div className={`s-observe-lane-expandable${expanded ? " s-observe-lane-expandable--open" : ""}`}>
      <div className={`${className} s-observe-lane-expandable-body`}>
        <span className="s-observe-lane-expandable-text">
          {body}
          {live && <ObserveStreamCursor text={normalized} />}
        </span>
        {needsExpand && (
          <LaneExpandToggle
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        )}
      </div>
    </div>
  );
}

function ThinkBlock({ event, laneMode = false }: { event: SessionEvent; laneMode?: boolean }) {
  const text = event.text ?? "";
  return (
    <ObserveReasoningDisclosure
      text={text}
      live={Boolean(event.live)}
      compact={laneMode}
      copyControl={
        !laneMode ? (
          <CopyButton
            text={text}
            label="Copy reasoning"
            className="s-observe-copy-btn--inline"
          />
        ) : undefined
      }
    />
  );
}

function DiffPreview({ preview }: { preview: string }) {
  const lines = preview.split("\n");
  return (
    <pre className="s-observe-tool-diff-preview">
      {lines.map((line, i) => {
        const head = line[0];
        const tone =
          head === "+"
            ? "add"
            : head === "-" || head === "−"
              ? "del"
              : line.startsWith("@@")
                ? "hunk"
                : "ctx";
        return (
          <span
            key={i}
            className={`s-observe-diff-line s-observe-diff-line--${tone}`}
          >
            {line}
            {i < lines.length - 1 ? "\n" : null}
          </span>
        );
      })}
    </pre>
  );
}

function observeToolGlyphKey(tool: string | undefined): string {
  const key = (tool ?? "").toLowerCase();
  return key === "shell" ? "bash" : key;
}

function toolArgLabel(event: SessionEvent): string | undefined {
  const arg = event.arg?.trim();
  if (!arg || arg === "started" || arg === "completed") return undefined;
  return arg;
}

/* ── bespoke per-tool lane rows ────────────────────────────────────────────
 * In the lane trace each tool call reads in its own idiom rather than a uniform
 * "name + arg" line: bash as a shell prompt, file ops as clean paths, search as
 * a quoted needle. The family is classified client-side so it survives both the
 * rich observe builder (normalized names) and the tail parser (raw names). The
 * expand/diff/outcome machinery below is shared — only the header line changes. */

type LaneToolFamily = "bash" | "read" | "file" | "search" | "fetch" | "agent" | "generic";

const LANE_TOOL_FAMILIES: Record<LaneToolFamily, readonly string[]> = {
  // Names span both harness idioms: Claude's tool names (Read/Bash/Grep/…) and
  // codex's raw call names (exec_command/apply_patch/…) which arrive verbatim.
  bash: [
    "bash", "shell", "terminal", "exec", "run", "command",
    "exec_command", "shell_command", "local_shell", "container_exec", "container.exec",
  ],
  read: ["read", "view", "cat", "readfile", "open", "open_file"],
  file: [
    "write", "writefile", "create", "edit", "multiedit",
    "str_replace", "strreplace", "str_replace_editor", "apply_patch", "applypatch", "patch", "patch_apply", "update",
    "delete",
  ],
  search: ["grep", "glob", "search", "rg", "ripgrep", "find", "codebase_search", "file_search"],
  fetch: ["webfetch", "web_fetch", "fetch", "websearch", "web_search", "browse", "url"],
  agent: ["agent", "task", "dispatch", "subagent"],
  generic: [],
};

const LANE_FAMILY_GLYPH: Record<LaneToolFamily, string> = {
  bash: "$",
  read: "◎",
  file: "✎",
  search: "⌕",
  fetch: "⤓",
  agent: "◇",
  generic: "▸",
};

function laneToolFamily(tool: string | undefined): LaneToolFamily {
  const key = (tool ?? "").trim().toLowerCase();
  if (!key) return "generic";
  for (const family of ["bash", "read", "file", "search", "fetch", "agent"] as const) {
    if (LANE_TOOL_FAMILIES[family].includes(key)) return family;
  }
  return "generic";
}

function laneIsControlArg(arg: string | undefined): boolean {
  return !arg || arg === "started" || arg === "completed";
}

/** Split a path into its directory prefix (kept with trailing slash) and leaf. */
function laneSplitPath(raw: string): { dir: string; base: string } {
  const clean = raw.trim().replace(/\/+$/u, "");
  const slash = clean.lastIndexOf("/");
  if (slash < 0) return { dir: "", base: clean };
  return { dir: clean.slice(0, slash + 1), base: clean.slice(slash + 1) };
}

/** Keep only the last `segs` directory segments, eliding the rest with "…/". */
function laneShortDir(dir: string, segs = 2): string {
  const parts = dir.split("/").filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length <= segs) return `${parts.join("/")}/`;
  return `…/${parts.slice(-segs).join("/")}/`;
}

function laneSearchCount(result: SessionEvent["result"]): number | null {
  if (!result) return null;
  for (const key of ["matches", "count", "results", "hits"]) {
    const value = result[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/u.test(value.trim())) return Number(value.trim());
  }
  return null;
}

function laneFetchHost(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname + parsed.search };
  } catch {
    return { host: url, path: "" };
  }
}

/** A codex shell wrapper like ["bash","-lc","<script>"] — show the script, not
 *  the wrapper. Otherwise join the parts. */
function laneCommandFromArray(parts: string[]): string {
  if (parts.length >= 3 && /^(?:ba|z)?sh$/u.test(parts[0]) && /^-[a-z]*c$/u.test(parts[1])) {
    return parts.slice(2).join(" ");
  }
  return parts.join(" ");
}

/** Pull a display string out of a (possibly truncated) JSON arg by trying keys
 *  in priority order. codex passes tool input as JSON in the call text, and the
 *  tail summary may cut it off mid-string — so fall back to a forgiving regex
 *  grab of the first matching key. Returns null when the arg isn't JSON-shaped. */
function laneStripJsonArg(arg: string, keys: readonly string[]): string | null {
  const text = arg.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value;
        if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
          return laneCommandFromArray(value as string[]);
        }
      }
    }
  } catch {
    // truncated/invalid JSON — fall through to the regex grab below
  }
  for (const key of keys) {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "u"));
    if (match?.[1]) {
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return match[1];
      }
    }
  }
  return null;
}

/** codex apply_patch carries a patch blob; pull the first touched file path out
 *  of its "*** Update File: <path>" header. */
function lanePathFromPatch(arg: string): string | null {
  const match = arg.match(/\*\*\*\s+(?:Update|Add|Delete|Move|Rename)\s+File:\s*(.+)/u);
  if (!match) return null;
  return match[1].trim().split(/\s*(?:->|=>)\s*/u)[0]?.trim() || null;
}

/** Resolve the raw tool arg into a clean display string for its family —
 *  unwrapping codex JSON / patch blobs so paths and commands read cleanly. */
function laneDecodeArg(family: LaneToolFamily, arg: string | undefined): string {
  const raw = arg?.trim();
  if (!raw) return "";
  switch (family) {
    case "bash":
      return laneStripJsonArg(raw, ["cmd", "command", "script", "input", "code"]) ?? raw;
    case "file":
      if (raw.includes("*** ")) return lanePathFromPatch(raw) ?? raw;
      return laneStripJsonArg(raw, ["file_path", "path", "filename", "file"]) ?? raw;
    case "read":
      return laneStripJsonArg(raw, ["file_path", "path", "filename", "file"]) ?? raw;
    case "search":
      return laneStripJsonArg(raw, ["pattern", "query", "glob", "regex", "q", "search"]) ?? raw;
    case "fetch":
      return laneStripJsonArg(raw, ["url", "href", "uri"]) ?? raw;
    default:
      return raw;
  }
}

function LanePath({ path, tone }: { path: string; tone: "read" | "file" }) {
  const displayPath = laneDisplayPath(path);
  const { dir, base } = laneSplitPath(displayPath);
  return (
    <span className="s-observe-tool-path" title={path}>
      {dir && <span className="s-observe-tool-path-dir">{laneShortDir(dir)}</span>}
      <span className={`s-observe-tool-path-base s-observe-tool-path-base--${tone}`}>{base}</span>
    </span>
  );
}

/** A cd destination: the directory name reads, the path prefix recedes. */
function LaneBashDir({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  const prefix = slash >= 0 ? path.slice(0, slash + 1) : "";
  const leaf = slash >= 0 ? path.slice(slash + 1) : path;
  return (
    <span className="s-observe-bash-dir">
      {prefix && <span className="s-observe-bash-dir-prefix">{prefix}</span>}
      {leaf}
    </span>
  );
}

/**
 * LaneBashLine — a shell command rendered as an embedded terminal line: a
 * bordered pill with a chevron prompt, then the command in tiers (program ·
 * args · plumbing), with a thoughtful `dir` treatment for a cd destination.
 * A leading cd can optionally lift into a powerline segment (off by default —
 * see lib/bash-format.ts). All parsing lives there; this stays presentational.
 * One line via CSS nowrap; full command on hover (title).
 */
function LaneBashLine({
  command,
  title,
  outcome,
  outputPreview,
  cwd,
  powerline,
}: {
  command: string;
  title?: string;
  outcome?: string;
  /** Compact stdout/stderr preview from a merged tool result. */
  outputPreview?: string;
  cwd?: string | null;
  powerline?: PowerlineMode;
}) {
  const { dir, spans } = formatBashLine(command, { cwd, powerline });
  return (
    <span
      className="s-observe-bash"
      title={title ?? command}
    >
      {dir && (
        <span className="s-observe-bash-pl">
          <span className="s-observe-bash-seg">{dir}</span>
          <span className="s-observe-bash-sep" aria-hidden />
        </span>
      )}
      <span className="s-observe-bash-prompt" aria-hidden>❯</span>
      {spans.length > 0 ? (
        <span className="s-observe-bash-cmd">
          {spans.map((span, index) => {
            const lead = index > 0 ? " " : "";
            if (span.tier === "dir") {
              return (
                <span key={index}>
                  {lead}
                  <LaneBashDir path={span.text} />
                </span>
              );
            }
            return (
              <span
                key={index}
                className={`s-observe-bash-${span.tier}${span.known ? " s-observe-bash-prog--known" : ""}${span.flag ? " s-observe-bash-flag" : ""}`}
              >
                {lead}
                {span.text}
              </span>
            );
          })}
        </span>
      ) : (
        !dir && <span className="s-observe-bash-arg">shell</span>
      )}
      {outputPreview && (
        <span className="s-observe-bash-out" title={outputPreview}>
          {" → "}
          {laneToolArgSnippet(outputPreview, 88)}
        </span>
      )}
      {outcome && <span className="s-observe-bash-ok">{outcome}</span>}
    </span>
  );
}

function LaneToolContent({ family, event }: { family: LaneToolFamily; event: SessionEvent }) {
  const decoded = laneDecodeArg(family, event.arg);
  // Guard against showing raw JSON the decoder couldn't unwrap (e.g. codex
  // write_stdin payloads) — fall back to the family's quiet placeholder instead.
  const looksJson = decoded.startsWith("{") || decoded.startsWith("[");
  const hasArg = Boolean(decoded) && !laneIsControlArg(decoded) && !looksJson;

  switch (family) {
    // bash is rendered by LaneBashLine (its own terminal block) in ToolBlock.
    case "read":
      return hasArg ? (
        <LanePath path={decoded} tone="read" />
      ) : (
        <span className="s-observe-tool-cmd-name">read</span>
      );
    case "file": {
      // codex apply_patch lands as arg:"patch" with the real path in the patch
      // blob (event.detail); a Claude Edit lands with the path already in arg.
      const path =
        hasArg && decoded !== "patch" ? decoded : lanePathFromPatch(event.detail ?? "") ?? "";
      return path ? (
        <LanePath path={path} tone="file" />
      ) : (
        <span className="s-observe-tool-cmd-name">{event.tool ?? "edit"}</span>
      );
    }
    case "search": {
      if (!hasArg) return <span className="s-observe-tool-cmd-name">search</span>;
      const count = laneSearchCount(event.result);
      return (
        <>
          <span className="s-observe-tool-needle">
            <span className="s-observe-tool-needle-q">"</span>
            {decoded}
            <span className="s-observe-tool-needle-q">"</span>
          </span>
          {count != null && (
            <span className="s-observe-tool-count">· {count} {count === 1 ? "match" : "matches"}</span>
          )}
        </>
      );
    }
    case "fetch": {
      if (!hasArg) return <span className="s-observe-tool-cmd-name">fetch</span>;
      const { host, path } = laneFetchHost(decoded);
      return (
        <span className="s-observe-tool-url" title={decoded}>
          <span className="s-observe-tool-host">{host}</span>
          {path && path !== "/" && (
            <span className="s-observe-tool-host-path">{laneToolArgSnippet(path, 40)}</span>
          )}
        </span>
      );
    }
    case "agent":
      return (
        <span className="s-observe-tool-agent-name">{hasArg ? decoded : event.tool ?? "agent"}</span>
      );
    default:
      return (
        <>
          <span className="s-observe-tool-cmd-name">{event.tool}</span>
          {hasArg ? (
            <>
              {" "}
              <span className="s-observe-tool-cmd-arg">{decoded}</span>
            </>
          ) : null}
        </>
      );
  }
}

function ToolBlock({
  event,
  laneMode = false,
  simple = false,
  wallLabel,
  wallTitle,
}: {
  event: SessionEvent;
  laneMode?: boolean;
  simple?: boolean;
  wallLabel?: string;
  wallTitle?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const family = laneToolFamily(event.tool);
  const glyph = laneMode
    ? LANE_FAMILY_GLYPH[family]
    : TOOL_GLYPH[observeToolGlyphKey(event.tool)] ?? "▸";
  // Lane bash renders as its own terminal block (chevron prompt, powerline cd
  // segment, tiered command) — it supplies its own prompt, so skip the glyph.
  const isLaneBash = laneMode && family === "bash";
  const bashCommand = isLaneBash ? laneDecodeArg("bash", event.arg) : "";
  const bashValid = Boolean(bashCommand) && !laneIsControlArg(bashCommand)
    && !bashCommand.startsWith("{") && !bashCommand.startsWith("[");
  const useBashPill = isLaneBash && !simple;
  const flatBashProg = bashValid
    ? formatBashLine(bashCommand).spans.find((span) => span.tier === "prog")?.text ?? bashCommand
    : "";
  const command = toolArgLabel(event);
  const fullCommand = command ?? event.arg?.trim() ?? "";
  const outcome = typeof event.result?.outcome === "string"
    ? event.result.outcome.trim()
    : (typeof event.result?.outcome === "number" ? String(event.result.outcome) : undefined);
  const outputPreview = !laneMode ? (event.stream?.[0]?.trim() || undefined) : undefined;
  const showOutcome = Boolean(outcome && outcome !== "success");
  const hasBody = !!(showOutcome || event.diff || event.stream);
  // Lane TL: params only (command, path, needle, …). Stream, diff, and full
  // results open in the detail trace — not inline on the timeline row.
  const laneExpandable = !laneMode && (
    hasBody || laneTextNeedsExpand(fullCommand, 120, 2)
  );
  const showBody = !laneExpandable || expanded;
  const streamPreview = !laneMode && laneExpandable && !expanded && event.stream
    ? laneSnippetText(event.stream.join("\n"), 180, 2)
    : null;

  const block = (
    <div
      className={`s-observe-tool s-observe-block${laneMode ? ` s-observe-tool--lane s-observe-tool--fam-${family}` : ""}${laneMode && simple ? " s-observe-tool--simple" : ""}`}
    >
      <div
        className={`s-observe-tool-header${hasBody && !laneMode ? " s-observe-tool-header--has-body" : ""}`}
      >
        {(!isLaneBash || simple) && <span className="s-observe-tool-glyph">{glyph}</span>}
        <span
          className="s-observe-tool-cmd"
          title={laneMode && !useBashPill
            ? (isLaneBash && bashValid ? bashCommand : `${event.tool ?? ""} ${fullCommand}`.trim() || undefined)
            : undefined}
        >
          {useBashPill ? (
            <LaneBashLine
              command={bashValid ? bashCommand : ""}
              title={bashValid ? bashCommand : undefined}
              outputPreview={outputPreview}
            />
          ) : isLaneBash && simple ? (
            <span className="s-observe-tool-cmd-name">{flatBashProg || "shell"}</span>
          ) : laneMode ? (
            <LaneToolContent family={family} event={event} />
          ) : (
            <>
              <span className="s-observe-tool-cmd-name">{event.tool}</span>
              {fullCommand ? (
                <>
                  {" "}
                  <span className="s-observe-tool-cmd-arg">{fullCommand}</span>
                </>
              ) : null}
            </>
          )}
          {outcome === "success" && (
            <span className="s-observe-tool-outcome s-observe-tool-outcome--success">
              ok
            </span>
          )}
          {!laneMode && event.diff && (
            <span className="s-observe-tool-diff-inline" aria-label={`${event.diff.add} additions, ${event.diff.del} deletions`}>
              <span className="s-observe-tool-diff-add">+{event.diff.add}</span>
              <span className="s-observe-tool-diff-del">−{event.diff.del}</span>
            </span>
          )}
        </span>
        {laneExpandable && (
          <LaneExpandToggle
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
            label={event.stream ? "output" : "details"}
          />
        )}
      </div>

      {streamPreview && (
        <pre className="s-observe-tool-stream-preview">{streamPreview}</pre>
      )}

      {(showOutcome && (laneMode || showBody)) && event.result && (
        <div className="s-observe-tool-result">
          {Object.entries(event.result)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ")}
        </div>
      )}

      {!laneMode && event.diff && showBody && (
        <div className="s-observe-tool-diff">
          <div className="s-observe-tool-diff-stats">
            <span className="s-observe-tool-diff-add">+{event.diff.add}</span>
            {event.diff.del > 0 && (
              <>
                {" "}
                <span className="s-observe-tool-diff-del">
                  −{event.diff.del}
                </span>
              </>
            )}
          </div>
          <DiffPreview preview={event.diff.preview} />
        </div>
      )}

      {!laneMode && event.stream && showBody && (
        <pre className="s-observe-tool-stream">{event.stream.join("\n")}</pre>
      )}

      {!laneMode && <CopyButton text={buildToolCopyText(event)} label="Copy tool call" />}
    </div>
  );

  return block;
}

function AskLine({
  event,
  laneMode = false,
  operatorName = "you",
  wallLabel,
  wallTitle,
}: {
  event: SessionEvent;
  laneMode?: boolean;
  /** Lane mode: display name on the chat-style request head. */
  operatorName?: string;
  /** Lane mode: relative time for the request head (the row's clock). */
  wallLabel?: string;
  wallTitle?: string;
}) {
  const ask = buildLaneAskDisplay(event);
  const previewText = ask.preview === ask.title ? "" : ask.preview;
  const initial = (operatorName.trim()[0] ?? "y").toUpperCase();
  return (
    <div className={`s-observe-ask s-observe-block${laneMode ? " s-observe-ask--lane" : ""}`}>
      {laneMode ? (
        <div className="s-observe-ask-head">
          <span
            className="s-observe-ask-avatar"
            style={{ background: actorColor(operatorName) }}
            aria-hidden="true"
          >
            {initial}
          </span>
          <span className="s-observe-ask-author">{operatorName}</span>
          {wallLabel ? (
            <span className="s-observe-ask-time" title={wallTitle}>{wallLabel}</span>
          ) : null}
        </div>
      ) : (
        <div className="s-observe-ask-label">{ask.label}</div>
      )}
      {ask.contextTags.length > 0 && (
        <div className="s-observe-ask-tags" aria-label="Attached context">
          {ask.contextTags.map((tag) => (
            <span key={tag.name} className="s-observe-ask-tag" title={tag.raw}>
              <Tag size={10} strokeWidth={2} aria-hidden="true" />
              <span className="s-observe-ask-tag-name">{tag.name}</span>
              {tag.detail ? (
                <span className="s-observe-ask-tag-detail">{tag.detail}</span>
              ) : null}
            </span>
          ))}
        </div>
      )}
      <div className="s-observe-ask-title">{ask.title}</div>
      {previewText ? (
        <LaneExpandableText
          text={previewText}
          className="s-observe-ask-text"
          laneMode={laneMode}
          live={event.live}
          renderCollapsed={(value) => renderWithMentions(value)}
          renderExpanded={(value) => <MessageMarkup text={value} />}
        />
      ) : event.live ? (
        <span className="s-observe-cursor" />
      ) : null}
      {ask.answer && (!laneMode || laneTextNeedsExpand(ask.answer.text)) && (
        <div className="s-observe-ask-answer">
          <span className="s-observe-ask-answer-meta">
            ↳ {ask.answer.label}
          </span>
          <div className="s-observe-ask-answer-text">{ask.answer.text}</div>
        </div>
      )}
      {!laneMode && <CopyButton text={ask.copyText} label="Copy request" />}
    </div>
  );
}

function messageDisplayLabel(event: Pick<SessionEvent, "to">): string | null {
  const to = event.to?.trim();
  if (!to) return null;
  if (to === "human") return "→ you";
  return `→ ${to}`;
}

function isLaneThinkingPlaceholderEvent(event: Pick<SessionEvent, "kind" | "text">): boolean {
  return event.kind === "message" && (event.text ?? "").trim().toLowerCase() === "[thinking]";
}

function MessageLine({ event, laneMode = false }: { event: SessionEvent; laneMode?: boolean }) {
  const rawText = event.text ?? "";
  const thinking = laneMode && isLaneThinkingPlaceholderEvent(event);
  const text = thinking ? "Thinking..." : rawText;
  const label = thinking ? "Agent thinking" : messageDisplayLabel(event);
  return (
    <div
      className={[
        "s-observe-block",
        laneMode && "s-observe-message--lane",
        thinking && "s-observe-message--thinking",
        event.live && "s-observe-message--streaming",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-busy={event.live || undefined}
    >
      {label ? <div className="s-observe-message-label">{label}</div> : null}
      <LaneExpandableText
        text={text}
        className="s-observe-message-text"
        laneMode={laneMode}
        live={event.live}
        renderCollapsed={(value) => renderWithMentions(value)}
        renderExpanded={(value) => <MessageMarkup text={value} />}
      />
      {!laneMode && <CopyButton text={rawText} label="Copy message" />}
    </div>
  );
}

function TechnicalSummaryLine({
  summary,
  expanded = false,
  onToggle,
}: {
  summary: ObserveTechnicalSummary;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const eventLabel = summary.totalCount === 1 ? "technical event" : "technical events";
  const body = (
    <>
      <span className="s-observe-tech-summary-count">
        {summary.totalCount} {eventLabel}
      </span>
      {summary.labels.length > 0 ? (
        <span className="s-observe-tech-summary-detail">
          {summary.labels.join(" · ")}
        </span>
      ) : null}
      {onToggle ? (
        expanded
          ? <ChevronUp size={12} strokeWidth={1.8} className="s-observe-tech-summary-chevron" aria-hidden />
          : <ChevronDown size={12} strokeWidth={1.8} className="s-observe-tech-summary-chevron" aria-hidden />
      ) : null}
    </>
  );

  if (!onToggle) {
    return (
      <div className="s-observe-tech-summary s-observe-block s-observe-block--inline">
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`s-observe-tech-summary s-observe-tech-summary--toggle s-observe-block s-observe-block--inline${
        expanded ? " is-expanded" : ""
      }`}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onToggle();
      }}
      aria-expanded={expanded}
      aria-label={
        expanded
          ? `Collapse ${summary.totalCount} ${eventLabel}`
          : `Expand ${summary.totalCount} ${eventLabel}`
      }
    >
      {body}
    </button>
  );
}

function LaneTraceModeToggle({
  collapseTechnicalEvents,
  onChange,
}: {
  collapseTechnicalEvents: boolean;
  onChange?: (enabled: boolean) => void;
}) {
  if (!onChange) return null;

  const label = collapseTechnicalEvents ? "Concise" : "Details";
  const title = collapseTechnicalEvents
    ? "Show detailed trace events"
    : "Show concise trace summaries";
  const Icon = collapseTechnicalEvents ? MessageCircle : Wrench;

  return (
    <label
      className={`s-observe-lane-trace-mode${
        collapseTechnicalEvents ? " s-observe-lane-trace-mode--concise" : " s-observe-lane-trace-mode--details"
      }`}
      title={title}
    >
      <input
        type="checkbox"
        checked={collapseTechnicalEvents}
        onChange={(event) => onChange(event.currentTarget.checked)}
        aria-label={title}
      />
      <Icon size={12} strokeWidth={1.8} aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

function laneSystemDetailVisible(detail: string | undefined, laneMode: boolean): boolean {
  if (!detail?.trim()) return false;
  if (!laneMode) return true;
  return !/^[a-z0-9._-]+ · [a-z0-9._-]+$/i.test(detail.trim());
}

const LANE_NOTE_LABELS: Record<string, string> = {
  turn_ended: "Turn complete",
  turn_started: "Turn started",
};

function formatLaneNoteLabel(text: string): string {
  const trimmed = text.trim();
  const bracket = trimmed.match(/^\[(.+)\]$/);
  const raw = bracket?.[1] ?? trimmed;
  return LANE_NOTE_LABELS[raw] ?? raw.replace(/_/g, " ");
}

function GrokTurnLaneLine({ turn, model }: { turn: number; model?: string }) {
  return (
    <div className="s-observe-grok-turn s-observe-block s-observe-block--inline">
      <span className="s-observe-grok-turn-num">turn {turn}</span>
      {model ? <span className="s-observe-grok-turn-model">{model}</span> : null}
    </div>
  );
}

function GrokPermissionLaneLine({ tool, decision }: { tool: string; decision: string }) {
  return (
    <div className="s-observe-grok-permission s-observe-block s-observe-block--inline">
      <span className={`s-observe-grok-permission-decision is-${decision}`}>{decision}</span>
      <span className="s-observe-grok-permission-tool">{tool}</span>
    </div>
  );
}

function GrokPhaseLaneLine({ phase }: { phase: string }) {
  return (
    <div className="s-observe-grok-phase s-observe-block s-observe-block--inline">
      <span className="s-observe-grok-phase-label">{humanizeGrokLanePhase(phase)}</span>
    </div>
  );
}

function NoteLine({ event, laneMode = false }: { event: SessionEvent; laneMode?: boolean }) {
  if (laneMode) {
    const grokTurn = parseGrokLaneSystemText(event.text ?? "");
    if (grokTurn?.kind === "turn" && typeof grokTurn.turn === "number") {
      return <GrokTurnLaneLine turn={grokTurn.turn} model={grokTurn.model} />;
    }

    return (
      <div className="s-observe-note s-observe-block s-observe-block--inline s-observe-note--lane">
        <span className="s-observe-note-text">{formatLaneNoteLabel(event.text)}</span>
      </div>
    );
  }

  return (
    <div className="s-observe-note s-observe-block s-observe-block--inline">
      <span className="s-observe-note-icon" aria-hidden="true">✓</span>
      <span className="s-observe-note-text">{event.text}</span>
      <CopyButton text={event.text ?? ""} label="Copy note" />
    </div>
  );
}

function SystemLine({ event, laneMode = false }: { event: SessionEvent; laneMode?: boolean }) {
  const grokParts = laneMode ? parseGrokLaneSystemText(event.text ?? "") : null;
  if (grokParts?.kind === "permission" && grokParts.tool && grokParts.decision) {
    return <GrokPermissionLaneLine tool={grokParts.tool} decision={grokParts.decision} />;
  }
  if (grokParts?.kind === "phase" && grokParts.phase) {
    return <GrokPhaseLaneLine phase={grokParts.phase} />;
  }

  const showDetail = laneSystemDetailVisible(event.detail, laneMode);
  const copyText = showDetail && event.detail
    ? `${event.text}\n${event.detail}`
    : event.text ?? "";
  return (
    <div className={`s-observe-system s-observe-block${laneMode ? " s-observe-system--lane" : ""}`}>
      <div className="s-observe-system-line">
        {!laneMode && <span className="s-observe-system-arrow" aria-hidden="true">▸ </span>}
        <span className="s-observe-system-text">{event.text}</span>
      </div>
      {showDetail && event.detail && (
        <div className="s-observe-system-detail">{event.detail}</div>
      )}
      <CopyButton text={copyText} label="Copy system event" />
    </div>
  );
}

function FollowToggle({
  isFollowing,
  isLive,
  liveLabel,
  onToggle,
}: {
  isFollowing: boolean;
  isLive: boolean;
  liveLabel?: string;
  onToggle: () => void;
}) {
  return (
    <button
      className={`s-observe-follow-btn${isFollowing ? " s-observe-follow-btn--on" : ""}`}
      onClick={onToggle}
      title={isFollowing ? "Pause auto-scroll" : "Jump to latest and follow"}
    >
      {isFollowing ? (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <rect x="1.5" y="1" width="3" height="8" rx="1" />
          <rect x="5.5" y="1" width="3" height="8" rx="1" />
        </svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <path d="M2 1.5l7 3.5-7 3.5V1.5z" />
        </svg>
      )}
      <span>{isFollowing ? (isLive ? (liveLabel ?? "Live") : "Latest") : "Follow"}</span>
    </button>
  );
}

/* ── Stream row ── */

const LANE_GUTTER_KIND: Record<SessionEvent["kind"], string> = {
  think: "think",
  tool: "tool",
  ask: "ask",
  message: "message",
  note: "note",
  system: "system",
  boot: "boot",
};

function laneGutterLabel(event: SessionEvent): string {
  const grokLabel = grokLaneGutterLabel(event);
  if (grokLabel) return grokLabel;

  if (event.kind === "tool") {
    if (event.tool === "res") return "result";
    return event.tool?.trim() || "tool";
  }
  return LANE_GUTTER_KIND[event.kind] ?? event.kind;
}

function isObserveInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest("button, a, input, textarea, select, [role='slider'], [contenteditable='true']"));
}

function StreamRow({
  event,
  prevT,
  prevWallMs,
  laneMode = false,
  entering = false,
  repeatCount = 1,
  sessionStartMs,
  nowMs = Date.now(),
  preferWallAge = false,
  highlighted = false,
  focusAnchor = false,
  simpleTool = false,
  stackedTool = false,
  laneGutter = "time",
  laneOperatorName,
  onLaneEventSelect,
  laneToolHover,
  hoverPreviewActive = false,
  technicalSummary,
  technicalExpanded = false,
  onTechnicalToggle,
}: {
  event: SessionEvent;
  prevT: number;
  prevWallMs?: number | null;
  laneMode?: boolean;
  entering?: boolean;
  repeatCount?: number;
  sessionStartMs?: number;
  nowMs?: number;
  preferWallAge?: boolean;
  highlighted?: boolean;
  focusAnchor?: boolean;
  simpleTool?: boolean;
  stackedTool?: boolean;
  laneGutter?: "time" | "label-time";
  laneOperatorName?: string;
  onLaneEventSelect?: (event: SessionEvent) => void;
  laneToolHover?: (event: SessionEvent, meta: {
    wallLabel?: string;
    wallTitle?: string;
    sessionOffset?: string;
  }) => LaneToolHoverBindings;
  hoverPreviewActive?: boolean;
  technicalSummary?: ObserveTechnicalSummary;
  technicalExpanded?: boolean;
  onTechnicalToggle?: () => void;
}) {
  const gap = event.t - prevT;
  const accent = technicalSummary ? "var(--dim)" : KIND_COLOR[event.kind] ?? "var(--dim)";
  const rowTime = laneMode
    ? fmtLaneRowTime(event, sessionStartMs, nowMs, preferWallAge)
    : fmtObserveRowTime(event, sessionStartMs);
  const eventWallMs = laneEventWallMs(event, sessionStartMs);
  const wallGapLabel = preferWallAge && typeof prevWallMs === "number" && eventWallMs !== null
    ? fmtLaneWallGapLabel(eventWallMs - prevWallMs)
    : null;
  const sessionGapLabel = !preferWallAge && gap > 15 ? `${fmtGap(gap)} gap` : null;
  const gapLabel = wallGapLabel ?? sessionGapLabel;

  const laneSelectable = laneMode && Boolean(onLaneEventSelect) && !technicalSummary;
  const rowClass = [
    "s-observe-row",
    `s-observe-row--kind-${event.kind}`,
    entering ? "s-observe-row--enter" : "",
    laneSelectable ? "s-observe-row--selectable" : "",
    highlighted ? "s-observe-row--highlighted" : "",
    focusAnchor ? "s-observe-row--focus-anchor" : "",
    simpleTool ? "s-observe-row--tool-simple" : "",
    stackedTool ? "s-observe-row--tool-stacked" : "",
    hoverPreviewActive ? "s-observe-row--hover-preview" : "",
    technicalSummary ? "s-observe-row--tech-summary" : "",
  ].filter(Boolean).join(" ");

  const rowBody = (
    <>
      {gapLabel ? <div className="s-observe-row-gap">{gapLabel}</div> : null}

      <div className="s-observe-row-time" title={rowTime.title}>
        {laneGutter === "label-time" && !stackedTool ? (
          <span className="s-observe-row-kind">{laneGutterLabel(event)}</span>
        ) : null}
        <span className="s-observe-row-clock">{rowTime.label}</span>
        {repeatCount > 1 && (
          <span className="s-observe-row-repeat" title={`${repeatCount} similar events merged`}>
            ×{repeatCount}
          </span>
        )}
      </div>

      <span className="s-observe-row-bead" style={{ background: accent }} />

      {technicalSummary ? (
        <TechnicalSummaryLine
          summary={technicalSummary}
          expanded={technicalExpanded}
          onToggle={onTechnicalToggle}
        />
      ) : (
        <>
          {event.kind === "think" && <ThinkBlock event={event} laneMode={laneMode} />}
          {event.kind === "tool" && (
            <ToolBlock
              event={event}
              laneMode={laneMode}
              simple={simpleTool}
              wallLabel={simpleTool ? rowTime.label : undefined}
              wallTitle={simpleTool ? rowTime.title : undefined}
            />
          )}
          {event.kind === "ask" && (
            <AskLine
              event={event}
              laneMode={laneMode}
              operatorName={laneOperatorName}
              wallLabel={laneMode ? rowTime.label : undefined}
              wallTitle={laneMode ? rowTime.title : undefined}
            />
          )}
          {event.kind === "message" && <MessageLine event={event} laneMode={laneMode} />}
          {event.kind === "note" && <NoteLine event={event} laneMode={laneMode} />}
          {(event.kind === "system" || event.kind === "boot") && (
            <SystemLine event={event} laneMode={laneMode} />
          )}
        </>
      )}
    </>
  );

  const toolHoverBindings = laneMode && event.kind === "tool" && laneToolHover
    ? laneToolHover(event, {
      wallLabel: rowTime.label,
      wallTitle: rowTime.title,
      sessionOffset: fmtLaneSessionOffset(event.t),
    })
    : null;

  const rowHoverBody = toolHoverBindings
    ? (
      <div
        ref={toolHoverBindings.ref}
        className="s-observe-row-hover-target"
        onMouseEnter={toolHoverBindings.onMouseEnter}
        onMouseLeave={toolHoverBindings.onMouseLeave}
        onFocus={toolHoverBindings.onFocus}
        onBlur={toolHoverBindings.onBlur}
      >
        {rowBody}
      </div>
    )
    : rowBody;

  return (
    <div
      className={rowClass}
      data-event-id={event.id}
      onClick={laneSelectable ? (clickEvent) => {
        if (isObserveInteractiveTarget(clickEvent.target)) return;
        onLaneEventSelect?.(event);
      } : undefined}
      onKeyDown={laneSelectable ? (keyEvent) => {
        if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
        if (isObserveInteractiveTarget(keyEvent.target)) return;
        keyEvent.preventDefault();
        onLaneEventSelect?.(event);
      } : undefined}
      role={laneSelectable ? "button" : undefined}
      tabIndex={laneSelectable ? 0 : undefined}
      aria-label={laneSelectable
        ? (event.kind === "tool"
          ? "Open command detail at this step"
          : "Open session detail at this step")
        : undefined}
    >
      {rowHoverBody}
    </div>
  );
}

/* ── Replay stream ── */

function scrollTraceToEnd(endEl: HTMLElement | null, behavior: ScrollBehavior): void {
  if (!endEl) return;

  const scrollParent = endEl.closest(".s-observe-main") as HTMLElement | null;
  if (scrollParent) {
    const top = scrollParent.scrollHeight - scrollParent.clientHeight;
    scrollParent.scrollTo({ top, left: scrollParent.scrollLeft, behavior });
    return;
  }

  endEl.scrollIntoView({ behavior, block: "end", inline: "nearest" });
}

function ReplayStream({
  events,
  followEnd,
  laneMode = false,
  sessionStartMs,
  nowMs = Date.now(),
  preferWallAge = false,
  focusEventId,
  inlineFocusEventId,
  inlineFocusContent,
  onLaneEventSelect,
  laneGutter = "time",
  richSimpleTools = false,
  collapseTechnicalEvents = false,
  laneOperatorName,
}: {
  events: SessionEvent[];
  followEnd: boolean;
  laneMode?: boolean;
  sessionStartMs?: number;
  nowMs?: number;
  preferWallAge?: boolean;
  focusEventId?: string | null;
  inlineFocusEventId?: string | null;
  inlineFocusContent?: ReactNode;
  onLaneEventSelect?: (event: SessionEvent) => void;
  laneGutter?: "time" | "label-time";
  richSimpleTools?: boolean;
  collapseTechnicalEvents?: boolean;
  laneOperatorName?: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const prevFollowEndRef = useRef(followEnd);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const laneEventsPrimedRef = useRef(false);
  const [enteringEventIds, setEnteringEventIds] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedTechnicalRollups, setExpandedTechnicalRollups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const toggleTechnicalRollup = useCallback((rollupId: string) => {
    setExpandedTechnicalRollups((current) => {
      const next = new Set(current);
      if (next.has(rollupId)) next.delete(rollupId);
      else next.add(rollupId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!collapseTechnicalEvents) {
      setExpandedTechnicalRollups(new Set());
    }
  }, [collapseTechnicalEvents]);

  const displayRows = useMemo(
    () => {
      const rows = laneMode
        ? collapseObserveDisplayRows(events)
        : events.map((event) => ({ event, repeatCount: 1 }));
      if (!laneMode) return rows;
      const visibleRows = rows.filter((row) => (
        row.event.live || !isLaneThinkingPlaceholderEvent(row.event)
      ));
      return collapseTechnicalEvents
        ? collapseTechnicalObserveDisplayRows(visibleRows)
        : visibleRows;
    },
    [events, laneMode, collapseTechnicalEvents],
  );

  useEffect(() => {
    if (!laneMode) {
      laneEventsPrimedRef.current = true;
      return;
    }

    const seen = seenEventIdsRef.current;
    if (!laneEventsPrimedRef.current) {
      for (const row of displayRows) seen.add(row.event.id);
      laneEventsPrimedRef.current = true;
      return;
    }

    const fresh: string[] = [];
    for (const row of displayRows) {
      if (seen.has(row.event.id)) continue;
      seen.add(row.event.id);
      fresh.push(row.event.id);
    }
    if (fresh.length === 0) return;

    const freshSet = new Set(fresh);
    setEnteringEventIds(freshSet);

    const timer = window.setTimeout(() => {
      setEnteringEventIds(new Set());
    }, 380);
    return () => window.clearTimeout(timer);
  }, [displayRows, followEnd, laneMode]);

  useLayoutEffect(() => {
    if (!followEnd) {
      prevFollowEndRef.current = false;
      return;
    }
    const justEnabled = !prevFollowEndRef.current;
    prevFollowEndRef.current = true;
    scrollTraceToEnd(
      endRef.current,
      laneMode || justEnabled ? "instant" : "smooth",
    );
  }, [displayRows.length, followEnd, laneMode]);
  const laneToolHover = useLaneToolHoverCard(laneMode);

  const renderDisplayRow = (
    row: ObserveDisplayRow,
    index: number,
    prevRow: ObserveDisplayRow | null,
    options: {
      keySuffix?: string;
      technicalExpanded?: boolean;
      onTechnicalToggle?: () => void;
      suppressInlineFocus?: boolean;
    } = {},
  ) => {
    const prevEvent = prevRow?.event ?? null;
    const prevWallMs = prevEvent
      ? laneEventWallMs(prevEvent, sessionStartMs)
      : null;
    const simpleTool = laneMode && !row.technicalSummary && !richSimpleTools && isSimpleLaneToolEvent(row.event);
    const stackedTool = simpleTool
      && prevEvent != null
      && !prevRow?.technicalSummary
      && isSimpleLaneToolEvent(prevEvent);
    const isInlineFocus = !options.suppressInlineFocus
      && inlineFocusEventId === row.event.id
      && Boolean(inlineFocusContent);
    const rowEl = (
      <StreamRow
        event={row.event}
        prevT={prevEvent?.t ?? 0}
        prevWallMs={prevWallMs}
        laneMode={laneMode}
        simpleTool={simpleTool}
        stackedTool={stackedTool}
        laneGutter={laneGutter}
        entering={laneMode && enteringEventIds.has(row.event.id)}
        repeatCount={row.repeatCount}
        sessionStartMs={sessionStartMs}
        nowMs={nowMs}
        preferWallAge={preferWallAge}
        highlighted={!laneMode && focusEventId === row.event.id}
        focusAnchor={isInlineFocus}
        laneOperatorName={laneOperatorName}
        onLaneEventSelect={onLaneEventSelect}
        laneToolHover={laneMode ? laneToolHover.bind : undefined}
        hoverPreviewActive={laneMode && laneToolHover.hoveredEventId === row.event.id}
        technicalSummary={row.technicalSummary}
        technicalExpanded={options.technicalExpanded}
        onTechnicalToggle={options.onTechnicalToggle}
      />
    );

    return (
      <div
        key={`${row.event.id}:${row.repeatCount}:${index}${options.keySuffix ?? ""}`}
        className={`s-observe-focus-group${isInlineFocus ? " s-observe-focus-group--active" : ""}`}
        data-focus-group={isInlineFocus ? "true" : undefined}
      >
        {rowEl}
        {isInlineFocus ? (
          <>
            <div className="s-observe-focus-connector" aria-hidden />
            <div className="s-observe-focus-detail">{inlineFocusContent}</div>
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="s-observe-stream">
      <div className="s-observe-spine" />
      {displayRows.map((row, index) => {
        const prevRow = index > 0 ? displayRows[index - 1]! : null;
        const sourceRows = row.technicalSourceRows;
        const isTechnicalRollup = Boolean(row.technicalSummary && sourceRows && sourceRows.length > 0);
        const isExpanded = isTechnicalRollup && expandedTechnicalRollups.has(row.event.id);

        if (isTechnicalRollup && isExpanded) {
          return (
            <div
              key={`${row.event.id}:${row.repeatCount}:${index}:rollup`}
              className="s-observe-tech-rollup s-observe-tech-rollup--expanded"
            >
              {renderDisplayRow(row, index, prevRow, {
                technicalExpanded: true,
                onTechnicalToggle: () => toggleTechnicalRollup(row.event.id),
                suppressInlineFocus: true,
              })}
              <div className="s-observe-tech-rollup-details">
                {sourceRows!.map((sourceRow, sourceIndex) => {
                  const sourcePrev = sourceIndex > 0 ? sourceRows![sourceIndex - 1]! : null;
                  return renderDisplayRow(sourceRow, sourceIndex, sourcePrev, {
                    keySuffix: `:rollup:${row.event.id}:detail`,
                    suppressInlineFocus: true,
                  });
                })}
              </div>
            </div>
          );
        }

        return renderDisplayRow(row, index, prevRow, {
          onTechnicalToggle: isTechnicalRollup
            ? () => toggleTechnicalRollup(row.event.id)
            : undefined,
        });
      })}
      <div ref={endRef} />
      {laneToolHover.card}
    </div>
  );
}

/* ── Context meter sparkline ── */

function ContextMeter({
  data,
  cursor,
}: {
  data: number[];
  cursor: number;
}) {
  const W = 276;
  const H = 44;
  const N = data.length;
  if (N < 2) return null;
  const stepX = W / (N - 1);
  const path = data
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"} ${(i * stepX).toFixed(1)} ${((1 - v) * H).toFixed(1)}`,
    )
    .join(" ");
  const curX = cursor * W;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: H, display: "block" }}
    >
      <defs>
        <linearGradient id="observeCtxFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.25} />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${path} L ${W} ${H} L 0 ${H} Z`} fill="url(#observeCtxFill)" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.2} />
      <line
        x1={curX}
        y1={0}
        x2={curX}
        y2={H}
        stroke="var(--accent)"
        strokeWidth={1}
        opacity={0.6}
        strokeDasharray="2 3"
      />
    </svg>
  );
}

/* ── File glyph ── */

function FileGlyph({ state }: { state: string }) {
  const col =
    state === "created"
      ? "var(--green)"
      : state === "modified"
        ? "var(--accent)"
        : "var(--dim)";
  const g = state === "created" ? "+" : state === "modified" ? "~" : "◎";

  return (
    <span
      className="s-observe-file-glyph"
      style={{
        background: "color-mix(in srgb, var(--bg) 70%, black)",
        border: `1px solid color-mix(in srgb, ${col} 40%, var(--border))`,
        color: col,
      }}
    >
      {g}
    </span>
  );
}

function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  // Zero / unavailable stats recede so the cards with real signal lead the eye.
  const isQuiet = value === "0" || value === "—" || value === "";
  return (
    <div className={`s-observe-stat${isQuiet ? " s-observe-stat--quiet" : ""}`}>
      <div className="s-observe-stat-value">{value}</div>
      <div className="s-observe-stat-label">{label}</div>
      {detail && <div className="s-observe-stat-detail">{detail}</div>}
    </div>
  );
}

/** Unified, calm empty-state line for rail sections with no captured data. */
function RailEmpty({ children = "Not captured for this session" }: { children?: ReactNode }) {
  return <div className="s-observe-empty">{children}</div>;
}

function LocalPathLink({
  path,
  basePath,
  agentId,
  sessionId,
  className,
  children,
}: {
  path: string;
  basePath?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  className: string;
  children: ReactNode;
}) {
  const { openFilePreview } = useScout();
  const resolvedPath = path.startsWith("/") || path.startsWith("~/")
    ? path
    : basePath
      ? `${basePath.replace(/\/$/, "")}/${path}`
      : path;
  return (
    <span className="s-observe-path-link-group">
      <button
        type="button"
        className={className}
        title={`Preview ${path} in Scout`}
        onClick={() => openFilePreview(resolvedPath)}
      >
        {children}
      </button>
      <button
        type="button"
        className="s-observe-path-link-external"
        title={`Reveal ${path} in OS`}
        aria-label="Reveal in OS"
        onClick={() => revealPath({ path, basePath, agentId, sessionId })}
      >
        <ExternalLink size={11} strokeWidth={1.6} />
      </button>
    </span>
  );
}

function SourceFileLink({
  path,
  basePath,
  agentId,
  sessionId,
}: {
  path: string;
  basePath?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
}) {
  return (
    <div className="s-observe-source">
      <span className="s-observe-source-label">Source</span>
      <LocalPathLink
        path={path}
        basePath={basePath}
        agentId={agentId}
        sessionId={sessionId}
        className="s-observe-source-link"
      >
        {basename(path)}
      </LocalPathLink>
    </div>
  );
}

function DetailRows({
  rows,
  agentId,
  sessionId,
}: {
  rows: ObserveDetailRow[];
  agentId?: string | null;
  sessionId?: string | null;
}) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="s-observe-detail-list">
      {rows.map((row) => {
        const valueClassName = `s-observe-detail-value s-observe-detail-value--${row.tone ?? "default"}${row.wrap ? " s-observe-detail-value--wrap" : ""}`;
        const shown = row.display ?? row.value;
        return (
          <div key={row.label} className="s-observe-detail-row">
            <div className="s-observe-detail-label">{row.label}</div>
            <div className="s-observe-detail-value-wrap">
              {row.actionPath ? (
                <LocalPathLink
                  path={row.actionPath}
                  basePath={row.actionBasePath}
                  agentId={agentId}
                  sessionId={sessionId}
                  className={`${valueClassName} s-observe-detail-link`}
                >
                  {shown}
                </LocalPathLink>
              ) : (
                <div
                  className={valueClassName}
                  title={row.title ?? (shown !== row.value ? row.value : undefined)}
                >
                  {shown}
                </div>
              )}
              <CopyButton
                text={row.actionPath ?? row.value}
                label={`Copy ${row.label.toLowerCase()}`}
                className="s-observe-copy-btn--inline"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Scrubber ── */

function Scrubber({
  events,
  duration,
  cursor,
  onCursor,
  snapTimes = [],
}: {
  events: SessionEvent[];
  duration: number;
  cursor: number;
  onCursor: (t: number) => void;
  snapTimes?: number[];
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const messageBuckets = useMemo(
    () => buildMessageBuckets(events, duration, 48),
    [events, duration],
  );
  const hasMessageBuckets = messageBuckets.some((bucket) => bucket.count > 0);
  const messageBucketCount = messageBuckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const chartTitle = hasMessageBuckets
    ? `${messageBucketCount} message turn anchors. Click the timeline or use arrow keys to snap between turns.`
    : "Session timeline";
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const rect = trackRef.current!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const raw = Math.max(0, Math.min(duration, (x / rect.width) * duration));
      onCursor(snapToTimelineTime(raw, duration, snapTimes));
    },
    [duration, onCursor, snapTimes],
  );
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (duration <= 0) return;
      const small = duration * 0.01;
      const large = duration * 0.05;
      let next = cursor;
      switch (e.key) {
        case "ArrowLeft":
          next = snapTimes.length ? previousSnapTime(cursor, snapTimes) : cursor - (e.shiftKey ? large : small);
          break;
        case "ArrowRight":
          next = snapTimes.length ? nextSnapTime(cursor, snapTimes, duration) : cursor + (e.shiftKey ? large : small);
          break;
        case "PageDown":
          next = cursor - large;
          break;
        case "PageUp":
          next = cursor + large;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = duration;
          break;
        default:
          return;
      }
      e.preventDefault();
      onCursor(snapTimes.length && (e.key === "PageDown" || e.key === "PageUp")
        ? snapToTimelineTime(next, duration, snapTimes)
        : Math.max(0, Math.min(duration, next)));
    },
    [cursor, duration, onCursor, snapTimes],
  );

  return (
    <div className="s-observe-track-wrap" title={chartTitle}>
      {hasMessageBuckets ? (
        <>
          <div className="s-observe-track-barsHead" aria-hidden>
            <span>Turns</span>
            <span>{messageBucketCount}</span>
          </div>
          <div className="s-observe-track-bars" aria-hidden>
            {messageBuckets.map((bucket) => (
              <span
                key={bucket.index}
                className="s-observe-track-bar"
                data-active={bucket.start <= cursor || undefined}
                style={{ height: `${bucketHeight(bucket.count, messageBuckets)}%` }}
              />
            ))}
          </div>
        </>
      ) : null}
      <div
        ref={trackRef}
        className="s-observe-track"
        onClick={onClick}
        onKeyDown={onKeyDown}
        role="slider"
        tabIndex={duration > 0 ? 0 : -1}
        aria-label="Session timeline"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={Math.max(0, Math.min(duration, cursor))}
      >
        {events.map((e) => {
          const h = e.kind === "tool" ? 6 : e.kind === "think" ? 4 : 5;
          return (
            <span
              key={e.id}
              className="s-observe-track-tick"
              style={{
                // Single-event sessions have duration 0 — park ticks at 0%.
                left: `${duration > 0 ? (e.t / duration) * 100 : 0}%`,
                top: h === 6 ? -2 : -1,
                height: h,
                background: KIND_COLOR[e.kind] ?? "var(--dim)",
              }}
            />
          );
        })}
        <div
          className="s-observe-track-played"
          style={{ width: `${duration > 0 ? (cursor / duration) * 100 : 0}%` }}
        />
        <span
          className="s-observe-track-cursor"
          style={{ left: `${duration > 0 ? (cursor / duration) * 100 : 0}%` }}
        />
      </div>
    </div>
  );
}

function isTurnAnchorEvent(event: SessionEvent): boolean {
  return event.kind === "message" || event.kind === "ask";
}

function turnAnchorTimes(events: SessionEvent[], duration: number): number[] {
  const times = events
    .filter(isTurnAnchorEvent)
    .map((event) => Math.max(0, Math.min(duration, event.t)))
    .sort((a, b) => a - b);
  return Array.from(new Set(times));
}

function snapToTimelineTime(raw: number, duration: number, snapTimes: number[]): number {
  const clamped = Math.max(0, Math.min(duration, raw));
  if (snapTimes.length === 0) return clamped;
  let best = snapTimes[0]!;
  let bestDistance = Math.abs(best - clamped);
  for (const time of snapTimes) {
    const distance = Math.abs(time - clamped);
    if (distance < bestDistance) {
      best = time;
      bestDistance = distance;
    }
  }
  return best;
}

function nextSnapTime(cursor: number, snapTimes: number[], duration: number): number {
  const next = snapTimes.find((time) => time > cursor + 0.01);
  return next ?? duration;
}

function previousSnapTime(cursor: number, snapTimes: number[]): number {
  for (let index = snapTimes.length - 1; index >= 0; index -= 1) {
    const time = snapTimes[index]!;
    if (time < cursor - 0.01) return time;
  }
  return 0;
}

function buildMessageBuckets(events: SessionEvent[], duration: number, bucketCount: number): Array<{ index: number; count: number; start: number }> {
  const safeDuration = Math.max(1, duration);
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    index,
    count: 0,
    start: (index / bucketCount) * safeDuration,
  }));
  for (const event of events) {
    if (!isTurnAnchorEvent(event)) continue;
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((event.t / safeDuration) * bucketCount)));
    buckets[index]!.count += 1;
  }
  return buckets;
}

function bucketHeight(count: number, buckets: Array<{ count: number }>): number {
  if (count <= 0) return 0;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return Math.max(18, (count / max) * 100);
}

function SessionTransport({
  events,
  duration,
  cursor,
  mode,
  speed,
  snapTimes,
  onCursor,
  onPlayToggle,
  onSpeedChange,
}: {
  events: SessionEvent[];
  duration: number;
  cursor: number;
  mode: "tail" | "playing" | "paused";
  speed: 0.5 | 1 | 2 | 4;
  snapTimes: number[];
  onCursor: (cursor: number) => void;
  onPlayToggle: () => void;
  onSpeedChange: (speed: 0.5 | 1 | 2 | 4) => void;
}) {
  const playTitle = mode === "tail"
    ? "Following latest"
    : mode === "playing"
      ? "Pause replay"
      : "Play turns";

  return (
    <div className="s-observe-transport" data-snap={snapTimes.length > 0 || undefined} data-mode={mode}>
      <button
        type="button"
        className="s-observe-play-btn"
        data-state={mode}
        onClick={onPlayToggle}
        aria-pressed={mode === "tail" || mode === "playing"}
        aria-label={playTitle}
        title={playTitle}
      >
        {mode === "playing" ? "❚❚" : "▶"}
      </button>
      <button
        type="button"
        className="s-observe-rewind-btn"
        onClick={() => {
          onCursor(0);
        }}
        aria-label="Jump to start"
        title="Jump to start"
      >
        ⏮
      </button>

      <Scrubber
        events={events}
        duration={duration}
        cursor={cursor}
        onCursor={onCursor}
        snapTimes={snapTimes}
      />

      <div className="s-observe-speed-group">
        {([0.5, 1, 2, 4] as const).map((s) => (
          <button
            type="button"
            key={s}
            className={`s-observe-speed-btn${speed === s ? " s-observe-speed-btn--active" : ""}`}
            onClick={() => onSpeedChange(s)}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Session header ── */

function fmtRelative(ts: number): string {
  return timeAgoWithSuffix(ts) || "unknown";
}

function fmtDuration(start: number, end: number): string {
  const startMs = normalizeTimestampMs(start);
  const endMs = normalizeTimestampMs(end);
  if (startMs === null || endMs === null) return "0:00";
  return formatDurationClock(endMs - startMs) || "0:00";
}

function SessionHeader({
  catalog,
  sessionId,
  agentId,
}: {
  catalog: SessionCatalogWithResume;
  sessionId: string | null;
  agentId?: string;
}) {
  const { navigate, route } = useScout();
  const [sent, setSent] = useState(false);
  const active = catalog.sessions.find((s) => s.id === catalog.activeSessionId);
  const past = catalog.sessions
    .filter((s) => s.id !== catalog.activeSessionId && s.endedAt)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 5);

  const displayId = catalog.activeSessionId ?? sessionId;
  const shortId = displayId ? displayId.slice(0, 8) : null;
  const canTakeover = Boolean(active?.canTakeover && catalog.resumeCommand);

  const runTakeover = useCallback(() => {
    if (!canTakeover || !catalog.resumeCommand) return;
    void queueTakeover({
      command: catalog.resumeCommand,
      cwd: catalog.resumeCwd,
      agentId,
    }).then(() => {
      openContent(navigate, { view: "terminal", agentId }, { returnTo: route });
    });
    setSent(true);
  }, [canTakeover, catalog.resumeCommand, catalog.resumeCwd, navigate, route, agentId]);

  const openPair = useCallback(() => {
    navigate({
      view: "agents-v2",
      agentId,
      tab: "message",
    });
  }, [navigate, agentId]);

  return (
    <div className="s-observe-session-header">
      <div className="s-observe-session-active">
        <div className="s-observe-session-row">
          {shortId && (
            <span className="s-observe-session-id" title={displayId ?? undefined}>
              {shortId}
            </span>
          )}
          {active && (
            <span className="s-observe-session-time">
              started {fmtRelative(active.startedAt)}
            </span>
          )}
          <button
            className="s-observe-pair-btn"
            onClick={openPair}
            title="Send messages into the live session without taking the terminal"
          >
            Pair
          </button>
          {canTakeover && (
            <button
              className="s-observe-takeover-btn"
              onClick={runTakeover}
              title={catalog.resumeCommand ?? undefined}
            >
              {sent ? "Sent" : "Takeover"}
            </button>
          )}
        </div>
      </div>

      {past.length > 0 && (
        <div className="s-observe-session-history">
          <div className="s-observe-session-history-label">
            {catalog.sessions.length} session{catalog.sessions.length !== 1 ? "s" : ""} total
          </div>
          {past.map((s) => (
            <div key={s.id} className="s-observe-session-past">
              <span className="s-observe-session-id">{s.id.slice(0, 8)}</span>
              <span className="s-observe-session-time">
                {fmtRelative(s.startedAt)}
                {s.endedAt ? ` · ${fmtDuration(s.startedAt, s.endedAt)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY_OBSERVE_DATA: SessionObserveData = {
  events: [
    {
      id: "observe:empty",
      t: 0,
      kind: "system",
      text: "No session trace is available for this agent yet.",
      detail: "Waiting for a live session or readable history file.",
    },
  ],
  files: [],
  contextUsage: [],
  live: false,
};

export function SessionObserveContextRail({
  data = EMPTY_OBSERVE_DATA,
  agentId,
  sessionId,
  cursor,
  duration,
  surface = "embedded",
  observeSource,
  observeFidelity,
}: {
  data?: SessionObserveData;
  agentId?: string;
  sessionId?: string | null;
  cursor?: number;
  duration?: number;
  surface?: "embedded" | "context";
  observeSource?: ObserveEvidenceSource;
  observeFidelity?: ObserveEvidenceFidelity;
}) {
  const { events, files } = data;
  const [catalog, setCatalog] = useState<SessionCatalogWithResume | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    api<SessionCatalogWithResume>(`/api/agents/${encodeURIComponent(agentId)}/session-catalog`)
      .then((result) => { if (!cancelled) setCatalog(result); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [agentId]);

  const metadata = data.metadata;
  const sessionMeta = metadata?.session;
  const usageMeta = metadata?.usage;
  const effectiveDuration = typeof duration === "number" && Number.isFinite(duration) && duration > 0
    ? duration
    : events.length > 0
      ? events[events.length - 1]!.t + 30
      : 60;
  const effectiveCursor = typeof cursor === "number" && Number.isFinite(cursor)
    ? cursor
    : effectiveDuration;
  const toolCount = events.filter((e) => e.kind === "tool").length;
  const thinkCount = events.filter((e) => e.kind === "think").length;
  const askCount = events.filter((e) => e.kind === "ask").length;
  const readCount = events.filter(
    (e) => e.kind === "tool" && e.tool === "read",
  ).length;
  const editCount = events.filter(
    (e) => e.kind === "tool" && (e.tool === "edit" || e.tool === "write"),
  ).length;
  const observedWindowSeconds = events.length > 0 ? events[events.length - 1]!.t : 0;
  const derivedLoadPercent = typeof usageMeta?.contextInputTokens === "number"
    && typeof usageMeta.contextWindowTokens === "number"
    && usageMeta.contextWindowTokens > 0
    ? Math.max(0, Math.min(100, Math.round((usageMeta.contextInputTokens / usageMeta.contextWindowTokens) * 100)))
    : null;
  const usageStatCards = [
    { label: "Context input", value: usageMeta?.contextInputTokens },
    { label: "Input", value: usageMeta?.inputTokens },
    { label: "Output", value: usageMeta?.outputTokens },
    { label: "Cache hit", value: usageMeta?.cacheReadInputTokens },
    { label: "Cache write", value: usageMeta?.cacheCreationInputTokens },
    { label: "Total", value: usageMeta?.totalTokens },
    { label: "Reasoning", value: usageMeta?.reasoningOutputTokens },
  ].filter((entry) => typeof entry.value === "number");
  const usageRows = definedObserveRows([
    typeof usageMeta?.assistantMessages === "number"
      ? {
          label: "Assistant msgs",
          value: fmtGroupedNumber(usageMeta.assistantMessages) ?? "0",
          tone: "accent",
        }
      : null,
    typeof usageMeta?.webSearchRequests === "number"
      ? {
          label: "Web search",
          value: fmtGroupedNumber(usageMeta.webSearchRequests) ?? "0",
        }
      : null,
    typeof usageMeta?.webFetchRequests === "number"
      ? {
          label: "Web fetch",
          value: fmtGroupedNumber(usageMeta.webFetchRequests) ?? "0",
        }
      : null,
    usageMeta?.serviceTier
      ? {
          label: "Service tier",
          value: usageMeta.serviceTier,
          tone: "good",
        }
      : null,
    usageMeta?.speed
      ? {
          label: "Speed",
          value: usageMeta.speed,
        }
      : null,
    usageMeta?.planType
      ? {
          label: "Plan",
          value: usageMeta.planType,
        }
      : null,
  ]);
  const windowRows = definedObserveRows([
    typeof usageMeta?.contextWindowTokens === "number"
      ? {
          label: "Model window",
          value: `${fmtGroupedNumber(usageMeta.contextWindowTokens)} tokens`,
          title: fmtGroupedNumber(usageMeta.contextWindowTokens) ?? undefined,
          tone: "accent",
        }
      : null,
    derivedLoadPercent !== null
      ? {
          label: "Window load",
          value: `${derivedLoadPercent}%`,
          tone: derivedLoadPercent >= 80 ? "warn" : "default",
        }
      : null,
  ]);
  const metadataRows = definedObserveRows([
    sessionMeta?.model ? { label: "Model", value: sessionMeta.model, tone: "accent" } : null,
    sessionMeta?.adapterType ? { label: "Adapter", value: sessionMeta.adapterType } : null,
    sessionMeta?.gitBranch ? { label: "Branch", value: sessionMeta.gitBranch } : null,
    sessionMeta?.cwd
      ? {
          label: "Workspace",
          value: sessionMeta.cwd,
          display: basename(sessionMeta.cwd),
          title: sessionMeta.cwd,
          actionPath: sessionMeta.cwd,
        }
      : null,
    sessionMeta?.entrypoint ? { label: "Entrypoint", value: sessionMeta.entrypoint } : null,
    sessionMeta?.cliVersion ? { label: "CLI", value: sessionMeta.cliVersion } : null,
    sessionMeta?.permissionMode ? { label: "Permissions", value: sessionMeta.permissionMode } : null,
    sessionMeta?.approvalPolicy ? { label: "Approval", value: sessionMeta.approvalPolicy } : null,
    sessionMeta?.sandbox ? { label: "Sandbox", value: sessionMeta.sandbox } : null,
    sessionMeta?.userType ? { label: "User type", value: sessionMeta.userType } : null,
    sessionMeta?.originator ? { label: "Originator", value: sessionMeta.originator } : null,
    sessionMeta?.modelProvider ? { label: "Provider", value: sessionMeta.modelProvider } : null,
    sessionMeta?.effort ? { label: "Effort", value: sessionMeta.effort } : null,
    sessionMeta?.timezone ? { label: "Timezone", value: sessionMeta.timezone } : null,
    sessionMeta?.externalSessionId
      ? {
          label: "External session",
          value: sessionMeta.externalSessionId,
          title: sessionMeta.externalSessionId,
        }
      : null,
    sessionMeta?.threadId
      ? {
          label: "Thread",
          value: sessionMeta.threadId,
          title: sessionMeta.threadId,
        }
      : null,
    sessionMeta?.threadPath
      ? {
          label: "Thread path",
          value: sessionMeta.threadPath,
          display: basename(sessionMeta.threadPath),
          title: sessionMeta.threadPath,
          actionPath: sessionMeta.threadPath,
          actionBasePath: sessionMeta.cwd ?? null,
        }
      : null,
    sessionMeta?.source ? { label: "Runtime source", value: sessionMeta.source } : null,
  ]);
  const hasUsageMetadata = hasObserveRows(usageMeta);
  const hasSessionMetadata = hasObserveRows(sessionMeta);
  const effectiveObserveSource = observeSource ?? (data.live ? "live" : "history");
  const effectiveObserveFidelity = observeFidelity ?? "timestamped";
  const evidence = describeObserveEvidence({
    source: effectiveObserveSource,
    fidelity: effectiveObserveFidelity,
    live: data.live,
    eventCount: events.length,
  });
  const hasTimestampedTrace = effectiveObserveFidelity === "timestamped";
  const hasObservedTraceEvents = evidence.traceEventCount > 0;

  return (
    <aside className={`s-observe-rail${surface === "context" ? " s-observe-rail--context" : ""}`}>
      <div>
        <div className="s-observe-rail-label">Evidence</div>
        <div className="s-observe-evidence-card" data-tone={evidence.tone}>
          <span className="s-observe-evidence-dot" aria-hidden="true" />
          <span>
            <strong>{evidence.label}</strong>
            <small>{evidence.detail}</small>
          </span>
        </div>
      </div>
      {catalog && catalog.sessions.length > 0 && (
        <div>
          <div className="s-observe-rail-label">Session</div>
          <SessionHeader catalog={catalog} sessionId={sessionId ?? null} agentId={agentId} />
        </div>
      )}

      <div>
        <div className="s-observe-rail-label">Trace stats</div>
        <div className="s-observe-stats">
          <StatCard
            label="Turns"
            value={fmtCompactNumber(hasObservedTraceEvents ? sessionMeta?.turnCount : undefined)}
          />
          <StatCard label="Tools" value={fmtCompactNumber(hasObservedTraceEvents ? toolCount : undefined)} />
          <StatCard label="Thinks" value={fmtCompactNumber(hasObservedTraceEvents ? thinkCount : undefined)} />
          <StatCard label="Requests" value={fmtCompactNumber(hasObservedTraceEvents ? askCount : undefined)} />
          <StatCard label="Reads" value={fmtCompactNumber(hasObservedTraceEvents ? readCount : undefined)} />
          <StatCard label="Edits" value={fmtCompactNumber(hasObservedTraceEvents ? editCount : undefined)} />
          <StatCard label="Files" value={fmtCompactNumber(hasObservedTraceEvents ? files.length : undefined)} />
          <StatCard
            label="Window"
            value={hasTimestampedTrace && hasObservedTraceEvents ? fmtWindowSpan(observedWindowSeconds) : "—"}
          />
        </div>
      </div>

      <div>
        <div className="s-observe-rail-label">Interacted agents</div>
        <ObservedTopologyPanel
          topology={metadata?.topology ?? null}
          sessionId={sessionId ?? metadata?.session?.externalSessionId ?? null}
          size="rail"
          maxAgents={4}
        />
      </div>

      <div>
        <div className="s-observe-rail-label">Context window</div>
        <DetailRows rows={windowRows} agentId={agentId ?? null} sessionId={sessionId ?? null} />
        {derivedLoadPercent !== null ? (
          <>
            <ContextMeter data={[derivedLoadPercent / 100, derivedLoadPercent / 100]} cursor={effectiveCursor / effectiveDuration} />
            <div className="s-observe-ctx-detail">
              Meter uses latest context input divided by the model window.
            </div>
          </>
        ) : windowRows.length === 0 ? (
          <RailEmpty />
        ) : (
          <div className="s-observe-ctx-detail">
            No derived load trace captured.
          </div>
        )}
      </div>

      <div>
        <div className="s-observe-rail-label">
          Files touched · {files.length}
        </div>
        <div className="s-observe-files">
          {files.map((f) => (
            <div
              key={f.path}
              className={`s-observe-file${f.lastT <= effectiveCursor ? " s-observe-file--visible" : " s-observe-file--hidden"}`}
            >
              <FileGlyph state={f.state} />
              <LocalPathLink
                path={f.path}
                basePath={sessionMeta?.cwd ?? null}
                agentId={agentId ?? null}
                sessionId={sessionId ?? null}
                className="s-observe-file-path"
              >
                {f.path}
              </LocalPathLink>
              <span className="s-observe-file-touches">×{f.touches}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="s-observe-rail-label">Usage</div>
        {usageStatCards.length > 0 && (
          <div className="s-observe-stats s-observe-stats--usage">
            {usageStatCards.map((card) => (
              <StatCard
                key={card.label}
                label={card.label}
                value={fmtCompactNumber(card.value)}
              />
            ))}
          </div>
        )}
        {usageRows.length > 0 ? (
          <DetailRows rows={usageRows} agentId={agentId ?? null} sessionId={sessionId ?? null} />
        ) : !hasUsageMetadata && usageStatCards.length === 0 ? (
          <RailEmpty />
        ) : null}
      </div>

      <div>
        <div className="s-observe-rail-label">Metadata</div>
        {metadataRows.length > 0 ? (
          <DetailRows rows={metadataRows} agentId={agentId ?? null} sessionId={sessionId ?? null} />
        ) : !hasSessionMetadata ? (
          <RailEmpty />
        ) : null}
      </div>
    </aside>
  );
}

function SessionObserveComposer({
  conversationId,
  agentId,
  sessionId,
  invoke,
}: {
  conversationId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  /**
   * Broker-invoke target for a session that has no live agent identity yet
   * (bare history trace). Carries the session's own project path + harness +
   * model so the broker resumes it the correct way in and mints an agent id.
   */
  invoke?: {
    projectPath: string;
    sessionId: string;
    harness?: string;
    model?: string;
    reasoningEffort?: string;
  } | null;
}) {
  const { navigate } = useScout();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState(() => conversationId?.trim() || null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setActiveConversationId(conversationId?.trim() || null);
  }, [conversationId]);

  const resumableAgentId = agentId?.trim() || null;
  const resumableSessionId = sessionId?.trim() || null;
  const canResumeSession = Boolean(resumableAgentId && resumableSessionId);
  const canInvokeSession = Boolean(invoke?.projectPath && invoke?.sessionId);
  const canWrite = Boolean(activeConversationId || canResumeSession || canInvokeSession);
  const canSubmit = canWrite && draft.trim().length > 0 && !sending;

  const submit = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    if (!activeConversationId && !canResumeSession && !canInvokeSession) {
      setError("No writable session target is attached yet.");
      return;
    }

    setSending(true);
    setStatus(null);
    setError(null);
    try {
      if (activeConversationId) {
        await api("/api/send", {
          method: "POST",
          body: JSON.stringify({
            body,
            conversationId: activeConversationId,
            intent: "steer",
          }),
        });
        setDraft("");
        setStatus("Sent into this session.");
        inputRef.current?.focus();
      } else if (canResumeSession) {
        const result = await resumeAgentSession({
          agentId: resumableAgentId!,
          sessionId: resumableSessionId!,
          instructions: body,
        });
        const resumedConversationId = result.conversationId?.trim();
        if (resumedConversationId) {
          setActiveConversationId(resumedConversationId);
        }
        setDraft("");
        setStatus("Sent into this session.");
        inputRef.current?.focus();
      } else {
        // No agent identity yet: have the broker invoke the raw session on its
        // own harness/model, then follow the minted conversation into a DM.
        const result = await invokeSession({
          projectPath: invoke!.projectPath,
          sessionId: invoke!.sessionId,
          ...(invoke!.harness ? { harness: invoke!.harness } : {}),
          ...(invoke!.model ? { model: invoke!.model } : {}),
          ...(invoke!.reasoningEffort ? { reasoningEffort: invoke!.reasoningEffort } : {}),
          instructions: body,
        });
        const invokedConversationId = result.conversationId?.trim();
        setDraft("");
        if (invokedConversationId) {
          setActiveConversationId(invokedConversationId);
          setStatus("Session invoked — opening conversation.");
          navigate({ view: "conversation", conversationId: invokedConversationId });
        } else {
          setStatus("Session invoked.");
          inputRef.current?.focus();
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="s-observe-compose">
      <MessageComposer
        renderWhenEmbedded
        density="panel"
        value={draft}
        onChange={setDraft}
        onSend={() => void submit()}
        sending={sending}
        disabled={!canWrite || sending}
        canSend={canSubmit}
        placeholder={
          !canWrite
            ? "This trace is read-only"
            : !activeConversationId && !canResumeSession && canInvokeSession
              ? "Message this session to invoke it…"
              : "Write into this session…"
        }
        textareaRef={inputRef}
        rows={3}
        showAttach={canWrite}
        onAttach={() => inputRef.current?.focus()}
        attachTitle="Add context"
        attachAriaLabel="Add context"
        sendTitle="Send into this session (Cmd+Enter)"
        sendAriaLabel="Send into this session"
        tools={!canWrite ? (
          <span className="s-observe-compose-status s-observe-compose-status--muted">
            No broker conversation or resumable agent session is attached to this trace.
          </span>
        ) : error ? (
          <span className="s-observe-compose-status s-observe-compose-status--error">{error}</span>
        ) : status ? (
          <span className="s-observe-compose-status">{status}</span>
        ) : null}
      />
    </div>
  );
}

/* ── Main component ── */

export function SessionObserve({
  data,
  agentId,
  sessionId,
  conversationId,
  observeSource,
  observeFidelity,

  showRail = true,
  variant = "default",
  traceLimit,
  traceWindowMs,
  traceWindowLabel,
  nowMs,
  initialCursorT,
  focusEventId,
  inlineFocusEventId,
  inlineFocusContent,
  onLaneEventSelect,
  surface = "scout",
  laneGutter,
  richSimpleTools,
  laneCollapseTechnicalEvents,
  onLaneCollapseTechnicalEventsChange,
  laneOperatorName,
}: {
  data?: SessionObserveData;
  agentId?: string;
  sessionId?: string | null;
  conversationId?: string | null;
  observeSource?: ObserveEvidenceSource;
  observeFidelity?: ObserveEvidenceFidelity;
  showRail?: boolean;
  variant?: "default" | "lane";
  /** Scope instrument: timeline only — no Scout replay chrome, rail, or lane meta bar. */
  surface?: "scout" | "scope";
  /** Lane mode: time-only gutter (Scout) or kind/tool label + time (Scope lanes). */
  laneGutter?: "time" | "label-time";
  /** Lane mode: render bash pills and per-family tool chrome even for single-token commands. */
  richSimpleTools?: boolean;
  /** Lane mode: collapse low-signal technical rows into turn-level summaries. */
  laneCollapseTechnicalEvents?: boolean;
  /** Lane mode: update the per-lane trace density preference. */
  onLaneCollapseTechnicalEventsChange?: (enabled: boolean) => void;
  /** Lane mode: operator display name on the chat-style user-request head. */
  laneOperatorName?: string;
  /** @deprecated Prefer traceWindowMs — lane mode time horizon for visible events. */
  traceLimit?: number;
  /** Lane mode: only render observe events inside this wall-clock window. */
  traceWindowMs?: number;
  /** Lane mode: human label for the selected horizon (e.g. "30m"). */
  traceWindowLabel?: string;
  /** Lane mode: shared wall clock for horizon filters (kept in sync with lane roster). */
  nowMs?: number;
  /** Default mode: open the replay cursor at this event time. */
  initialCursorT?: number;
  /** Default mode: visually mark and scroll to this event when the view opens. */
  focusEventId?: string | null;
  /** Default mode: expand detail content inline below this timeline row. */
  inlineFocusEventId?: string | null;
  inlineFocusContent?: ReactNode;
  /** Lane mode: open the full session detail sheet for a clicked trace row. */
  onLaneEventSelect?: (event: SessionEvent) => void;
}) {
  const laneMode = variant === "lane";
  const scopeSurface = surface === "scope";
  const effectiveLaneGutter = laneGutter ?? (scopeSurface ? "label-time" : "time");
  const effectiveRichSimpleTools = richSimpleTools ?? scopeSurface;
  const effectiveShowRail = showRail && !scopeSurface;
  const observeData = data ?? EMPTY_OBSERVE_DATA;
  const { events } = observeData;
  const effectiveObserveSource = observeSource ?? (observeData.live ? "live" : "history");
  const effectiveObserveFidelity = observeFidelity ?? "timestamped";
  const evidence = describeObserveEvidence({
    source: effectiveObserveSource,
    fidelity: effectiveObserveFidelity,
    live: observeData.live,
    eventCount: events.length,
  });
  const sessionStartMs = observeData.metadata?.session?.sessionStart;

  const [internalNow, setInternalNow] = useState(Date.now);
  const now = typeof nowMs === "number" ? nowMs : internalNow;
  useEffect(() => {
    if (!laneMode || typeof nowMs === "number") return;
    const timer = setInterval(() => setInternalNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [laneMode, nowMs]);

  const duration = events.length > 0 ? events[events.length - 1].t + 30 : 60;
  const anchoredCursor = typeof initialCursorT === "number"
    ? Math.max(0, Math.min(duration, initialCursorT))
    : null;
  const [cursor, setCursor] = useState(() => anchoredCursor ?? duration);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<0.5 | 1 | 2 | 4>(1);
  const [autoFollow, setAutoFollow] = useState(anchoredCursor == null);
  const previousDurationRef = useRef(duration);
  const observeRootRef = useRef<HTMLDivElement | null>(null);
  const snapTimes = useMemo(() => turnAnchorTimes(events, duration), [events, duration]);

  useEffect(() => {
    if (anchoredCursor == null) return;
    setCursor(anchoredCursor);
    setAutoFollow(false);
    setPlaying(false);
  }, [anchoredCursor, focusEventId]);

  useEffect(() => {
    setCursor((current) => {
      const previousDuration = previousDurationRef.current;
      previousDurationRef.current = duration;
      const wasNearLiveEdge = isCursorAtLiveEdge(current, previousDuration);
      if (current > duration || (wasNearLiveEdge && autoFollow)) {
        return duration;
      }
      return current;
    });
  }, [duration, autoFollow]);

  useEffect(() => {
    if (!playing) return;
    const intervalMs = snapTimes.length > 0 ? Math.max(220, 700 / speed) : 100;
    const id = setInterval(() => {
      setCursor((c) => {
        if (snapTimes.length > 0) {
          const next = nextSnapTime(c, snapTimes, duration);
          if (next >= duration) {
            setAutoFollow(true);
            setPlaying(false);
            return duration;
          }
          return next;
        }
        const next = c + speed;
        if (next >= duration) {
          setAutoFollow(true);
          setPlaying(false);
          return duration;
        }
        return next;
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [playing, duration, snapTimes, speed]);

  const useHorizonTrace = laneMode && Boolean(traceWindowMs && traceWindowMs > 0);
  const visible = (() => {
    let filtered = events.filter((event) => event.t <= cursor);
    if (useHorizonTrace && traceWindowMs) {
      const horizoned = filterObserveEventsForHorizon(
        filtered,
        sessionStartMs,
        now,
        traceWindowMs,
      );
      // The horizon decides lane presence; content keeps a minimum tail so a
      // present-but-quiet lane still fills with recent history.
      filtered = horizoned.length >= LANE_TRACE_FILL_MIN
        ? horizoned
        : filtered.slice(-LANE_TRACE_FILL_MIN);
    } else if (laneMode && traceLimit && traceLimit > 0) {
      filtered = filtered.slice(-traceLimit);
    }
    return filtered;
  })();
  const laneTraceStats = useMemo(() => {
    if (!useHorizonTrace || !traceWindowMs) return null;
    // Count events hidden before the OLDEST VISIBLE event (not the horizon
    // cutoff) so the "earlier" stat stays honest when the tail fill reaches
    // back past the window.
    const oldestVisibleId = visible[0]?.id;
    const hiddenBeforeCount = oldestVisibleId === undefined
      ? countObserveEventsBeforeHorizon(events, sessionStartMs, now, traceWindowMs)
      : Math.max(0, events.findIndex((event) => event.id === oldestVisibleId));
    return laneTraceWindowStats(
      visible,
      sessionStartMs,
      now,
      traceWindowMs,
      hiddenBeforeCount,
    );
  }, [events, now, sessionStartMs, traceWindowMs, useHorizonTrace, visible]);
  useLayoutEffect(() => {
    if (laneMode || !focusEventId) return;
    const root = observeRootRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>('[data-focus-group="true"]')
      ?? root.querySelector<HTMLElement>(`[data-event-id="${focusEventId}"]`);
    const scrollParent = target?.closest(".s-observe-main") as HTMLElement | null;
    if (target && scrollParent) {
      const parentRect = scrollParent.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const top = scrollParent.scrollTop + (targetRect.top - parentRect.top) - 16;
      scrollParent.scrollTo({ top: Math.max(0, top), behavior: "instant" });
      return;
    }
    target?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [focusEventId, inlineFocusEventId, laneMode, visible.length]);
  const isAtTail = isCursorAtLiveEdge(cursor, duration);
  const isFollowing = isAtTail && autoFollow;
  const playbackMode: "tail" | "playing" | "paused" = isFollowing
    ? "tail"
    : playing
      ? "playing"
      : "paused";

  const setManualCursor = useCallback((nextCursor: number) => {
    setAutoFollow(false);
    setPlaying(false);
    setCursor(nextCursor);
  }, []);

  const handlePlayToggle = useCallback(() => {
    if (isFollowing) {
      setAutoFollow(false);
      setPlaying(false);
    } else {
      setAutoFollow(false);
      setPlaying((current) => !current);
    }
  }, [isFollowing]);

  const metadata = observeData.metadata;
  const sessionMeta = metadata?.session;
  const sourcePath = sessionMeta?.threadPath ?? null;

  // A bare history trace has no live agent identity. If the session carries its
  // own project path + id, offer a broker-invoke path in the composer so the
  // user can engage — resumed the correct way in (its own harness + model),
  // with an agent identity minted on top by the broker.
  const invokeTargetSessionId = sessionId?.trim() || sessionMeta?.externalSessionId?.trim() || null;
  const invokeHarness = resumableHarnessFromAdapterType(sessionMeta?.adapterType);
  const invokeTarget =
    !agentId && sessionMeta?.cwd && invokeTargetSessionId && invokeHarness
      ? {
          projectPath: sessionMeta.cwd,
          sessionId: invokeTargetSessionId,
          harness: invokeHarness,
          model: sessionMeta.model,
          reasoningEffort: sessionMeta.effort,
        }
      : null;

  return (
    <div
      ref={observeRootRef}
      className={[
        "s-observe",
        (!effectiveShowRail || laneMode) && "s-observe--content-only",
        laneMode && "s-observe--lane",
        laneMode && effectiveLaneGutter === "label-time" && "s-observe--lane-gutter-label",
        scopeSurface && "s-observe--scope",
      ].filter(Boolean).join(" ")}
    >
      {/* Main timeline */}
      <main className="s-observe-main">
        {!laneMode && !scopeSurface && (
          <div className="s-observe-evidence-banner" data-tone={evidence.tone}>
            <span className="s-observe-evidence-dot" aria-hidden="true" />
            <span>
              <strong>{evidence.label}</strong>
              <small>{evidence.detail}</small>
            </span>
          </div>
        )}
        {sourcePath && !laneMode && (
          <SourceFileLink
            path={sourcePath}
            basePath={sessionMeta?.cwd ?? null}
            agentId={agentId ?? null}
            sessionId={sessionId ?? null}
          />
        )}
        {!evidence.receiptOnly && !scopeSurface && useHorizonTrace && laneTraceStats ? (
          <div className="s-observe-lane-trace-meta">
            <span className="s-observe-lane-trace-meta-leading">
              <span className="s-observe-lane-trace-meta-label">Trace</span>
              <LaneTraceModeToggle
                collapseTechnicalEvents={Boolean(laneCollapseTechnicalEvents)}
                onChange={onLaneCollapseTechnicalEventsChange}
              />
            </span>
            <span className="s-observe-lane-trace-meta-stats">
              <span className="s-observe-lane-trace-meta-window">
                last {traceWindowLabel ?? fmtTraceSpanMs(traceWindowMs ?? 0)}
              </span>
              <span className="s-observe-lane-trace-meta-sep" aria-hidden="true">·</span>
              <span>
                {laneTraceStats.eventCount} event{laneTraceStats.eventCount === 1 ? "" : "s"}
              </span>
              {laneTraceStats.spanMs > 0 ? (
                <>
                  <span className="s-observe-lane-trace-meta-sep" aria-hidden="true">·</span>
                  <span>{fmtTraceSpanMs(laneTraceStats.spanMs)} span</span>
                </>
              ) : null}
              {laneTraceStats.truncatedBefore ? (
                <span
                  className="s-observe-lane-trace-meta-tag"
                  title="Earlier activity in this window may not be loaded"
                >
                  partial
                </span>
              ) : null}
            </span>
          </div>
        ) : null}
        {evidence.receiptOnly ? (
          <SessionObserveReceiptView events={events} />
        ) : (
          <ReplayStream
            events={visible}
            followEnd={isFollowing}
            laneMode={laneMode}
            sessionStartMs={sessionStartMs}
            nowMs={now}
            preferWallAge={useHorizonTrace}
            focusEventId={focusEventId}
            inlineFocusEventId={inlineFocusEventId}
            inlineFocusContent={inlineFocusContent}
            onLaneEventSelect={onLaneEventSelect}
            laneGutter={effectiveLaneGutter}
            richSimpleTools={effectiveRichSimpleTools}
            collapseTechnicalEvents={laneMode && Boolean(laneCollapseTechnicalEvents)}
            laneOperatorName={laneOperatorName}
          />
        )}
      </main>

      {/* Right rail */}
      {effectiveShowRail && !laneMode && (
        <SessionObserveContextRail
          data={observeData}
          agentId={agentId}
          sessionId={sessionId}
          cursor={cursor}
          duration={duration}
          observeSource={observeSource}
          observeFidelity={observeFidelity}
        />
      )}

      {/* Scrubber footer */}
      {!scopeSurface && !laneMode && (
        <footer className="s-observe-scrubber">
          {evidence.replayable ? (
            <SessionTransport
              events={events}
              duration={duration}
              cursor={cursor}
              mode={playbackMode}
              speed={speed}
              snapTimes={snapTimes}
              onCursor={setManualCursor}
              onPlayToggle={handlePlayToggle}
              onSpeedChange={setSpeed}
            />
          ) : (
            <div className="s-observe-static-evidence">
              <span className="s-observe-evidence-dot" aria-hidden="true" />
              <span>{evidence.label}</span>
              <small>No timestamped replay is available.</small>
            </div>
          )}
          <SessionObserveComposer
            conversationId={conversationId}
            agentId={agentId}
            sessionId={sessionId}
            invoke={invokeTarget}
          />
        </footer>
      )}
    </div>
  );
}
