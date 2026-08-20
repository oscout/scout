// Pi adapter — persistent process with bidirectional RPC.
//
// Spawns `pi --mode rpc` as a persistent process. The Pi coding agent streams
// structured JSON events for the full turn lifecycle: agent_start, turn_start,
// message_start, message_update (text_delta, tool_use, tool_result, thinking),
// message_end, turn_end, agent_end.
//
// Pi RPC commands:
//   prompt       — send a user message (starts a turn)
//   steer        — inject mid-turn guidance (maps to Proposal 002)
//   follow_up    — queue a follow-up after current turn
//   abort        — interrupt the current turn
//   get_state    — get session state
//   new_session  — start a fresh session
//   switch_session / fork — session management
//
// Faithful harness: Pi's extensions, skills, and prompt templates are loaded
// from the project's config unless explicitly disabled. The adapter deliberately
// does not inherit the full environment; it forwards only runtime basics and
// credentials for the selected provider.

import { BaseAdapter } from "../../protocol/adapter.js";
import type { AdapterConfig } from "../../protocol/adapter.js";
import type {
  Action,
  Block,
  BlockStatus,
  Prompt,
  Turn,
  TurnStatus,
} from "../../protocol/primitives.js";
import {
  spawnHarnessProcess,
  type HarnessProcess,
} from "../../runtime/process.js";
import { redactSecrets, registerSecretValue } from "../../secret-redaction.js";

const BASE_PROCESS_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;

type EnvSource = Record<string, string | undefined>;

type CredentialEnvMapping = {
  outputKey: string;
  sourceKeys?: readonly string[];
};

const PROVIDER_CREDENTIAL_ENV: Record<string, readonly CredentialEnvMapping[]> = {
  anthropic: [
    { outputKey: "ANTHROPIC_API_KEY" },
    { outputKey: "ANTHROPIC_OAUTH_TOKEN" },
  ],
  azure: [
    { outputKey: "AZURE_OPENAI_API_KEY" },
    { outputKey: "AZURE_OPENAI_BASE_URL" },
    { outputKey: "AZURE_OPENAI_RESOURCE_NAME" },
    { outputKey: "AZURE_OPENAI_API_VERSION" },
    { outputKey: "AZURE_OPENAI_DEPLOYMENT_NAME_MAP" },
  ],
  bedrock: [
    { outputKey: "AWS_ACCESS_KEY_ID" },
    { outputKey: "AWS_SECRET_ACCESS_KEY" },
    { outputKey: "AWS_SESSION_TOKEN" },
    { outputKey: "AWS_REGION" },
    { outputKey: "AWS_DEFAULT_REGION" },
    { outputKey: "AWS_PROFILE" },
  ],
  cerebras: [{ outputKey: "CEREBRAS_API_KEY" }],
  gemini: [{ outputKey: "GEMINI_API_KEY" }],
  google: [{ outputKey: "GEMINI_API_KEY" }],
  groq: [{ outputKey: "GROQ_API_KEY" }],
  kimi: [{ outputKey: "KIMI_API_KEY" }],
  minimax: [{
    outputKey: "MINIMAX_API_KEY",
    sourceKeys: ["MINIMAX_API_KEY", "MINIMAX_TOKEN"],
  }],
  mistral: [{ outputKey: "MISTRAL_API_KEY" }],
  moonshot: [{ outputKey: "KIMI_API_KEY" }],
  openai: [{ outputKey: "OPENAI_API_KEY" }],
  openrouter: [{ outputKey: "OPENROUTER_API_KEY" }],
  opencode: [{ outputKey: "OPENCODE_API_KEY" }],
  vercel: [{ outputKey: "AI_GATEWAY_API_KEY" }],
  xai: [{ outputKey: "XAI_API_KEY", sourceKeys: ["XAI_API_KEY", "SCOUT_XAI_API_KEY"] }],
  zai: [{ outputKey: "ZAI_API_KEY" }],
};

function readEnvValue(source: EnvSource | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function copyFirstValue(
  target: Record<string, string>,
  outputKey: string,
  keys: readonly string[],
  sources: readonly EnvSource[],
): void {
  for (const source of sources) {
    for (const key of keys) {
      const value = readEnvValue(source, key);
      if (value) {
        target[outputKey] = value;
        return;
      }
    }
  }
}

function normalizeProvider(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "azure-openai") return "azure";
  if (normalized === "aws" || normalized === "aws-bedrock") return "bedrock";
  if (normalized === "ai-gateway" || normalized === "ai_gateway") return "vercel";
  if (normalized === "grok" || normalized === "x-ai") return "xai";
  return normalized;
}

function inferProviderFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("/")) {
    return normalizeProvider(normalized.split("/", 1)[0]);
  }
  if (normalized.startsWith("minimax")) return "minimax";
  if (normalized.startsWith("grok")) return "xai";
  if (normalized.startsWith("claude")) return "anthropic";
  if (
    normalized.startsWith("gpt")
    || normalized.startsWith("o1")
    || normalized.startsWith("o3")
    || normalized.startsWith("o4")
  ) return "openai";
  if (normalized.startsWith("gemini")) return "google";
  if (normalized.startsWith("mistral") || normalized.startsWith("codestral")) return "mistral";
  return undefined;
}

function normalizePiThinkingLevel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.toLowerCase() === "none" ? "off" : normalized;
}

function normalizePiProviderArgument(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const lowered = normalized.toLowerCase();
  return lowered === "grok" || lowered === "x-ai" ? "xai" : normalized;
}

function selectedProvider(options: AdapterConfig["options"] | undefined): string | undefined {
  const provider = typeof options?.provider === "string" ? options.provider : undefined;
  const model = typeof options?.model === "string" ? options.model : undefined;
  return normalizeProvider(provider) ?? inferProviderFromModel(model);
}

function isLikelySessionFilePath(value: string | undefined): value is string {
  if (!value) return false;
  return value.includes("/") || value.endsWith(".jsonl");
}

const MAX_PI_STDERR_CHARS = 4_096;

function appendBoundedStderr(current: string, line: string): string {
  const next = current ? `${current}\n${line}` : line;
  return next.length <= MAX_PI_STDERR_CHARS
    ? next
    : next.slice(-MAX_PI_STDERR_CHARS);
}

function summarizePiStderr(stderr: string): string {
  return stderr.trim().replace(/\s+/gu, " ");
}

export function buildPiLaunchArgs(options: AdapterConfig["options"] = {}): string[] {
  const args = ["--mode", "rpc"];

  const model = options?.["model"] as string | undefined;
  if (model) args.push("--model", model);

  const provider = normalizePiProviderArgument(options?.["provider"] as string | undefined);
  if (provider) args.push("--provider", provider);

  const thinking = normalizePiThinkingLevel(options?.["thinking"] as string | undefined);
  if (thinking) args.push("--thinking", thinking);

  const resume = options?.["resume"] as boolean | undefined;
  if (resume) args.push("--continue");

  // Pi owns its native session ids. Scout's AdapterConfig.sessionId is a
  // control-plane id and must never be forwarded as a Pi CLI flag. An explicit
  // native session reference is the only value that belongs on --resume.
  const session = options?.["session"] as string | undefined;
  if (session) args.push("--resume", session);

  const sessionDir = options?.["sessionDir"] as string | undefined;
  if (sessionDir) args.push("--session-dir", sessionDir);

  const appendSystemPrompt = options?.["appendSystemPrompt"] as string | undefined;
  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);

  const extensions = options?.["extensions"] as string[] | undefined;
  if (extensions) {
    for (const ext of extensions) args.push("--extension", ext);
  }

  const extraArgs = options?.["extraArgs"] as string[] | undefined;
  if (extraArgs) args.push(...extraArgs);

  return args;
}

