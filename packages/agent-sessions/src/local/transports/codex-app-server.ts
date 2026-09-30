import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildScoutMcpCodexLaunchArgs } from "../../codex-launch-config.js";
import { resolveCodexExecutable } from "../../codex-executable.js";
import { redactSecrets } from "../../secret-redaction.js";
import {
  connectCodexAppServerSocket,
  defaultCodexAppServerControlSocketPath,
  readCodexAppServerDaemonVersion,
  resolveCodexAppServerConnectionConfig,
  spawnCodexAppServerStdioConnection,
  type CodexAppServerConnection,
  type CodexAppServerConnectionClose,
  type CodexAppServerConnectionConfig,
  type CodexAppServerConnectionHandlers,
  type CodexAppServerConnectionMode,
  type CodexAppServerDaemonVersion,
} from "./codex-app-server-connection.js";

export {
  defaultCodexAppServerControlSocketPath,
  type CodexAppServerConnectionConfig,
  type CodexAppServerConnectionMode,
} from "./codex-app-server-connection.js";

export type CodexAppServerApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";
export type CodexAppServerSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexAppServerRequest = {
  id: string | number;
  method: string;
  params?: unknown;
};

export type CodexAppServerResponse = {
  id: string | number;
  result?: unknown;
  error?: {
    message?: string;
    code?: string | number;
    data?: unknown;
  };
};

