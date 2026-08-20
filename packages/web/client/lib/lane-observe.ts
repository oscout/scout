import { fullTimestamp, normalizeTimestampMs, timeAgo } from "./time.ts";
import { observeToolIsEdit, observeToolIsRead } from "./tail-display.ts";
import type { ObserveEvent, ObserveFile, ObserveData } from "./types.ts";

export type LaneTraceWindowStats = {
  eventCount: number;
  spanMs: number;
  oldestAt: number | null;
  newestAt: number | null;
  /** Oldest loaded event starts after the horizon cutoff — earlier window may be missing. */
  truncatedBefore: boolean;
  /** Events in source data that fell before the horizon cutoff. */
  hiddenBeforeCount: number;
};

const LANE_WALL_GAP_MIN_MS = 2 * 60_000;
const LANE_TRUNCATION_SLACK_MS = 90_000;

/** Lane trace age label — always reads as wall-clock age, never session elapsed. */
export function fmtLaneAgeLabel(wallMs: number, nowMs = Date.now()): string {
  const ago = timeAgo(wallMs, nowMs);
  return ago === "now" ? "now" : `${ago} ago`;
}

export function fmtLaneAgeTitle(wallMs: number): string {
  return fullTimestamp(wallMs);
}

/** Compact duration for trace span summaries (e.g. "18m", "2h 5m"). */
export function fmtTraceSpanMs(spanMs: number): string {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return "0s";
  if (spanMs < 60_000) {
    return `${Math.max(1, Math.round(spanMs / 1000))}s`;
  }
  if (spanMs < 3_600_000) {
    return `${Math.max(1, Math.round(spanMs / 60_000))}m`;
  }
  const hours = Math.floor(spanMs / 3_600_000);
  const minutes = Math.round((spanMs % 3_600_000) / 60_000);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** Wall-clock gap label between lane events (null when gap is too small to show). */
export function fmtLaneWallGapLabel(gapMs: number): string | null {
  if (!Number.isFinite(gapMs) || gapMs < LANE_WALL_GAP_MIN_MS) return null;
  const totalSeconds = Math.floor(gapMs / 1000);
  if (totalSeconds < 3_600) {
    return `${Math.floor(totalSeconds / 60)}m gap`;
  }
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m gap` : `${hours}h gap`;
}

export function laneTraceWindowStats(
  events: ObserveEvent[],
  sessionStartMs: number | undefined,
  nowMs: number,
  windowMs: number,
  hiddenBeforeCount = 0,
): LaneTraceWindowStats {
  const cutoff = nowMs - windowMs;

  const wallTimes = events
    .map((event) => observeEventWallMs(event, sessionStartMs))
    .filter((value): value is number => value !== null);

  if (wallTimes.length === 0) {
    return {
      eventCount: 0,
      spanMs: 0,
      oldestAt: null,
      newestAt: null,
      truncatedBefore: false,
      hiddenBeforeCount,
    };
  }

  const oldestAt = Math.min(...wallTimes);
  const newestAt = Math.max(...wallTimes);
  return {
    eventCount: events.length,
    spanMs: Math.max(0, newestAt - oldestAt),
    oldestAt,
    newestAt,
    truncatedBefore: oldestAt > cutoff + LANE_TRUNCATION_SLACK_MS,
    hiddenBeforeCount,
  };
}

export function observeEventWallMs(
  event: ObserveEvent,
  sessionStartMs: number | undefined,
): number | null {
  const eventAt = normalizeTimestampMs(event.at);
  if (eventAt !== null) return eventAt;
  if (!Number.isFinite(event.t) || event.t < 0) return null;
  const sessionStart = normalizeTimestampMs(sessionStartMs);
  if (sessionStart === null) return null;
  return sessionStart + event.t * 1000;
}

/** Lane trace alias — same wall-clock resolver as observeEventWallMs. */
export const laneEventWallMs = observeEventWallMs;

export function filterObserveEventsForHorizon(
  events: ObserveEvent[],
  sessionStartMs: number | undefined,
  now: number,
  windowMs: number,
): ObserveEvent[] {
  const cutoff = now - windowMs;
  return events.filter((event) => {
    const wallMs = observeEventWallMs(event, sessionStartMs);
    if (wallMs === null) return false;
    return wallMs >= cutoff;
  });
}

export function countObserveEventsBeforeHorizon(
  events: ObserveEvent[],
  sessionStartMs: number | undefined,
  nowMs: number,
  windowMs: number,
): number {
  const cutoff = nowMs - windowMs;
  return events.reduce((count, event) => {
    const wallMs = observeEventWallMs(event, sessionStartMs);
    if (wallMs === null || wallMs >= cutoff) return count;
    return count + 1;
  }, 0);
}

/** Minimum events a lane trace keeps regardless of the horizon window. Lane
 * PRESENCE is horizon-gated; trace CONTENT tops up past the window so a
 * freshly-admitted lane isn't nearly empty — tail -n style, with the horizon
 * only deciding which lanes exist. */
export const LANE_TRACE_FILL_MIN = 50;

/** Horizon-filter a lane's observe data, but keep at least `fillMin` trailing
 * events when the window alone is too sparse to fill the lane. The fill path
 * keeps the full touched-files inventory — files are a summary, not a feed. */
export function filterObserveDataForHorizonWithFill(
  data: ObserveData | null | undefined,
  now: number,
  windowMs: number,
  fillMin: number = LANE_TRACE_FILL_MIN,
): ObserveData | null {
  const filtered = filterObserveDataForHorizon(data, now, windowMs);
  if (!data || !filtered) return filtered ?? null;
  if (filtered.events.length >= fillMin) return filtered;
  if (data.events.length <= filtered.events.length) return filtered;
  return { ...data, events: data.events.slice(-fillMin) };
}

export function filterObserveDataForHorizon(
  data: ObserveData | null | undefined,
  now: number,
  windowMs: number,
): ObserveData | null {
  if (!data) return null;

  const sessionStart = data.metadata?.session?.sessionStart;
  const events = filterObserveEventsForHorizon(data.events, sessionStart, now, windowMs);
  if (events.length === data.events.length) return data;

  const cutoff = now - windowMs;
  const files = data.files.filter((file) => {
    if (typeof sessionStart !== "number" || !Number.isFinite(sessionStart)) return true;
    if (!Number.isFinite(file.lastT) || file.lastT < 0) return true;
    return sessionStart + file.lastT * 1000 >= cutoff;
  });

  return {
    ...data,
    events,
    files,
  };
}

export const LANE_SNIPPET_MAX_CHARS = 180;
export const LANE_SNIPPET_MAX_LINES = 3;

export function laneSnippetText(
  text: string,
  maxChars = LANE_SNIPPET_MAX_CHARS,
  maxLines = LANE_SNIPPET_MAX_LINES,
): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const lineLimited = lines.slice(0, maxLines).join("\n");
  if (lineLimited.length <= maxChars && lines.length <= maxLines) {
    return lineLimited;
  }

  const clipped = lineLimited.slice(0, maxChars).trimEnd();
  const boundary = Math.max(
    clipped.lastIndexOf(" "),
    clipped.lastIndexOf("\n"),
    clipped.lastIndexOf("."),
  );
  const soft = boundary > maxChars * 0.55 ? clipped.slice(0, boundary) : clipped;
  return `${soft.trimEnd()}…`;
}

export function laneTextNeedsExpand(
  text: string,
  maxChars = LANE_SNIPPET_MAX_CHARS,
  maxLines = LANE_SNIPPET_MAX_LINES,
): boolean {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return false;
  return normalized.length > maxChars || normalized.split("\n").length > maxLines;
}

const PATH_LIKE = /(?:^|[\s'"`])(\/[^\s'"`]+|(?:[\w@.-]+\/)+[\w@./-]+\.\w{1,8})/g;
const SED_PATH = /\b(?:sed|cat|head|tail|nl)\s+(?:-[^\s]+\s+)*['"]?([^\s'"]+)/;
const RG_FILE = /\b(?:[\w./-]+\/)+[\w@./-]+\.\w{1,8}\b/g;
const GIT_DIFF_PATH = /\bgit\s+diff\b[\s\S]*?\s--\s+([^\n\r;&|]+)/g;
const PATCH_PATH = /^(?:\+\+\+|---)\s+(?:[ab]\/)?([^\s]+)|^\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)$/gm;

function normalizeInferredPath(raw: string): string | null {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed || trimmed.length < 3) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
  if (/^(https?:|git@)/.test(trimmed)) return null;
  if (!trimmed.includes("/") && !trimmed.includes(".")) return null;
  return trimmed;
}

/**
 * Shell/command words that occasionally leak into `observe.files` READ inventory
 * when a multi-line bash command is mis-recorded line-by-line. We prefer the
 * structural rules below, but a small denylist catches bare command words
 * (including newline-split `\n…` artifacts that surface as a leading `n`).
 */
const SHELL_COMMAND_WORDS = new Set([
  "echo", "sed", "grep", "egrep", "fgrep", "rg", "awk", "cat", "head", "tail",
  "ls", "cd", "pwd", "cp", "mv", "rm", "mkdir", "touch", "chmod", "chown",
  "npx", "npm", "pnpm", "yarn", "bun", "node", "deno", "python", "python3",
  "pip", "pip3", "ruby", "go", "cargo", "rustc", "swift", "make", "cmake",
  "bash", "sh", "zsh", "fish", "curl", "wget", "git", "docker", "kubectl",
  "for", "do", "done", "then", "fi", "else", "elif", "case", "esac", "while",
  "until", "function", "return", "exit", "set", "export", "source", "eval",
  "true", "false", "test", "find", "xargs", "sort", "uniq", "wc", "tee",
  "open", "kill", "ps", "top", "env", "printf", "read", "sleep",
]);

const KNOWN_FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "swift", "kt", "java", "go", "rs", "rb", "py", "php", "c", "h", "cc",
  "cpp", "hpp", "m", "mm", "cs", "scala", "clj", "ex", "exs", "lua", "dart",
  "json", "json5", "jsonc", "yaml", "yml", "toml", "xml", "ini", "cfg",
  "conf", "env", "lock", "properties", "plist", "entitlements",
  "md", "mdx", "markdown", "txt", "rst", "adoc", "csv", "tsv",
  "css", "scss", "sass", "less", "html", "htm", "vue", "svelte",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "tiff", "avif",
  "pdf", "mp4", "mov", "webm", "mp3", "wav", "woff", "woff2", "ttf", "otf",
  "sql", "graphql", "gql", "proto", "prisma", "wasm", "map",
  "gradle", "bazel", "bzl", "mk", "cmake", "dockerfile", "gitignore",
  "npmrc", "nvmrc", "editorconfig", "prettierrc", "eslintrc", "babelrc",
]);

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FILE_EXTENSION_RE = /\.([A-Za-z0-9_+-]{1,12})$/;

