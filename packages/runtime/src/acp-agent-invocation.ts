import {
  createLocalAgentClient,
  type LocalAgentClient,
  type LocalAgentHarness,
  type LocalAgentTransport,
} from "@openscout/agent-sessions/local";

import type { RuntimeTimer } from "./portable-types.js";
import { RequesterWaitTimeoutError } from "./requester-timeout.js";

export interface AcpAgentInvocationOptions {
  adapterType: "grok-acp" | "kimi-acp" | "cursor-acp" | "opencode-acp";
  label: string;
  /** Stable broker/runtime session id. It is not an ACP provider session id. */
  sessionId: string;
  /** Stable resolved endpoint key used to own one live ACP process. */
  poolKey?: string;
  /** Provider-native ACP session id used only when attaching a cold process. */
  resumeSessionId?: string;
  cwd: string;
  prompt: string;
  name?: string;
  timeoutMs?: number;
  hardCeilingMs?: number;
  adapterOptions?: Record<string, unknown>;
}

export interface AcpAgentInvocationResult {
  output: string;
  /** Provider-native ACP session id, suitable for a later cold resume. */
  sessionId: string;
  metadata?: Record<string, unknown>;
  /** Token counts as reported by the provider, when it reports any. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
  };
}

type AcpPoolEntry = {
  client: LocalAgentClient;
  fingerprint: string;
  nativeSessionId?: string;
};

const DEFAULT_ACP_HARD_CEILING_MS = 30 * 60_000;
const activeAcpSessions = new Map<string, Promise<AcpPoolEntry>>();

function harnessForAdapter(adapterType: AcpAgentInvocationOptions["adapterType"]): LocalAgentHarness {
  if (adapterType === "grok-acp") return "grok";
  if (adapterType === "kimi-acp") return "kimi";
  if (adapterType === "opencode-acp") return "opencode";
  return "cursor";
}

function transportForAdapter(adapterType: AcpAgentInvocationOptions["adapterType"]): LocalAgentTransport {
  if (adapterType === "grok-acp") return "grok_acp";
  if (adapterType === "kimi-acp") return "kimi_acp";
  if (adapterType === "opencode-acp") return "opencode_acp";
  return "cursor_acp";
}

function resolvedPoolKey(options: AcpAgentInvocationOptions): string {
  return options.poolKey?.trim() || `${options.adapterType}\u0000${options.sessionId}`;
}

function sessionFingerprint(options: AcpAgentInvocationOptions): string {
  const requestedModel = typeof options.adapterOptions?.model === "string"
    ? options.adapterOptions.model.trim()
    : "";
  // Adapter model selection happens when the ACP process/session is created.
  // Reusing the same pool entry after the requested model changes would keep
  // prompting the old model while reporting the new request as resolved.
  return [options.adapterType, options.sessionId, options.cwd, requestedModel].join("\u0000");
}

async function createPoolEntry(options: AcpAgentInvocationOptions): Promise<AcpPoolEntry> {
  const client = await createLocalAgentClient({
    harness: harnessForAdapter(options.adapterType),
    transport: transportForAdapter(options.adapterType),
    cwd: options.cwd,
    sessionId: options.sessionId,
    reuseKey: options.resumeSessionId,
    adapterOptions: options.adapterOptions,
    warmth: "lazy",
  });
  return {
    client,
    fingerprint: sessionFingerprint(options),
    nativeSessionId: options.resumeSessionId,
  };
}

async function closeEntry(entryPromise: Promise<AcpPoolEntry>): Promise<void> {
  const entry = await entryPromise.catch(() => null);
  if (entry) {
    await entry.client.close().catch(() => undefined);
  }
}

async function entryForInvocation(options: AcpAgentInvocationOptions): Promise<AcpPoolEntry> {
  const key = resolvedPoolKey(options);
  const fingerprint = sessionFingerprint(options);
  let detachedNativeSessionId: string | undefined;
  const existingPromise = activeAcpSessions.get(key);
  if (existingPromise) {
    const existing = await existingPromise;
    const requestedNativeId = options.resumeSessionId?.trim();
    const nativeIdConflict = Boolean(
      requestedNativeId
      && existing.nativeSessionId
      && requestedNativeId !== existing.nativeSessionId,
    );
    if (existing.fingerprint === fingerprint && !nativeIdConflict && existing.client.isAlive?.() !== false) {
      return existing;
    }
    detachedNativeSessionId = existing.nativeSessionId;
    if (activeAcpSessions.get(key) === existingPromise) {
      activeAcpSessions.delete(key);
    }
    await closeEntry(existingPromise);
  }

  const createdPromise = createPoolEntry({
    ...options,
    resumeSessionId: options.resumeSessionId ?? detachedNativeSessionId,
  });
  activeAcpSessions.set(key, createdPromise);
  try {
    return await createdPromise;
  } catch (error) {
    if (activeAcpSessions.get(key) === createdPromise) {
      activeAcpSessions.delete(key);
    }
    throw error;
  }
}

export async function invokeAcpAgent(
  options: AcpAgentInvocationOptions,
): Promise<AcpAgentInvocationResult> {
  const key = resolvedPoolKey(options);
  const entry = await entryForInvocation(options);
  const turn = entry.client.turn({
    input: options.prompt,
    timeoutMs: options.hardCeilingMs ?? DEFAULT_ACP_HARD_CEILING_MS,
  }).then((result) => {
    const nativeSessionId = result.session.nativeId?.trim()
      || entry.nativeSessionId
      || options.resumeSessionId?.trim();
    if (!nativeSessionId) {
      throw new Error(`${options.label} did not expose a provider-native ACP session id.`);
    }
    entry.nativeSessionId = nativeSessionId;
    return {
      output: result.text,
      sessionId: nativeSessionId,
      metadata: result.metadata,
      usage: result.usage,
    };
  }).catch(async (error) => {
    const current = activeAcpSessions.get(key);
    if (current && await current.catch(() => null) === entry) {
      activeAcpSessions.delete(key);
    }
    await entry.client.close().catch(() => undefined);
    throw error;
  });

  return await waitForRequesterResult(turn, options.timeoutMs, options.label);
}

export async function shutdownAcpAgentSession(input: {
  adapterType: AcpAgentInvocationOptions["adapterType"];
  sessionId: string;
  poolKey?: string;
}): Promise<void> {
  const key = input.poolKey?.trim() || `${input.adapterType}\u0000${input.sessionId}`;
  const entry = activeAcpSessions.get(key);
  if (!entry) return;
  activeAcpSessions.delete(key);
  await closeEntry(entry);
}

export async function shutdownAllAcpAgentSessions(): Promise<void> {
  const entries = [...activeAcpSessions.values()];
  activeAcpSessions.clear();
  await Promise.all(entries.map(closeEntry));
}

function requesterTimeoutMs(timeoutMs: number | undefined): number | null {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return Math.floor(timeoutMs);
}

async function waitForRequesterResult<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  const effectiveTimeoutMs = requesterTimeoutMs(timeoutMs);
  if (effectiveTimeoutMs === null) return await promise;

  let timer: RuntimeTimer | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RequesterWaitTimeoutError({ label, timeoutMs: effectiveTimeoutMs }));
    }, effectiveTimeoutMs);
    timer.unref?.();
  });

  return await Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