export type CodexAppServerNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type CodexAppServerServerRequest = {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type CodexErrorResponse = {
  code: number;
  message: string;
  data?: unknown;
};

type ThreadStartResult = {
  thread: {
    id: string;
    path?: string | null;
    cwd?: string | null;
    name?: string | null;
  };
};

type ThreadResumeResult = ThreadStartResult;

type TurnStartResult = {
  turn: {
    id: string;
  };
};

type TurnCompletedParams = {
  threadId: string;
  turn: {
    id: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    error?: {
      message?: string;
      additionalDetails?: string | null;
    } | null;
  };
};

export type CodexAppServerClientInfo = {
  name: string;
  title: string;
  version: string;
};

export type CodexAppServerSessionOptions = {
  agentName: string;
  sessionId: string;
  cwd: string;
  systemPrompt: string;
  runtimeDirectory: string;
  logsDirectory: string;
  env?: Record<string, string | undefined>;
  /** Final child-process environment. When omitted, process.env plus env overrides is used. */
  processEnv?: Record<string, string | undefined>;
  launchArgs?: string[];
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  threadId?: string;
  requireExistingThread?: boolean;
  clientInfo?: CodexAppServerClientInfo;
  /** Called with each agent-message delta as the active turn streams. */
  onDelta?: (delta: string) => void;
  /** Optional owner lifetime; checked before launching or starting a turn. */
  signal?: AbortSignal;
  /**
   * Which app-server to talk to. Default `{ mode: "spawn" }`: Scout launches
   * and owns a private `codex app-server`. `{ mode: "attach" }` connects to an
   * app-server that is already running (the Codex daemon control socket);
   * Scout never stops or restarts that server.
   */
  connection?: CodexAppServerConnectionConfig;
  /** Optional title set with `thread/name/set` when Scout starts a new thread. */
  threadName?: string;
};

/**
 * Which Codex this session is talking to. Captured from `initialize` and, for
 * attached servers, `codex app-server daemon version`.
 */
export type CodexAppServerIdentity = {
  connection: CodexAppServerConnectionMode;
  socketPath: string | null;
  pid: number | null;
  userAgent: string | null;
  appServerVersion: string | null;
  codexHome: string | null;
  platformOs: string | null;
  /** Scout-side features that do not apply to this server. */
  capabilityGaps: string[];
  connectedAt: number;
};

/**
 * Attached servers were launched by someone else: Scout cannot add its MCP
 * server, launch args, or process environment (including CODEX_HOME).
 */
export const CODEX_ATTACHED_CAPABILITY_GAPS = [
  "scout_mcp_injection",
  "launch_args",
  "process_env",
] as const;

type InitializeResult = {
  userAgent?: string;
  codexHome?: string;
  platformOs?: string;
};

function codexVersionFromUserAgent(userAgent: string | null): string | null {
  const match = userAgent?.match(/\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
  return match?.[1] ?? null;
}

export function buildCodexAppServerIdentity(input: {
  connection: Pick<CodexAppServerConnection, "mode" | "pid" | "socketPath">;
  initialized: InitializeResult | null | undefined;
  daemon?: CodexAppServerDaemonVersion | null;
  now?: number;
}): CodexAppServerIdentity {
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  const userAgent = text(input.initialized?.userAgent);
  // Only trust the daemon's version when it describes the socket we attached to.
  const daemonMatches = Boolean(
    input.daemon
      && input.connection.socketPath
      && input.daemon.socketPath === input.connection.socketPath,
  );
  return {
    connection: input.connection.mode,
    socketPath: input.connection.socketPath,
    pid: input.connection.pid,
    userAgent,
    appServerVersion: (daemonMatches ? input.daemon?.appServerVersion : null) ?? codexVersionFromUserAgent(userAgent),
    codexHome: text(input.initialized?.codexHome),
    platformOs: text(input.initialized?.platformOs),
    capabilityGaps: input.connection.mode === "attached" ? [...CODEX_ATTACHED_CAPABILITY_GAPS] : [],
    connectedAt: input.now ?? Date.now(),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export type CodexAppServerInvocationOptions = CodexAppServerSessionOptions & {
  prompt: string;
  timeoutMs?: number;
};

export type CodexAppServerSteerOptions = CodexAppServerSessionOptions & {
  prompt: string;
};

export type CodexAppServerInterruptOptions = CodexAppServerSessionOptions;

export type CodexAppServerShutdownOptions = {
  resetThread?: boolean;
  reason?: string;
};

export type CodexAppServerTurnResult = {
  output: string;
  threadId: string;
  /** Which Codex answered: attached vs Scout-spawned, socket, version, home. */
  codexAppServer?: CodexAppServerIdentity | null;
};

export type CodexAppServerTurnStartResult = {
  threadId: string;
  turnId: string;
};

export type CodexAppServerThreadResult = {
  threadId: string;
  durableThreadId: string | null;
  codexAppServer?: CodexAppServerIdentity | null;
};

export type CodexAppServerExitKind =
  | "proactive_shutdown"
  | "external_sigterm"
  | "unexpected_exit";

export class CodexAppServerExitError extends Error {
  readonly code = "CODEX_APP_SERVER_EXIT";

  readonly exitKind: CodexAppServerExitKind;

  readonly agentName: string;

  readonly exitCode: number | null;

  readonly signal: string | null;

  readonly reason: string | null;

  readonly noteworthy: boolean;

  constructor(input: {
    agentName: string;
    exitKind?: CodexAppServerExitKind;
    exitCode: number | null;
    signal: string | null;
    reason?: string | null;
  }) {
    const exitKind: CodexAppServerExitKind = input.exitKind ?? (input.signal === "SIGTERM" || input.exitCode === 143
      ? "external_sigterm"
      : "unexpected_exit");
    super(codexAppServerExitMessage({
      ...input,
      exitKind,
    }));
    this.name = "CodexAppServerExitError";
    this.exitKind = exitKind;
    this.agentName = input.agentName;
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.reason = input.reason ?? null;
    this.noteworthy = exitKind !== "unexpected_exit";
  }
}

export function isCodexAppServerExitError(error: unknown): error is CodexAppServerExitError {
  return error instanceof CodexAppServerExitError
    || Boolean(
      error
        && typeof error === "object"
        && (error as { code?: unknown }).code === "CODEX_APP_SERVER_EXIT",
    );
}

export class CodexAppServerRequesterTimeoutError extends Error {
  readonly code = "REQUESTER_WAIT_TIMEOUT";
  readonly timeoutMs: number;
  readonly label: string;

  constructor(input: { label: string; timeoutMs: number }) {
    super(`Timed out after ${input.timeoutMs}ms waiting for ${input.label}.`);
    this.name = "RequesterWaitTimeoutError";
    this.label = input.label;
    this.timeoutMs = input.timeoutMs;
  }
}

export class CodexThreadHeldExternallyError extends Error {
  readonly code = "CODEX_THREAD_HELD_EXTERNALLY";
  readonly threadId: string;
  readonly agentName: string;

  constructor(input: { agentName: string; threadId: string; detail?: string | null }) {
    super(
      `Codex thread ${input.threadId} is open in another application`
        + (input.detail ? ` (${input.detail})` : "")
        + "; it will accept turns once that application releases it.",
    );
    this.name = "CodexThreadHeldExternallyError";
    this.threadId = input.threadId;
    this.agentName = input.agentName;
  }
}

export function isCodexThreadHeldExternallyError(error: unknown): error is CodexThreadHeldExternallyError {
  return error instanceof CodexThreadHeldExternallyError
    || Boolean(
      error
        && typeof error === "object"
        && (error as { code?: unknown }).code === "CODEX_THREAD_HELD_EXTERNALLY",
    );
}

function codexAppServerExitMessage(input: {
  agentName: string;
  exitKind: CodexAppServerExitKind;
  exitCode: number | null;
  signal: string | null;
  reason?: string | null;
}): string {
  if (input.exitKind === "proactive_shutdown") {
    return `Codex app-server session for ${input.agentName} was stopped by OpenScout`
      + (input.reason ? `: ${input.reason}` : "")
      + ".";
  }

  if (input.exitKind === "external_sigterm") {
    return `Codex app-server for ${input.agentName} was interrupted by SIGTERM.`;
  }

  return `Codex app-server exited for ${input.agentName}`
    + (input.exitCode !== null ? ` with code ${input.exitCode}` : "")
    + (input.signal ? ` (${input.signal})` : "");
}

function normalizeCodexModelValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower === "6" || lower === "gpt-6" || lower === "astra") {
    return "gpt-6-astra";
  }
  if (lower === "5.6" || lower === "gpt-5.6") {
    return "gpt-5.6-sol";
  }

  // Scout route labels document shorthand such as `@agent#codex?5.5`.
  // Codex app-server expects the full model id, e.g. `gpt-5.5`.
  if (/^\d+(?:\.\d+)*(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(trimmed)) {
    return `gpt-${trimmed}`;
  }

  return trimmed;
}

function normalizeCodexReasoningEffortValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function encodeCodexModelConfig(model: string): string {
  return `model=${JSON.stringify(model)}`;
}

function encodeCodexReasoningEffortConfig(reasoningEffort: string): string {
  return `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`;
}

function parseCodexConfigValue(value: string | null | undefined, expectedKey: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  if (key !== expectedKey) {
    return null;
  }

  const rawValue = trimmed.slice(separatorIndex + 1).trim();
  if (!rawValue) {
    return null;
  }

  if (
    (rawValue.startsWith("\"") && rawValue.endsWith("\""))
    || (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1) || null;
  }

  return rawValue;
}

function parseCodexModelConfig(value: string | null | undefined): string | null {
  return normalizeCodexModelValue(parseCodexConfigValue(value, "model"));
}

function parseCodexReasoningEffortConfig(value: string | null | undefined): string | null {
  return parseCodexConfigValue(value, "model_reasoning_effort");
}

export function normalizeCodexAppServerLaunchArgs(launchArgs?: string[]): string[] {
  const args = Array.isArray(launchArgs)
    ? launchArgs.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  const normalized: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index] ?? "";
    if (current === "--model" || current === "-m") {
      const model = normalizeCodexModelValue(args[index + 1]);
      if (model) {
        normalized.push("-c", encodeCodexModelConfig(model));
        index += 1;
        continue;
      }
      normalized.push(current);
      continue;
    }

    if (current.startsWith("--model=")) {
      const model = normalizeCodexModelValue(current.slice("--model=".length));
      if (model) {
        normalized.push("-c", encodeCodexModelConfig(model));
        continue;
      }
    }

    if (current.startsWith("-m=")) {
      const model = normalizeCodexModelValue(current.slice(3));
      if (model) {
        normalized.push("-c", encodeCodexModelConfig(model));
        continue;
      }
    }

    if (current === "--reasoning-effort" || current === "--effort") {
      const reasoningEffort = normalizeCodexReasoningEffortValue(args[index + 1]);
      if (reasoningEffort) {
        normalized.push("-c", encodeCodexReasoningEffortConfig(reasoningEffort));
        index += 1;
        continue;
      }
      normalized.push(current);
      continue;
    }

    if (current.startsWith("--reasoning-effort=")) {
      const reasoningEffort = normalizeCodexReasoningEffortValue(current.slice("--reasoning-effort=".length));
      if (reasoningEffort) {
        normalized.push("-c", encodeCodexReasoningEffortConfig(reasoningEffort));
        continue;
      }
    }

    if (current.startsWith("--effort=")) {
      const reasoningEffort = normalizeCodexReasoningEffortValue(current.slice("--effort=".length));
      if (reasoningEffort) {
        normalized.push("-c", encodeCodexReasoningEffortConfig(reasoningEffort));
        continue;
      }
    }

    if (current === "-c" || current === "--config") {
      const next = args[index + 1];
      if (typeof next === "string") {
        const model = parseCodexModelConfig(next);
        const reasoningEffort = parseCodexReasoningEffortConfig(next);
        normalized.push(
          current === "--config" ? "--config" : "-c",
          model
            ? encodeCodexModelConfig(model)
            : reasoningEffort
              ? encodeCodexReasoningEffortConfig(reasoningEffort)
              : next,
        );
        index += 1;
        continue;
      }
    }

    if (current.startsWith("--config=")) {
      const value = current.slice("--config=".length);
      const model = parseCodexModelConfig(value);
      const reasoningEffort = parseCodexReasoningEffortConfig(value);
      normalized.push(
        model
          ? `--config=${encodeCodexModelConfig(model)}`
          : reasoningEffort
            ? `--config=${encodeCodexReasoningEffortConfig(reasoningEffort)}`
            : current,
      );
      continue;
    }

    normalized.push(current);
  }

  return normalized;
}

export function readCodexAppServerModelFromLaunchArgs(launchArgs?: string[]): string | null {
  const normalized = normalizeCodexAppServerLaunchArgs(launchArgs);

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index] ?? "";
    if (current === "-c" || current === "--config") {
      const model = parseCodexModelConfig(normalized[index + 1]);
      if (model) {
        return model;
      }
      index += 1;
      continue;
    }

    if (current.startsWith("--config=")) {
      const model = parseCodexModelConfig(current.slice("--config=".length));
      if (model) {
        return model;
      }
    }
  }

  return null;
}

