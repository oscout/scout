import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import type { SessionState } from "@openscout/agent-sessions";
import { epochMs, type AgentEndpoint } from "@openscout/protocol";
import { loadScoutBrokerContext } from "../../core/broker/service.ts";
import {
  answerLocalAgentSessionQuestion,
  getLocalAgentConfig,
  getLocalAgentEndpointSessionSnapshot,
  getLocalAgentSessionSnapshot,
} from "@openscout/runtime/local-agents";
import type { RuntimeRegistrySnapshot } from "@openscout/runtime/registry";
import { relayAgentLogsDirectory } from "@openscout/runtime/support-paths";
import { getScoutDesktopPairingSessionSnapshot } from "./pairing.ts";

export type ScoutDesktopAgentSessionMode = "trace" | "debug" | "unavailable";
export type ScoutDesktopAgentSessionDebugMode = "tmux" | "logs";

export type ScoutDesktopAgentSessionInspector = {
  agentId: string;
  title: string;
  subtitle: string;
  mode: ScoutDesktopAgentSessionMode;
  harness: string | null;
  transport: string | null;
  sessionId: string | null;
  trace: SessionState | null;
  traceSource: "pairing_bridge" | "local_runtime" | null;
  debugMode: ScoutDesktopAgentSessionDebugMode | null;
  commandLabel: string | null;
  pathLabel: string | null;
  directoryPath: string | null;
  body: string;
  updatedAtLabel: string | null;
  lineCount: number;
  truncated: boolean;
  missing: boolean;
};

export type AnswerScoutDesktopAgentSessionQuestionInput = {
  agentId: string;
  sessionId: string;
  turnId: string;
  blockId: string;
  answer: string[];
};

export type ScoutDesktopAgentSessionHost = {
  platform?: string;
  execFile?: (file: string, args: string[]) => Promise<void>;
  openPath?: (targetPath: string) => Promise<string> | string;
};

const LOG_TAIL_CHUNK_BYTES = 64 * 1024;
const DEFAULT_AGENT_SESSION_TAIL_LINES = 180;

function compactHomePath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const home = process.env.HOME ?? "";
  return home && value.startsWith(home) ? value.replace(home, "~") : value;
}

function expandHomePath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value === "~") {
    return process.env.HOME ?? value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", value.slice(2));
  }
  return value;
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeTimestamp(value: number | null | undefined): number {
  const ms = epochMs(value);
  return ms === null ? 0 : Math.floor(ms / 1000);
}