/**
 * Gate touched-file inventory entries to plausible file paths. Rejects shell
 * command tokens, env assignments, flags, JSON fragments, and newline-split
 * artifacts that pollute the READ list; accepts anything containing a `/` or a
 * basename ending in a recognized file extension.
 *
 * Conservative by design: NEVER drops a token containing a `/`.
 */
export function isPlausibleFilePath(path: string): boolean {
  if (typeof path !== "string") return false;
  const trimmed = path.trim();
  if (!trimmed) return false;

  // Newline-bearing tokens are command fragments, never a single file path.
  if (/[\n\r]/.test(trimmed)) return false;

  // Anything with a path separator is a genuine path — accept unconditionally.
  if (trimmed.includes("/")) return true;

  // From here on it's a bare basename (no `/`). Apply structural rejections.
  if (trimmed.length < 3) return false;
  if (trimmed.startsWith("-")) return false; // flags / option fragments
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false; // JSON
  if (ENV_ASSIGNMENT_RE.test(trimmed)) return false; // CHROME=, nCHROME=
  if (/\s/.test(trimmed)) return false; // multi-word — not a basename

  const lower = trimmed.toLowerCase();
  if (SHELL_COMMAND_WORDS.has(lower)) return false;
  // Newline-split artifact: a leading `n` glued to a command word (e.g. `necho`).
  if (lower.startsWith("n") && SHELL_COMMAND_WORDS.has(lower.slice(1))) return false;

  // A bare basename is a file only if it has a recognized extension.
  const extMatch = trimmed.match(FILE_EXTENSION_RE);
  if (!extMatch) return false;
  return KNOWN_FILE_EXTENSIONS.has(extMatch[1].toLowerCase());
}