export function readCodexAppServerReasoningEffortFromLaunchArgs(launchArgs?: string[]): string | null {
  const normalized = normalizeCodexAppServerLaunchArgs(launchArgs);

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index] ?? "";
    if (current === "-c" || current === "--config") {
      const reasoningEffort = parseCodexReasoningEffortConfig(normalized[index + 1]);
      if (reasoningEffort) {
        return reasoningEffort;
      }
      index += 1;
      continue;
    }

    if (current.startsWith("--config=")) {
      const reasoningEffort = parseCodexReasoningEffortConfig(current.slice("--config=".length));
      if (reasoningEffort) {
        return reasoningEffort;
      }
    }
  }

  return null;
}

function resolveRequesterTimeoutMs(timeoutMs: number | undefined): number | null {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }

  return null;
}

function waitForRequesterResult<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  const effectiveTimeoutMs = resolveRequesterTimeoutMs(timeoutMs);
  if (effectiveTimeoutMs === null) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CodexAppServerRequesterTimeoutError({ label, timeoutMs: effectiveTimeoutMs }));
    }, effectiveTimeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function metadataRecord(metadata: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeEnvironmentOverrides(env: Record<string, string | undefined> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!env) {
    return normalized;
  }

  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }

  return normalized;
}

function mergeEnvironmentOverrides(
  baseEnv: Record<string, string | undefined>,
  overrides: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...baseEnv };
  if (!overrides) {
    return merged;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      merged[key] = value;
    } else {
      delete merged[key];
    }
  }

  return merged;
}

function parseJsonLine(line: string): CodexAppServerResponse | CodexAppServerNotification | CodexAppServerServerRequest | null {
  try {
    return JSON.parse(line) as CodexAppServerResponse | CodexAppServerNotification | CodexAppServerServerRequest;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const trimmed = raw.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

async function assertCodexWorkingDirectory(cwd: string, agentName: string): Promise<void> {
  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Codex app-server cwd is not a directory for ${agentName}: ${cwd}`);
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`Codex app-server cwd does not exist for ${agentName}: ${cwd}`);
    }
    throw error;
  }
}

function buildUnsupportedServerRequestError(message: CodexAppServerServerRequest): CodexErrorResponse {
  if (message.method === "item/tool/call") {
    const tool = typeof message.params?.tool === "string" ? message.params.tool : null;
    const toolLabel = tool ? `dynamic tool call \`${tool}\`` : "dynamic tool call";
    return {
      code: -32000,
      message: `${toolLabel} is not supported by openscout-runtime`,
    };
  }

  return {
    code: -32000,
    message: `Unsupported server request: ${message.method}`,
  };
}

function isResponse(message: unknown): message is CodexAppServerResponse {
  return Boolean(
    message
    && typeof message === "object"
    && "id" in message
    && ("result" in message || "error" in message),
  );
}

function isServerRequest(message: unknown): message is CodexAppServerServerRequest {
  return Boolean(
    message
    && typeof message === "object"
    && "id" in message
    && "method" in message
    && !("result" in message)
    && !("error" in message),
  );
}

function isNotification(message: unknown): message is CodexAppServerNotification {
  return Boolean(
    message
    && typeof message === "object"
    && "method" in message
    && !("id" in message),
  );
}

type CodexSessionCatalogEntry = {
  id: string;
  startedAt: number;
  endedAt?: number;
  cwd: string;
  harness?: string;
  transport?: string;
  model?: string | null;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
};

type CodexSessionCatalog = {
  activeSessionId: string | null;
  sessions: CodexSessionCatalogEntry[];
};

const SESSION_CATALOG_FILENAME = "session-catalog.json";
const SESSION_CATALOG_MAX_ENTRIES = 64;

function parseCodexMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

async function readCodexSessionCatalog(runtimeDirectory: string): Promise<CodexSessionCatalog> {
  const raw = await readOptionalFile(join(runtimeDirectory, SESSION_CATALOG_FILENAME));
  if (!raw) {
    return { activeSessionId: null, sessions: [] };
  }

  const parsed = parseCodexMaybeJson(raw) as Partial<CodexSessionCatalog> | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { activeSessionId: null, sessions: [] };
  }

  return {
    activeSessionId: typeof parsed.activeSessionId === "string" ? parsed.activeSessionId : null,
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter((entry): entry is CodexSessionCatalogEntry => (
      Boolean(entry)
      && typeof entry === "object"
      && typeof (entry as CodexSessionCatalogEntry).id === "string"
      && typeof (entry as CodexSessionCatalogEntry).startedAt === "number"
      && typeof (entry as CodexSessionCatalogEntry).cwd === "string"
    )) : [],
  };
}

async function writeCodexSessionCatalog(runtimeDirectory: string, catalog: CodexSessionCatalog): Promise<void> {
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(join(runtimeDirectory, SESSION_CATALOG_FILENAME), JSON.stringify(catalog, null, 2) + "\n");
}

async function recordCodexSessionCatalog(
  runtimeDirectory: string,
  threadId: string,
  input: {
    cwd: string;
    harness: string;
    transport: string;
    model: string | null;
    approvalPolicy: CodexAppServerApprovalPolicy;
    sandbox: CodexAppServerSandboxMode;
  },
): Promise<void> {
  const catalog = await readCodexSessionCatalog(runtimeDirectory);
  const now = Date.now();
  const sessions = catalog.sessions.map((session) =>
    session.id === catalog.activeSessionId && session.id !== threadId && !session.endedAt
      ? { ...session, endedAt: now }
      : session
  );

  if (!sessions.some((session) => session.id === threadId)) {
    sessions.push({
      id: threadId,
      startedAt: now,
      cwd: input.cwd,
      harness: input.harness,
      transport: input.transport,
      model: input.model,
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox,
    });
  }

  while (sessions.length > SESSION_CATALOG_MAX_ENTRIES) {
    sessions.shift();
  }

  await writeCodexSessionCatalog(runtimeDirectory, {
    activeSessionId: threadId,
    sessions,
  });
}

async function closeCodexSessionCatalog(runtimeDirectory: string, threadId: string | null): Promise<void> {
  if (!threadId) {
    return;
  }
  const catalog = await readCodexSessionCatalog(runtimeDirectory);
  if (catalog.activeSessionId !== threadId) {
    return;
  }
  const activeSessionId = threadId;
  const now = Date.now();
  const sessions = catalog.sessions.map((session) =>
    session.id === activeSessionId && !session.endedAt
      ? { ...session, endedAt: now }
      : session
  );
  await writeCodexSessionCatalog(runtimeDirectory, {
    activeSessionId: null,
    sessions,
  });
}

function isMissingCodexRolloutError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("no rollout found for thread id");
}

function isCodexThreadWriterConflictError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("already has an active writer")
    || message.includes("thread-store conflict");
}

type ProactiveCodexAppServerShutdown = {
  reason: string;
};

export class CodexAppServerTransport {
  private readonly threadIdPath: string;
  private readonly statePath: string;
  private readonly stdoutLogPath: string;
  private readonly stderrLogPath: string;

  private connection: CodexAppServerConnection | null = null;
  private serverIdentity: CodexAppServerIdentity | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  private starting: Promise<void> | null = null;
  private threadPersistence: Promise<void> = Promise.resolve();
  private threadId: string | null = null;
  private threadPath: string | null = null;
  private durableThreadId: string | null = null;
  private proactiveShutdown: ProactiveCodexAppServerShutdown | null = null;
  private lastConfigSignature: string;
  private readonly notificationListeners = new Set<(message: CodexAppServerNotification) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  constructor(private options: CodexAppServerSessionOptions) {
    this.threadIdPath = join(options.runtimeDirectory, "codex-thread-id.txt");
    this.statePath = join(options.runtimeDirectory, "state.json");
    this.stdoutLogPath = join(options.logsDirectory, "stdout.log");
    this.stderrLogPath = join(options.logsDirectory, "stderr.log");
    this.lastConfigSignature = this.configSignature(options);
  }

