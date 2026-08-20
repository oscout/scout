import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { epochMs } from "@openscout/protocol";
import type { BrokerServiceStatus } from "@openscout/runtime/broker-process-manager";
import {
  resolveOpenScoutSupportPaths,
} from "@openscout/runtime/support-paths";

import { getRuntimeBrokerServiceStatus } from "./runtime-service-client.ts";
import { resolveScoutAppRoot, resolveScoutWorkspaceRoot } from "../../shared/paths.ts";
import { getScoutDesktopPairingState, resolveScoutPairingPaths } from "./pairing.ts";
import { getScoutDesktopAppSettings } from "./settings.ts";

export type ScoutDesktopLogGroup = "runtime" | "app" | "agents";

export type ScoutDesktopLogSource = {
  id: string;
  title: string;
  subtitle: string;
  group: ScoutDesktopLogGroup;
  pathLabel: string;
};

export type ScoutDesktopLogCatalog = {
  sources: ScoutDesktopLogSource[];
  defaultSourceId: string | null;
};

export type ScoutDesktopBrokerInspector = {
  statusLabel: string;
  statusDetail: string | null;
  version: string | null;
  label: string;
  mode: string;
  url: string;
  brokerSocketPath: string;
  installed: boolean;
  loaded: boolean;
  reachable: boolean;
  healthCheckedAtLabel: string | null;
  healthTransport: string | null;
  socketFallbackError: string | null;
  pid: string | null;
  processCommand: string | null;
  lastRestartLabel: string | null;
  nodeId: string | null;
  meshId: string | null;
  launchdState: string | null;
  lastExitStatus: string | null;
  lastLogLine: string | null;
  supportDirectory: string;
  controlHome: string;
  launchAgentPath: string;
  bootoutCommand: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  actorCount: number | null;
  agentCount: number | null;
  conversationCount: number | null;
  messageCount: number | null;
  flightCount: number | null;
  collaborationRecordCount: number | null;
  troubleshooting: string[];
  feedbackSummary: string;
};

export type ScoutDesktopFeedbackEntry = {
  label: string;
  value: string;
};

export type ScoutDesktopFeedbackSection = {
  id: string;
  title: string;
  entries: ScoutDesktopFeedbackEntry[];
};

export type ScoutDesktopFeedbackBundle = {
  generatedAt: string;
  generatedAtLabel: string;
  sections: ScoutDesktopFeedbackSection[];
  text: string;
};

export type SubmitScoutFeedbackReportInput = {
  message: string;
};

export type ScoutDesktopFeedbackSubmission = {
  id: string;
  key: string;
  endpoint: string;
  adminUrl: string;
};

export type ReadScoutLogSourceInput = {
  sourceId: string;
  tailLines?: number;
};

export type ScoutDesktopLogContent = {
  sourceId: string;
  title: string;
  subtitle: string;
  pathLabel: string;
  body: string;
  updatedAtLabel: string | null;
  lineCount: number;
  truncated: boolean;
  missing: boolean;
};

type ResolvedScoutLogSource = ScoutDesktopLogSource & {
  paths: string[];
};

const LOG_TAIL_CHUNK_BYTES = 64 * 1024;
const DEFAULT_LOG_TAIL_LINES = 240;
const DEFAULT_SCOUT_FEEDBACK_REPORT_URL = "https://api.openscout.app/api/feedback";

function compactHomePath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const home = process.env.HOME ?? "";
  return home && value.startsWith(home) ? value.replace(home, "~") : value;
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

function readPackageVersion(candidate: string): string | null {
  if (!existsSync(candidate)) {
    return null;
  }

  try {
    const payload = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
    if (typeof payload.version === "string" && payload.version.trim().length > 0) {
      return payload.version.trim();
    }
  } catch {
    // Ignore malformed package metadata and fall through.
  }

  return null;
}

function resolveToolPath(command: string): string | null {
  return runOptionalCommand("which", [command]);
}

function resolveToolVersion(command: string, args = ["--version"]): string | null {
  return runOptionalCommand(command, args);
}

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

function joinValues(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "None";
}

function serializeFeedbackSections(sections: ScoutDesktopFeedbackSection[]): string {
  return sections
    .map((section) => {
      const body = section.entries.map((entry) => `${entry.label}: ${entry.value}`).join("\n");
      return `${section.title}\n${body}`;
    })
    .join("\n\n");
}

