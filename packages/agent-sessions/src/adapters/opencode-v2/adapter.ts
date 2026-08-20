// OpenCode product-v2 adapter — shared local service + official Promise client.
//
// Product V2 is intentionally separate from:
//   - `opencode`, the legacy V1 server adapter; and
//   - `opencode-acp`, the ACP stdio adapter.
//
// V2 installs as `opencode2`, registers a shared background service, and uses
// the breaking `/api/*` contract. The service is user-owned: this adapter may
// ensure it exists, but never stops it on session shutdown.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  OpenCode,
  Service,
  type DiscoverOptions,
  type Endpoint,
  type EnsureOptions,
  type OpenCodeClient,
  type OpenCodeClientOptions,
  type OpenCodeEvent,
  type ServiceFacade,
  type SessionInfo,
} from "./upstream.js";

import { BaseAdapter, type AdapterConfig } from "../../protocol/adapter.js";
import type {
  AgentSessionStreamEvent,
  Prompt,
  QuestionAnswer,
} from "../../protocol/primitives.js";
import { redactSecrets, registerSecretValue } from "../../secret-redaction.js";
import {
  createOpenCodeV2EventNormalizer,
  type OpenCodeV2EventNormalizer,
} from "./normalizer.js";

export const OPENCODE_V2_CLIENT_VERSION = "0.0.0-next-17226";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export type OpenCodeV2Dependencies = {
  service: ServiceFacade;
  makeClient(options: OpenCodeClientOptions): OpenCodeClient;
  delay(milliseconds: number, signal?: AbortSignal): Promise<void>;
  now(): string;
  nextId(): string;
};

type OpenCodeV2AdapterOptions = {
  serverUrl?: string;
  serverUsername: string;
  serverPassword?: string;
  serviceFile?: string;
  autoStart: boolean;
  command: readonly string[];
  requiredVersion: string | null;
  startupTimeoutMs: number;
  reconnectDelayMs: number;
  remoteSessionId?: string;
  allowCrossDirectoryResume: boolean;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

type PendingQuestionRequest = {
  answers: string[][];
  answered: Set<number>;
  blockIds: string[];
};

type OriginatedInputState = {
  id: string;
  postStarted: boolean;
  /** The local Promise settled; a Transport error can still leave server work in flight. */
  postSettled: boolean;
  /** A native HTTP response was observed, so this particular handler cannot admit later. */
  serverResponseObserved: boolean;
  admitted: boolean;
  promoted: boolean;
  cleanupRequested: boolean;
  cleanupErrorReported: boolean;
  allowPromotedInterrupt: boolean;
  /**
   * Monotonic evidence generation for native cleanup. A pending DELETE can
   * race the prompt POST, admission, or promotion; a failed exact-id attempt
   * retries when one of those boundaries changed while it was in flight.
   */
  cleanupRevision: number;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    return undefined;
  }
  return value.map((entry) => (entry as string).trim());
}

function defaultOpenCodeV2Binary(env: Record<string, string> | undefined): string {
  const override = stringValue(env?.OPENCODE_V2_BIN) ?? stringValue(process.env.OPENCODE_V2_BIN);
  if (override) return override;
  const home = stringValue(env?.HOME) ?? homedir();
  const candidates = [
    "/opt/homebrew/bin/opencode2",
    "/usr/local/bin/opencode2",
    join(home, ".opencode", "bin", "opencode2"),
    join(home, ".local", "bin", "opencode2"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "opencode2";
}

function modelRef(value: unknown, variantValue: unknown): OpenCodeV2AdapterOptions["model"] {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const hash = raw.lastIndexOf("#");
  const withoutVariant = hash > 0 ? raw.slice(0, hash) : raw;
  const inlineVariant = hash > 0 ? stringValue(raw.slice(hash + 1)) : undefined;
  const slash = withoutVariant.indexOf("/");
  const providerID = slash > 0 ? withoutVariant.slice(0, slash) : "opencode";
  const id = slash > 0 ? withoutVariant.slice(slash + 1) : withoutVariant;
  if (!id) return undefined;
  const variant = stringValue(variantValue) ?? inlineVariant;
  return { id, providerID, ...(variant ? { variant } : {}) };
}

function parseOptions(config: AdapterConfig): OpenCodeV2AdapterOptions {
  const raw = isRecord(config.options) ? config.options : {};
  const explicitCommand = stringArray(raw.command);
  const binary = stringValue(raw.command) ?? defaultOpenCodeV2Binary(config.env);
  const args = stringArray(raw.args) ?? ["serve", "--service"];
  const requiredVersion = raw.requiredVersion === false
    ? null
    : stringValue(raw.requiredVersion) ?? OPENCODE_V2_CLIENT_VERSION;
  return {
    serverUrl: stringValue(raw.serverUrl) ?? stringValue(raw.url),
    serverUsername: stringValue(raw.serverUsername) ?? "opencode",
    serverPassword: stringValue(raw.serverPassword)
      ?? stringValue(config.env?.OPENCODE_PASSWORD)
      ?? stringValue(process.env.OPENCODE_PASSWORD),
    serviceFile: stringValue(raw.serviceFile),
    autoStart: raw.autoStart !== false,
    command: explicitCommand ?? [binary, ...args],
    requiredVersion,
    startupTimeoutMs: numberValue(raw.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
    reconnectDelayMs: numberValue(raw.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS),
    remoteSessionId: stringValue(raw.sessionId) ?? stringValue(raw.session),
    allowCrossDirectoryResume: raw.allowCrossDirectoryResume === true,
    title: stringValue(raw.title) ?? stringValue(config.name),
    agent: stringValue(raw.agent),
    model: modelRef(raw.model, raw.variant),
  };
}

function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      rejectPromise(abortReason(signal!));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const DEFAULT_DEPENDENCIES: OpenCodeV2Dependencies = {
  service: Service,
  makeClient: OpenCode.make,
  delay: defaultDelay,
  now: () => new Date().toISOString(),
  nextId: () => crypto.randomUUID(),
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === "string" ? signal.reason : "OpenCode operation aborted.");
}

function linkedTimeoutSignal(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("OpenCode V2 request timed out.")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(() => undefined, () => undefined),
      new Promise<void>((resolvePromise) => {
        timer = setTimeout(resolvePromise, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function observeWithinSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      rejectPromise(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        rejectPromise(error);
      },
    );
  });
}

function normalizedError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return new Error(redactSecrets(error.message || fallback), { cause: error });
  if (isRecord(error)) {
    const tag = stringValue(error._tag);
    const message = stringValue(error.message) ?? fallback;
    return new Error(redactSecrets(tag ? `${message} (${tag})` : message));
  }
  return new Error(redactSecrets(typeof error === "string" ? error : fallback));
}

function isAuthoritativePromptRejection(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error._tag === "InvalidRequestError"
    || error._tag === "UnauthorizedError"
    || error._tag === "SessionNotFoundError";
}

function httpServerResponseObserved(error: unknown): boolean {
  if (!isRecord(error)) return false;
  // Declared API errors are decoded JSON response bodies. Conflict remains
  // admission-ambiguous, but its request handler itself has finished.
  if (typeof error._tag === "string") return true;
  // The generated Promise client preserves response-vs-transport failures in
  // ClientError.reason. Unsupported/malformed/undeclared responses still prove
  // the server answered; Transport does not (including a client-side abort).
  return error.reason === "UnexpectedStatus"
    || error.reason === "UnsupportedContentType"
    || error.reason === "MalformedResponse";
}

function modelName(model: SessionInfo["model"]): string | undefined {
  return model
    ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
    : undefined;
}

function promptFiles(prompt: Prompt, cwd: string | undefined): Array<{ uri: string; name?: string }> {
  const files: Array<{ uri: string; name?: string }> = [];
  for (const file of prompt.files ?? []) {
    if (file.startsWith("file:") || file.startsWith("data:")) {
      files.push({ uri: file });
      continue;
    }
    const path = isAbsolute(file) ? file : resolve(cwd ?? process.cwd(), file);
    files.push({ uri: pathToFileURL(path).href, name: basename(path) });
  }
  for (const [index, image] of (prompt.images ?? []).entries()) {
    const bytes = Buffer.byteLength(image.data, "base64");
    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error(`OpenCode image ${index + 1} exceeds the 20 MiB V2 attachment limit.`);
    }
    files.push({
      uri: `data:${image.mimeType};base64,${image.data}`,
      name: `image-${index + 1}`,
    });
  }
  return files;
}

