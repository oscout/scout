import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

import { registerSecretValue } from "@openscout/agent-sessions/secret-redaction";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  StateTracker,
  createPiAdapter,
  type Adapter,
  type AgentSessionStreamEvent,
  type SessionState,
} from "@openscout/agent-sessions";

export type PiRpcSessionRequestOptions = {
  agentName: string;
  sessionId: string;
  cwd: string;
  systemPrompt: string;
  runtimeDirectory: string;
  logsDirectory: string;
  launchArgs: string[];
};

export type PiRpcInvocationOptions = PiRpcSessionRequestOptions & {
  prompt: string;
  timeoutMs?: number;
};

export type PiRpcSessionResult = {
  sessionId: string;
  metadata?: Record<string, unknown>;
};

export type PiRpcInvocationResult = PiRpcSessionResult & {
  output: string;
};

export type PiRpcLaunchOptions = {
  model?: string;
  provider?: string;
  thinking?: string;
  session?: string;
  sessionDir?: string;
  extensions: string[];
  extraArgs: string[];
};

const DEFAULT_PI_RPC_TIMEOUT_MS = 300_000;
const PI_SCOUT_EXTENSION_CANDIDATES = [
  process.env.OPENSCOUT_PI_SCOUT_EXTENSION_PATH,
  join(homedir(), ".pi", "agent", "extensions", "pi-scout"),
  join(homedir(), "dev", "pi-scout"),
].filter((candidate): candidate is string => Boolean(candidate));

const PI_RPC_FLAGS_WITH_VALUES = new Set([
  "--model",
  "--provider",
  "--thinking",
  "--resume",
  "--session",
  "--session-id",
  "--session-dir",
  "--append-system-prompt",
  "--extension",
]);

const PI_RPC_OPTION_KEYS: Record<string, keyof Omit<PiRpcLaunchOptions, "extensions" | "extraArgs">> = {
  "--model": "model",
  "--provider": "provider",
  "--thinking": "thinking",
  "--resume": "session",
  "--session": "session",
  "--session-dir": "sessionDir",
};

const LEGACY_PI_RPC_IGNORED_FLAGS = new Set(["--session-id"]);

type CredentialEnvSource = Record<string, string | undefined>;

type PiRpcCredentialEnvMapping = {
  outputKey: string;
  envKeys: readonly string[];
  secretKeys?: readonly string[];
};

const PI_RPC_CREDENTIAL_ENV: Record<string, readonly PiRpcCredentialEnvMapping[]> = {
  minimax: [{
    outputKey: "MINIMAX_API_KEY",
    envKeys: ["MINIMAX_API_KEY", "MINIMAX_TOKEN"],
    secretKeys: ["MINIMAX_API_KEY"],
  }],
  xai: [{
    outputKey: "XAI_API_KEY",
    envKeys: ["XAI_API_KEY", "SCOUT_XAI_API_KEY"],
    secretKeys: ["XAI_API_KEY", "SCOUT_XAI_API_KEY"],
  }],
};

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readFlagAssignment(value: string): { flag: string; assigned: string } | null {
  const equals = value.indexOf("=");
  if (equals <= 0) {
    return null;
  }
  const flag = value.slice(0, equals);
  if (!PI_RPC_FLAGS_WITH_VALUES.has(flag)) {
    return null;
  }
  return { flag, assigned: value.slice(equals + 1) };
}