  get currentThreadId(): string | null {
    return this.threadId;
  }

  get currentThreadPath(): string | null {
    return this.threadPath;
  }

  get currentDurableThreadId(): string | null {
    return this.durableThreadId;
  }

  get stdoutLogFile(): string {
    return this.stdoutLogPath;
  }

  get stderrLogFile(): string {
    return this.stderrLogPath;
  }

  get pid(): number | null {
    return this.connection?.pid ?? null;
  }

  get identity(): CodexAppServerIdentity | null {
    return this.serverIdentity;
  }

  private get connectionConfig() {
    return resolveCodexAppServerConnectionConfig(this.options.connection);
  }

  get sessionOptions(): CodexAppServerSessionOptions {
    return this.options;
  }

  matches(options: CodexAppServerSessionOptions): boolean {
    return this.lastConfigSignature === this.configSignature(options);
  }

  update(options: CodexAppServerSessionOptions): void {
    this.options = options;
    this.lastConfigSignature = this.configSignature(options);
  }

  onNotification(listener: (message: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  isAlive(): boolean {
    return Boolean(this.connection?.isOpen());
  }

  async ensureOnline(): Promise<CodexAppServerThreadResult> {
    await this.ensureStarted();
    if (!this.threadId) {
      throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
    }

    return {
      threadId: this.threadId,
      durableThreadId: this.durableThreadId,
      codexAppServer: this.serverIdentity,
    };
  }

  async startTurn(prompt: string): Promise<TurnStartResult> {
    await this.ensureStarted();
    if (!this.threadId) {
      throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
    }

    const response = await this.request<TurnStartResult>("turn/start", {
      threadId: this.threadId,
      cwd: this.options.cwd,
      input: this.textInput(prompt),
      ...this.attachedRuntimeParams({ includeEffort: true }),
    });
    await this.persistThreadId();
    return response;
  }

  async steerTurn(prompt: string, expectedTurnId: string): Promise<void> {
    await this.ensureStarted();
    if (!this.threadId) {
      throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
    }

    await this.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId,
      input: this.textInput(prompt),
    });
  }