function formatRelativeTime(value: number): string {
  const deltaSeconds = Math.max(0, Math.floor(Date.now() / 1000) - normalizeTimestamp(value));
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function runOptionalCommand(command: string, args: string[]): string | null {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function splitLogLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function logSectionLabel(filePath: string): string {
  return path.basename(filePath);
}

async function readVisibleLogFile(filePath: string, tailLines: number): Promise<{
  lines: string[];
  updatedAtMs: number;
  truncated: boolean;
}> {
  const file = await open(filePath, "r");

  try {
    const stats = await file.stat();
    if (tailLines <= 0 || stats.size <= 0) {
      const raw = stats.size > 0 ? await file.readFile({ encoding: "utf8" }) : "";
      return {
        lines: splitLogLines(raw),
        updatedAtMs: stats.mtimeMs,
        truncated: false,
      };
    }

    let position = stats.size;
    let newlineCount = 0;
    let totalBytes = 0;
    const chunks: Uint8Array[] = [];

    while (position > 0 && newlineCount <= tailLines) {
      const readSize = Math.min(LOG_TAIL_CHUNK_BYTES, position);
      position -= readSize;
      const buffer = new Uint8Array(readSize);
      const { bytesRead } = await file.read(buffer, 0, readSize, position);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      totalBytes += bytesRead;
      for (const byte of chunk) {
        if (byte === 10) {
          newlineCount += 1;
        }
      }
    }

    const raw = decodeByteChunks(chunks, totalBytes);
    const lines = splitLogLines(raw);
    return {
      lines: lines.length > tailLines ? lines.slice(-tailLines) : lines,
      updatedAtMs: stats.mtimeMs,
      truncated: position > 0 || lines.length > tailLines,
    };
  } finally {
    await file.close();
  }
}

function decodeByteChunks(chunks: Uint8Array[], totalBytes: number): string {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function captureTmuxPane(sessionId: string, tailLines: number): {
  body: string;
  lineCount: number;
  truncated: boolean;
  missing: boolean;
} {
  const output = runOptionalCommand("tmux", [
    "capture-pane",
    "-p",
    "-t",
    sessionId,
    "-S",
    `-${Math.max(tailLines, 40)}`,
  ]);
  if (output === null) {
    return {
      body: "",
      lineCount: 0,
      truncated: false,
      missing: true,
    };
  }

  const lines = splitLogLines(output);
  const visibleLines = lines.length > tailLines ? lines.slice(-tailLines) : lines;
  return {
    body: visibleLines.join("\n"),
    lineCount: visibleLines.length,
    truncated: lines.length > tailLines,
    missing: false,
  };
}

async function readAgentSessionLogs(agentId: string, tailLines: number): Promise<{
  body: string;
  pathLabel: string;
  targetPath: string | null;
  updatedAtLabel: string | null;
  lineCount: number;
  truncated: boolean;
  missing: boolean;
}> {
  const logsDirectory = relayAgentLogsDirectory(agentId);
  const sources = [
    path.join(logsDirectory, "stdout.log"),
    path.join(logsDirectory, "stderr.log"),
  ];
  const sections: string[] = [];
  let updatedAtMs = 0;
  let lineCount = 0;
  let truncated = false;
  let foundAny = false;
  let targetPath: string | null = null;

  for (const filePath of sources) {
    if (!existsSync(filePath)) {
      continue;
    }

    foundAny = true;
    targetPath ??= filePath;
    const content = await readVisibleLogFile(filePath, tailLines);
    updatedAtMs = Math.max(updatedAtMs, content.updatedAtMs);
    lineCount += content.lines.length;
    truncated = truncated || content.truncated;
    sections.push(`== ${logSectionLabel(filePath)} ==`);
    sections.push(content.lines.join("\n") || "(empty)");
  }

  return {
    body: foundAny ? sections.join("\n\n") : "",
    pathLabel: compactHomePath(targetPath ?? logsDirectory) ?? targetPath ?? logsDirectory,
    targetPath,
    updatedAtLabel: updatedAtMs > 0 ? formatRelativeTime(Math.floor(updatedAtMs / 1000)) : null,
    lineCount,
    truncated,
    missing: !foundAny,
  };
}

type ScoutDesktopAgentEndpoint = {
  agentId: string;
  state?: string;
  transport?: string;
  harness?: string;
  cwd?: string;
  projectRoot?: string;
  sessionId?: string;
};

function activeEndpoint(snapshot: RuntimeRegistrySnapshot, agentId: string): ScoutDesktopAgentEndpoint | null {
  const candidates = Object.values(snapshot.endpoints as Record<string, {
    agentId: string;
    state?: string;
    transport?: string;
    harness?: string;
    cwd?: string;
    projectRoot?: string;
    sessionId?: string;
  }>).filter((endpoint) => endpoint.agentId === agentId);
  const rank = (state: string | undefined) => {
    switch (state) {
      case "active":
        return 0;
      case "idle":
        return 1;
      case "waiting":
        return 2;
      case "offline":
        return 5;
      default:
        return 4;
    }
  };

  return [...candidates].sort((left, right) => rank(left.state) - rank(right.state))[0] ?? null;
}

function buildTmuxInspector(input: {
  agentId: string;
  title: string;
  harness: string | null;
  transport: string | null;
  sessionId: string;
  directoryPath: string | null;
  cwdLabel: string | null;
  tailLines: number;
}): ScoutDesktopAgentSessionInspector | null {
  const tmuxCapture = captureTmuxPane(input.sessionId, input.tailLines);
  if (tmuxCapture.missing) {
    return null;
  }

  return {
    agentId: input.agentId,
    title: input.title,
    subtitle: input.cwdLabel
      ? `Debug tmux tail · ${input.cwdLabel}`
      : "Debug tmux tail",
    mode: "debug",
    harness: input.harness,
    transport: input.transport,
    sessionId: input.sessionId,
    trace: null,
    traceSource: null,
    debugMode: "tmux",
    commandLabel: `tmux attach -t ${input.sessionId}`,
    pathLabel: input.cwdLabel ? `${input.cwdLabel} · tmux:${input.sessionId}` : `tmux:${input.sessionId}`,
    directoryPath: input.directoryPath,
    body: tmuxCapture.body,
    updatedAtLabel: null,
    lineCount: tmuxCapture.lineCount,
    truncated: tmuxCapture.truncated,
    missing: false,
  };
}

function latestSessionActivity(snapshot: SessionState): number | null {
  const lastTurn = snapshot.turns.at(-1) ?? null;
  if (!lastTurn) {
    return null;
  }
  if (
    snapshot.currentTurnId === lastTurn.id
    || lastTurn.status === "streaming"
    || snapshot.session.status === "active"
  ) {
    return Date.now();
  }
  return lastTurn.endedAt ?? lastTurn.startedAt ?? null;
}

function buildTraceInspector(input: {
  agentId: string;
  title: string;
  harness: string | null;
  transport: string | null;
  sessionId: string;
  directoryPath: string | null;
  cwdLabel: string | null;
  snapshot: SessionState;
  traceSource: "pairing_bridge" | "local_runtime";
}): ScoutDesktopAgentSessionInspector {
  const lastActivity = latestSessionActivity(input.snapshot);
  return {
    agentId: input.agentId,
    title: input.title,
    subtitle: input.cwdLabel
      ? `Live session trace · ${input.cwdLabel}`
      : "Live session trace",
    mode: "trace",
    harness: input.harness,
    transport: input.transport,
    sessionId: input.sessionId,
    trace: input.snapshot,
    traceSource: input.traceSource,
    debugMode: null,
    commandLabel: null,
    pathLabel: input.cwdLabel,
    directoryPath: input.directoryPath,
    body: "",
    updatedAtLabel: lastActivity ? formatRelativeTime(lastActivity) : null,
    lineCount: 0,
    truncated: false,
    missing: false,
  };
}

export async function getScoutDesktopAgentSession(agentId: string): Promise<ScoutDesktopAgentSessionInspector> {
  const [agentConfig, broker] = await Promise.all([
    getLocalAgentConfig(agentId),
    loadScoutBrokerContext(),
  ]);

  const configuredTitle = agentConfig?.agentId ?? agentId;
  const configuredHarness = agentConfig?.runtime.harness ?? null;
  const configuredTransport = agentConfig?.runtime.transport ?? null;
  const configuredSessionId = agentConfig?.runtime.sessionId ?? null;
  const configuredDirectoryPath = agentConfig?.runtime.cwd ?? null;

  const snapshot = broker?.snapshot;
  const agent = snapshot?.agents?.[agentId] as { displayName?: string } | undefined;
  const endpoint = snapshot ? activeEndpoint(snapshot, agentId) : null;

  const title = agent?.displayName ?? configuredTitle;
  const harness = endpoint?.harness ?? configuredHarness;
  const transport = endpoint?.transport ?? configuredTransport;
  const sessionId = endpoint?.sessionId ?? configuredSessionId;
  const directoryPath = endpoint?.cwd ?? configuredDirectoryPath;
  const cwd = compactHomePath(directoryPath ?? "") || null;

  if (transport === "pairing_bridge" && sessionId) {
    const snapshot = await getScoutDesktopPairingSessionSnapshot(sessionId);
    if (snapshot) {
      return buildTraceInspector({
        agentId,
        title,
        harness,
        transport,
        sessionId,
        directoryPath,
        cwdLabel: cwd,
        snapshot,
        traceSource: "pairing_bridge",
      });
    }
  }

  if (transport === "claude_stream_json" || transport === "codex_app_server") {
    const snapshot = agentConfig
      ? await getLocalAgentSessionSnapshot(agentId)
      : endpoint
        ? await getLocalAgentEndpointSessionSnapshot(endpoint as AgentEndpoint)
        : null;
    if (snapshot) {
      return buildTraceInspector({
        agentId,
        title,
        harness,
        transport,
        sessionId: snapshot.session.id,
        directoryPath,
        cwdLabel: cwd,
        snapshot,
        traceSource: "local_runtime",
      });
    }

    return {
      agentId,
      title,
      subtitle: "No live session trace is available yet.",
      mode: "unavailable",
      harness,
      transport,
      sessionId,
      trace: null,
      traceSource: null,
      debugMode: null,
      commandLabel: null,
      pathLabel: cwd,
      directoryPath,
      body: "",
      updatedAtLabel: null,
      lineCount: 0,
      truncated: false,
      missing: true,
    };
  }

  const logCapture = await readAgentSessionLogs(agentId, DEFAULT_AGENT_SESSION_TAIL_LINES);

  if ((transport ?? configuredTransport) === "tmux" && sessionId) {
    const inspector = buildTmuxInspector({
      agentId,
      title,
      harness,
      transport: transport ?? configuredTransport,
      sessionId,
      directoryPath,
      cwdLabel: cwd,
      tailLines: DEFAULT_AGENT_SESSION_TAIL_LINES,
    });
    if (inspector) {
      return inspector;
    }
  }

  if (!logCapture.missing) {
    return {
      agentId,
      title,
      subtitle: transport && transport !== "tmux"
        ? `Debug ${transport} logs`
        : "Debug runtime logs",
      mode: "debug",
      harness,
      transport,
      sessionId,
      trace: null,
      traceSource: null,
      debugMode: "logs",
      commandLabel: null,
      pathLabel: logCapture.pathLabel,
      directoryPath: logCapture.targetPath ?? relayAgentLogsDirectory(agentId),
      body: logCapture.body,
      updatedAtLabel: logCapture.updatedAtLabel,
      lineCount: logCapture.lineCount,
      truncated: logCapture.truncated,
      missing: false,
    };
  }

  return {
    agentId,
    title,
    subtitle: transport === "pairing_bridge"
      ? "No live session trace is available right now."
      : "No live session trace or debug output is available yet.",
    mode: "unavailable",
    harness,
    transport,
    sessionId,
    trace: null,
    traceSource: null,
    debugMode: null,
    commandLabel: sessionId && transport === "tmux" ? `tmux attach -t ${sessionId}` : null,
    pathLabel: cwd,
    directoryPath,
    body: "",
    updatedAtLabel: null,
    lineCount: 0,
    truncated: false,
    missing: true,
  };
}

export async function answerScoutDesktopAgentSessionQuestion(
  input: AnswerScoutDesktopAgentSessionQuestionInput,
): Promise<void> {
  await answerLocalAgentSessionQuestion(input.agentId, {
    blockId: input.blockId,
    answer: input.answer,
  });
}

export async function openScoutDesktopAgentSession(
  agentId: string,
  host: ScoutDesktopAgentSessionHost = {},
): Promise<boolean> {
  const session = await getScoutDesktopAgentSession(agentId);
  const platform = host.platform ?? process.platform;

  if (session.mode === "trace") {
    throw new Error("Trace-backed sessions open directly inside Scout.");
  }

  if (session.transport === "claude_stream_json" || session.transport === "codex_app_server") {
    throw new Error("Managed local sessions are trace-backed inside Scout and do not open through tmux or raw log views.");
  }

  if (session.debugMode === "tmux" && session.commandLabel) {
    if (platform !== "darwin") {
      throw new Error("Direct tmux attach is only wired for macOS right now.");
    }
    if (!host.execFile) {
      throw new Error("Scout agent-session terminal attach is unavailable.");
    }

    await host.execFile("osascript", [
      "-e",
      'tell application "Terminal" to activate',
      "-e",
      `tell application "Terminal" to do script "${escapeAppleScriptString(session.commandLabel)}"`,
    ]);
    return true;
  }

  const targetPath = expandHomePath(session.directoryPath);
  if (targetPath) {
    if (!host.openPath) {
      throw new Error("Scout agent-session path opening is unavailable.");
    }

    const errorMessage = await host.openPath(targetPath);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return true;
  }

  throw new Error("No live session debug output is available for this agent yet.");
}