function resolveDefaultPiScoutExtension(): string | null {
  if (process.env.OPENSCOUT_PI_SCOUT_EXTENSION === "0") {
    return null;
  }

  for (const candidate of PI_SCOUT_EXTENSION_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function normalizePiProvider(value: string | undefined): string | undefined {
  const provider = normalizeOptionalString(value)?.toLowerCase();
  if (!provider) {
    return undefined;
  }
  if (provider === "grok" || provider === "x-ai") {
    return "xai";
  }
  return provider;
}

function inferPiProvider(launch: Pick<PiRpcLaunchOptions, "provider" | "model">): string | undefined {
  const provider = normalizePiProvider(launch.provider);
  if (provider) {
    return provider;
  }
  const model = normalizeOptionalString(launch.model)?.toLowerCase();
  if (model?.includes("/")) {
    return normalizePiProvider(model.split("/", 1)[0]);
  }
  if (model?.startsWith("minimax")) {
    return "minimax";
  }
  if (model?.startsWith("grok")) {
    return "xai";
  }
  return undefined;
}

/**
 * Read a credential from the macOS keychain via the `secret` CLI.
 *
 * `commandOverride` exists so tests can point at a stub binary by absolute
 * path. Prepending a temp directory to `process.env.PATH` does **not** work:
 * `execFileSync` resolves independently of a mutated PATH, so a test that
 * tries to isolate itself that way silently runs the real CLI and prints a
 * live credential into its assertion output. That is exactly how
 * `SCOUT_OPENCODE_API_KEY` leaked on 2026-08-04. Mirrors the `secretCommand`
 * option on the opencode-acp adapter.
 */
export function readPiRpcCredentialFile(
  name: string,
  options: {
    env?: CredentialEnvSource;
    platform?: NodeJS.Platform;
    homedir?: string;
  } = {},
): string | undefined {
  if (!/^[A-Z0-9_]+$/.test(name)) {
    return undefined;
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const directory = normalizeOptionalString(env.CREDENTIALS_DIRECTORY)
    ?? normalizeOptionalString(env.OPENSCOUT_CREDENTIALS_DIRECTORY)
    ?? (platform === "linux"
      ? join(
        normalizeOptionalString(env.XDG_CONFIG_HOME) ?? join(options.homedir ?? homedir(), ".config"),
        "openscout",
        "credentials",
      )
      : undefined);
  if (!directory) {
    return undefined;
  }

  try {
    const directoryStat = statSync(directory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
      return undefined;
    }
    const path = join(directory, name);
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024) {
      return undefined;
    }
    const value = readFileSync(path, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function readSecretValue(
  name: string,
  commandOverride?: string | null,
  env: CredentialEnvSource = process.env,
): string | undefined {
  const credentialFile = readPiRpcCredentialFile(name, { env });
  if (credentialFile) {
    return credentialFile;
  }
  try {
    const output = execFileSync(commandOverride || "secret", ["get", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function readMappedCredentialValue(
  mapping: PiRpcCredentialEnvMapping,
  env: CredentialEnvSource,
  readSecret: (name: string) => string | undefined,
): string | undefined {
  for (const key of mapping.envKeys) {
    const value = normalizeOptionalString(env[key]);
    if (value) {
      return value;
    }
  }

  for (const key of mapping.secretKeys ?? []) {
    const value = normalizeOptionalString(readSecret(key));
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function buildPiRpcCredentialEnv(
  launch: Pick<PiRpcLaunchOptions, "provider" | "model">,
  sources: {
    env?: CredentialEnvSource;
    readSecret?: (name: string) => string | undefined;
    /** Absolute path to a stub `secret` binary; see `readSecretValue`. */
    secretCommand?: string | null;
  } = {},
): Record<string, string> | undefined {
  const provider = inferPiProvider(launch);
  const mappings = provider ? PI_RPC_CREDENTIAL_ENV[provider] : undefined;
  if (!mappings) {
    return undefined;
  }

  const env: Record<string, string> = {};
  const sourceEnv = sources.env ?? process.env;
  const readSecret = sources.readSecret
    ?? ((name: string) => readSecretValue(name, sources.secretCommand, sourceEnv));
  for (const mapping of mappings) {
    const value = readMappedCredentialValue(mapping, sourceEnv, readSecret);
    if (value) {
      // Sensitive by provenance: env-key or keychain, any variable name.
      registerSecretValue(value, "pi-rpc:credential");
      env[mapping.outputKey] = value;
    }
  }

  return Object.keys(env).length > 0 ? env : undefined;
}

export function parsePiRpcLaunchArgs(
  launchArgs: readonly string[],
  options: { runtimeDirectory: string; includeDefaultScoutExtension?: boolean },
): PiRpcLaunchOptions {
  const parsed: PiRpcLaunchOptions = {
    extensions: [],
    extraArgs: [],
    sessionDir: join(options.runtimeDirectory, "pi-sessions"),
  };

  for (let index = 0; index < launchArgs.length; index += 1) {
    const current = launchArgs[index] ?? "";
    const assignment = readFlagAssignment(current);
    if (assignment) {
      if (LEGACY_PI_RPC_IGNORED_FLAGS.has(assignment.flag)) {
        continue;
      }
      if (assignment.flag === "--extension") {
        const extension = normalizeOptionalString(assignment.assigned);
        if (extension) parsed.extensions.push(extension);
        continue;
      }
      if (assignment.flag === "--append-system-prompt") {
        continue;
      }
      const key = PI_RPC_OPTION_KEYS[assignment.flag];
      const value = normalizeOptionalString(assignment.assigned);
      if (key && value) {
        parsed[key] = value;
        continue;
      }
    }

    if (current === "--extension") {
      const value = normalizeOptionalString(launchArgs[index + 1]);
      if (value) {
        parsed.extensions.push(value);
        index += 1;
      }
      continue;
    }

    if (current === "--append-system-prompt") {
      index += 1;
      continue;
    }

    if (LEGACY_PI_RPC_IGNORED_FLAGS.has(current)) {
      index += 1;
      continue;
    }

    if (PI_RPC_OPTION_KEYS[current]) {
      const key = PI_RPC_OPTION_KEYS[current]!;
      const value = normalizeOptionalString(launchArgs[index + 1]);
      if (value) {
        parsed[key] = value;
        index += 1;
      }
      continue;
    }

    parsed.extraArgs.push(current);
  }

  if (options.includeDefaultScoutExtension !== false) {
    const defaultExtension = resolveDefaultPiScoutExtension();
    if (defaultExtension && !parsed.extensions.includes(defaultExtension)) {
      parsed.extensions.push(defaultExtension);
    }
  }

  return parsed;
}

function extractTurnText(snapshot: SessionState | null, turnId: string): string {
  const turn = snapshot?.turns.find((candidate) => candidate.id === turnId);
  if (!turn) {
    return "";
  }

  const textParts: string[] = [];
  const errorParts: string[] = [];
  for (const blockState of turn.blocks) {
    const block = blockState.block;
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "error") {
      errorParts.push(block.message);
    }
  }

  const text = textParts.join("").trim();
  if (text) {
    return text;
  }
  return errorParts.join("\n").trim();
}

function terminalTurnError(snapshot: SessionState | null, turnId: string): string | null {
  const turn = snapshot?.turns.find((candidate) => candidate.id === turnId);
  if (!turn || turn.status !== "error") {
    return null;
  }
  return extractTurnText(snapshot, turnId) || "Pi RPC turn failed.";
}

class PiRpcAgentSession {
  private adapter: Adapter | null = null;
  private readonly tracker = new StateTracker();
  private currentRun: Promise<unknown> = Promise.resolve();
  private lastError: Error | null = null;

  constructor(private readonly options: PiRpcSessionRequestOptions) {}

  get snapshot(): SessionState | null {
    return this.tracker.getSessionState(this.options.sessionId);
  }

  get sessionMetadata(): Record<string, unknown> | undefined {
    const providerMeta = this.snapshot?.session.providerMeta;
    if (!providerMeta || typeof providerMeta !== "object" || Array.isArray(providerMeta)) {
      return undefined;
    }
    return { ...providerMeta };
  }

  get alive(): boolean {
    const status = this.snapshot?.session.status;
    return Boolean(this.adapter && status !== "closed" && status !== "error");
  }

  async ensureOnline(): Promise<{ sessionId: string }> {
    if (this.alive) {
      return { sessionId: this.options.sessionId };
    }

    await mkdir(this.options.runtimeDirectory, { recursive: true });
    await mkdir(this.options.logsDirectory, { recursive: true });
    await writeFile(join(this.options.runtimeDirectory, "prompt.txt"), this.options.systemPrompt);

    const launch = parsePiRpcLaunchArgs(this.options.launchArgs, {
      runtimeDirectory: this.options.runtimeDirectory,
    });
    const adapter = createPiAdapter({
      sessionId: this.options.sessionId,
      name: `${this.options.agentName} Pi RPC`,
      cwd: this.options.cwd,
      env: buildPiRpcCredentialEnv(launch),
      options: {
        ...launch,
        appendSystemPrompt: this.options.systemPrompt,
      },
    });

    this.adapter = adapter;
    this.lastError = null;
    this.tracker.createSession(this.options.sessionId, adapter.session);
    adapter.on("event", (event) => {
      this.tracker.trackEvent(this.options.sessionId, event);
    });
    adapter.on("error", (error) => {
      this.lastError = error;
      this.tracker.trackEvent(this.options.sessionId, {
        event: "session:update",
        session: {
          ...adapter.session,
          status: "error",
          providerMeta: {
            ...(adapter.session.providerMeta ?? {}),
            errorMessage: error.message,
          },
        },
      });
    });

    await adapter.start();
    this.tracker.trackEvent(this.options.sessionId, {
      event: "session:update",
      session: { ...adapter.session },
    });

    return { sessionId: this.options.sessionId };
  }

  async invoke(prompt: string, timeoutMs = DEFAULT_PI_RPC_TIMEOUT_MS): Promise<string> {
    const run = this.currentRun.then(() => this.invokeNow(prompt, timeoutMs));
    this.currentRun = run.catch(() => undefined);
    return run;
  }

  async shutdown(): Promise<void> {
    const adapter = this.adapter;
    this.adapter = null;
    if (adapter) {
      await adapter.shutdown();
      this.tracker.trackEvent(this.options.sessionId, {
        event: "session:closed",
        sessionId: this.options.sessionId,
      });
    }
  }

  private async invokeNow(prompt: string, timeoutMs: number): Promise<string> {
    await this.ensureOnline();
    const adapter = this.adapter;
    if (!adapter) {
      throw new Error("Pi RPC adapter is not online.");
    }

    return new Promise<string>((resolve, reject) => {
      let turnId: string | null = null;
      let settled = false;
      const cleanup = () => {
        adapter.off("event", onEvent);
        adapter.off("error", onError);
        clearTimeout(timer);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onError = (error: Error) => {
        finish(() => reject(error));
      };
      const onEvent = (event: AgentSessionStreamEvent) => {
        if (event.event === "turn:start" && !turnId) {
          turnId = event.turn.id;
          return;
        }
        if (event.event !== "turn:end" || event.turnId !== turnId) {
          return;
        }
        const snapshot = this.snapshot;
        const error = terminalTurnError(snapshot, event.turnId);
        if (error) {
          finish(() => reject(new Error(error)));
          return;
        }
        const output = extractTurnText(snapshot, event.turnId);
        if (!output.trim()) {
          turnId = null;
          return;
        }
        finish(() => resolve(output));
      };
      const timer = setTimeout(() => {
        adapter.interrupt();
        finish(() => reject(new Error(`Pi RPC invocation timed out after ${timeoutMs}ms.`)));
      }, timeoutMs);

      adapter.on("event", onEvent);
      adapter.on("error", onError);

      if (this.lastError) {
        finish(() => reject(this.lastError!));
        return;
      }

      adapter.send({
        sessionId: this.options.sessionId,
        text: prompt,
      });
    });
  }
}

const sessions = new Map<string, PiRpcAgentSession>();

function sessionKey(options: Pick<PiRpcSessionRequestOptions, "sessionId">): string {
  return options.sessionId;
}

function getOrCreateSession(options: PiRpcSessionRequestOptions): PiRpcAgentSession {
  const key = sessionKey(options);
  const existing = sessions.get(key);
  if (existing) {
    return existing;
  }
  const session = new PiRpcAgentSession(options);
  sessions.set(key, session);
  return session;
}

export async function ensurePiRpcAgentOnline(options: PiRpcSessionRequestOptions): Promise<PiRpcSessionResult> {
  const session = getOrCreateSession(options);
  const result = await session.ensureOnline();
  return {
    ...result,
    ...(session.sessionMetadata ? { metadata: session.sessionMetadata } : {}),
  };
}

export async function invokePiRpcAgent(options: PiRpcInvocationOptions): Promise<PiRpcInvocationResult> {
  const session = getOrCreateSession(options);
  const output = await session.invoke(options.prompt, options.timeoutMs);
  return {
    output,
    sessionId: options.sessionId,
    ...(session.sessionMetadata ? { metadata: session.sessionMetadata } : {}),
  };
}

export function getPiRpcAgentSnapshot(options: Pick<PiRpcSessionRequestOptions, "sessionId">): SessionState | null {
  return sessions.get(sessionKey(options))?.snapshot ?? null;
}

export function isPiRpcAgentAlive(options: Pick<PiRpcSessionRequestOptions, "sessionId">): boolean {
  return sessions.get(sessionKey(options))?.alive ?? false;
}

export async function shutdownPiRpcAgent(options: Pick<PiRpcSessionRequestOptions, "sessionId">): Promise<void> {
  const key = sessionKey(options);
  const session = sessions.get(key);
  if (!session) {
    return;
  }
  await session.shutdown();
  sessions.delete(key);
}
