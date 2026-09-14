import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { readBoundedClaudeFile } from "./claude-session-records.js";

import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export type ClaudeStatuslineSnapshot = Record<string, unknown>;

export type ClaudeStatuslineDelegate = {
  version: 1;
  command: string;
  source: "claude-settings.statusLine" | "manual";
  installedAt: number;
  statusLine?: Record<string, unknown>;
};

export type ClaudeStatuslineCaptureResult =
  | {
      captured: true;
      latestPath: string;
      historyPath: string;
      snapshot: ClaudeStatuslineSnapshot;
    }
  | {
      captured: false;
      reason: "invalid-json" | "invalid-record";
    };

export function resolveClaudeStatuslineDirectory(): string {
  return join(resolveOpenScoutSupportPaths().runtimeDirectory, "statusline");
}

export function resolveClaudeStatuslineLatestPath(): string {
  return join(resolveClaudeStatuslineDirectory(), "claude-latest.json");
}

export function resolveClaudeStatuslineHistoryPath(): string {
  return join(resolveClaudeStatuslineDirectory(), "claude-history.jsonl");
}

export function resolveClaudeStatuslineSessionsDirectory(directory = resolveClaudeStatuslineDirectory()): string {
  return join(directory, "sessions");
}

const CLAUDE_STATUSLINE_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

/** Latest payload per Claude session id, so a session's model and effort can be read without scanning history. */
export function resolveClaudeStatuslineSessionSnapshotPath(sessionId: string, directory?: string): string | null {
  const trimmed = sessionId.trim();
  if (!CLAUDE_STATUSLINE_SESSION_ID_PATTERN.test(trimmed)) return null;
  return join(resolveClaudeStatuslineSessionsDirectory(directory), `${trimmed}.json`);
}

export function resolveClaudeStatuslineDelegatePath(): string {
  return join(resolveClaudeStatuslineDirectory(), "claude-delegate.json");
}