function resolveScoutFeedbackReportUrl(): string {
  return (
    process.env.OPENSCOUT_FEEDBACK_REPORT_URL?.trim()
    || process.env.SCOUT_FEEDBACK_REPORT_URL?.trim()
    || DEFAULT_SCOUT_FEEDBACK_REPORT_URL
  );
}

function resolveScoutFeedbackAdminUrl(endpoint: string, reportId: string): string {
  try {
    const url = new URL(endpoint);
    return new URL(`/feedback/${reportId}`, url.origin).toString();
  } catch {
    return `https://api.openscout.app/feedback/${reportId}`;
  }
}

function detectSystemLabel(platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

function formatMemoryLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "Unknown";
  }
  return `${Math.round(bytes / (1024 ** 3))} GB`;
}

function parseOptionalInteger(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveBrokerProcessId(brokerUrl: string, fallbackPid: number | null): number | null {
  if (fallbackPid && Number.isFinite(fallbackPid)) {
    return fallbackPid;
  }

  try {
    const port = new URL(brokerUrl).port;
    if (!port) {
      return null;
    }
    const output = runOptionalCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const pid = Number.parseInt(output?.split(/\s+/g)[0] ?? "", 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function formatProcessStartLabel(pid: number | null): string | null {
  if (!pid) {
    return null;
  }

  const raw = runOptionalCommand("ps", ["-p", String(pid), "-o", "lstart="]);
  if (!raw) {
    return null;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return formatRelativeTime(Math.floor(parsed.getTime() / 1000));
  }

  return raw;
}

function readProcessCommand(pid: number | null): string | null {
  if (!pid) {
    return null;
  }
  return runOptionalCommand("ps", ["-p", String(pid), "-o", "command="]);
}

function brokerStatusLabel(
  status: BrokerServiceStatus,
): { label: string; detail: string | null } {
  if (status.reachable && status.health.ok) {
    return {
      label: "Running",
      detail: `Broker is responding at ${status.brokerUrl}.`,
    };
  }
  if (status.loaded) {
    return {
      label: "Starting",
      detail: "Base LaunchAgent is loaded, but the broker health endpoint is not responding yet.",
    };
  }
  if (status.installed) {
    return {
      label: "Installed",
      detail: "Base LaunchAgent exists on disk, but it is not currently loaded.",
    };
  }
  return {
    label: "Missing",
    detail: "No base LaunchAgent is installed for Scout yet.",
  };
}

function brokerTroubleshootingHints(status: BrokerServiceStatus): string[] {
  const hints: string[] = [];

  if (!status.installed) {
    hints.push("The Scout base LaunchAgent is not installed.");
  }
  if (status.installed && !status.loaded) {
    hints.push("The LaunchAgent exists but is not loaded.");
  }
  if (status.loaded && !status.reachable) {
    hints.push("launchd reports the service as loaded, but the broker health endpoint is not responding.");
  }
  if (status.health.socketFallbackError) {
    hints.push("Broker health succeeded over HTTP after the configured Unix socket failed.");
  }
  if (status.lastExitStatus !== null && status.lastExitStatus !== 0) {
    hints.push(`The last broker exit status was ${status.lastExitStatus}.`);
  }
  if (status.lastLogLine) {
    hints.push(`Last broker log line: ${status.lastLogLine}`);
  }

  return hints;
}

function runtimeVersionLabel(): string | null {
  const candidates: string[] = [];

  try {
    const appRoot = resolveScoutAppRoot();
    candidates.push(
      path.join(appRoot, "node_modules", "@openscout", "runtime", "package.json"),
      path.join(appRoot, "package.json"),
    );
  } catch {
    // Continue to workspace fallback below.
  }

  try {
    const workspaceRoot = resolveScoutWorkspaceRoot();
    candidates.push(
      path.join(workspaceRoot, "packages", "runtime", "package.json"),
      path.join(workspaceRoot, "package.json"),
    );
  } catch {
    // Source checkouts are optional in packaged builds.
  }

  for (const candidate of candidates) {
    const version = readPackageVersion(candidate);
    if (version) {
      return version;
    }
  }

  return null;
}

function appVersionLabel(): string | null {
  try {
    return readPackageVersion(path.join(resolveScoutAppRoot(), "package.json"));
  } catch {
    return null;
  }
}

function appModeLabel(): string {
  try {
    const appRoot = resolveScoutAppRoot();
    const packageJsonPath = path.join(appRoot, "package.json");
    if (existsSync(packageJsonPath)) {
      const payload = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
      if (payload.name === "@openscout/scout" || payload.name === "@openscout/cli") {
        return "installed";
      }
    }
  } catch {
    // Fall through to source label below.
  }

  return "source";
}

function brokerFeedbackSummary(
  status: BrokerServiceStatus,
  processId: number | null,
  processCommand: string | null,
  startedLabel: string | null,
  version: string | null,
): string {
  const counts = status.health.counts;
  return [
    `status: ${status.reachable ? "reachable" : "unreachable"}`,
    `label: ${status.label}`,
    `mode: ${status.mode}`,
    `version: ${version ?? "not reported"}`,
    `url: ${status.brokerUrl}`,
    `socket: ${compactHomePath(status.brokerSocketPath) ?? status.brokerSocketPath}`,
    `health_transport: ${status.health.transport ?? "not reported"}`,
    `socket_fallback: ${status.health.socketFallbackError ?? "none"}`,
    `pid: ${processId ?? "not reported"}`,
    `started: ${startedLabel ?? "not reported"}`,
    `launchd: ${status.launchdState ?? "not reported"}`,
    `last_exit: ${status.lastExitStatus ?? "not reported"}`,
    `node: ${status.health.nodeId ?? "not reported"}`,
    `mesh: ${status.health.meshId ?? "not reported"}`,
    `counts: actors=${counts?.actors ?? "?"} agents=${counts?.agents ?? "?"} conversations=${counts?.conversations ?? "?"} messages=${counts?.messages ?? "?"} flights=${counts?.flights ?? "?"} collaborationRecords=${counts?.collaborationRecords ?? "?"}`,
    `command: ${processCommand ?? "not reported"}`,
    `stdout: ${compactHomePath(status.stdoutLogPath) ?? status.stdoutLogPath}`,
    `stderr: ${compactHomePath(status.stderrLogPath) ?? status.stderrLogPath}`,
    `last_log: ${status.lastLogLine ?? "not reported"}`,
  ].join("\n");
}

function coreLogSources(): ResolvedScoutLogSource[] {
  const supportPaths = resolveOpenScoutSupportPaths();
  const pairingPaths = resolveScoutPairingPaths();
  return [
    {
      id: "broker",
      title: "Base Service",
      subtitle: "Broker stdout and stderr",
      group: "runtime",
      pathLabel: compactHomePath(supportPaths.brokerLogsDirectory) ?? supportPaths.brokerLogsDirectory,
      paths: [
        path.join(supportPaths.brokerLogsDirectory, "stdout.log"),
        path.join(supportPaths.brokerLogsDirectory, "stderr.log"),
      ],
    },
    {
      id: "app",
      title: "Desktop App",
      subtitle: "Desktop host and local app logs",
      group: "app",
      pathLabel: compactHomePath(supportPaths.appLogsDirectory) ?? supportPaths.appLogsDirectory,
      paths: [
        path.join(supportPaths.appLogsDirectory, "native.log"),
        path.join(supportPaths.appLogsDirectory, "agent-host.log"),
      ],
    },
    {
      id: "pairing",
      title: "Pairing",
      subtitle: "Phone bridge runtime log",
      group: "runtime",
      pathLabel: compactHomePath(pairingPaths.logPath) ?? pairingPaths.logPath,
      paths: [
        pairingPaths.logPath,
      ],
    },
  ];
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

async function tailScoutLogSource(
  source: ResolvedScoutLogSource,
  tailLines = DEFAULT_LOG_TAIL_LINES,
): Promise<ScoutDesktopLogContent> {
  const sections: string[] = [];
  let updatedAtMs = 0;
  let lineCount = 0;
  let truncated = false;
  let foundAny = false;

  for (const filePath of source.paths) {
    if (!existsSync(filePath)) {
      continue;
    }

    foundAny = true;
    const content = await readVisibleLogFile(filePath, tailLines);
    updatedAtMs = Math.max(updatedAtMs, content.updatedAtMs);
    lineCount += content.lines.length;
    truncated = truncated || content.truncated;
    sections.push(`== ${logSectionLabel(filePath)} ==`);
    sections.push(content.lines.join("\n") || "(empty)");
  }

  return {
    sourceId: source.id,
    title: source.title,
    subtitle: source.subtitle,
    pathLabel: source.pathLabel,
    body: foundAny ? sections.join("\n\n") : "",
    updatedAtLabel: updatedAtMs > 0 ? formatRelativeTime(Math.floor(updatedAtMs / 1000)) : null,
    lineCount,
    truncated,
    missing: !foundAny,
  };
}

export async function getScoutDesktopLogCatalog(
  _currentDirectory = process.cwd(),
): Promise<ScoutDesktopLogCatalog> {
  const sources = coreLogSources();
  return {
    sources: sources.map(({ paths: _paths, ...source }) => source),
    defaultSourceId: "broker",
  };
}

export async function getScoutDesktopBrokerInspector(): Promise<ScoutDesktopBrokerInspector> {
  const status = await getRuntimeBrokerServiceStatus();
  const processId = resolveBrokerProcessId(status.brokerUrl, status.pid);
  const processCommand = readProcessCommand(processId);
  const lastRestartLabel = formatProcessStartLabel(processId);
  const version = runtimeVersionLabel();
  const { label, detail } = brokerStatusLabel(status);
  const counts = status.health.counts;

  return {
    statusLabel: label,
    statusDetail: detail,
    version,
    label: status.label,
    mode: status.mode,
    url: status.brokerUrl,
    brokerSocketPath: compactHomePath(status.brokerSocketPath) ?? status.brokerSocketPath,
    installed: status.installed,
    loaded: status.loaded,
    reachable: status.reachable,
    healthCheckedAtLabel: status.health.checkedAt
      ? formatRelativeTime(status.health.checkedAt)
      : null,
    healthTransport: status.health.transport ?? null,
    socketFallbackError: status.health.socketFallbackError ?? null,
    pid: processId ? String(processId) : null,
    processCommand,
    lastRestartLabel,
    nodeId: status.health.nodeId ?? null,
    meshId: status.health.meshId ?? null,
    launchdState: status.launchdState,
    lastExitStatus: status.lastExitStatus !== null ? String(status.lastExitStatus) : null,
    lastLogLine: status.lastLogLine,
    supportDirectory: compactHomePath(status.supportDirectory) ?? status.supportDirectory,
    controlHome: compactHomePath(status.controlHome) ?? status.controlHome,
    launchAgentPath: compactHomePath(status.launchAgentPath) ?? status.launchAgentPath,
    bootoutCommand: status.bootoutCommand,
    stdoutLogPath: compactHomePath(status.stdoutLogPath) ?? status.stdoutLogPath,
    stderrLogPath: compactHomePath(status.stderrLogPath) ?? status.stderrLogPath,
    actorCount: counts?.actors ?? null,
    agentCount: counts?.agents ?? null,
    conversationCount: counts?.conversations ?? null,
    messageCount: counts?.messages ?? null,
    flightCount: counts?.flights ?? null,
    collaborationRecordCount: counts?.collaborationRecords ?? null,
    troubleshooting: brokerTroubleshootingHints(status),
    feedbackSummary: brokerFeedbackSummary(status, processId, processCommand, lastRestartLabel, version),
  };
}

export async function readScoutDesktopLogSource(
  input: ReadScoutLogSourceInput,
  _currentDirectory = process.cwd(),
): Promise<ScoutDesktopLogContent> {
  const sources = coreLogSources();
  const source = sources.find((entry) => entry.id === input.sourceId);
  if (!source) {
    throw new Error(`Unknown log source: ${input.sourceId}`);
  }
  const MAX_TAIL_LINES = 1000;
  const tailLines = Math.min(input.tailLines ?? DEFAULT_LOG_TAIL_LINES, MAX_TAIL_LINES);
  return tailScoutLogSource(source, tailLines);
}

export async function getScoutDesktopFeedbackBundle(
  currentDirectory = process.cwd(),
): Promise<ScoutDesktopFeedbackBundle> {
  const generatedAt = new Date().toISOString();
  const supportPaths = resolveOpenScoutSupportPaths();
  const appSettings = await getScoutDesktopAppSettings(currentDirectory);
  const pairingState = await getScoutDesktopPairingState(currentDirectory);
  const brokerInspector = await getScoutDesktopBrokerInspector();

  const appRoot = (() => {
    try {
      return compactHomePath(resolveScoutAppRoot()) ?? resolveScoutAppRoot();
    } catch {
      return "Unavailable";
    }
  })();
  const workspaceRoot = (() => {
    try {
      return compactHomePath(resolveScoutWorkspaceRoot()) ?? resolveScoutWorkspaceRoot();
    } catch {
      return "Unavailable";
    }
  })();

  const bunPath = resolveToolPath("bun");
  const nodePath = resolveToolPath("node");
  const npmPath = resolveToolPath("npm");
  const scoutPath = resolveToolPath("scout");

  const sections: ScoutDesktopFeedbackSection[] = [
    {
      id: "app",
      title: "App",
      entries: [
        { label: "Mode", value: appModeLabel() },
        { label: "Version", value: appVersionLabel() ?? runtimeVersionLabel() ?? "Unavailable" },
        { label: "App Root", value: appRoot },
        { label: "Workspace Root", value: workspaceRoot },
        { label: "Current Directory", value: compactHomePath(currentDirectory) ?? currentDirectory },
      ],
    },
    {
      id: "tooling",
      title: "Tooling",
      entries: [
        { label: "bun", value: bunPath ? `${compactHomePath(bunPath) ?? bunPath} (${resolveToolVersion("bun") ?? "version unavailable"})` : "Not found on PATH" },
        { label: "node", value: nodePath ? `${compactHomePath(nodePath) ?? nodePath} (${resolveToolVersion("node") ?? "version unavailable"})` : "Not found on PATH" },
        { label: "npm", value: npmPath ? `${compactHomePath(npmPath) ?? npmPath} (${resolveToolVersion("npm") ?? "version unavailable"})` : "Not found on PATH" },
        { label: "scout", value: scoutPath ? `${compactHomePath(scoutPath) ?? scoutPath} (${resolveToolVersion("scout", ["version"]) ?? "version unavailable"})` : "Not found on PATH" },
      ],
    },
    {
      id: "support",
      title: "OpenScout Support",
      entries: [
        { label: "Support Directory", value: compactHomePath(supportPaths.supportDirectory) ?? supportPaths.supportDirectory },
        { label: "Settings", value: compactHomePath(supportPaths.settingsPath) ?? supportPaths.settingsPath },
        { label: "Agent Registry", value: compactHomePath(supportPaths.relayAgentsRegistryPath) ?? supportPaths.relayAgentsRegistryPath },
        { label: "Harness Catalog", value: compactHomePath(supportPaths.harnessCatalogPath) ?? supportPaths.harnessCatalogPath },
        { label: "Relay Hub", value: compactHomePath(supportPaths.relayHubDirectory) ?? supportPaths.relayHubDirectory },
        { label: "Control Home", value: compactHomePath(supportPaths.controlHome) ?? supportPaths.controlHome },
      ],
    },
    {
      id: "onboarding",
      title: "Onboarding",
      entries: [
        { label: "Needed", value: yesNo(appSettings.onboarding.needed) },
        { label: "Title", value: appSettings.onboarding.title },
        { label: "Detail", value: appSettings.onboarding.detail },
        { label: "Context Root", value: (compactHomePath(appSettings.onboardingContextRoot) ?? appSettings.onboardingContextRoot) || "Unset" },
        { label: "Workspace Roots", value: joinValues(appSettings.workspaceRoots.map((root) => compactHomePath(root) ?? root)) },
        { label: "Current Project Config", value: compactHomePath(appSettings.currentProjectConfigPath) ?? appSettings.currentProjectConfigPath ?? "None" },
      ],
    },
    {
      id: "pairing",
      title: "Pairing",
      entries: [
        { label: "Status", value: pairingState.statusLabel },
        { label: "Detail", value: pairingState.statusDetail ?? "None" },
        { label: "Running", value: yesNo(pairingState.isRunning) },
        { label: "Relay", value: pairingState.pairing?.relay ?? pairingState.relay ?? "Not set" },
        { label: "Workspace Root", value: compactHomePath(pairingState.workspaceRoot) ?? pairingState.workspaceRoot ?? "Not set" },
        { label: "Command", value: pairingState.commandLabel },
        { label: "Config", value: compactHomePath(pairingState.configPath) ?? pairingState.configPath },
        { label: "Identity", value: compactHomePath(pairingState.identityPath) ?? pairingState.identityPath },
        { label: "Trusted Peers", value: compactHomePath(pairingState.trustedPeersPath) ?? pairingState.trustedPeersPath },
        { label: "Log", value: compactHomePath(pairingState.logPath) ?? pairingState.logPath },
      ],
    },
    {
      id: "broker",
      title: "Relay Service",
      entries: [
        { label: "Status", value: brokerInspector.statusLabel },
        { label: "Detail", value: brokerInspector.statusDetail ?? "None" },
        { label: "Reachable", value: yesNo(brokerInspector.reachable) },
        { label: "URL", value: brokerInspector.url },
        { label: "Broker Socket", value: brokerInspector.brokerSocketPath },
        { label: "Health Transport", value: brokerInspector.healthTransport ?? "Unknown" },
        { label: "Socket Fallback", value: brokerInspector.socketFallbackError ?? "None" },
        { label: "LaunchAgent", value: brokerInspector.launchAgentPath },
        { label: "Bootout", value: brokerInspector.bootoutCommand },
        { label: "stdout", value: brokerInspector.stdoutLogPath },
        { label: "stderr", value: brokerInspector.stderrLogPath },
        { label: "Summary", value: brokerInspector.feedbackSummary },
      ],
    },
  ];

  return {
    generatedAt,
    generatedAtLabel: generatedAt.replace("T", " ").replace("Z", " UTC"),
    sections,
    text: serializeFeedbackSections(sections),
  };
}

type TalkieCompatibleReport = {
  id: string;
  timestamp: string;
  system: {
    os: string;
    osVersion: string;
    chip: string;
    memory: string;
    locale?: string;
  };
  apps: Record<string, {
    running: boolean;
    pid?: number;
    version?: string;
  }>;
  context: {
    source: string;
    connectionState?: string;
    lastError?: string;
    userDescription?: string;
    reportSections?: ScoutDesktopFeedbackSection[];
    generatedAt?: string;
    generatedAtLabel?: string;
    currentDirectory?: string;
  };
  logs: string[];
  performance?: Record<string, string>;
};

export async function submitScoutDesktopFeedbackReport(
  input: SubmitScoutFeedbackReportInput,
  currentDirectory = process.cwd(),
): Promise<ScoutDesktopFeedbackSubmission> {
  const message = input.message.trim();
  if (message.length === 0) {
    throw new Error("Feedback message is required.");
  }

  const bundle = await getScoutDesktopFeedbackBundle(currentDirectory);
  const pairingState = await getScoutDesktopPairingState(currentDirectory);
  const brokerInspector = await getScoutDesktopBrokerInspector();
  const endpoint = resolveScoutFeedbackReportUrl();
  const reportId = randomUUID();
  const report: TalkieCompatibleReport = {
    id: reportId,
    timestamp: bundle.generatedAt,
    system: {
      os: detectSystemLabel(),
      osVersion: typeof os.version === "function" ? os.version() : os.release(),
      chip: os.cpus()[0]?.model ?? os.arch(),
      memory: formatMemoryLabel(os.totalmem()),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
    },
    apps: {
      "Scout Desktop": {
        running: true,
        pid: process.pid,
        version: appVersionLabel() ?? runtimeVersionLabel() ?? undefined,
      },
      "OpenScout Relay": {
        running: brokerInspector.reachable,
        pid: parseOptionalInteger(brokerInspector.pid),
        version: brokerInspector.version ?? undefined,
      },
      "Scout Pairing": {
        running: pairingState.isRunning,
      },
    },
    context: {
      source: "Scout Desktop",
      connectionState: `Pairing: ${pairingState.statusLabel}; Relay: ${brokerInspector.statusLabel}`,
      lastError: !brokerInspector.reachable
        ? brokerInspector.statusDetail ?? undefined
        : (!pairingState.isRunning ? pairingState.statusDetail ?? undefined : undefined),
      userDescription: message,
      reportSections: bundle.sections,
      generatedAt: bundle.generatedAt,
      generatedAtLabel: bundle.generatedAtLabel,
      currentDirectory: compactHomePath(currentDirectory) ?? currentDirectory,
    },
    logs: bundle.text.split("\n"),
    performance: {
      "Bundle Generated": bundle.generatedAtLabel,
      "Section Count": String(bundle.sections.length),
      "Relay Reachable": brokerInspector.reachable ? "Yes" : "No",
      "Pairing Running": pairingState.isRunning ? "Yes" : "No",
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(report),
  });

  const payload = await response.json().catch(() => null) as
    | { success?: boolean; id?: string; key?: string; adminUrl?: string; error?: string }
    | null;

  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error || `Feedback submission failed (${response.status}).`);
  }

  return {
    id: payload.id ?? reportId,
    key: payload.key ?? (payload.id ?? reportId).slice(0, 8),
    endpoint,
    adminUrl: payload.adminUrl ?? resolveScoutFeedbackAdminUrl(endpoint, payload.id ?? reportId),
  };
}