function sameDirectory(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function remoteMessageId(value: string): string {
  return value.startsWith("msg_") ? value : `msg_${value}`;
}

export class OpenCodeV2Adapter extends BaseAdapter {
  readonly type = "opencode-v2";

  private readonly options: OpenCodeV2AdapterOptions;
  private readonly dependencies: OpenCodeV2Dependencies;
  private readonly normalizer: OpenCodeV2EventNormalizer;
  private sequence = 0;
  private client: OpenCodeClient | null = null;
  private endpoint: Endpoint | null = null;
  private nativeSessionId: string | null = null;
  private serverVersion: string | null = null;
  /** Aborts startup work when registry/session shutdown races start(). */
  private readonly lifecycleAbort = new AbortController();
  private streamAbort: AbortController | null = null;
  private streamLoop: Promise<void> | null = null;
  private streamConnected = false;
  private streamEverConnected = false;
  private shuttingDown = false;
  private promptQueue: Promise<void> = Promise.resolve();
  private activeTurnCompletion: Deferred<void> | null = null;
  private activeRemoteInputId: string | null = null;
  private activeInputAdmitted = false;
  private activeInputPromoted = false;
  private activePromptAbort: AbortController | null = null;
  private readonly originatedInputs = new Map<string, OriginatedInputState>();
  private readonly inputCleanupInFlight = new Map<string, Promise<void>>();
  /** Session-wide interrupt requests whose handler completion is unproven. */
  private readonly unresolvedSessionInterrupts = new Set<symbol>();
  private ownsNativeSession = false;
  private remoteExecutionNeedsQuiescence = false;
  private readonly recoveryInputIds = new Set<string>();
  private pendingQuestions = new Map<string, PendingQuestionRequest>();

  constructor(config: AdapterConfig, dependencies: Partial<OpenCodeV2Dependencies> = {}) {
    super(config);
    this.options = parseOptions(config);
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    this.normalizer = createOpenCodeV2EventNormalizer({
      sessionId: config.sessionId,
      now: this.dependencies.now,
      nextId: () => this.dependencies.nextId(),
    });
    (this.session as { adapterType: string }).adapterType = this.type;
  }

  async start(): Promise<void> {
    const startup = linkedTimeoutSignal(
      this.lifecycleAbort.signal,
      this.options.startupTimeoutMs,
    );
    try {
      await this.configureClient(
        await observeWithinSignal(this.resolveEndpoint(), startup.signal),
        startup.signal,
      );
      if (startup.signal.aborted || this.shuttingDown) throw abortReason(startup.signal);

      const nativeSession = await observeWithinSignal(
        this.ensureSession(startup.signal),
        startup.signal,
      );
      if (startup.signal.aborted || this.shuttingDown) throw abortReason(startup.signal);
      this.ownsNativeSession = !this.options.remoteSessionId;
      this.nativeSessionId = nativeSession.id;
      this.normalizer.setRemoteSessionId(nativeSession.id);
      this.applyNativeSession(nativeSession);

      const ready = deferred<void>();
      this.streamAbort = new AbortController();
      this.streamLoop = this.consumeEventStream(ready, this.streamAbort.signal);
      await observeWithinSignal(ready.promise, startup.signal);
      if (startup.signal.aborted || this.shuttingDown) throw abortReason(startup.signal);
      if (this.options.remoteSessionId && this.streamAbort) {
        await this.stabilizeResumedSession(startup.signal);
      }
      if (startup.signal.aborted || this.shuttingDown) throw abortReason(startup.signal);
      this.setStatus("idle");
    } catch (error) {
      this.streamAbort?.abort();
      if (this.streamLoop) await settleWithin(this.streamLoop, 2_000);
      const startupError = normalizedError(error, "Failed to start the OpenCode V2 adapter.");
      // Registry shutdown can race an awaited start(). Preserve its terminal
      // closed state and do not resurrect the removed adapter as an error/idle
      // session when a non-cancellable Service.ensure() resolves later.
      if (!this.shuttingDown) {
        this.emit("error", startupError);
        this.setStatus("error");
      }
      throw startupError;
    } finally {
      startup.dispose();
    }
  }

  send(prompt: Prompt): void {
    this.promptQueue = this.promptQueue.then(
      () => this.runPrompt(prompt),
      () => this.runPrompt(prompt),
    );
  }

  interrupt(): void {
    if (!this.client || !this.nativeSessionId || !this.normalizer.turnOpen) return;
    const inputId = this.activeRemoteInputId;
    if (inputId) this.markInputForCleanup(inputId);
    this.activePromptAbort?.abort(new Error("OpenCode V2 turn interrupted."));
    // Settle the local edge deterministically. Native cancellation/interrupt
    // may publish its event before the HTTP 204, and must not race stopped
    // into a failed turn. Stable originated-input tracking owns remote cleanup.
    this.emitNormalized(this.normalizer.ingest({
      source: "adapter_control",
      sequence: this.sequence++,
      event: "interrupt",
    }));
  }

  decide(turnId: string, blockId: string, decision: "approve" | "deny", reason?: string): void {
    if (!this.client || !this.nativeSessionId || this.normalizer.currentTurnId !== turnId) return;
    const requestId = this.normalizer.permissionRequestForBlock(blockId);
    if (!requestId) return;
    const inputId = this.activeRemoteInputId;
    void this.client.permission.reply({
      sessionID: this.nativeSessionId,
      requestID: requestId,
      reply: decision === "approve" ? "once" : "reject",
      ...(reason ? { message: reason } : {}),
    }, { signal: AbortSignal.timeout(this.options.startupTimeoutMs) }).then(
      () => this.emitNormalized(this.normalizer.resolvePermission(requestId, decision)),
      (error: unknown) => {
        const replyError = normalizedError(error, "OpenCode V2 permission reply failed.");
        if (!this.normalizer.permissionBlockId(requestId)) {
          // Native acknowledgement is published before the HTTP response. A
          // later fetch failure cannot revoke an already accepted decision.
          this.emit("error", replyError);
          return;
        }
        this.failTurnIfCurrent(turnId, inputId, replyError);
      },
    );
  }

  answerQuestion(answer: QuestionAnswer): void {
    if (!this.client || !this.nativeSessionId) return;
    const descriptor = this.normalizer.questionRequestForBlock(answer.blockId);
    if (!descriptor) return;
    const pending = this.pendingQuestions.get(descriptor.requestId);
    if (!pending) return;
    pending.answers[descriptor.index] = [...answer.answer];
    pending.answered.add(descriptor.index);
    if (pending.answered.size !== pending.blockIds.length) return;
    this.pendingQuestions.delete(descriptor.requestId);
    const turnId = this.normalizer.currentTurnId;
    const inputId = this.activeRemoteInputId;
    void this.client.question.reply({
      sessionID: this.nativeSessionId,
      requestID: descriptor.requestId,
      answers: pending.answers,
    }, { signal: AbortSignal.timeout(this.options.startupTimeoutMs) }).then(
      () => this.emitNormalized(this.normalizer.resolveQuestions(descriptor.requestId, pending.answers)),
      (error: unknown) => {
        const replyError = normalizedError(error, "OpenCode V2 question reply failed.");
        if (this.normalizer.questionBlockIds(descriptor.requestId).length === 0) {
          // question.replied/rejected is the authoritative acknowledgement,
          // even when its HTTP reply is lost afterward.
          this.emit("error", replyError);
          return;
        }
        this.failTurnIfCurrent(turnId, inputId, replyError);
      },
    );
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.lifecycleAbort.abort(new Error("OpenCode V2 adapter is shutting down."));

    if (this.normalizer.turnOpen) {
      if (this.activeRemoteInputId) this.markInputForCleanup(this.activeRemoteInputId);
      this.activePromptAbort?.abort(new Error("OpenCode V2 adapter is shutting down."));
      this.emitNormalized(this.normalizer.ingest({
        source: "adapter_control",
        sequence: this.sequence++,
        event: "transport_closed",
      }));
    }

    // Let an in-flight POST observe its abort and run its exact-id cleanup
    // before closing the only stream that can reveal a late admission or
    // promotion. Queued prompts see shuttingDown and drain without posting.
    await settleWithin(this.promptQueue, 2_000);
    const existingCleanup = [...this.inputCleanupInFlight.values()];
    const requestedCleanup =
      [...this.originatedInputs.values()]
        .filter((input) => input.cleanupRequested)
        .map((input) => this.attemptInputCleanup(input.id));
    await settleWithin(Promise.allSettled([...existingCleanup, ...requestedCleanup]), 2_000);
    let unresolvedCleanup = this.inputCleanupInFlight.size > 0
      || this.unresolvedSessionInterrupts.size > 0
      || [...this.originatedInputs.values()].some((input) => input.cleanupRequested);
    if (
      this.client
      && this.nativeSessionId
      && (this.remoteExecutionNeedsQuiescence || unresolvedCleanup)
    ) {
      const shutdownSignal = AbortSignal.timeout(2_000);
      let quiescent = false;
      try {
        if (this.unresolvedSessionInterrupts.size > 0) {
          throw new Error("A prior OpenCode V2 session interrupt is still transport-ambiguous.");
        }
        const pending = await this.client.session.pending.list(
          { sessionID: this.nativeSessionId },
          { signal: shutdownSignal },
        );
        for (const input of pending) {
          const originated = this.originatedInputs.get(input.id);
          if (!originated?.cleanupRequested) continue;
          this.updateOriginatedInput(originated, { admitted: true });
          await this.client.session.pending.cancel(
            { sessionID: this.nativeSessionId, inputID: input.id },
            { signal: shutdownSignal },
          ).catch(() => undefined);
        }
        if (this.ownsNativeSession) {
          await this.interruptNativeSession(
            this.client,
            this.nativeSessionId,
            shutdownSignal,
          );
        }
        await this.client.session.wait(
          { sessionID: this.nativeSessionId },
          { signal: shutdownSignal },
        );
        await this.assertNativeSessionQuiescent(shutdownSignal, "during shutdown");
        await defaultDelay(
          Math.min(this.options.reconnectDelayMs, 250),
          shutdownSignal,
        );
        await this.assertNativeSessionQuiescent(shutdownSignal, "after shutdown stabilization");
        // A Transport-settled POST can still admit after an idle snapshot. Do
        // not claim native cleanup until the server answered, native admission
        // was observed, or the request was never posted.
        quiescent = this.inputCleanupInFlight.size === 0
          && this.unresolvedSessionInterrupts.size === 0
          && [...this.originatedInputs.values()].every(
            (input) => !input.cleanupRequested
              || !input.postStarted
              || input.serverResponseObserved
              || input.admitted,
          );
      } catch {
        // Shared-session uncertainty is deliberately fail-closed locally; the
        // adapter never interrupts foreign work merely to make shutdown neat.
      }
      if (quiescent) {
        for (const input of [...this.originatedInputs.values()]) {
          if (input.cleanupRequested) this.retireOriginatedInput(input.id);
        }
        this.remoteExecutionNeedsQuiescence = false;
      }
      unresolvedCleanup = this.inputCleanupInFlight.size > 0
        || this.unresolvedSessionInterrupts.size > 0
        || [...this.originatedInputs.values()].some((input) => input.cleanupRequested);
    }
    if (unresolvedCleanup) {
      this.emit("error", new Error(
        "OpenCode V2 shutdown could not confirm cancellation of every originated native input; "
        + (this.ownsNativeSession
          ? "native work may still be settling."
          : "the resumed shared session was not interrupted destructively."),
      ));
    }

    this.streamAbort?.abort();
    if (this.streamLoop) await settleWithin(this.streamLoop, 2_000);
    this.streamAbort = null;
    this.streamLoop = null;
    this.streamConnected = false;
    this.pendingQuestions.clear();
    this.activeRemoteInputId = null;
    this.activeInputAdmitted = false;
    this.activeInputPromoted = false;
    this.activePromptAbort = null;
    this.ownsNativeSession = false;
    this.remoteExecutionNeedsQuiescence = false;
    this.recoveryInputIds.clear();
    this.originatedInputs.clear();
    this.inputCleanupInFlight.clear();
    this.unresolvedSessionInterrupts.clear();
    this.client = null;
    this.endpoint = null;
    this.nativeSessionId = null;
    // The background service and native session are intentionally persistent
    // and may be shared with the TUI or another adapter. Never Service.stop().
    this.setStatus("closed");
  }

  private async resolveEndpoint(): Promise<Endpoint> {
    if (this.options.serverUrl) {
      return {
        url: this.options.serverUrl.replace(/\/$/, ""),
        ...(this.options.serverPassword
          ? {
            auth: {
              type: "basic" as const,
              username: this.options.serverUsername,
              password: this.options.serverPassword,
            },
          }
          : {}),
      };
    }

    const discoverOptions = this.options.serviceFile ? { file: this.options.serviceFile } : {};
    const discovered = await this.dependencies.service.discover(discoverOptions);
    if (discovered) return discovered;
    if (!this.options.autoStart) {
      throw new Error("No compatible OpenCode V2 shared service is registered and autoStart is disabled.");
    }
    return this.dependencies.service.ensure({
      ...discoverOptions,
      // The published service helper still defaults to `opencode`; pass the
      // product-v2 binary explicitly so V1 can never be launched by mistake.
      command: this.options.command,
    });
  }

  private async configureClient(
    endpoint: Endpoint,
    signal: AbortSignal = AbortSignal.timeout(this.options.startupTimeoutMs),
  ): Promise<void> {
    const headers = this.dependencies.service.headers(endpoint);
    registerSecretValue(endpoint.auth?.password, "opencode-v2:service-password");
    registerSecretValue(headers?.authorization, "opencode-v2:authorization");
    const client = this.dependencies.makeClient({
      baseUrl: endpoint.url,
      ...(headers ? { headers } : {}),
    });
    const health = await client.health.get({ signal });
    if (signal.aborted || this.shuttingDown) throw abortReason(signal);
    if (this.options.requiredVersion && health.version !== this.options.requiredVersion) {
      throw new Error(
        `OpenCode V2 service ${health.version} does not match the pinned client ${this.options.requiredVersion}. `
        + "Update OpenScout's @opencode-ai/client pin or run the matching opencode2 build.",
      );
    }
    this.endpoint = endpoint;
    this.client = client;
    this.serverVersion = health.version;
  }

  private async refreshClient(signal: AbortSignal): Promise<void> {
    const request = linkedTimeoutSignal(signal, this.options.startupTimeoutMs);
    try {
      await this.configureClient(
        await observeWithinSignal(this.resolveEndpoint(), request.signal),
        request.signal,
      );
      if (!this.nativeSessionId) return;
      const resumed = await this.client!.session.get(
        { sessionID: this.nativeSessionId },
        { signal: request.signal },
      );
      if (request.signal.aborted || this.shuttingDown) throw abortReason(request.signal);
      if (
        this.config.cwd
        && !this.options.allowCrossDirectoryResume
        && !sameDirectory(resumed.location.directory, this.config.cwd)
      ) {
        throw new Error(
          `OpenCode V2 session ${resumed.id} moved to ${resumed.location.directory}, not ${this.config.cwd}.`,
        );
      }
      this.applyNativeSession(resumed);
    } finally {
      request.dispose();
    }
  }

  private async quiesceInterruptedExecution(signal: AbortSignal): Promise<void> {
    if (!this.remoteExecutionNeedsQuiescence || !this.client || !this.nativeSessionId) return;
    const request = linkedTimeoutSignal(signal, this.options.startupTimeoutMs);
    try {
      if (this.unresolvedSessionInterrupts.size > 0) {
        throw new Error("A prior OpenCode V2 session interrupt is still transport-ambiguous.");
      }
      const pending = await this.client.session.pending.list(
        { sessionID: this.nativeSessionId },
        { signal: request.signal },
      );
      for (const input of pending) {
        if (!this.recoveryInputIds.has(input.id)) continue;
        const originated = this.originatedInputs.get(input.id);
        if (originated) this.updateOriginatedInput(originated, { admitted: true });
        await this.client.session.pending.cancel(
          { sessionID: this.nativeSessionId, inputID: input.id },
          { signal: request.signal },
        ).catch(() => undefined);
      }
      // A newly created native session is adapter-owned, so an uncertain
      // execution can be interrupted safely. Exact resume is explicitly shared:
      // wait non-destructively rather than cancelling another client's work.
      if (this.ownsNativeSession) {
        await this.interruptNativeSession(
          this.client,
          this.nativeSessionId,
          request.signal,
        );
      }
      await this.client.session.wait(
        { sessionID: this.nativeSessionId },
        { signal: request.signal },
      );
      await this.assertNativeSessionQuiescent(request.signal, "after stream recovery");
      // A restarted service can report ready just before reclaiming durable
      // work. Keep admission closed across one reconnect interval and recheck so
      // a resumed orphan cannot be mistaken for a clean boundary.
      await this.dependencies.delay(this.options.reconnectDelayMs, signal);
      await this.assertNativeSessionQuiescent(request.signal, "after recovery stabilization");
      const unsettled = [...this.recoveryInputIds].some((inputId) => {
        const input = this.originatedInputs.get(inputId);
        return input?.postStarted && !input.serverResponseObserved && !input.admitted;
      });
      if (unsettled) {
        throw new Error(
          "OpenCode V2 cannot prove recovery while an originated prompt's server admission boundary remains ambiguous.",
        );
      }
      for (const inputId of [...this.recoveryInputIds]) this.retireOriginatedInput(inputId);
      this.remoteExecutionNeedsQuiescence = false;
    } finally {
      request.dispose();
    }
  }

  private async assertNativeSessionQuiescent(
    signal: AbortSignal,
    context: string,
  ): Promise<void> {
    if (!this.client || !this.nativeSessionId) return;
    const [active, pending] = await Promise.all([
      this.client.session.active({ signal }),
      this.client.session.pending.list({ sessionID: this.nativeSessionId }, { signal }),
    ]);
    if (active[this.nativeSessionId] || pending.length > 0) {
      throw new Error(`OpenCode V2 session ${this.nativeSessionId} is not quiescent ${context}.`);
    }
  }

  private async stabilizeResumedSession(signal: AbortSignal): Promise<void> {
    const request = linkedTimeoutSignal(signal, this.options.startupTimeoutMs);
    try {
      await this.assertNativeSessionQuiescent(request.signal, "during resumed-session attach");
      // Managed V2 services publish readiness just before restart-continuity
      // fibers reclaim durable work. A second check closes that attach race
      // without relying on the experimental durable session log.
      await this.dependencies.delay(this.options.reconnectDelayMs, signal);
      await this.assertNativeSessionQuiescent(request.signal, "after resumed-session stabilization");
    } finally {
      request.dispose();
    }
  }

  private async ensureSession(signal: AbortSignal): Promise<SessionInfo> {
    const client = this.client!;
    if (this.options.remoteSessionId) {
      const resumed = await client.session.get(
        { sessionID: this.options.remoteSessionId },
        { signal },
      );
      if (
        this.config.cwd
        && !this.options.allowCrossDirectoryResume
        && !sameDirectory(resumed.location.directory, this.config.cwd)
      ) {
        throw new Error(
          `OpenCode V2 session ${resumed.id} belongs to ${resumed.location.directory}, not ${this.config.cwd}. `
          + "Set allowCrossDirectoryResume only when that mismatch is intentional.",
        );
      }
      return resumed;
    }

    return client.session.create(
      {
        ...(this.options.title ? { title: this.options.title } : {}),
        ...(this.options.agent ? { agent: this.options.agent } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.config.cwd ? { location: { directory: resolve(this.config.cwd) } } : {}),
      },
      { signal },
    );
  }

  private applyNativeSession(nativeSession: SessionInfo): void {
    (this.session as { cwd?: string }).cwd = nativeSession.location.directory;
    const selectedModel = modelName(nativeSession.model)
      ?? (this.ownsNativeSession ? modelName(this.options.model) : undefined);
    if (selectedModel) (this.session as { model?: string }).model = selectedModel;
    (this.session as { providerMeta?: Record<string, unknown> }).providerMeta = {
      ...(this.session.providerMeta ?? {}),
      externalSessionId: nativeSession.id,
      opencode: {
        protocolVersion: "v2",
        clientVersion: OPENCODE_V2_CLIENT_VERSION,
        serverVersion: this.serverVersion,
        serverUrl: this.endpoint?.url,
      },
    };
  }

  private async consumeEventStream(ready: Deferred<void>, signal: AbortSignal): Promise<void> {
    let refreshRequired = false;
    while (!signal.aborted && !this.shuttingDown) {
      if (refreshRequired) {
        try {
          await this.refreshClient(signal);
          refreshRequired = false;
        } catch (error) {
          if (signal.aborted || this.shuttingDown) return;
          this.emit("error", normalizedError(error, "Failed to rediscover the OpenCode V2 service."));
          this.setStatus("connecting");
          await this.dependencies.delay(this.options.reconnectDelayMs * 2, signal).catch(() => undefined);
          continue;
        }
      }

      let connectedThisAttempt = false;
      try {
        const events = this.client!.event.subscribe({ signal });
        for await (const event of events) {
          if (event.type === "server.connected") {
            await this.quiesceInterruptedExecution(signal);
            connectedThisAttempt = true;
            this.streamConnected = true;
            if (!this.streamEverConnected) {
              this.streamEverConnected = true;
              ready.resolve();
            } else if (!this.shuttingDown) {
              this.setStatus(this.normalizer.turnOpen ? "active" : "idle");
            }
            continue;
          }
          this.handleNativeEvent(event);
        }
        if (!signal.aborted) throw new Error("OpenCode V2 event stream ended unexpectedly.");
      } catch (error) {
        if (signal.aborted || this.shuttingDown) return;
        this.streamConnected = false;
        refreshRequired = true;
        const streamError = normalizedError(error, "OpenCode V2 event stream failed.");
        if (!this.streamEverConnected) {
          ready.reject(streamError);
          return;
        }
        const turnWasOpen = this.normalizer.turnOpen;
        const lostActiveInputId = this.activeRemoteInputId;
        if (turnWasOpen) {
          // The global SSE stream has no replay cursor. The prompt may still
          // be executing remotely, so a later local turn cannot be admitted
          // until a freshly discovered service has reached a verified idle
          // boundary. Adapter-owned sessions may be interrupted; explicitly
          // resumed sessions are only waited and inspected so foreign work is
          // never cancelled. This avoids cross-turn contamination after a gap.
          if (lostActiveInputId) {
            this.recoveryInputIds.add(lostActiveInputId);
            const input = this.originatedInputs.get(lostActiveInputId);
            // Exact resume is a shared attachment. Disable session-wide
            // promoted cleanup before failActiveTurn synchronously requests
            // cleanup, not afterward.
            if (input && !this.ownsNativeSession && input.allowPromotedInterrupt) {
              this.updateOriginatedInput(input, { allowPromotedInterrupt: false });
            }
          }
          this.failActiveTurn(streamError);
        }
        // Cleanup can outlive the normalized turn (Stop settles locally before
        // its exact-id DELETE/interrupt completes). A stream gap during that
        // interval is still a dirty native boundary and must rediscover,
        // reconcile, wait, and stabilize before another prompt is admitted.
        for (const input of this.originatedInputs.values()) {
          if (!input.cleanupRequested) continue;
          this.recoveryInputIds.add(input.id);
          if (!this.ownsNativeSession && input.allowPromotedInterrupt) {
            this.updateOriginatedInput(input, { allowPromotedInterrupt: false });
          }
        }
        if (
          turnWasOpen
          || this.recoveryInputIds.size > 0
          || this.unresolvedSessionInterrupts.size > 0
        ) {
          this.remoteExecutionNeedsQuiescence = true;
        }
        if (!turnWasOpen) this.emit("error", streamError);
        this.setStatus("connecting");
        await this.dependencies.delay(
          connectedThisAttempt ? this.options.reconnectDelayMs : this.options.reconnectDelayMs * 2,
          signal,
        ).catch(() => undefined);
      }
    }
  }

  private handleNativeEvent(event: OpenCodeEvent): void {
    const data = event.data as { sessionID?: string };
    if (!this.nativeSessionId || data.sessionID !== this.nativeSessionId) return;

    if (event.type === "session.input.admitted") {
      const originated = this.originatedInputs.get(event.data.inputID);
      if (originated) {
        this.updateOriginatedInput(originated, { admitted: true });
        if (originated.cleanupRequested) void this.attemptInputCleanup(originated.id);
      }
      if (this.normalizer.turnOpen && event.data.inputID === this.activeRemoteInputId) {
        this.activeInputAdmitted = true;
      }
      // Admission alone does not own output. Another client may queue behind
      // this adapter's active input without contaminating it; only promotion
      // changes which input the execution is processing.
      return;
    }
    if (event.type === "session.input.promoted") {
      const originated = this.originatedInputs.get(event.data.inputID);
      if (originated) {
        this.updateOriginatedInput(originated, { admitted: true, promoted: true });
        if (originated.cleanupRequested || !this.normalizer.turnOpen) {
          this.updateOriginatedInput(originated, { cleanupRequested: true });
          void this.attemptInputCleanup(originated.id);
          return;
        }
      }
      if (!this.normalizer.turnOpen) return;
      if (event.data.inputID !== this.activeRemoteInputId) {
        // If our input had already promoted, its model step has crossed into a
        // coalesced foreign input. The foreign input now owns the execution, so
        // fail locally but do not interrupt it. If ours was still queued,
        // retain its exact id for cancellation/late-promotion cleanup.
        if (this.activeInputPromoted && this.activeRemoteInputId) {
          this.retireOriginatedInput(this.activeRemoteInputId);
        }
        this.failActiveTurn(new Error(
          "OpenCode V2 promoted another client's input while a local turn was pending.",
        ));
        return;
      }
      this.activeInputAdmitted = true;
      this.activeInputPromoted = true;
      this.setStatus("active");
      return;
    }
    if (event.type === "session.input.queued" || event.type === "session.input.steered") {
      return;
    }
    if (event.type === "session.input.cancelled") {
      const originated = this.originatedInputs.get(event.data.inputID);
      if (originated) this.retireOriginatedInput(originated.id);
      if (this.normalizer.turnOpen && event.data.inputID === this.activeRemoteInputId) {
        if (originated?.cleanupRequested) {
          this.emitNormalized(this.normalizer.ingest({
            source: "adapter_control",
            sequence: this.sequence++,
            event: "interrupt",
          }));
        } else {
          this.failActiveTurn(new Error("OpenCode V2 cancelled the admitted prompt before completion."));
        }
      }
      return;
    }

    const executionTerminal = event.type === "session.execution.succeeded"
      || event.type === "session.execution.failed"
      || event.type === "session.execution.interrupted"
      || event.type === "session.idle";
    if (executionTerminal && !this.normalizer.turnOpen) {
      for (const input of [...this.originatedInputs.values()]) {
        // A native terminal proves the old execution ended, but not that an
        // already-received session-wide interrupt request is inert. Keep its
        // cleanup fence until that HTTP control request answers; a Transport
        // failure remains admission-ambiguous.
        if (input.promoted && !input.cleanupRequested) {
          this.retireOriginatedInput(input.id);
        }
      }
      this.pendingQuestions.clear();
      this.setStatus("idle");
      return;
    }
    if (this.normalizer.turnOpen && !this.activeInputPromoted) {
      // execution.started precedes input promotion in product V2 and may
      // describe a coalesced busy period. Output ownership begins only at the
      // matching input.promoted edge, never at session or execution scope.
      if (executionTerminal) {
        this.failActiveTurn(new Error(
          "OpenCode V2 execution ended before the local input was promoted; the pending input was quarantined.",
        ));
        this.setStatus("idle");
      }
      return;
    }

    if (event.type === "session.step.started") {
      (this.session as { model?: string }).model = modelName(event.data.model);
      this.emitSessionSnapshot();
    } else if (event.type === "session.step.ended" || event.type === "session.step.failed") {
      this.patchUsage(event.data.tokens, event.data.cost);
    } else if (event.type === "session.usage.updated") {
      this.patchUsage(event.data.tokens, event.data.cost);
    }

    const terminalInputId = executionTerminal ? this.activeRemoteInputId : null;
    const normalized = this.normalizer.ingest({
      source: "harness",
      sequence: this.sequence++,
      payload: event,
    });
    if (event.type === "question.asked") {
      const blockIds = [...this.normalizer.questionBlockIds(event.data.id)];
      this.pendingQuestions.set(event.data.id, {
        answers: blockIds.map(() => []),
        answered: new Set(),
        blockIds,
      });
    } else if (event.type === "question.replied" || event.type === "question.rejected") {
      this.pendingQuestions.delete(event.data.requestID);
    }
    // EventEmitter listeners run synchronously. Populate/retire question
    // routing before exposing normalized blocks so an immediate answer cannot
    // race and disappear.
    this.emitNormalized(normalized);
    if (terminalInputId) {
      const input = this.originatedInputs.get(terminalInputId);
      if (!input?.cleanupRequested) this.retireOriginatedInput(terminalInputId);
    }

    if (executionTerminal) {
      this.pendingQuestions.clear();
      this.setStatus("idle");
    }
  }

  private patchUsage(
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined,
    cost: number | undefined,
  ): void {
    if (!tokens) return;
    const providerMeta = this.session.providerMeta ?? {};
    (this.session as { providerMeta?: Record<string, unknown> }).providerMeta = {
      ...providerMeta,
      usage: {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        reasoningTokens: tokens.reasoning,
        cachedInputTokens: tokens.cache.read,
        totalTokens: tokens.input + tokens.output + tokens.reasoning,
        ...(typeof cost === "number" ? { costUsd: cost } : {}),
      },
    };
    this.emitSessionSnapshot();
  }

  private emitSessionSnapshot(): void {
    this.emit("event", { event: "session:update", session: { ...this.session } });
  }

  private async runPrompt(prompt: Prompt): Promise<void> {
    if (this.shuttingDown) return;
    // A promoted cleanup uses the session-wide interrupt endpoint. Its native
    // terminal can arrive before the HTTP request settles, so keep the next
    // admission behind the in-flight cleanup barrier; otherwise that delayed
    // interrupt could strike the new turn.
    if (this.inputCleanupInFlight.size > 0) {
      await settleWithin(
        Promise.allSettled([...this.inputCleanupInFlight.values()]),
        2_100,
      );
    }
    if (this.shuttingDown) return;
    const unresolvedPreviousInput = this.inputCleanupInFlight.size > 0
      || this.unresolvedSessionInterrupts.size > 0
      || [...this.originatedInputs.values()].some((input) => input.cleanupRequested);
    const turnId = this.dependencies.nextId();
    // Product V2 brands user-input identifiers with the `msg_` prefix even
    // though the generated Promise client's flattened type is only `string`.
    const remoteInputId = remoteMessageId(this.dependencies.nextId());
    const inputState: OriginatedInputState = {
      id: remoteInputId,
      postStarted: false,
      postSettled: false,
      serverResponseObserved: false,
      admitted: false,
      promoted: false,
      cleanupRequested: false,
      cleanupErrorReported: false,
      allowPromotedInterrupt: true,
      cleanupRevision: 0,
    };
    this.originatedInputs.set(remoteInputId, inputState);
    const completion = deferred<void>();
    this.activeTurnCompletion = completion;
    this.activeRemoteInputId = remoteInputId;
    this.activeInputAdmitted = false;
    this.activeInputPromoted = false;
    this.emitNormalized(this.normalizer.ingest({
      source: "adapter_control",
      sequence: this.sequence++,
      event: "prompt_accepted",
      turnId,
      payload: { remoteSessionId: this.nativeSessionId },
    }));

    const promptAbort = new AbortController();
    this.activePromptAbort = promptAbort;
    const request = linkedTimeoutSignal(promptAbort.signal, this.options.startupTimeoutMs);
    try {
      const client = this.client;
      const nativeSessionId = this.nativeSessionId;
      if (!client || !nativeSessionId || !this.streamConnected) {
        throw new Error("OpenCode V2 service is not connected.");
      }
      if (unresolvedPreviousInput) {
        throw new Error(
          "OpenCode V2 cannot admit another prompt until the previous native input is cancelled or quiescent.",
        );
      }
      const active = await client.session.active({ signal: request.signal });
      const pending = await client.session.pending.list(
        { sessionID: nativeSessionId },
        { signal: request.signal },
      );
      if (active[nativeSessionId] || pending.length > 0) {
        throw new Error(
          `OpenCode V2 session ${nativeSessionId} already has active or pending work from another client.`,
        );
      }
      if (!this.streamConnected || client !== this.client || nativeSessionId !== this.nativeSessionId) {
        throw new Error("OpenCode V2 event stream disconnected before prompt admission.");
      }
      if (!this.normalizer.turnOpen || this.activeRemoteInputId !== remoteInputId) {
        // An interrupt or a foreign promotion may have settled this turn while
        // the non-atomic idle checks were in flight. Never post an orphaned
        // prompt after ownership has already been lost.
        return;
      }
      const files = promptFiles(prompt, this.session.cwd ?? this.config.cwd);
      this.updateOriginatedInput(inputState, { postStarted: true });
      const admitted = await client.session.prompt(
        {
          sessionID: nativeSessionId,
          id: remoteInputId,
          text: prompt.text,
          ...(files.length ? { files } : {}),
          // OpenScout exposes single, serialized turns. Native steering can
          // coalesce another input into an active execution and has no faithful
          // normalized boundary, so the server adapter always queues.
          delivery: "queue",
          resume: true,
        },
        { signal: request.signal },
      );
      this.updateOriginatedInput(inputState, {
        postSettled: true,
        serverResponseObserved: true,
      });
      if (admitted.id !== remoteInputId || admitted.sessionID !== nativeSessionId) {
        throw new Error("OpenCode V2 returned an unexpected prompt admission identity.");
      }
      this.updateOriginatedInput(inputState, { admitted: true });
      if (!this.normalizer.turnOpen || this.activeRemoteInputId !== remoteInputId) {
        // The HTTP request crossed an interrupt/concurrency edge. Retain the
        // stable id until pending cancellation, late matching promotion plus
        // native interruption, or bounded native reconciliation closes it.
        this.markInputForCleanup(remoteInputId);
        await this.attemptInputCleanup(remoteInputId);
        return;
      }
      // The HTTP response is also authoritative admission evidence. Normally
      // the durable session.input.admitted event arrives first; accepting the
      // response covers a scheduler delay without weakening input-id checks.
      if (this.activeRemoteInputId === remoteInputId && this.normalizer.turnOpen) {
        this.activeInputAdmitted = true;
      }
    } catch (error) {
      this.updateOriginatedInput(inputState, {
        postSettled: true,
        ...(httpServerResponseObserved(error) ? { serverResponseObserved: true } : {}),
      });
      const authoritativeRejection = isAuthoritativePromptRejection(error)
        && !inputState.admitted
        && !this.activeInputAdmitted;
      if (authoritativeRejection) {
        // Declared 400/401/404 prompt responses prove the server rejected the
        // request before admission. Do not quarantine an id that cannot exist;
        // doing so would turn the inevitable pending DELETE 404 into a
        // permanent cross-turn liveness failure. A 409 remains ambiguous.
        this.retireOriginatedInput(remoteInputId);
        if (this.normalizer.turnOpen && this.activeRemoteInputId === remoteInputId) {
          this.failActiveTurn(normalizedError(error, "OpenCode V2 rejected the prompt."));
        }
      } else if (inputState.cleanupRequested || !this.normalizer.turnOpen) {
        if (inputState.cleanupRequested) await this.attemptInputCleanup(remoteInputId);
      } else if (
        this.normalizer.turnOpen
        && !(this.activeRemoteInputId === remoteInputId && (this.activeInputAdmitted || inputState.admitted))
      ) {
        this.failActiveTurn(normalizedError(error, "OpenCode V2 rejected the prompt."));
      }
    } finally {
      request.dispose();
      if (this.activePromptAbort === promptAbort) this.activePromptAbort = null;
    }

    if (this.normalizer.turnOpen) {
      await completion.promise;
    }
    if (this.activeTurnCompletion === completion) this.activeTurnCompletion = null;
  }

  private markInputForCleanup(inputId: string): void {
    const input = this.originatedInputs.get(inputId);
    if (!input) return;
    this.updateOriginatedInput(input, { cleanupRequested: true });
    if (!input.postStarted) {
      this.retireOriginatedInput(inputId);
      return;
    }
    void this.attemptInputCleanup(inputId);
  }

  private async interruptNativeSession(
    client: OpenCodeClient,
    nativeSessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const request = Symbol("opencode-v2-session-interrupt");
    this.unresolvedSessionInterrupts.add(request);
    try {
      await client.session.interrupt(
        { sessionID: nativeSessionId },
        { signal },
      );
      this.unresolvedSessionInterrupts.delete(request);
    } catch (error) {
      // A decoded/undeclared HTTP response proves this handler is done even if
      // it rejected. Transport/timeout does not: product V2 may have received
      // the uninterruptible request and apply it to a later execution.
      if (httpServerResponseObserved(error)) {
        this.unresolvedSessionInterrupts.delete(request);
      }
      throw error;
    }
  }

  private attemptInputCleanup(inputId: string): Promise<void> {
    const existing = this.inputCleanupInFlight.get(inputId);
    if (existing) return existing;
    const input = this.originatedInputs.get(inputId);
    if (!input?.cleanupRequested || !this.client || !this.nativeSessionId) {
      return Promise.resolve();
    }
    const attemptedPromotion = input.promoted;
    const sessionInterrupt = attemptedPromotion && input.allowPromotedInterrupt;
    if (sessionInterrupt && this.unresolvedSessionInterrupts.size > 0) {
      return Promise.resolve();
    }
    const attemptedRevision = input.cleanupRevision;
    const client = this.client;
    const nativeSessionId = this.nativeSessionId;
    const cleanup = (async () => {
      try {
        if (attemptedPromotion && !sessionInterrupt) return;
        if (sessionInterrupt) {
          await this.interruptNativeSession(
            client,
            nativeSessionId,
            AbortSignal.timeout(2_000),
          );
        } else {
          await client.session.pending.cancel(
            { sessionID: nativeSessionId, inputID: inputId },
            { signal: AbortSignal.timeout(2_000) },
          );
        }
        const current = this.originatedInputs.get(inputId);
        if (sessionInterrupt) {
          // A successful session-wide interrupt response is the authoritative
          // control boundary. Finalize this exact originated input even if
          // prompt admission/HTTP evidence advanced its cleanup revision while
          // the interrupt was in flight; retrying would endanger later work.
          if (current === input) this.retireOriginatedInput(inputId);
          return;
        }
        if (
          current === input
          && !current.promoted
          && (current.serverResponseObserved || current.admitted)
        ) {
          this.retireOriginatedInput(inputId);
        }
      } catch (error) {
        const current = this.originatedInputs.get(inputId);
        if (current && !current.cleanupErrorReported && !this.shuttingDown) {
          current.cleanupErrorReported = true;
          this.emit("error", normalizedError(
            error,
            attemptedPromotion
              ? "OpenCode V2 failed to interrupt a late promoted input."
              : "OpenCode V2 has not yet confirmed pending-input cancellation.",
          ));
        }
      } finally {
        this.inputCleanupInFlight.delete(inputId);
        const current = this.originatedInputs.get(inputId);
        if (
          !sessionInterrupt
          && current?.cleanupRequested
          && current.cleanupRevision !== attemptedRevision
        ) {
          queueMicrotask(() => void this.attemptInputCleanup(inputId));
        }
      }
    })();
    this.inputCleanupInFlight.set(inputId, cleanup);
    return cleanup;
  }

  private retireOriginatedInput(inputId: string): void {
    this.originatedInputs.delete(inputId);
    this.recoveryInputIds.delete(inputId);
  }

  private updateOriginatedInput(
    input: OriginatedInputState,
    patch: Partial<Pick<
      OriginatedInputState,
      | "postStarted"
      | "postSettled"
      | "serverResponseObserved"
      | "admitted"
      | "promoted"
      | "cleanupRequested"
      | "allowPromotedInterrupt"
    >>,
  ): void {
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
      const value = patch[key];
      if (value === undefined || input[key] === value) continue;
      (input as unknown as Record<string, unknown>)[key] = value;
      changed = true;
    }
    if (changed) input.cleanupRevision += 1;
  }

  private failActiveTurn(error: Error): void {
    if (this.activeRemoteInputId) this.markInputForCleanup(this.activeRemoteInputId);
    this.emit("error", error);
    this.emitNormalized(this.normalizer.ingest({
      source: "adapter_control",
      sequence: this.sequence++,
      event: "transport_error",
      payload: { message: error.message },
    }));
  }

  private failTurnIfCurrent(
    turnId: string | null | undefined,
    inputId: string | null,
    error: Error,
  ): void {
    if (
      turnId
      && inputId
      && this.normalizer.turnOpen
      && this.normalizer.currentTurnId === turnId
      && this.activeRemoteInputId === inputId
    ) {
      this.failActiveTurn(error);
      return;
    }
    // Permission/question HTTP replies can settle after their native event and
    // terminal. Never let a stale rejection tear down a later turn.
    this.emit("error", error);
  }

  private emitNormalized(events: readonly AgentSessionStreamEvent[]): void {
    for (const event of events) {
      this.emit("event", event);
      if (event.event === "turn:end") {
        this.activePromptAbort?.abort(new Error("OpenCode V2 turn settled."));
        this.activeRemoteInputId = null;
        this.activeInputAdmitted = false;
        this.activeInputPromoted = false;
        this.activeTurnCompletion?.resolve();
        this.activeTurnCompletion = null;
      }
    }
  }

  /** Exposed only for focused adapter tests. */
  get debugNativeSessionId(): string | null {
    return this.nativeSessionId;
  }
}

export const createAdapter = (config: AdapterConfig) => new OpenCodeV2Adapter(config);

/** Narrow capability object for registries that cannot consume adapter.spec.json. */
export const OPENCODE_V2_CAPABILITIES = Object.freeze({
  protocolVersion: "v2",
  transport: "http-sse",
  exactResume: true,
  textStreaming: true,
  reasoningStreaming: true,
  tools: true,
  files: true,
  images: true,
  questions: true,
  approvals: true,
  interrupt: true,
  sharedService: true,
  stopsSharedService: false,
});