  async interruptTurn(turnId: string): Promise<void> {
    await this.ensureStarted();
    if (!this.threadId) {
      return;
    }

    await this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId,
    });
  }

  async shutdown(options: CodexAppServerShutdownOptions = {}): Promise<void> {
    await this.leaveAttachedThread();
    this.proactiveShutdown = {
      reason: options.reason
        ?? (options.resetThread ? "OpenScout reset the app-server session" : "OpenScout stopped the app-server session"),
    };
    const stoppedError = new CodexAppServerExitError({
      agentName: this.options.agentName,
      exitKind: "proactive_shutdown",
      exitCode: null,
      signal: null,
      reason: this.proactiveShutdown.reason,
    });

    for (const pending of this.pendingRequests.values()) {
      pending.reject(stoppedError);
    }
    this.pendingRequests.clear();

    const connection = this.connection;
    this.connection = null;
    this.starting = null;

    // Spawned: Scout owns the child and terminates it. Attached: close only
    // disconnects; the shared server keeps running.
    await connection?.close();
    await this.threadPersistence;


    if (options.resetThread) {
      await closeCodexSessionCatalog(this.options.runtimeDirectory, this.durableThreadId);
      this.threadId = null;
      this.threadPath = null;
      this.durableThreadId = null;
      await rm(this.threadIdPath, { force: true });
    }

    await this.persistState();
  }

  /**
   * Attached servers were not launched with Scout's `-c model=…` args, so the
   * model and effort ride on the JSON-RPC requests instead. Spawned servers
   * keep today's launch-arg path unchanged.
   */
  private attachedRuntimeParams(options: { includeEffort?: boolean } = {}): Record<string, string> {
    if (this.connectionConfig.mode !== "attach") return {};
    const model = readCodexAppServerModelFromLaunchArgs(this.options.launchArgs);
    const effort = options.includeEffort
      ? readCodexAppServerReasoningEffortFromLaunchArgs(this.options.launchArgs)
      : null;
    return {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
  }

  /** Attached servers outlive Scout: unsubscribe so the server can unload the thread. */
  private async leaveAttachedThread(): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.mode !== "attached" || !connection.isOpen() || !this.threadId) return;
    const threadId = this.threadId;
    try {
      await withTimeout(this.request("thread/unsubscribe", { threadId }), 2_000, "thread/unsubscribe");
    } catch (error) {
      await appendFile(
        this.stderrLogPath,
        `[openscout] failed to unsubscribe attached Codex thread ${threadId}: ${errorMessage(error)}\n`,
      ).catch(() => undefined);
    }
  }

  private textInput(prompt: string): Array<{ type: "text"; text: string; text_elements: never[] }> {
    return [
      {
        type: "text",
        text: prompt,
        text_elements: [],
      },
    ];
  }

  private configSignature(options: CodexAppServerSessionOptions): string {
    return JSON.stringify({
      cwd: options.cwd,
      sessionId: options.sessionId,
      systemPrompt: options.systemPrompt,
      approvalPolicy: options.approvalPolicy ?? "never",
      sandbox: options.sandbox ?? "danger-full-access",
      threadId: options.threadId ?? null,
      requireExistingThread: options.requireExistingThread === true,
      env: normalizeEnvironmentOverrides(options.env),
      launchArgs: normalizeCodexAppServerLaunchArgs(options.launchArgs),
      connection: resolveCodexAppServerConnectionConfig(options.connection),
      threadName: options.threadName?.trim() || null,
    });
  }

  private async ensureStarted(): Promise<void> {
    this.options.signal?.throwIfAborted();
    if (this.isAlive() && this.threadId) {
      return;
    }

    if (this.starting) {
      return this.starting;
    }

    this.starting = this.startSession();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startSession(): Promise<void> {
    await mkdir(this.options.runtimeDirectory, { recursive: true });
    await mkdir(this.options.logsDirectory, { recursive: true });
    await writeFile(join(this.options.runtimeDirectory, "prompt.txt"), this.options.systemPrompt);
    this.proactiveShutdown = null;
    try {
      await assertCodexWorkingDirectory(this.options.cwd, this.options.agentName);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(errorMessage(error));
      await appendFile(this.stderrLogPath, `[openscout] ${failure.message}\n`).catch(() => undefined);
      await this.persistState().catch(() => undefined);
      throw failure;
    }

    this.options.signal?.throwIfAborted();
    const env = this.options.processEnv ?? mergeEnvironmentOverrides(process.env, this.options.env);
    const connectionConfig = this.connectionConfig;
    let connection: CodexAppServerConnection | undefined;
    const handlers = this.connectionHandlers(() => connection);
    let daemonVersion: Promise<CodexAppServerDaemonVersion | null> | null = null;
    if (connectionConfig.mode === "attach") {
      // `codex app-server daemon version` only describes the default control
      // socket, and it is read-only: it never starts or restarts the daemon.
      if (connectionConfig.socketPath === defaultCodexAppServerControlSocketPath()) {
        const executable = (() => {
          try {
            return resolveCodexExecutable();
          } catch {
            return null;
          }
        })();
        daemonVersion = executable ? readCodexAppServerDaemonVersion({ executable, env }) : null;
      }
      connection = await connectCodexAppServerSocket({
        socketPath: connectionConfig.socketPath,
        handlers,
      });
      await appendFile(
        this.stderrLogPath,
        `[openscout] attached to running Codex app-server at ${connectionConfig.socketPath}; Scout will not stop or restart it\n`,
      ).catch(() => undefined);
    } else {
      const launchArgs = normalizeCodexAppServerLaunchArgs(this.options.launchArgs);
      connection = spawnCodexAppServerStdioConnection({
        executable: resolveCodexExecutable(),
        args: [
          "app-server",
          ...buildScoutMcpCodexLaunchArgs({
            currentDirectory: this.options.cwd,
            env,
          }),
          ...launchArgs,
        ],
        cwd: this.options.cwd,
        env,
        handlers,
      });
    }

    this.connection = connection;
    this.serverIdentity = null;

    const clientInfo = this.options.clientInfo ?? {
      name: "openscout-agent-sessions",
      title: "OpenScout Agent Sessions",
      version: "0.0.0",
    };

    const initialized = await this.request<InitializeResult>("initialize", {
      clientInfo,
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
    this.serverIdentity = buildCodexAppServerIdentity({
      connection,
      initialized,
      daemon: daemonVersion ? await daemonVersion : null,
    });

    await this.resumeOrStartThread();
    await this.persistState();
  }

  private async resumeOrStartThread(): Promise<void> {
    const requestedThreadId = this.options.threadId?.trim() || null;
    const storedThreadId = requestedThreadId ?? await readOptionalFile(this.threadIdPath);
    if (storedThreadId) {
      const threadOrigin = requestedThreadId ? "requested" : "stored";
      try {
        const resumed = await this.request<ThreadResumeResult>("thread/resume", {
          threadId: storedThreadId,
          cwd: this.options.cwd,
          approvalPolicy: this.options.approvalPolicy ?? "never",
          sandbox: this.options.sandbox ?? "danger-full-access",
          baseInstructions: this.options.systemPrompt,
          persistExtendedHistory: true,
          ...this.attachedRuntimeParams(),
        });
        this.threadId = resumed.thread.id;
        this.threadPath = resumed.thread.path ?? null;
        await this.persistThreadId({ confirmed: true });
        return;
      } catch (error) {
        await appendFile(
          this.stderrLogPath,
          `[openscout] failed to resume ${threadOrigin} Codex thread ${storedThreadId}: ${errorMessage(error)}\n`,
        ).catch(() => undefined);
        if (!requestedThreadId && isMissingCodexRolloutError(error)) {
          await rm(this.threadIdPath, { force: true }).catch(() => undefined);
          await closeCodexSessionCatalog(this.options.runtimeDirectory, storedThreadId);
          await this.persistState();
        }
        if (requestedThreadId || this.options.requireExistingThread) {
          if (isCodexThreadWriterConflictError(error)) {
            // Single-writer rule: the thread is open in another app-server
            // (typically the Codex desktop app). The session is not gone —
            // callers park delivery and retry when the writer lock releases.
            throw new CodexThreadHeldExternallyError({
              agentName: this.options.agentName,
              threadId: storedThreadId,
              detail: errorMessage(error),
            });
          }
          throw new Error(`Failed to resume ${threadOrigin} Codex thread ${storedThreadId}: ${errorMessage(error)}`);
        }
      }
    }

    if (this.options.requireExistingThread) {
      const detail = requestedThreadId
        ? ` for requested thread ${requestedThreadId}`
        : "";
      throw new Error(`Codex app-server session for ${this.options.agentName} requires an existing thread${detail}.`);
    }

    const started = await this.request<ThreadStartResult>("thread/start", {
      cwd: this.options.cwd,
      approvalPolicy: this.options.approvalPolicy ?? "never",
      sandbox: this.options.sandbox ?? "danger-full-access",
      baseInstructions: this.options.systemPrompt,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      ...this.attachedRuntimeParams(),
      ...(this.connectionConfig.mode === "attach" ? { threadSource: "user" } : {}),
    });
    this.threadId = started.thread.id;
    this.threadPath = started.thread.path ?? null;
    if (this.durableThreadId !== this.threadId) {
      this.durableThreadId = null;
    }
    await this.persistThreadId();
    await this.nameStartedThread(started.thread.id);
  }

  private async nameStartedThread(threadId: string): Promise<void> {
    const name = this.options.threadName?.trim();
    if (!name) return;
    try {
      await this.request("thread/name/set", { threadId, name });
    } catch (error) {
      await appendFile(
        this.stderrLogPath,
        `[openscout] failed to name Codex thread ${threadId}: ${errorMessage(error)}\n`,
      ).catch(() => undefined);
    }
  }

  private catalogRuntimeMeta(): {
    cwd: string;
    harness: string;
    transport: string;
    model: string | null;
    approvalPolicy: CodexAppServerApprovalPolicy;
    sandbox: CodexAppServerSandboxMode;
  } {
    return {
      cwd: this.options.cwd,
      harness: "codex",
      transport: "codex_app_server",
      model: readCodexAppServerModelFromLaunchArgs(this.options.launchArgs),
      approvalPolicy: this.options.approvalPolicy ?? "never",
      sandbox: this.options.sandbox ?? "danger-full-access",
    };
  }

  private connectionHandlers(current: () => CodexAppServerConnection | undefined): CodexAppServerConnectionHandlers {
    return {
      onMessage: (text) => this.handleMessageText(text),
      onStdout: (chunk) => {
        void appendFile(this.stdoutLogPath, redactSecrets(chunk)).catch(() => undefined);
      },
      onStderr: (chunk) => {
        void appendFile(this.stderrLogPath, redactSecrets(chunk)).catch(() => undefined);
      },
      onClose: (close) => this.handleConnectionClose(current(), close),
    };
  }

  private handleConnectionClose(
    connection: CodexAppServerConnection | undefined,
    close: CodexAppServerConnectionClose,
  ): void {
    const proactiveShutdown = this.proactiveShutdown;
    if (proactiveShutdown) {
      this.handleProactiveProcessExit(connection, proactiveShutdown, close.exitCode, close.signal);
      return;
    }
    if (connection?.mode === "attached") {
      this.failSession(new CodexAppServerExitError({
        agentName: this.options.agentName,
        exitKind: "unexpected_exit",
        exitCode: null,
        signal: null,
        reason: close.error?.message ?? null,
      }));
      return;
    }
    if (close.error && close.exitCode === null && close.signal === null) {
      this.failSession(new Error(`Codex app-server failed for ${this.options.agentName}: ${errorMessage(close.error)}`));
      return;
    }
    this.failSession(new CodexAppServerExitError({
      agentName: this.options.agentName,
      exitCode: close.exitCode,
      signal: close.signal,
    }));
  }

  private handleMessageText(line: string): void {
    const message = parseJsonLine(line);
    if (!message) {
      void appendFile(this.stderrLogPath, `[openscout] unparsable app-server output: ${redactSecrets(line)}\n`).catch(() => undefined);
      return;
    }

    if (this.connection?.mode === "attached") {
      void appendFile(this.stdoutLogPath, `${redactSecrets(line)}\n`).catch(() => undefined);
    }

    if (isResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (isServerRequest(message)) {
      this.handleServerRequest(message);
      return;
    }

    if (isNotification(message)) {
      this.handleNotification(message);
    }
  }

  private handleResponse(message: CodexAppServerResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || `Codex app-server request failed: ${String(message.id)}`));
      return;
    }

    pending.resolve(message.result);
  }

  private handleServerRequest(message: CodexAppServerServerRequest): void {
    this.writeMessage({
      id: message.id,
      error: buildUnsupportedServerRequestError(message),
    });
  }

  private handleNotification(message: CodexAppServerNotification): void {
    const method = message.method;
    const params = message.params ?? {};

    if (method === "thread/started" || method === "thread/name/updated") {
      const thread = params.thread as { id?: string; path?: string | null } | undefined;
      if (thread?.id) {
        if (thread.id !== this.threadId) {
          this.durableThreadId = null;
        }
        this.threadId = thread.id;
      }
      if ("path" in (thread ?? {})) {
        this.threadPath = thread?.path ?? null;
      }
      void this.persistThreadId();
    } else if (this.threadId && !this.durableThreadId) {
      void this.persistThreadId();
    }

    this.emitNotification(message);
  }

  private emitNotification(message: CodexAppServerNotification): void {
    for (const listener of this.notificationListeners) {
      listener(message);
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  private failSession(error: Error): void {
    this.connection?.detach();
    this.connection = null;
    this.starting = null;

    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    void appendFile(this.stderrLogPath, `[openscout] ${error.message}\n`).catch(() => undefined);
    void this.persistState().catch(() => undefined);
    this.emitError(error);
  }

  private handleProactiveProcessExit(
    connection: CodexAppServerConnection | undefined,
    shutdown: ProactiveCodexAppServerShutdown,
    code: number | null,
    signal: string | null,
  ): void {
    if (connection && this.connection === connection) {
      this.connection = null;
    }
    this.proactiveShutdown = null;
    this.starting = null;

    const exitDetail = [
      code !== null ? `code ${code}` : null,
      signal,
    ].filter(Boolean).join(", ");
    const detail = exitDetail ? ` (${exitDetail})` : "";
    void appendFile(
      this.stderrLogPath,
      connection?.mode === "attached"
        ? `[openscout] detached from shared Codex app-server for ${this.options.agentName}: ${shutdown.reason}\n`
        : `[openscout] Codex app-server stopped for ${this.options.agentName}: ${shutdown.reason}${detail}\n`,
    ).catch(() => undefined);
    void this.persistState();
  }

  private persistThreadId(options: { confirmed?: boolean } = {}): Promise<void> {
    const persistence = this.threadPersistence.then(() => this.persistThreadIdNow(options));
    this.threadPersistence = persistence.catch(() => undefined);
    return persistence;
  }

  private async persistThreadIdNow(options: { confirmed?: boolean }): Promise<void> {
    const threadId = this.threadId;
    if (!threadId) {
      this.durableThreadId = null;
      await rm(this.threadIdPath, { force: true });
      await this.persistState();
      return;
    }

    let rolloutExists = false;
    if (this.threadPath) {
      try {
        rolloutExists = (await stat(this.threadPath)).isFile();
      } catch {
        rolloutExists = false;
      }
    }

    if (!options.confirmed && !rolloutExists && this.durableThreadId !== threadId) {
      this.durableThreadId = null;
      await rm(this.threadIdPath, { force: true });
      await this.persistState();
      return;
    }

    const becameDurable = this.durableThreadId !== threadId;
    await writeFile(this.threadIdPath, `${threadId}\n`);
    this.durableThreadId = threadId;
    await this.persistState();
    if (becameDurable) {
      await recordCodexSessionCatalog(this.options.runtimeDirectory, threadId, this.catalogRuntimeMeta());
    }
  }

  private async persistState(): Promise<void> {
    const durableThreadPath = this.durableThreadId === this.threadId
      ? this.threadPath
      : null;
    await mkdir(this.options.runtimeDirectory, { recursive: true });
    await writeFile(
      this.statePath,
      JSON.stringify({
        agentId: this.options.agentName,
        transport: "codex_app_server",
        sessionId: this.options.sessionId,
        projectRoot: this.options.cwd,
        cwd: this.options.cwd,
        threadId: this.durableThreadId,
        threadPath: durableThreadPath,
        requestedThreadId: this.options.threadId ?? null,
        requireExistingThread: this.options.requireExistingThread === true,
        pid: this.connection?.pid ?? null,
        codexAppServer: this.serverIdentity,
        stdoutLogFile: this.stdoutLogPath,
        stderrLogFile: this.stderrLogPath,
        updatedAt: new Date().toISOString(),
      }, null, 2) + "\n",
    );
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    const id = String(this.nextRequestId++);

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });

      try {
        this.writeMessage({
          id,
          method,
          params,
        });
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  private writeMessage(message: Record<string, unknown>): void {
    const connection = this.connection;
    if (!connection || !connection.isOpen()) {
      throw new Error(`Codex app-server session for ${this.options.agentName} is not running.`);
    }

    connection.send(JSON.stringify(message));
  }
}

type ActiveTurn = {
  onDelta?: (delta: string) => void;
  turnId: string;
  startedAt: number;
  messageOrder: string[];
  messageByItemId: Map<string, string>;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  watchers: Array<{
    resolve: (output: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }>;
};

export class CodexAppServerClient {
  private readonly transport: CodexAppServerTransport;
  private serialized = Promise.resolve();
  private activeTurn: ActiveTurn | null = null;
  private removeNotificationListener: (() => void) | null = null;
  private removeErrorListener: (() => void) | null = null;

  constructor(private options: CodexAppServerSessionOptions) {
    this.transport = new CodexAppServerTransport(options);
    this.bindTransport();
  }

  get threadId(): string | null {
    return this.transport.currentThreadId;
  }

  get threadPath(): string | null {
    return this.transport.currentThreadPath;
  }

  get stdoutLogFile(): string {
    return this.transport.stdoutLogFile;
  }

  get identity(): CodexAppServerIdentity | null {
    return this.transport.identity;
  }

  get stderrLogFile(): string {
    return this.transport.stderrLogFile;
  }

  matches(options: CodexAppServerSessionOptions): boolean {
    return this.transport.matches(options);
  }

  update(options: CodexAppServerSessionOptions): void {
    this.options = options;
    this.transport.update(options);
  }

  isAlive(): boolean {
    return this.transport.isAlive();
  }

  hasActiveTurn(): boolean {
    return Boolean(this.activeTurn);
  }

  ensureOnline(): Promise<CodexAppServerThreadResult> {
    return this.transport.ensureOnline();
  }

  async invoke(prompt: string, timeoutMs?: number): Promise<CodexAppServerTurnResult> {
    const onDelta = this.options.onDelta;
    const signal = this.options.signal;
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      await this.transport.ensureOnline();
      signal?.throwIfAborted();
      if (!this.transport.currentThreadId) {
        throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
      }

      const outputPromise = new Promise<string>(async (resolve, reject) => {
        const turn = this.createActiveTurn(resolve, reject, onDelta);

        try {
          const response = await this.transport.startTurn(prompt);
          turn.turnId = response.turn.id;
        } catch (error) {
          this.clearActiveTurn(turn);
          reject(error instanceof Error ? error : new Error(errorMessage(error)));
        }
      });
      const output = await waitForRequesterResult(outputPromise, timeoutMs, this.options.agentName);

      return {
        output,
        threadId: this.transport.currentThreadId,
        codexAppServer: this.transport.identity,
      };
    });
  }

  /**
   * Start a turn and return as soon as Codex accepts it. The active-turn
   * tracker remains attached to app-server notifications so later steer,
   * interrupt, and snapshot calls observe the same turn.
   */
  async start(prompt: string): Promise<CodexAppServerTurnStartResult> {
    const onDelta = this.options.onDelta;
    const signal = this.options.signal;
    return this.enqueue(async () => {
      signal?.throwIfAborted();
      await this.transport.ensureOnline();
      signal?.throwIfAborted();
      if (!this.transport.currentThreadId) {
        throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
      }
      if (this.activeTurn) {
        throw new Error(`Codex app-server session for ${this.options.agentName} already has an active turn.`);
      }

      let turn!: ActiveTurn;
      const completion = new Promise<string>((resolve, reject) => {
        turn = this.createActiveTurn(resolve, reject, onDelta);
      });
      // This path intentionally does not await the final reply. Keep the
      // completion promise observed while notifications finish the turn.
      void completion.catch(() => undefined);

      try {
        const response = await this.transport.startTurn(prompt);
        turn.turnId = response.turn.id;
        return {
          threadId: this.transport.currentThreadId,
          turnId: response.turn.id,
        };
      } catch (error) {
        this.clearActiveTurn(turn);
        turn.reject(error instanceof Error ? error : new Error(errorMessage(error)));
        throw error;
      }
    });
  }

  async send(prompt: string, timeoutMs?: number): Promise<CodexAppServerTurnResult> {
    if (this.hasActiveTurn()) {
      return this.steerAndWait(prompt, timeoutMs);
    }
    return this.invoke(prompt, timeoutMs);
  }

  async steerAndWait(prompt: string, timeoutMs?: number): Promise<CodexAppServerTurnResult> {
    await this.transport.ensureOnline();
    if (!this.transport.currentThreadId) {
      throw new Error(`Codex app-server session for ${this.options.agentName} has no active thread.`);
    }

    const activeTurn = this.activeTurn;
    if (!activeTurn?.turnId) {
      return this.invoke(prompt, timeoutMs);
    }

    const output = await new Promise<string>(async (resolve, reject) => {
      const watcher = this.addTurnWatcher(activeTurn, resolve, reject, timeoutMs);
      try {
        await this.transport.steerTurn(prompt, activeTurn.turnId);
      } catch (error) {
        this.removeTurnWatcher(activeTurn, watcher);
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });

    return {
      output,
      threadId: this.transport.currentThreadId,
      codexAppServer: this.transport.identity,
    };
  }

  async steer(prompt: string): Promise<void> {
    await this.transport.ensureOnline();
    if (!this.transport.currentThreadId || !this.activeTurn?.turnId) {
      throw new Error(`Codex app-server session for ${this.options.agentName} has no active turn to steer.`);
    }

    await this.transport.steerTurn(prompt, this.activeTurn.turnId);
  }

  async interrupt(): Promise<void> {
    await this.transport.ensureOnline();
    if (!this.transport.currentThreadId || !this.activeTurn?.turnId) {
      return;
    }

    await this.transport.interruptTurn(this.activeTurn.turnId);
  }

  async shutdown(options: CodexAppServerShutdownOptions = {}): Promise<void> {
    const stoppedError = new CodexAppServerExitError({
      agentName: this.options.agentName,
      exitKind: "proactive_shutdown",
      exitCode: null,
      signal: null,
      reason: options.reason
        ?? (options.resetThread ? "OpenScout reset the app-server session" : "OpenScout stopped the app-server session"),
    });

    const activeTurn = this.activeTurn;
    this.activeTurn = null;
    if (activeTurn) {
      for (const watcher of this.drainTurnWatchers(activeTurn)) {
        watcher.reject(stoppedError);
      }
      activeTurn.reject(stoppedError);
    }

    this.removeNotificationListener?.();
    this.removeNotificationListener = null;
    this.removeErrorListener?.();
    this.removeErrorListener = null;
    await this.transport.shutdown(options);
  }

  private bindTransport(): void {
    this.removeNotificationListener = this.transport.onNotification((message) => this.handleNotification(message));
    this.removeErrorListener = this.transport.onError((error) => this.failActiveTurn(error));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.serialized.then(task, task);
    this.serialized = next.then(() => undefined, () => undefined);
    return next;
  }

  private createActiveTurn(
    resolve: (output: string) => void,
    reject: (error: Error) => void,
    onDelta?: (delta: string) => void,
  ): ActiveTurn {
    if (this.activeTurn) {
      throw new Error(`Codex app-server session for ${this.options.agentName} already has an active turn.`);
    }

    const turn: ActiveTurn = {
      onDelta,
      turnId: "",
      startedAt: Date.now(),
      messageOrder: [],
      messageByItemId: new Map<string, string>(),
      resolve,
      reject,
      watchers: [],
    };

    this.activeTurn = turn;
    return turn;
  }

  private addTurnWatcher(
    turn: ActiveTurn,
    resolve: (output: string) => void,
    reject: (error: Error) => void,
    timeoutMs: number | undefined,
  ): ActiveTurn["watchers"][number] {
    const watcher: ActiveTurn["watchers"][number] = {
      resolve,
      reject,
      timer: null,
    };
    const effectiveTimeoutMs = resolveRequesterTimeoutMs(timeoutMs);
    if (effectiveTimeoutMs !== null) {
      watcher.timer = setTimeout(() => {
        this.removeTurnWatcher(turn, watcher);
        reject(new CodexAppServerRequesterTimeoutError({
          label: this.options.agentName,
          timeoutMs: effectiveTimeoutMs,
        }));
      }, effectiveTimeoutMs);
    }
    turn.watchers.push(watcher);
    return watcher;
  }

  private removeTurnWatcher(turn: ActiveTurn, watcher: ActiveTurn["watchers"][number]): void {
    if (watcher.timer) {
      clearTimeout(watcher.timer);
    }
    turn.watchers = turn.watchers.filter((candidate) => candidate !== watcher);
  }

  private drainTurnWatchers(turn: ActiveTurn): ActiveTurn["watchers"] {
    const watchers = turn.watchers;
    turn.watchers = [];
    for (const watcher of watchers) {
      if (watcher.timer) {
        clearTimeout(watcher.timer);
      }
    }
    return watchers;
  }

  private clearActiveTurn(turn: ActiveTurn): void {
    if (this.activeTurn === turn) {
      this.activeTurn = null;
    }
  }

  private handleNotification(message: CodexAppServerNotification): void {
    const method = message.method;
    const params = message.params ?? {};

    if (method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      if (this.activeTurn && turn?.id && !this.activeTurn.turnId) {
        this.activeTurn.turnId = turn.id;
      }
      return;
    }

    if (method === "item/agentMessage/delta") {
      const turnId = typeof params.turnId === "string" ? params.turnId : null;
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!this.activeTurn || !turnId || !itemId) {
        return;
      }
      if (this.activeTurn.turnId && this.activeTurn.turnId !== turnId) {
        return;
      }
      if (!this.activeTurn.messageByItemId.has(itemId)) {
        this.activeTurn.messageOrder.push(itemId);
        this.activeTurn.messageByItemId.set(itemId, "");
      }
      this.activeTurn.messageByItemId.set(itemId, (this.activeTurn.messageByItemId.get(itemId) ?? "") + delta);
      if (delta) this.activeTurn.onDelta?.(delta);
      return;
    }

    if (method === "item/completed") {
      const turnId = typeof params.turnId === "string" ? params.turnId : null;
      const item = params.item as { type?: string; id?: string; text?: string } | undefined;
      if (!this.activeTurn || !turnId || item?.type !== "agentMessage" || !item.id) {
        return;
      }
      if (this.activeTurn.turnId && this.activeTurn.turnId !== turnId) {
        return;
      }
      if (!this.activeTurn.messageByItemId.has(item.id)) {
        this.activeTurn.messageOrder.push(item.id);
      }
      this.activeTurn.messageByItemId.set(item.id, item.text ?? this.activeTurn.messageByItemId.get(item.id) ?? "");
      return;
    }

    if (method === "turn/completed") {
      this.completeTurn(params as unknown as TurnCompletedParams);
      return;
    }

    if (method === "error") {
      const willRetry = params.willRetry === true;
      if (willRetry) {
        return;
      }
      const errorPayload = metadataRecord(params, "error");
      const messageText = metadataString(errorPayload, "message")
        ?? metadataString(params, "message")
        ?? "Codex app-server reported an error.";
      const codexErrorInfo = metadataString(errorPayload, "codexErrorInfo")
        ?? metadataString(params, "codexErrorInfo");
      const additionalDetails = metadataString(errorPayload, "additionalDetails")
        ?? metadataString(params, "additionalDetails");
      const detail = [codexErrorInfo, additionalDetails]
        .filter((value): value is string => Boolean(value && value.trim().length > 0))
        .join("; ");
      const error = detail.length > 0 ? `${messageText} (${detail})` : messageText;
      if (this.activeTurn) {
        const activeTurn = this.activeTurn;
        this.clearActiveTurn(activeTurn);
        activeTurn.reject(new Error(error));
      }
    }
  }

  private completeTurn(params: TurnCompletedParams): void {
    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return;
    }

    if (activeTurn.turnId && activeTurn.turnId !== params.turn.id) {
      return;
    }

    this.clearActiveTurn(activeTurn);

    if (params.turn.status === "failed") {
      const message = params.turn.error?.message || params.turn.error?.additionalDetails || `Turn failed for ${this.options.agentName}.`;
      for (const watcher of this.drainTurnWatchers(activeTurn)) {
        watcher.reject(new Error(message));
      }
      activeTurn.reject(new Error(message));
      return;
    }

    if (params.turn.status === "interrupted") {
      for (const watcher of this.drainTurnWatchers(activeTurn)) {
        watcher.reject(new Error(`Turn interrupted for ${this.options.agentName}.`));
      }
      activeTurn.reject(new Error(`Turn interrupted for ${this.options.agentName}.`));
      return;
    }

    // Codex can close a turn with a message that repeats an earlier one
    // word for word (a progress note restated as the final answer); the reply
    // carries it once.
    const output = activeTurn.messageOrder
      .map((itemId) => (activeTurn.messageByItemId.get(itemId) ?? "").trim())
      .filter((text, index, all) => text.length > 0 && all.indexOf(text) === index)
      .join("\n\n")
      .trim();

    if (!output) {
      for (const watcher of this.drainTurnWatchers(activeTurn)) {
        watcher.reject(new Error(`Codex completed without producing a final response for ${this.options.agentName}.`));
      }
      activeTurn.reject(new Error(`Codex completed without producing a final response for ${this.options.agentName}.`));
      return;
    }

    for (const watcher of this.drainTurnWatchers(activeTurn)) {
      watcher.resolve(output);
    }
    activeTurn.resolve(output);
  }

  private failActiveTurn(error: Error): void {
    const activeTurn = this.activeTurn;
    this.activeTurn = null;
    if (!activeTurn) {
      return;
    }

    for (const watcher of this.drainTurnWatchers(activeTurn)) {
      watcher.reject(error);
    }
    activeTurn.reject(error);
  }
}

