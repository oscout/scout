// Pure Claude Code harness-event normalizer (SCO-042).
// No filesystem, process, network, environment, stdin, or stdout access.
// Topology file reads and stdin writes stay in the live adapter shell.

import {
  isClaudeCodeQuotaEvent,
  readClaudeCodeQuotaObservation,
} from "./quota.js";
import type {
  Action,
  AgentSessionStreamEvent,
  Block,
  BlockStatus,
  Session,
  Turn,
  TurnStatus,
} from "../../protocol/primitives.js";
import { OBSERVED_HARNESS_TOPOLOGY_META_KEY } from "../../protocol/primitives.js";
import type {
  AdapterReplayRecord,
  HarnessEventNormalizer,
  HarnessEventNormalizerContext,
} from "../../protocol/normalizer.js";
import {
  boundOpaqueValue,
  boundActionInlineText,
  MAX_ACTION_OUTPUT_EVENT_UTF8_BYTES,
  MAX_DIAGNOSTIC_UTF8_BYTES,
  MAX_OPAQUE_BLOCK_VALUE_UTF8_BYTES,
  MAX_SESSION_EVENT_UTF8_BYTES,
  snapshotNormalizedValue,
  splitTextForSessionEvents,
  truncateUtf8,
  utf8ByteLength,
} from "../../protocol/normalizer.js";

const ACTION_OUTPUT_EVENT_METADATA_RESERVE_UTF8_BYTES = 512;

type TextualBlock = Extract<Block, { type: "text" | "reasoning" }>;