/** Filter + dedupe touched-file inventory by normalized path for display. */
export function plausibleTouchedFiles(files: ObserveFile[]): ObserveFile[] {
  const byPath = new Map<string, ObserveFile>();
  for (const file of files) {
    const path = file.path?.trim();
    if (!path || !isPlausibleFilePath(path)) continue;
    const existing = byPath.get(path);
    if (!existing) {
      byPath.set(path, { ...file, path });
      continue;
    }
    existing.touches += file.touches;
    existing.lastT = Math.max(existing.lastT, file.lastT);
    if (existing.state === "read" && file.state !== "read") existing.state = file.state;
    if (existing.state === "modified" && file.state === "created") existing.state = "created";
  }
  return [...byPath.values()];
}

function pathsFromToolArg(tool: string | undefined, arg: string | undefined): string[] {
  const paths = new Set<string>();
  const command = arg?.trim();
  if (!command) return [];

  const readJson = command.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (readJson?.[1]) {
    const path = readJson[1].replace(/\\"/g, "\"");
    const normalized = normalizeInferredPath(path);
    if (normalized) paths.add(normalized);
  }

  const sedMatch = command.match(SED_PATH);
  if (sedMatch?.[1]) {
    const normalized = normalizeInferredPath(sedMatch[1]);
    if (normalized) paths.add(normalized);
  }

  for (const match of command.matchAll(GIT_DIFF_PATH)) {
    for (const part of (match[1] ?? "").split(/\s+/)) {
      const normalized = normalizeInferredPath(part);
      if (normalized) paths.add(normalized);
    }
  }

  for (const match of command.matchAll(PATCH_PATH)) {
    const normalized = normalizeInferredPath(match[1] ?? match[2] ?? "");
    if (normalized && normalized !== "/dev/null") paths.add(normalized);
  }

  for (const match of command.matchAll(PATH_LIKE)) {
    const normalized = normalizeInferredPath(match[1] ?? "");
    if (normalized) paths.add(normalized);
  }

  if (paths.size === 0) {
    for (const match of command.matchAll(RG_FILE)) {
      const normalized = normalizeInferredPath(match[0] ?? "");
      if (normalized) paths.add(normalized);
    }
  }

  if (paths.size === 0 && observeToolIsRead(tool) && command.length < 240) {
    const normalized = normalizeInferredPath(command);
    if (normalized) paths.add(normalized);
  }

  return [...paths];
}