const codexAppServerClients = new Map<string, CodexAppServerClient>();

export function codexAppServerSessionKey(options: Pick<CodexAppServerSessionOptions, "agentName" | "sessionId">): string {
  return `${options.agentName}:${options.sessionId}`;
}

export function getOrCreateCodexAppServerClient(options: CodexAppServerSessionOptions): CodexAppServerClient {
  const key = codexAppServerSessionKey(options);
  const existing = codexAppServerClients.get(key);
  if (existing) {
    if (existing.matches(options)) {
      return existing;
    }

    void existing.shutdown({
      resetThread: true,
      reason: "OpenScout replaced the app-server session after its launch options changed",
    });
    codexAppServerClients.delete(key);
  }

  const session = new CodexAppServerClient(options);
  codexAppServerClients.set(key, session);
  return session;
}

export async function ensureCodexAppServerLocalAgentOnline(
  options: CodexAppServerSessionOptions,
): Promise<CodexAppServerThreadResult> {
  const session = getOrCreateCodexAppServerClient(options);
  session.update(options);
  return session.ensureOnline();
}

export async function invokeCodexAppServerLocalAgent(
  options: CodexAppServerInvocationOptions,
): Promise<CodexAppServerTurnResult> {
  const session = getOrCreateCodexAppServerClient(options);
  session.update(options);
  return session.invoke(options.prompt, options.timeoutMs);
}