export type ClaudeCodeNormalizerOptions = {
  sessionName?: string;
  cwd?: string;
  model?: string;
  providerMeta?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export class ClaudeCodeEventNormalizer implements HarnessEventNormalizer {
  private readonly context: HarnessEventNormalizerContext;
  private session: Session;
  private currentTurn: Turn | null = null;
  private blockIndex = 0;
  private claudeSessionId: string | null = null;
  private toolBlockMap = new Map<string, string>();
  private questionBlockMap = new Map<string, string>();
  private activeStreamBlocks = new Map<number, TextualBlock>();
  private sawStreamTextThisTurn = false;

  constructor(context: HarnessEventNormalizerContext, options: ClaudeCodeNormalizerOptions = {}) {
    this.context = context;
    this.session = {
      id: context.sessionId,
      name: options.sessionName ?? "claude-code",
      adapterType: "claude-code",
      status: "active",
      cwd: options.cwd,
      model: options.model,
      providerMeta: options.providerMeta ? { ...options.providerMeta } : undefined,
    };
  }

  get turnOpen(): boolean {
    return this.currentTurn !== null
      && (this.currentTurn.status === "started" || this.currentTurn.status === "streaming");
  }

  getSession(): Session {
    return {
      ...this.session,
      providerMeta: this.session.providerMeta ? { ...this.session.providerMeta } : undefined,
    };
  }

  getClaudeSessionId(): string | null {
    return this.claudeSessionId;
  }

  ingest(record: AdapterReplayRecord): readonly AgentSessionStreamEvent[] {
    if (record.source === "adapter_control") {
      return this.ingestControl(record);
    }
    return this.ingestHarness(record.payload);
  }

  finishReplay(): readonly AgentSessionStreamEvent[] {
    // Do not invent turn:end on capture EOF.
    return [];
  }

  private ingestControl(
    record: Extract<AdapterReplayRecord, { source: "adapter_control" }>,
  ): readonly AgentSessionStreamEvent[] {
    switch (record.event) {
      case "prompt_accepted": {
        const turnId = record.turnId ?? this.context.nextId("turn");
        return this.openTurn(turnId);
      }
      case "question_answered": {
        const payload = asRecord(record.payload) ?? {};
        const blockId = typeof payload.blockId === "string" ? payload.blockId : "";
        const answer = Array.isArray(payload.answer)
          ? payload.answer.filter((entry): entry is string => typeof entry === "string")
          : [];
        if (!blockId || !this.currentTurn) return [];
        return [{
          event: "block:question:answer",
          sessionId: this.session.id,
          turnId: this.currentTurn.id,
          blockId,
          questionStatus: "answered",
          answer,
        }];
      }
      case "topology_observed": {
        const topology = record.payload;
        const providerMeta: Record<string, unknown> = {
          ...(this.session.providerMeta ?? {}),
        };
        if (topology == null) {
          delete providerMeta[OBSERVED_HARNESS_TOPOLOGY_META_KEY];
        } else {
          providerMeta[OBSERVED_HARNESS_TOPOLOGY_META_KEY] = topology;
        }
        this.session.providerMeta = Object.keys(providerMeta).length > 0 ? providerMeta : undefined;
        return [this.sessionUpdateEvent()];
      }
      case "interrupt": {
        if (!this.currentTurn) return [];
        return this.endTurn(this.currentTurn, "stopped");
      }
      case "transport_error": {
        if (!this.currentTurn) return [];
        const message = typeof record.payload === "object" && record.payload !== null
          && typeof (record.payload as { message?: unknown }).message === "string"
          ? (record.payload as { message: string }).message
          : "Claude Code transport error.";
        const events = this.emitError(this.currentTurn, message);
        events.push(...this.endTurn(this.currentTurn, "failed"));
        return events;
      }
      case "transport_closed": {
        if (this.currentTurn && this.currentTurn.status !== "stopped") {
          // EOF proves that no more records can arrive; it does not prove the
          // harness completed the turn successfully. Only a result record may
          // produce completed (SCO-042-C008).
          return this.endTurn(this.currentTurn, "stopped");
        }
        return [];
      }
      default:
        return [];
    }
  }

  private ingestHarness(payload: unknown): readonly AgentSessionStreamEvent[] {
    const event = asRecord(payload);
    if (!event || typeof event.type !== "string") {
      return [];
    }

    switch (event.type) {
      case "system":
        return this.handleSystem(event);
      case "assistant":
        return this.handleAssistant(event);
      case "user":
        return this.handleUser(event);
      case "tool_use":
        return this.handleToolUse(event);
      case "tool_result":
        return this.handleToolResult(event);
      case "stream_event":
        return this.handleStreamEvent(event);
      case "rate_limit_event":
      case "rate_limits.updated":
      case "rate_limit":
      case "quota_event":
      case "usage_limit_event":
        return this.handleQuotaEvent(event);
      case "result":
        return this.handleResult(event);
      case "error": {
        if (!this.currentTurn) return [];
        const message = typeof asRecord(event.error)?.message === "string"
          ? String(asRecord(event.error)!.message)
          : typeof event.message === "string"
            ? event.message
            : "Unknown error";
        const events = this.emitError(this.currentTurn, message);
        events.push(...this.endTurn(this.currentTurn, "failed"));
        return events;
      }
      default:
        // Unknown source records do not terminate replay (SCO-042-C007).
        return [];
    }
  }

  private openTurn(turnId: string): AgentSessionStreamEvent[] {
    this.blockIndex = 0;
    this.toolBlockMap.clear();
    this.questionBlockMap.clear();
    this.activeStreamBlocks.clear();
    this.sawStreamTextThisTurn = false;

    const turn: Turn = {
      id: turnId,
      sessionId: this.session.id,
      status: "started",
      startedAt: this.context.now(),
      blocks: [],
    };
    this.currentTurn = turn;
    return [{
      event: "turn:start",
      sessionId: this.session.id,
      turn: snapshotNormalizedValue(turn),
    }];
  }

  private handleSystem(event: Record<string, unknown>): AgentSessionStreamEvent[] {
    if (event.subtype !== "init") return [];

    const sid = event.session_id ?? event.sessionId;
    if (typeof sid === "string" && sid.trim()) {
      this.claudeSessionId = sid;
    }
    if (typeof event.cwd === "string" && event.cwd.trim()) {
      this.session.cwd = event.cwd;
    }
    if (typeof event.model === "string" && event.model.trim()) {
      this.session.model = event.model;
    }
    // Topology refresh is a filesystem side effect owned by the live shell.
    // Fixtures pass topology_observed separately when needed.
    return [this.sessionUpdateEvent()];
  }

  private handleAssistant(event: Record<string, unknown>): AgentSessionStreamEvent[] {
    if (!this.currentTurn) return [];

    const content = asRecord(event.message)?.content ?? event.content;
    if (!Array.isArray(content)) return [];

    const events: AgentSessionStreamEvent[] = [];
    for (const part of content) {
      const record = asRecord(part);
      if (!record) continue;
      if (record.type === "thinking" || record.type === "reasoning") {
        if (this.sawStreamTextThisTurn) continue;
        const text = typeof record.thinking === "string"
          ? record.thinking
          : typeof record.text === "string"
            ? record.text
            : "";
        const inline = utf8ByteLength(JSON.stringify(text))
          <= MAX_OPAQUE_BLOCK_VALUE_UTF8_BYTES;
        const block = this.startBlock(this.currentTurn, {
          type: "reasoning",
          text: inline ? text : "",
          status: inline ? "completed" : "streaming",
        }, events);
        if (!inline) this.appendTextDelta(block as TextualBlock, text, events);
        this.emitBlockEnd(this.currentTurn, block, "completed", events);
      } else if (record.type === "text") {
        if (this.sawStreamTextThisTurn) continue;
        const text = typeof record.text === "string" ? record.text : "";
        const inline = utf8ByteLength(JSON.stringify(text))
          <= MAX_OPAQUE_BLOCK_VALUE_UTF8_BYTES;
        const block = this.startBlock(this.currentTurn, {
          type: "text",
          text: inline ? text : "",
          status: inline ? "completed" : "streaming",
        }, events);
        if (!inline) this.appendTextDelta(block as TextualBlock, text, events);
        this.emitBlockEnd(this.currentTurn, block, "completed", events);
      } else if (record.type === "tool_use") {
        events.push(...this.handleToolUse(record));
      }
    }
    return events;
  }

  /** Claude Code reports completed tool results inside top-level user messages. */
  private handleUser(event: Record<string, unknown>): AgentSessionStreamEvent[] {
    const content = asRecord(event.message)?.content ?? event.content;
    if (!Array.isArray(content)) return [];

    const events: AgentSessionStreamEvent[] = [];
    for (const part of content) {
      const record = asRecord(part);
      if (record?.type === "tool_result") {
        events.push(...this.handleToolResult(record));
      }
    }
    return events;
  }

  private handleStreamEvent(event: Record<string, unknown>): AgentSessionStreamEvent[] {
    const streamEvent = asRecord(event.event);
    if (!streamEvent) return [];

    if (isClaudeCodeQuotaEvent(streamEvent)) {
      return this.handleQuotaEvent(streamEvent);
    }

    if (!this.currentTurn) return [];

    const streamType = typeof streamEvent.type === "string" ? streamEvent.type : "";
    if (streamType === "message_start") {
      this.activeStreamBlocks.clear();
      this.sawStreamTextThisTurn = false;
      return [];
    }

    const events: AgentSessionStreamEvent[] = [];

    if (streamType === "content_block_start") {
      const index = typeof streamEvent.index === "number" ? streamEvent.index : 0;
      const contentBlock = asRecord(streamEvent.content_block);
      if (!contentBlock) return [];

      const contentType = typeof contentBlock.type === "string" ? contentBlock.type : "";
      if (contentType !== "text" && contentType !== "thinking") return [];

      const block = this.startBlock(this.currentTurn, {
        type: contentType === "thinking" ? "reasoning" : "text",
        text: "",
        status: "streaming",
      }, events) as TextualBlock;

      this.activeStreamBlocks.set(index, block);
      this.sawStreamTextThisTurn = true;

      const initialText = contentType === "thinking"
        ? typeof contentBlock.thinking === "string" ? contentBlock.thinking : ""
        : typeof contentBlock.text === "string" ? contentBlock.text : "";
      this.appendTextDelta(block, initialText, events);
      return events;
    }

    if (streamType === "content_block_delta") {
      const index = typeof streamEvent.index === "number" ? streamEvent.index : 0;
      const block = this.activeStreamBlocks.get(index);
      const delta = asRecord(streamEvent.delta);
      if (!block || !delta) return [];

      const deltaType = typeof delta.type === "string" ? delta.type : "";
      if (deltaType === "text_delta") {
        this.appendTextDelta(block, typeof delta.text === "string" ? delta.text : "", events);
        return events;
      }
      if (deltaType === "thinking_delta") {
        this.appendTextDelta(block, typeof delta.thinking === "string" ? delta.thinking : "", events);
      }
      return events;
    }

    if (streamType === "content_block_stop") {
      const index = typeof streamEvent.index === "number" ? streamEvent.index : 0;
      const block = this.activeStreamBlocks.get(index);
      if (!block || !this.currentTurn) return [];
      this.emitBlockEnd(this.currentTurn, block, "completed", events);
      this.activeStreamBlocks.delete(index);
      return events;
    }

    return [];
  }

  private handleQuotaEvent(event: Record<string, unknown>): AgentSessionStreamEvent[] {
    const observation = readClaudeCodeQuotaObservation(event);
    if (!observation) return [];

    const providerMeta = { ...(this.session.providerMeta ?? {}) };
    providerMeta.provider = "anthropic";
    const observeQuota: Record<string, unknown> = {
      provider: observation.provider,
      capturedAt: observation.capturedAt,
      windows: observation.windows.map((window) => ({ ...window })),
    };
    if (observation.planType) observeQuota.planType = observation.planType;
    if (observation.userId) observeQuota.userId = observation.userId;
    if (observation.accountId) observeQuota.accountId = observation.accountId;
    providerMeta.observeQuota = observeQuota;
    this.session.providerMeta = providerMeta;
    return [this.sessionUpdateEvent()];
  }

  private handleToolUse(event: Record<string, unknown>): AgentSessionStreamEvent[] {
    if (!this.currentTurn) return [];

    const toolName = typeof event.tool_name === "string"
      ? event.tool_name
      : typeof event.name === "string"
        ? event.name
        : "unknown";
    const toolCallId = typeof event.tool_use_id === "string"
      ? event.tool_use_id
      : typeof event.id === "string"
        ? event.id
        : this.context.nextId("event");
    if (this.toolBlockMap.has(toolCallId)) return [];

    const events: AgentSessionStreamEvent[] = [];
    const input = asRecord(event.input) ?? {};

    if (toolName === "AskUserQuestion") {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const first = asRecord(questions[0]) ?? {};
      const options = Array.isArray(first.options)
        ? first.options.map((entry) => {
          const option = asRecord(entry) ?? {};
          return {
            label: typeof option.label === "string" ? option.label : String(entry),
            description: typeof option.description === "string" ? option.description : undefined,
          };
        })
        : [];

      const block = this.startBlock(this.currentTurn, {
        type: "question",
        header: typeof first.header === "string" ? first.header : undefined,
        question: typeof first.question === "string" ? first.question : "",
        options,
        multiSelect: first.multiSelect === true,
        questionStatus: "awaiting_answer",
        answer: undefined,
        status: "streaming",
      }, events);

      this.toolBlockMap.set(toolCallId, block.id);
      this.questionBlockMap.set(toolCallId, block.id);
      return events;
    }

    let action: Action;
    if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
      action = {
        kind: "file_change",
        path: typeof input.file_path === "string"
          ? input.file_path
          : typeof input.path === "string"
            ? input.path
            : "",
        diff: "",
        status: "running",
        output: "",
      };
    } else if (toolName === "Bash") {
      action = {
        kind: "command",
        command: typeof input.command === "string" ? input.command : "",
        status: "running",
        output: "",
      };
    } else if (toolName === "Agent") {
      action = {
        kind: "subagent",
        agentId: toolCallId,
        agentName: typeof input.description === "string" ? input.description : undefined,
        prompt: typeof input.prompt === "string" ? input.prompt : undefined,
        status: "running",
        output: "",
      };
    } else {
      action = {
        kind: "tool_call",
        toolName,
        toolCallId,
        input: boundOpaqueValue(
          event.input,
          MAX_OPAQUE_BLOCK_VALUE_UTF8_BYTES,
          `tool:${toolCallId}:input`,
        ),
        status: "running",
        output: "",
      };
    }

    const block = this.startBlock(this.currentTurn, {
      type: "action",
      action: boundActionInlineText(action, `tool:${toolCallId}`),
      status: "streaming",
    }, events);
    this.toolBlockMap.set(toolCallId, block.id);
    return events;
  }

  private handleToolResult(event: Record<string, unknown>): AgentSessionStreamEvent[] {
    if (!this.currentTurn) return [];

    const toolCallId = typeof event.tool_use_id === "string"
      ? event.tool_use_id
      : typeof event.id === "string"
        ? event.id
        : "";
    const blockId = this.toolBlockMap.get(toolCallId);
    if (!blockId) return [];

    if (this.questionBlockMap.has(toolCallId)) {
      this.questionBlockMap.delete(toolCallId);
      this.toolBlockMap.delete(toolCallId);
      return [{
        event: "block:end",
        sessionId: this.session.id,
        turnId: this.currentTurn.id,
        blockId,
        status: event.is_error ? "failed" : "completed",
      }];
    }

    const rawOutput = typeof event.content === "string"
      ? event.content
      : JSON.stringify(event.content ?? "");
    const truncated = truncateUtf8(rawOutput, MAX_ACTION_OUTPUT_EVENT_UTF8_BYTES);
    const output = truncated.text;

    const status = event.is_error ? "failed" : "completed";
    this.toolBlockMap.delete(toolCallId);
    const outputEvents = splitTextForSessionEvents<
      Extract<AgentSessionStreamEvent, { event: "block:action:output" }>
    >(output, (chunk) => ({
      event: "block:action:output" as const,
      sessionId: this.session.id,
      turnId: this.currentTurn!.id,
      blockId,
      output: chunk,
    }), MAX_SESSION_EVENT_UTF8_BYTES - ACTION_OUTPUT_EVENT_METADATA_RESERVE_UTF8_BYTES);
    if (truncated.omittedBytes > 0) {
      const last = outputEvents.at(-1);
      if (last) {
        last.truncation = {
          omittedBytes: truncated.omittedBytes,
          maxRetainedBytes: MAX_ACTION_OUTPUT_EVENT_UTF8_BYTES,
          sourceRef: `tool:${toolCallId}`,
        };
      }
    }
    return [
      ...outputEvents,
      {
        event: "block:action:status",
        sessionId: this.session.id,
        turnId: this.currentTurn.id,
        blockId,
        status,
      },
      {
        event: "block:end",
        sessionId: this.session.id,
        turnId: this.currentTurn.id,
        blockId,
        status: status === "failed" ? "failed" : "completed",
      },
    ];
  }

  private handleResult(event: Record<string, unknown>): AgentSessionStreamEvent[] {
    const events: AgentSessionStreamEvent[] = [];
    events.push(...this.completeOpenStreamBlocks());

    const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
    for (const denial of denials) {
      const denialRecord = asRecord(denial);
      if (!denialRecord || denialRecord.tool_name !== "AskUserQuestion" || !this.currentTurn) {
        continue;
      }
      const input = asRecord(denialRecord.tool_input) ?? {};
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const first = asRecord(questions[0]) ?? {};
      const options = Array.isArray(first.options)
        ? first.options.map((entry) => {
          const option = asRecord(entry) ?? {};
          return {
            label: typeof option.label === "string" ? option.label : String(entry),
            description: typeof option.description === "string" ? option.description : undefined,
          };
        })
        : [];
      const block = this.startBlock(this.currentTurn, {
        type: "question",
        header: typeof first.header === "string" ? first.header : undefined,
        question: typeof first.question === "string" ? first.question : "",
        options,
        multiSelect: first.multiSelect === true,
        questionStatus: "denied",
        status: "completed",
      }, events);
      this.emitBlockEnd(this.currentTurn, block, "completed", events);
    }

    if (this.currentTurn && this.currentTurn.status !== "stopped") {
      // Topology refresh is shell-owned; fixtures emit topology_observed separately.
      events.push(this.sessionUpdateEvent());
      events.push(...this.endTurn(
        this.currentTurn,
        event.subtype === "error" ? "failed" : "completed",
      ));
    }
    return events;
  }

  private startBlock(
    turn: Turn,
    partial: Record<string, unknown> & { type: string; status: BlockStatus },
    events: AgentSessionStreamEvent[],
  ): Block {
    const block: Block = {
      ...partial,
      id: this.context.nextId("block"),
      turnId: turn.id,
      index: this.blockIndex++,
    } as Block;

    turn.blocks.push(block);
    events.push({
      event: "block:start",
      sessionId: this.session.id,
      turnId: turn.id,
      block: snapshotNormalizedValue(block),
    });
    return block;
  }

  private emitBlockEnd(
    turn: Turn,
    block: Block,
    status: BlockStatus,
    events: AgentSessionStreamEvent[],
  ): void {
    events.push({
      event: "block:end",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      status,
    });
  }

  private emitError(turn: Turn, message: string): AgentSessionStreamEvent[] {
    const events: AgentSessionStreamEvent[] = [];
    const truncated = truncateUtf8(message, MAX_DIAGNOSTIC_UTF8_BYTES);
    const block = this.startBlock(turn, {
      type: "error",
      message: truncated.text,
      ...(truncated.omittedBytes > 0
        ? {
            truncation: {
              omittedBytes: truncated.omittedBytes,
              maxRetainedBytes: MAX_DIAGNOSTIC_UTF8_BYTES,
              sourceRef: `turn:${turn.id}`,
            },
          }
        : {}),
      status: "completed",
    }, events);
    this.emitBlockEnd(turn, block, "completed", events);
    return events;
  }

  private endTurn(turn: Turn, status: TurnStatus): AgentSessionStreamEvent[] {
    turn.status = status;
    turn.endedAt = this.context.now();
    this.currentTurn = null;
    this.activeStreamBlocks.clear();
    this.sawStreamTextThisTurn = false;
    return [{
      event: "turn:end",
      sessionId: this.session.id,
      turnId: turn.id,
      status,
    }];
  }

  private appendTextDelta(
    block: TextualBlock,
    text: string,
    events: AgentSessionStreamEvent[],
  ): void {
    if (!text || !this.currentTurn) return;
    block.text += text;
    events.push(...splitTextForSessionEvents(text, (chunk) => ({
      event: "block:delta" as const,
      sessionId: this.session.id,
      turnId: this.currentTurn!.id,
      blockId: block.id,
      text: chunk,
    })));
  }

  private completeOpenStreamBlocks(): AgentSessionStreamEvent[] {
    if (!this.currentTurn) return [];
    const events: AgentSessionStreamEvent[] = [];
    for (const block of this.activeStreamBlocks.values()) {
      this.emitBlockEnd(this.currentTurn, block, "completed", events);
    }
    this.activeStreamBlocks.clear();
    return events;
  }

  private sessionUpdateEvent(): AgentSessionStreamEvent {
    return {
      event: "session:update",
      session: this.getSession(),
    };
  }
}

export function createClaudeCodeEventNormalizer(
  context: HarnessEventNormalizerContext,
  options?: ClaudeCodeNormalizerOptions,
): ClaudeCodeEventNormalizer {
  return new ClaudeCodeEventNormalizer(context, options);
}