function fileStateForTool(tool: string | undefined): ObserveFile["state"] {
  if (observeToolIsEdit(tool)) return "modified";
  if (observeToolIsRead(tool)) return "read";
  return "read";
}

/** Infer touched files from lane trace tool events when full observe files are absent. */
export function filesFromObserveEvents(events: ObserveEvent[]): ObserveFile[] {
  const byPath = new Map<string, ObserveFile>();

  for (const event of events) {
    if (event.kind !== "tool") continue;
    // Tool-result rows ("res:") carry an output preview, not a file touch —
    // mining them for paths would pollute the inventory with echoed content.
    if (event.tool === "res") continue;
    const paths = [
      ...pathsFromToolArg(event.tool, event.arg ?? event.text),
      ...pathsFromToolArg(event.tool, event.detail),
    ];
    for (const path of paths) {
      const state = fileStateForTool(event.tool);
      const existing = byPath.get(path);
      if (!existing) {
        byPath.set(path, {
          path,
          state,
          touches: 1,
          lastT: event.t,
        });
        continue;
      }
      existing.touches += 1;
      existing.lastT = Math.max(existing.lastT, event.t);
      if (state === "modified") existing.state = "modified";
    }
  }

  return [...byPath.values()].sort((left, right) => right.lastT - left.lastT);
}

/** Single-line lane rows — clip here instead of wrapping mid-command. */
export const LANE_CMD_SNIPPET_MAX = 88;

export function laneToolArgSnippet(arg: string | undefined, max = 96): string {
  const trimmed = arg?.trim();
  if (!trimmed) return "";
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