export function resolveClaudeStatuslineWrapperPath(): string {
  return join(resolveClaudeStatuslineDirectory(), "claude-statusline.sh");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function percentLabel(value: unknown): string | null {
  const number = numberValue(value);
  if (number === undefined) return null;
  if (Math.abs(number - Math.round(number)) < 0.05) {
    return `${Math.round(number)}%`;
  }
  return `${number.toFixed(1)}%`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function parseClaudeStatuslinePayload(input: string): ClaudeStatuslineSnapshot | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeClaudeStatuslineSnapshot(
  input: ClaudeStatuslineSnapshot,
  capturedAt = Date.now(),
): ClaudeStatuslineSnapshot {
  const workspace = recordValue(input.workspace);
  const cwd = stringValue(input.cwd) ?? stringValue(workspace?.current_dir);
  const snapshot: ClaudeStatuslineSnapshot = {
    ...input,
    openscoutCapturedAt: numberValue(input.openscoutCapturedAt) ?? capturedAt,
  };
  if (cwd && !stringValue(snapshot.cwd)) {
    snapshot.cwd = cwd;
  }
  return snapshot;
}

export async function captureClaudeStatuslineSnapshot(
  input: string | ClaudeStatuslineSnapshot,
  options: {
    capturedAt?: number;
    directory?: string;
  } = {},
): Promise<ClaudeStatuslineCaptureResult> {
  const parsed = typeof input === "string" ? parseClaudeStatuslinePayload(input) : input;
  if (!parsed) {
    return { captured: false, reason: typeof input === "string" ? "invalid-json" : "invalid-record" };
  }
  if (!isRecord(parsed)) {
    return { captured: false, reason: "invalid-record" };
  }

  const directory = options.directory ?? resolveClaudeStatuslineDirectory();
  const latestPath = join(directory, "claude-latest.json");
  const historyPath = join(directory, "claude-history.jsonl");
  const snapshot = normalizeClaudeStatuslineSnapshot(parsed, options.capturedAt);
  const line = JSON.stringify(snapshot);
  const sessionId = stringValue(snapshot.session_id);
  const sessionSnapshotPath = sessionId ? resolveClaudeStatuslineSessionSnapshotPath(sessionId, directory) : null;

  await mkdir(directory, { recursive: true });
  if (sessionSnapshotPath) {
    await mkdir(resolveClaudeStatuslineSessionsDirectory(directory), { recursive: true });
  }
  await Promise.all([
    writeFile(latestPath, `${line}\n`, "utf8"),
    appendFile(historyPath, `${line}\n`, "utf8"),
    ...(sessionSnapshotPath ? [writeFile(sessionSnapshotPath, `${line}\n`, "utf8")] : []),
  ]);

  return {
    captured: true,
    latestPath,
    historyPath,
    snapshot,
  };
}

/** The newest statusline payload Claude Code emitted for this session id, or null when none was captured. */
export async function readClaudeStatuslineSessionSnapshot(
  sessionId: string,
  options: { directory?: string } = {},
): Promise<ClaudeStatuslineSnapshot | null> {
  const path = resolveClaudeStatuslineSessionSnapshotPath(sessionId, options.directory);
  if (!path) return null;
  let raw: string;
  try {
    const bounded = await readBoundedClaudeFile(path);
    if (bounded === null) return null;
    raw = bounded;
  } catch {
    return null;
  }
  const parsed = parseClaudeStatuslinePayload(raw);
  if (!parsed || stringValue(parsed.session_id) !== sessionId.trim()) return null;
  return parsed;
}

export type ClaudeStatuslineObservedRuntime = {
  model?: string;
  reasoningEffort?: string;
  sessionName?: string;
  cwd?: string;
  transcriptPath?: string;
  capturedAt?: number;
};

/** Runtime dimensions the harness itself reported in a statusline payload. */
export function claudeStatuslineObservedRuntime(snapshot: ClaudeStatuslineSnapshot): ClaudeStatuslineObservedRuntime {
  const model = stringValue(recordValue(snapshot.model)?.id);
  const reasoningEffort = stringValue(recordValue(snapshot.effort)?.level);
  const sessionName = stringValue(snapshot.session_name);
  const cwd = stringValue(snapshot.cwd);
  const transcriptPath = stringValue(snapshot.transcript_path);
  const capturedAt = numberValue(snapshot.openscoutCapturedAt);
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(sessionName ? { sessionName } : {}),
    ...(cwd ? { cwd } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(capturedAt !== undefined ? { capturedAt } : {}),
  };
}

export async function readClaudeStatuslineDelegate(
  path = resolveClaudeStatuslineDelegatePath(),
): Promise<ClaudeStatuslineDelegate | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return null;
    const command = stringValue(parsed.command);
    if (!command) return null;
    return {
      version: 1,
      command,
      source: parsed.source === "manual" ? "manual" : "claude-settings.statusLine",
      installedAt: numberValue(parsed.installedAt) ?? Date.now(),
      ...(isRecord(parsed.statusLine) ? { statusLine: parsed.statusLine } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeClaudeStatuslineDelegate(
  delegate: Omit<ClaudeStatuslineDelegate, "version">,
  path = resolveClaudeStatuslineDelegatePath(),
): Promise<ClaudeStatuslineDelegate> {
  const next: ClaudeStatuslineDelegate = {
    version: 1,
    ...delegate,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function isOpenScoutClaudeStatuslineCommand(command: string, wrapperPath = resolveClaudeStatuslineWrapperPath()): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (trimmed.includes(wrapperPath)) return true;
  return /(?:^|\s|["'])\S*scout(?:["']|\s)+statusline\s+claude(?:\s|$)/u.test(trimmed);
}

export function formatClaudeStatuslineFallback(snapshot: ClaudeStatuslineSnapshot | null): string {
  if (!snapshot) {
    return "Scout | Claude status";
  }

  const model = recordValue(snapshot.model);
  const workspace = recordValue(snapshot.workspace);
  const context = recordValue(snapshot.context_window);
  const rateLimits = recordValue(snapshot.rate_limits);
  const fiveHour = recordValue(rateLimits?.five_hour);
  const sevenDay = recordValue(rateLimits?.seven_day);
  const cwd = stringValue(snapshot.cwd) ?? stringValue(workspace?.current_dir);

  const parts = [
    "Scout",
    stringValue(model?.display_name) ?? stringValue(model?.id) ?? "Claude",
  ];
  if (cwd) {
    parts.push(basename(cwd));
  }

  const contextPercent = percentLabel(context?.used_percentage);
  if (contextPercent) {
    parts.push(`ctx ${contextPercent}`);
  }

  const fiveHourPercent = percentLabel(fiveHour?.used_percentage);
  if (fiveHourPercent) {
    parts.push(`5h ${fiveHourPercent}`);
  }

  const sevenDayPercent = percentLabel(sevenDay?.used_percentage);
  if (sevenDayPercent) {
    parts.push(`7d ${sevenDayPercent}`);
  }

  return parts.join(" | ");
}
