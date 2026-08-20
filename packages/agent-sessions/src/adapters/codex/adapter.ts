import { homedir } from "node:os";
import { join } from "node:path";

import {
  CodexAppServerTransport,
  type CodexAppServerNotification,
  type CodexAppServerSessionOptions,
} from "../../local/transports/codex-app-server.js";
import { BaseAdapter } from "../../protocol/adapter.js";
import type { AdapterConfig } from "../../protocol/adapter.js";
import { createLiveNormalizerContext } from "../../protocol/live-normalizer-context.js";
import type {
  AgentSessionStreamEvent,
  Prompt,
} from "../../protocol/primitives.js";
import {
  CodexEventNormalizer,
  createCodexEventNormalizer,
} from "./normalizer.js";
import { CodexObservedTopologyTracker } from "./topology.js";

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export class CodexAdapter extends BaseAdapter {
  readonly type = "codex";

  private transport: CodexAppServerTransport | null = null;
  private removeTransportNotificationListener: (() => void) | null = null;
  private removeTransportErrorListener: (() => void) | null = null;
  private serialized = Promise.resolve();
  private starting: Promise<void> | null = null;

  private currentThreadId: string | null = null;
  private currentThreadPath: string | null = null;
  private currentTurnId: string | null = null;
  private readonly observedTopology: CodexObservedTopologyTracker;
  private readonly normalizer: CodexEventNormalizer;
  private sequence = 0;

  constructor(config: AdapterConfig) {
    super(config);
    const runtimeRoot = join(homedir(), ".scout/pairing", "codex", this.session.id);
    this.observedTopology = new CodexObservedTopologyTracker({
      cwd: config.cwd ?? process.cwd(),
      homeDir: config.env?.HOME,
      sessionName: config.name ?? config.sessionId,
    });
    this.normalizer = createCodexEventNormalizer(
      createLiveNormalizerContext(this.session.id),
      {
        sessionName: this.session.name,
        cwd: this.session.cwd ?? config.cwd,
        model: this.session.model,
        providerMeta: {
          ...(this.session.providerMeta ?? {}),
          stdoutLogFile: join(runtimeRoot, "logs/stdout.log"),
          stderrLogFile: join(runtimeRoot, "logs/stderr.log"),
        },
      },
    );
  }

  async start(): Promise<void> {
    await this.ensureStarted();
  }

  send(prompt: Prompt): void {
    void this.enqueue(async () => {
      try {
        await this.ensureStarted();
        const transport = this.requireTransport();
        if (!transport.currentThreadId) {
          throw new Error(`Codex adapter for ${this.session.name} has no active thread.`);
        }

        if (this.currentTurnId) {
          await transport.steerTurn(prompt.text, this.currentTurnId);
          return;
        }

        await transport.startTurn(prompt.text);
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });
  }

  interrupt(): void {
    void this.enqueue(async () => {
      try {
        await this.ensureStarted();
        const transport = this.requireTransport();
        if (!transport.currentThreadId || !this.currentTurnId) {
          return;
        }

        await transport.interruptTurn(this.currentTurnId);
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error(errorMessage(error)));
      }
    });
  }

  async shutdown(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.starting = null;
    this.removeTransportNotificationListener?.();
    this.removeTransportNotificationListener = null;
    this.removeTransportErrorListener?.();
    this.removeTransportErrorListener = null;

    this.emitNormalized(this.normalizer.ingest({
      source: "adapter_control",
      sequence: this.sequence++,
      event: "transport_closed",
    }));
    this.currentTurnId = null;

    if (transport) {
      await transport.shutdown({ reason: `Codex adapter for ${this.session.name} was shut down` });
    }

    this.setStatus("closed");
  }

  private get codexOptions(): CodexAppServerSessionOptions {
    const runtimeRoot = join(homedir(), ".scout/pairing", "codex", this.session.id);
    const configuredThreadId = this.config.options?.["threadId"] as string | undefined;
    const requireExistingThread = this.config.options?.["requireExistingThread"] as boolean | undefined;
    const rawLaunchArgs = this.config.options?.["launchArgs"];
    const launchArgs = Array.isArray(rawLaunchArgs)
      ? rawLaunchArgs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const approvalPolicy = this.config.options?.["approvalPolicy"];
    const sandbox = this.config.options?.["sandbox"];

    return {
      agentName: this.session.name,
      sessionId: this.session.id,
      cwd: this.config.cwd ?? process.cwd(),
      systemPrompt: this.systemPrompt,
      runtimeDirectory: join(runtimeRoot, "runtime"),
      logsDirectory: join(runtimeRoot, "logs"),
      env: this.config.env,
      launchArgs,
      threadId: typeof configuredThreadId === "string" && configuredThreadId.trim().length > 0
        ? configuredThreadId.trim()
        : undefined,
      requireExistingThread: requireExistingThread ?? Boolean(configuredThreadId),
      approvalPolicy: approvalPolicy === "untrusted" || approvalPolicy === "on-request" || approvalPolicy === "on-failure" || approvalPolicy === "never"
        ? approvalPolicy
        : undefined,
      sandbox: sandbox === "read-only" || sandbox === "workspace-write" || sandbox === "danger-full-access"
        ? sandbox
        : undefined,
      clientInfo: {
        name: "openscout-pairing",
        title: "OpenScout Pairing",
        version: "0.0.0",
      },
    };
  }

  private get systemPrompt(): string {
    const raw = this.config.options?.systemPrompt;
    return typeof raw === "string" && raw.trim().length > 0
      ? raw
      : "You are a helpful agent working through Pairing.";
  }

  private get stdoutLogPath(): string {
    return this.transport?.stdoutLogFile ?? join(this.codexOptions.logsDirectory, "stdout.log");
  }

  private get stderrLogPath(): string {
    return this.transport?.stderrLogFile ?? join(this.codexOptions.logsDirectory, "stderr.log");
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.serialized.then(task, task);
    this.serialized = next.then(() => undefined, () => undefined);
    return next;
  }

  private requireTransport(): CodexAppServerTransport {
    if (!this.transport) {
      throw new Error(`Codex app-server for ${this.session.name} is not running.`);
    }
    return this.transport;
  }

  private async ensureStarted(): Promise<void> {
    if (this.transport?.isAlive() && this.transport.currentThreadId) {
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
    const options = this.codexOptions;
    this.removeTransportNotificationListener?.();
    this.removeTransportErrorListener?.();
    const transport = new CodexAppServerTransport(options);
    this.transport = transport;
    this.removeTransportNotificationListener = transport.onNotification((message) => this.handleNotification(message));
    this.removeTransportErrorListener = transport.onError((error) => this.failSession(error));

    await transport.ensureOnline();
    if (transport.currentThreadId || transport.currentThreadPath) {
      const thread = {
        ...(transport.currentThreadId ? { id: transport.currentThreadId } : {}),
        ...(transport.currentThreadPath ? { path: transport.currentThreadPath } : {}),
        cwd: options.cwd,
      };
      this.syncThreadShellState(thread);
      this.emitNormalized(this.normalizer.ingest({
        source: "harness",
        sequence: this.sequence++,
        payload: {
          method: "thread/started",
          params: { thread },
        },
      }));
      this.attachLogPathsAndEmit();
    }
    this.setStatus("idle");
  }

  private handleNotification(message: CodexAppServerNotification): void {
    const params = message.params ?? {};

    // Live shell topology observation (may read filesystem). Pure normalizer only
    // receives the resulting topology_observed control record.
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = params.item as Record<string, unknown> | undefined;
      if (item && this.observedTopology.observeItem(
        item,
        message.method === "item/started" ? "started" : "completed",
      )) {
        this.pushObservedTopology();
      }
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      const thread = params.thread as Record<string, unknown> | undefined;
      if (thread) {
        this.syncThreadShellState(thread);
      }
    }

    this.emitNormalized(this.normalizer.ingest({
      source: "harness",
      sequence: this.sequence++,
      payload: {
        method: message.method,
        params,
      },
    }));

    // Re-attach log paths after normalizer session updates.
    if (
      message.method === "thread/started"
      || message.method === "thread/name/updated"
      || message.method === "thread/status/changed"
    ) {
      this.attachLogPathsAndEmit();
    }
  }

  private syncThreadShellState(thread: Record<string, unknown>): void {
    const threadId = typeof thread.id === "string" ? thread.id : null;
    const threadPath = typeof thread.path === "string" ? thread.path : null;
    if (threadId) this.currentThreadId = threadId;
    if (threadPath !== null) this.currentThreadPath = threadPath;
    this.observedTopology.updateThread(thread);
  }

  private pushObservedTopology(): void {
    const topology = this.observedTopology.toTopology();
    this.emitNormalized(this.normalizer.ingest({
      source: "adapter_control",
      sequence: this.sequence++,
      event: "topology_observed",
      payload: topology ?? null,
    }));
    this.attachLogPathsAndEmit();
  }

  private attachLogPathsAndEmit(): void {
    const providerMeta: Record<string, unknown> = {
      ...(this.session.providerMeta ?? {}),
    };
    if (this.currentThreadId) providerMeta.threadId = this.currentThreadId;
    if (this.currentThreadPath) providerMeta.threadPath = this.currentThreadPath;
    providerMeta.stdoutLogFile = this.stdoutLogPath;
    providerMeta.stderrLogFile = this.stderrLogPath;
    const topology = this.observedTopology.toTopology();
    if (topology) {
      providerMeta.observedTopology = topology;
    }
    this.session.providerMeta = providerMeta;
    this.emit("event", {
      event: "session:update",
      session: {
        ...this.session,
        providerMeta: { ...providerMeta },
      },
    });
  }

  private emitNormalized(events: readonly AgentSessionStreamEvent[]): void {
    for (const event of events) {
      if (event.event === "session:update") {
        this.session.name = event.session.name;
        this.session.status = event.session.status;
        this.session.cwd = event.session.cwd;
        this.session.model = event.session.model;
        this.session.providerMeta = event.session.providerMeta;
        (this.session as { adapterType: string }).adapterType = this.type;
      }
      if (event.event === "turn:start") {
        this.currentTurnId = event.turn.id;
      }
      if (event.event === "turn:end") {
        this.currentTurnId = null;
      }
      this.emit("event", event);
    }
  }

  private failSession(error: Error): void {
    this.starting = null;
    this.emitNormalized(this.normalizer.ingest({
      source: "adapter_control",
      sequence: this.sequence++,
      event: "transport_error",
      payload: { message: error.message },
    }));
    this.currentTurnId = null;
    this.emit("error", error);
    this.setStatus("error");
  }
}


export const createAdapter = (config: AdapterConfig) => new CodexAdapter(config);