export function buildPiProcessEnv(
  config: Pick<AdapterConfig, "env" | "options">,
  sourceEnv: EnvSource = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const sources = [config.env ?? {}, sourceEnv];

  for (const key of BASE_PROCESS_ENV_KEYS) {
    copyFirstValue(env, key, [key], sources);
  }

  const provider = selectedProvider(config.options);
  const credentialMappings = provider ? PROVIDER_CREDENTIAL_ENV[provider] : undefined;
  if (!credentialMappings) {
    return env;
  }

  for (const mapping of credentialMappings) {
    copyFirstValue(env, mapping.outputKey, mapping.sourceKeys ?? [mapping.outputKey], sources);
    registerSecretValue(env[mapping.outputKey], "pi:provider-env");
  }

  return env;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PiAdapter extends BaseAdapter {
  readonly type = "pi";

  private process: HarnessProcess | null = null;
  private currentTurn: Turn | null = null;
  private blockIndex = 0;

  // Track streaming blocks for delta accumulation.
  private currentTextBlock: Block | null = null;
  private currentReasoningBlock: Block | null = null;
  private toolBlockByIndex = new Map<number, Block>();
  private toolBlockByToolCallId = new Map<string, Block>();
  private toolOutputByToolCallId = new Map<string, string>();
  private sawStreamingTextInTurn = false;

  constructor(config: AdapterConfig) {
    super(config);
  }

  async start(): Promise<void> {
    const args = buildPiLaunchArgs(this.config.options);
    const model = this.config.options?.["model"] as string | undefined;
    const thinking = normalizePiThinkingLevel(this.config.options?.["thinking"] as string | undefined);
    const sessionPath = this.config.options?.["session"] as string | undefined;
    const sessionDir = this.config.options?.["sessionDir"] as string | undefined;
    const extensions = this.config.options?.["extensions"] as string[] | undefined;

    // Note: we do NOT pass --no-extensions or --no-skills by default.
    // Faithful harness behavior comes from Pi's project config, not shell-wide
    // credential inheritance.

    const env = buildPiProcessEnv(this.config);
    const selected = selectedProvider(this.config.options);
    this.session.model = model;
    this.session.providerMeta = {
      ...(this.session.providerMeta ?? {}),
      transport: "pi_rpc",
      ...(selected ? { provider: selected } : {}),
      ...(isLikelySessionFilePath(sessionPath) ? { threadPath: sessionPath } : {}),
      ...(sessionDir ? { sessionDir } : {}),
      ...(thinking ? { thinking } : {}),
      ...(extensions?.length ? { extensions: [...extensions] } : {}),
      observeRuntime: {
        source: "pi_rpc",
        entrypoint: "pi --mode rpc",
        ...(selected ? { modelProvider: selected } : {}),
        ...(thinking ? { effort: thinking } : {}),
      },
    };

    const child = await spawnHarnessProcess("pi", args, {
      cwd: this.config.cwd,
      env,
    });
    this.process = child;

    this.readStdout();
    let stderr = "";
    let resolveStderrEnd: () => void = () => undefined;
    const stderrEnded = new Promise<void>((resolve) => {
      resolveStderrEnd = resolve;
    });
    child.readStderrLines(
      (line) => {
        stderr = appendBoundedStderr(stderr, line);
      },
      resolveStderrEnd,
    );

    child.onError((error) => {
      if (this.process === child && this.session.status !== "closed") {
        this.emit("error", error);
        this.setStatus("error");
      }
    });
    child.onExit((code, signal) => {
      if (code === 0) return;
      void stderrEnded.then(() => {
        if (this.process !== child || this.session.status === "closed") {
          return;
        }
        const detail = redactSecrets(summarizePiStderr(stderr));
        this.emit("error", new Error(
          `pi exited`
          + (code !== null ? ` with code ${code}` : "")
          + (signal ? ` (${signal})` : "")
          + (detail ? `: ${detail}` : ""),
        ));
        this.setStatus("error");
      });
    });

    this.setStatus("active");
    this.updateSessionProviderMeta({
      launchCommand: "pi --mode rpc",
      ...(typeof this.process.pid === "number" ? { processId: this.process.pid } : {}),
    });
    this.requestState();
  }

  send(prompt: Prompt): void {
    this.updateSessionProviderMeta({
      turnPhase: "queued",
      lastPromptAt: new Date().toISOString(),
    });
    this.sendRPC({
      type: "prompt",
      message: prompt.text,
      images: prompt.images?.map((img) => ({
        mimeType: img.mimeType,
        data: img.data,
      })),
    });
  }

  interrupt(): void {
    this.sendRPC({ type: "abort" });
    if (this.currentTurn) {
      this.endTurn(this.currentTurn, "stopped");
    }
  }

  async shutdown(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = null;
    this.setStatus("closed");
  }

  // ---------------------------------------------------------------------------
  // RPC send
  // ---------------------------------------------------------------------------

  private sendRPC(command: Record<string, unknown>): void {
    const stdin = this.process?.stdin;
    if (!stdin?.writable) return;
    stdin.write(JSON.stringify(command) + "\n");
  }

  private requestState(): void {
    this.sendRPC({ id: `state-${crypto.randomUUID()}`, type: "get_state" });
  }

  // ---------------------------------------------------------------------------
  // Stdout reader
  // ---------------------------------------------------------------------------

  private readStdout(): void {
    this.process?.readStdoutLines(
      (line) => this.handleStdoutLine(line),
      () => {
        if (this.currentTurn && this.currentTurn.status !== "stopped") {
          this.endTurn(this.currentTurn, "completed");
        }
      },
    );
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      this.handleEvent(JSON.parse(trimmed));
    } catch {
      // Ignore malformed harness output.
    }
  }

  // ---------------------------------------------------------------------------
  // Event router — Pi RPC events → Pairing primitives
  // ---------------------------------------------------------------------------

  private handleEvent(event: any): void {
    switch (event.type) {
      case "turn_start": {
        this.blockIndex = 0;
        this.currentTextBlock = null;
        this.currentReasoningBlock = null;
        this.toolBlockByIndex.clear();
        this.toolBlockByToolCallId.clear();
        this.toolOutputByToolCallId.clear();
        this.sawStreamingTextInTurn = false;

        const turn: Turn = {
          id: crypto.randomUUID(),
          sessionId: this.session.id,
          status: "started",
          startedAt: new Date().toISOString(),
          blocks: [],
        };
        this.currentTurn = turn;
        this.updateSessionProviderMeta({ turnPhase: "running" });
        this.emit("event", { event: "turn:start", sessionId: this.session.id, turn });
        break;
      }

      case "turn_end": {
        this.handleTurnEndPayload(event);
        this.closeOpenBlocks();
        if (this.currentTurn) {
          this.endTurn(this.currentTurn, "completed");
        }
        this.updateSessionProviderMeta({
          turnPhase: "ended",
          ...(typeof event.message?.stopReason === "string" ? { lastStopReason: event.message.stopReason } : {}),
        });
        break;
      }

      case "message_update": {
        this.handleMessageUpdate(event);
        break;
      }

      case "message": {
        this.handleMessageRecord(event);
        break;
      }

      case "message_end": {
        // Close any open blocks when a message ends.
        if (event.message?.role === "assistant") {
          this.handleMessageRecord(event);
          this.closeOpenBlocks();
        }
        break;
      }

      case "message_start": {
        // Extract model info from assistant message start.
        if (event.message?.role === "assistant" && event.message?.model) {
          (this.session as any).model = event.message.model;
          this.updateSessionMetadataFromMessageRecord(event, event.message);
        }
        break;
      }

      case "response": {
        if (event.command === "get_state" && event.success && event.data) {
          this.updateSessionMetadataFromState(event.data);
          break;
        }
        // RPC response — check for errors.
        if (!event.success && event.error) {
          if (this.currentTurn) {
            this.emitError(this.currentTurn, event.error);
          }
        }
        break;
      }

      case "agent_start": {
        this.updateSessionProviderMeta({ turnPhase: "agent_start" });
        this.setStatus("active");
        break;
      }

      case "agent_end": {
        this.updateSessionProviderMeta({ turnPhase: "idle", lastCompletedAt: new Date().toISOString() });
        this.requestState();
        this.setStatus("idle");
        break;
      }

      case "queue_update": {
        const pendingMessageCount = typeof event.pendingMessageCount === "number"
          ? event.pendingMessageCount
          : undefined;
        this.updateSessionProviderMeta({
          ...(pendingMessageCount !== undefined ? { pendingMessageCount } : {}),
        });
        break;
      }

      case "tool_execution_start":
        this.handleToolExecutionStart(event);
        break;

      case "tool_execution_update":
        this.handleToolExecutionUpdate(event);
        break;

      case "tool_execution_end":
        this.handleToolExecutionEnd(event);
        break;

      // Extension UI requests and compaction/retry events are session-level
      // details for now; they stay visible in Pi's own transcript.
    }
  }

  // ---------------------------------------------------------------------------
  // Message update handler — the core streaming logic
  // ---------------------------------------------------------------------------

  private handleMessageUpdate(event: any): void {
    if (!this.currentTurn) return;

    const ame = event.assistantMessageEvent;
    if (!ame) return;
    if (event.message?.role === "assistant") {
      this.updateSessionMetadataFromMessageRecord(event, event.message);
    }

    switch (ame.type) {
      // -- Text streaming ---------------------------------------------------
      case "text_start": {
        this.sawStreamingTextInTurn = true;
        this.currentTextBlock = this.startBlock(this.currentTurn, {
          type: "text",
          text: "",
          status: "streaming",
        });
        break;
      }

      case "text_delta": {
        this.sawStreamingTextInTurn = true;
        if (this.currentTextBlock) {
          this.emit("event", {
            event: "block:delta",
            sessionId: this.session.id,
            turnId: this.currentTurn.id,
            blockId: this.currentTextBlock.id,
            text: ame.delta ?? "",
          });
        }
        break;
      }

      case "text_end": {
        if (this.currentTextBlock) {
          this.emitBlockEnd(this.currentTurn, this.currentTextBlock, "completed");
          this.currentTextBlock = null;
        }
        break;
      }

      // -- Thinking/reasoning streaming -------------------------------------
      case "thinking_start": {
        this.currentReasoningBlock = this.startBlock(this.currentTurn, {
          type: "reasoning",
          text: "",
          status: "streaming",
        });
        break;
      }

      case "thinking_delta": {
        if (this.currentReasoningBlock) {
          this.emit("event", {
            event: "block:delta",
            sessionId: this.session.id,
            turnId: this.currentTurn.id,
            blockId: this.currentReasoningBlock.id,
            text: ame.delta ?? "",
          });
        }
        break;
      }

      case "thinking_end": {
        if (this.currentReasoningBlock) {
          this.emitBlockEnd(this.currentTurn, this.currentReasoningBlock, "completed");
          this.currentReasoningBlock = null;
        }
        break;
      }

      // -- Tool use ---------------------------------------------------------
      case "tool_start":
      case "toolcall_start": {
        const contentIndex: number = ame.contentIndex ?? 0;
        const toolCall = this.toolCallFromAssistantEvent(ame, event.message);
        if (!toolCall.id && !toolCall.name) {
          break;
        }
        this.ensureToolActionBlock({
          contentIndex,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input,
        });
        break;
      }

      case "tool_delta": {
        const contentIndex: number = ame.contentIndex ?? 0;
        const block = this.toolBlockByIndex.get(contentIndex);
        if (block) {
          this.emit("event", {
            event: "block:action:output",
            sessionId: this.session.id,
            turnId: this.currentTurn.id,
            blockId: block.id,
            output: ame.delta ?? "",
          });
        }
        break;
      }

      case "toolcall_delta": {
        // Pi streams tool-call arguments separately from tool execution output.
        // The top-level tool_execution_* events carry the user-visible result.
        break;
      }

      case "tool_end": {
        const contentIndex: number = ame.contentIndex ?? 0;
        const block = this.toolBlockByIndex.get(contentIndex);
        if (block) {
          this.emit("event", {
            event: "block:action:status",
            sessionId: this.session.id,
            turnId: this.currentTurn.id,
            blockId: block.id,
            status: "completed",
          });
          this.emitBlockEnd(this.currentTurn, block, "completed");
          this.deleteToolBlock(block);
        }
        break;
      }

      case "toolcall_end": {
        const contentIndex: number = ame.contentIndex ?? 0;
        const toolCall = this.toolCallFromAssistantEvent(ame, event.message);
        this.ensureToolActionBlock({
          contentIndex,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.input,
        });
        break;
      }

      // -- Tool result (separate from tool_end in some flows) ---------------
      case "tool_result_start":
      case "tool_result_delta": {
        const contentIndex: number = ame.contentIndex ?? 0;
        const block = this.toolBlockByIndex.get(contentIndex);
        if (block && ame.delta) {
          this.emit("event", {
            event: "block:action:output",
            sessionId: this.session.id,
            turnId: this.currentTurn.id,
            blockId: block.id,
            output: ame.delta,
          });
        }
        break;
      }

      case "tool_result_end": {
        const contentIndex: number = ame.contentIndex ?? 0;
        const block = this.toolBlockByIndex.get(contentIndex);
        if (block) {
          const isError = ame.content?.is_error ?? false;
          this.emit("event", {
            event: "block:action:status",
            sessionId: this.session.id,
            turnId: this.currentTurn.id,
            blockId: block.id,
            status: isError ? "failed" : "completed",
          });
          this.emitBlockEnd(this.currentTurn, block, isError ? "failed" : "completed");
          this.deleteToolBlock(block);
        }
        break;
      }
    }
  }

  private handleTurnEndPayload(event: any): void {
    if (event.message?.role === "assistant") {
      this.handleMessageRecord(event);
      this.updateSessionMetadataFromMessageRecord(event, event.message);
    }
    if (Array.isArray(event.toolResults)) {
      for (const result of event.toolResults) {
        this.handleToolResultMessage(result);
      }
    }
  }

  private handleToolExecutionStart(event: any): void {
    if (!this.currentTurn) return;
    this.ensureToolActionBlock({
      toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
      toolName: typeof event.toolName === "string" ? event.toolName : undefined,
      input: event.args,
    });
  }

  private handleToolExecutionUpdate(event: any): void {
    if (!this.currentTurn) return;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const block = toolCallId ? this.toolBlockByToolCallId.get(toolCallId) : undefined;
    if (!block) return;
    const output = this.textFromToolResultLike(event.partialResult ?? event.result);
    this.emitToolOutputDelta(block, toolCallId, output);
  }

  private handleToolExecutionEnd(event: any): void {
    if (!this.currentTurn) return;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const block = toolCallId ? this.toolBlockByToolCallId.get(toolCallId) : undefined;
    if (!block) return;
    const output = this.textFromToolResultLike(event.result ?? event.finalResult ?? event.partialResult);
    this.emitToolOutputDelta(block, toolCallId, output);
    const failed = Boolean(event.isError)
      || Boolean(event.result?.isError)
      || Boolean(event.result?.is_error)
      || (typeof event.exitCode === "number" && event.exitCode !== 0);
    this.emit("event", {
      event: "block:action:status",
      sessionId: this.session.id,
      turnId: this.currentTurn.id,
      blockId: block.id,
      status: failed ? "failed" : "completed",
      meta: {
        ...(typeof event.exitCode === "number" ? { exitCode: event.exitCode } : {}),
      },
    });
    this.emitBlockEnd(this.currentTurn, block, failed ? "failed" : "completed");
    this.deleteToolBlock(block, toolCallId);
  }

  private handleToolResultMessage(message: any): void {
    if (!this.currentTurn || message?.role !== "toolResult") return;
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
    const block = toolCallId ? this.toolBlockByToolCallId.get(toolCallId) : undefined;
    if (!block) return;
    const output = this.textFromToolResultLike(message);
    this.emitToolOutputDelta(block, toolCallId, output);
    const failed = Boolean(message.isError) || Boolean(message.is_error);
    this.emit("event", {
      event: "block:action:status",
      sessionId: this.session.id,
      turnId: this.currentTurn.id,
      blockId: block.id,
      status: failed ? "failed" : "completed",
    });
    this.emitBlockEnd(this.currentTurn, block, failed ? "failed" : "completed");
    this.deleteToolBlock(block, toolCallId);
  }

  private ensureToolActionBlock(params: {
    contentIndex?: number;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
  }): Block | null {
    if (!this.currentTurn) return null;

    const existing = params.toolCallId
      ? this.toolBlockByToolCallId.get(params.toolCallId)
      : params.contentIndex !== undefined
        ? this.toolBlockByIndex.get(params.contentIndex)
        : undefined;
    if (existing) {
      if (params.contentIndex !== undefined) {
        this.toolBlockByIndex.set(params.contentIndex, existing);
      }
      if (params.toolCallId) {
        this.toolBlockByToolCallId.set(params.toolCallId, existing);
      }
      return existing;
    }

    const toolName = params.toolName?.trim() || "unknown";
    const toolCallId = params.toolCallId?.trim() || crypto.randomUUID();
    const block = this.startBlock(this.currentTurn, {
      type: "action",
      action: this.buildAction(toolName, toolCallId, params.input),
      status: "streaming",
    });

    if (params.contentIndex !== undefined) {
      this.toolBlockByIndex.set(params.contentIndex, block);
    }
    this.toolBlockByToolCallId.set(toolCallId, block);
    return block;
  }

  private buildAction(toolName: string, toolCallId: string, input: unknown): Action {
    const normalizedInput = this.normalizeToolInput(input);
    if (toolName === "edit" || toolName === "write") {
      return {
        kind: "file_change",
        path: this.stringProperty(normalizedInput, "file_path")
          ?? this.stringProperty(normalizedInput, "path")
          ?? "",
        diff: "",
        status: "running",
        output: "",
      };
    }
    if (toolName === "bash") {
      return {
        kind: "command",
        command: this.stringProperty(normalizedInput, "command") ?? "",
        status: "running",
        output: "",
      };
    }
    return {
      kind: "tool_call",
      toolName,
      toolCallId,
      input: normalizedInput,
      status: "running",
      output: "",
    };
  }

  private normalizeToolInput(input: unknown): unknown {
    if (typeof input !== "string") return input;
    const trimmed = input.trim();
    if (!trimmed) return input;
    try {
      return JSON.parse(trimmed);
    } catch {
      return input;
    }
  }

  private stringProperty(input: unknown, key: string): string | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const value = (input as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }

  private toolCallFromAssistantEvent(ame: any, message: any): { id?: string; name?: string; input?: unknown } {
    const byIndex = Array.isArray(message?.content) && typeof ame.contentIndex === "number"
      ? message.content[ame.contentIndex]
      : undefined;
    const byType = Array.isArray(message?.content)
      ? message.content.find((part: any) => part?.type === "toolCall")
      : undefined;
    const candidate = [ame.content, ame.toolCall, byIndex, byType, ame.partial]
      .find((part) => (
        part
        && typeof part === "object"
        && (
          typeof part.id === "string"
          || typeof part.name === "string"
          || part.input !== undefined
          || part.arguments !== undefined
        )
      ));
    const id = typeof candidate?.id === "string"
      ? candidate.id
      : typeof ame.id === "string"
        ? ame.id
        : undefined;
    const name = typeof candidate?.name === "string"
      ? candidate.name
      : typeof ame.name === "string"
        ? ame.name
        : undefined;
    const input = candidate?.input ?? candidate?.arguments ?? ame.input ?? ame.arguments;
    return { id, name, input };
  }

  private textFromToolResultLike(value: any): string {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value.output === "string") return value.output;
    if (typeof value.stdout === "string") return value.stdout;
    if (typeof value.text === "string") return value.text;
    const content = value.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
          return "";
        })
        .filter(Boolean)
        .join("");
    }
    return "";
  }

  private emitToolOutputDelta(block: Block, toolCallId: string, output: string): void {
    if (!this.currentTurn || !output) return;
    const previous = this.toolOutputByToolCallId.get(toolCallId) ?? "";
    const delta = output.startsWith(previous) ? output.slice(previous.length) : output;
    this.toolOutputByToolCallId.set(toolCallId, output);
    if (!delta) return;
    this.emit("event", {
      event: "block:action:output",
      sessionId: this.session.id,
      turnId: this.currentTurn.id,
      blockId: block.id,
      output: delta,
    });
  }

  private deleteToolBlock(block: Block, toolCallId?: string): void {
    if (toolCallId) {
      this.toolBlockByToolCallId.delete(toolCallId);
      this.toolOutputByToolCallId.delete(toolCallId);
    }
    for (const [index, candidate] of this.toolBlockByIndex) {
      if (candidate.id === block.id) {
        this.toolBlockByIndex.delete(index);
      }
    }
  }

  private handleMessageRecord(event: any): void {
    const message = event.message;
    if (!this.currentTurn || message?.role !== "assistant") {
      return;
    }

    this.updateSessionMetadataFromMessageRecord(event, message);
    if (this.sawStreamingTextInTurn) {
      return;
    }

    const text = this.assistantTextFromMessage(message);
    if (!text.trim()) {
      return;
    }

    const block = this.startBlock(this.currentTurn, {
      type: "text",
      text: "",
      status: "streaming",
    });
    this.emit("event", {
      event: "block:delta",
      sessionId: this.session.id,
      turnId: this.currentTurn.id,
      blockId: block.id,
      text,
    });
    this.emitBlockEnd(this.currentTurn, block, "completed");
  }

  private assistantTextFromMessage(message: any): string {
    const content = message?.content;
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        if ((part.type === "text" || part.type === "output_text") && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  private updateSessionMetadataFromMessageRecord(event: any, message: any): void {
    const model = typeof event.model === "string"
      ? event.model
      : typeof message.model === "string"
      ? message.model
      : undefined;
    const provider = typeof event.provider === "string"
      ? event.provider
      : typeof message.provider === "string"
      ? message.provider
      : undefined;

    const usage = this.observeUsageFromMessage(message);

    if (!model && !provider && !usage) {
      return;
    }

    if (model) {
      this.session.model = model;
    }
    this.updateSessionProviderMeta({
      ...(provider ? { provider } : {}),
      ...(usage ? { observeUsage: usage } : {}),
    });
  }

  // Pi normalizes every provider response (xAI/Grok included, via the
  // OpenAI-compatible completions path in pi-ai) into a single Usage shape:
  //   { input, output, cacheRead, cacheWrite, totalTokens, cost }
  // where `input` is the non-cached prompt portion and `output` already folds
  // reasoning tokens in. We project that into the observe-usage metadata shape
  // the web Tokens panel + context gauge read off providerMeta.observeUsage,
  // merging onto whatever is already there so repeated assistant messages keep
  // the latest cumulative figures. Only fields actually reported are emitted.
  private observeUsageFromMessage(message: any): Record<string, unknown> | undefined {
    const raw = message?.usage;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return undefined;
    }

    const num = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

    const inputTokens = num(raw.input);
    const outputTokens = num(raw.output);
    const cacheReadInputTokens = num(raw.cacheRead);
    const cacheCreationInputTokens = num(raw.cacheWrite);
    const totalTokens = num(raw.totalTokens)
      ?? (inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0)
          + (outputTokens ?? 0)
          + (cacheReadInputTokens ?? 0)
          + (cacheCreationInputTokens ?? 0)
        : undefined);
    // Context "used" = the full prompt for the latest turn (non-cached input +
    // cache read + cache write), so the web context gauge can derive load.
    const contextInputTokens = inputTokens !== undefined
      || cacheReadInputTokens !== undefined
      || cacheCreationInputTokens !== undefined
      ? (inputTokens ?? 0) + (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0)
      : undefined;

    const usage: Record<string, unknown> = {};
    if (inputTokens !== undefined) usage.inputTokens = inputTokens;
    if (outputTokens !== undefined) usage.outputTokens = outputTokens;
    if (cacheReadInputTokens !== undefined) usage.cacheReadInputTokens = cacheReadInputTokens;
    if (cacheCreationInputTokens !== undefined) usage.cacheCreationInputTokens = cacheCreationInputTokens;
    if (totalTokens !== undefined) usage.totalTokens = totalTokens;
    if (contextInputTokens !== undefined && contextInputTokens > 0) {
      usage.contextInputTokens = contextInputTokens;
    }

    if (Object.keys(usage).length === 0) {
      return undefined;
    }

    const current = this.session.providerMeta?.observeUsage;
    const previous = current && typeof current === "object" && !Array.isArray(current)
      ? current as Record<string, unknown>
      : {};
    return { ...previous, ...usage };
  }

  private updateSessionMetadataFromState(data: any): void {
    const model = typeof data.model === "string"
      ? data.model
      : typeof data.model?.id === "string"
        ? data.model.id
        : undefined;
    if (model) {
      this.session.model = model;
    }

    const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
    const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : undefined;
    const pendingMessageCount = typeof data.pendingMessageCount === "number"
      ? data.pendingMessageCount
      : undefined;
    const isStreaming = typeof data.isStreaming === "boolean" ? data.isStreaming : undefined;
    const followUpMode = typeof data.followUpMode === "string" ? data.followUpMode : undefined;
    const sessionName = typeof data.sessionName === "string" ? data.sessionName : undefined;
    this.updateSessionProviderMeta({
      ...(sessionId ? { externalSessionId: sessionId, threadId: sessionId } : {}),
      ...(sessionFile ? { threadPath: sessionFile } : {}),
      ...(pendingMessageCount !== undefined ? { pendingMessageCount } : {}),
      ...(isStreaming !== undefined ? { isStreaming } : {}),
      ...(followUpMode ? { followUpMode } : {}),
      ...(sessionName ? { sessionName } : {}),
    });
  }

  private updateSessionProviderMeta(meta: Record<string, unknown>): void {
    const current = this.session.providerMeta ?? {};
    const currentRuntime = current.observeRuntime && typeof current.observeRuntime === "object" && !Array.isArray(current.observeRuntime)
      ? current.observeRuntime as Record<string, unknown>
      : {};
    const nextRuntime = meta.observeRuntime && typeof meta.observeRuntime === "object" && !Array.isArray(meta.observeRuntime)
      ? meta.observeRuntime as Record<string, unknown>
      : undefined;
    this.session.providerMeta = {
      ...current,
      ...meta,
      ...(nextRuntime ? { observeRuntime: { ...currentRuntime, ...nextRuntime } } : {}),
    };
    this.emit("event", { event: "session:update", session: { ...this.session } });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private closeOpenBlocks(): void {
    if (!this.currentTurn) return;

    if (this.currentTextBlock) {
      this.emitBlockEnd(this.currentTurn, this.currentTextBlock, "completed");
      this.currentTextBlock = null;
    }

    if (this.currentReasoningBlock) {
      this.emitBlockEnd(this.currentTurn, this.currentReasoningBlock, "completed");
      this.currentReasoningBlock = null;
    }

    const openToolBlocks = new Set<Block>([
      ...this.toolBlockByIndex.values(),
      ...this.toolBlockByToolCallId.values(),
    ]);
    for (const block of openToolBlocks) {
      this.emitBlockEnd(this.currentTurn, block, "completed");
    }
    this.toolBlockByIndex.clear();
    this.toolBlockByToolCallId.clear();
    this.toolOutputByToolCallId.clear();
  }

  private startBlock(turn: Turn, partial: Record<string, unknown> & { type: string; status: BlockStatus }): Block {
    const block: Block = {
      ...partial,
      id: crypto.randomUUID(),
      turnId: turn.id,
      index: this.blockIndex++,
    } as Block;

    turn.blocks.push(block);

    this.emit("event", {
      event: "block:start",
      sessionId: this.session.id,
      turnId: turn.id,
      block,
    });

    return block;
  }

  private emitBlockEnd(turn: Turn, block: Block, status: BlockStatus): void {
    block.status = status;
    this.emit("event", {
      event: "block:end",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      status,
    });
  }

  private emitError(turn: Turn, message: string): void {
    const block = this.startBlock(turn, {
      type: "error",
      message,
      status: "completed",
    });
    this.emitBlockEnd(turn, block, "completed");
  }

  private endTurn(turn: Turn, status: TurnStatus): void {
    turn.status = status;
    turn.endedAt = new Date().toISOString();
    this.currentTurn = null;
    this.emit("event", {
      event: "turn:end",
      sessionId: this.session.id,
      turnId: turn.id,
      status,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory export
// ---------------------------------------------------------------------------

export const createAdapter = (config: AdapterConfig) => new PiAdapter(config);