export async function startCodexAppServerLocalAgent(
  options: CodexAppServerInvocationOptions,
): Promise<CodexAppServerTurnStartResult> {
  const session = getOrCreateCodexAppServerClient(options);
  session.update(options);
  return session.start(options.prompt);
}

export async function sendCodexAppServerLocalAgent(
  options: CodexAppServerInvocationOptions,
): Promise<CodexAppServerTurnResult> {
  const session = getOrCreateCodexAppServerClient(options);
  session.update(options);
  return session.send(options.prompt, options.timeoutMs);
}

export async function steerCodexAppServerLocalAgent(options: CodexAppServerSteerOptions): Promise<void> {
  const session = getOrCreateCodexAppServerClient(options);
  session.update(options);
  await session.steer(options.prompt);
}

export async function interruptCodexAppServerLocalAgent(options: CodexAppServerInterruptOptions): Promise<void> {
  const key = codexAppServerSessionKey(options);
  const session = codexAppServerClients.get(key);
  if (!session) {
    return;
  }

  session.update(options);
  await session.interrupt();
}

export function isCodexAppServerLocalAgentAlive(options: CodexAppServerSessionOptions): boolean {
  const session = codexAppServerClients.get(codexAppServerSessionKey(options));
  return Boolean(session?.isAlive());
}

export async function shutdownCodexAppServerLocalAgent(
  options: CodexAppServerSessionOptions,
  shutdownOptions: CodexAppServerShutdownOptions = {},
): Promise<void> {
  const key = codexAppServerSessionKey(options);
  const session = codexAppServerClients.get(key);
  if (!session) {
    if (shutdownOptions.resetThread) {
      const threadId = await readOptionalFile(join(options.runtimeDirectory, "codex-thread-id.txt"));
      await closeCodexSessionCatalog(options.runtimeDirectory, threadId);
      await rm(join(options.runtimeDirectory, "codex-thread-id.txt"), { force: true });
    }
    return;
  }

  codexAppServerClients.delete(key);
  await session.shutdown(shutdownOptions);
}
