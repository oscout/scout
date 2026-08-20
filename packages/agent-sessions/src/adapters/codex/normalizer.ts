// Pure Codex harness-event normalizer (SCO-042).
// No filesystem, process, network, environment, stdin, or stdout access.

import {
  projectCodexAssistantStreamText,
  projectCodexAssistantText,
  type CodexHostMetadata,
} from "./host-metadata.js";
import type {
  Action,
  ActionBlock,
  AgentSessionStreamEvent,
  Block,
  BlockStatus,
  Session,
  SessionStatus,
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

type TurnCompletedParams = {
  threadId?: string;
  turn: {
    id: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    error?: {
      message?: string;
      additionalDetails?: string | null;
    } | null;
  };
};

type ActiveTurnState = {
  turn: Turn;
  blocksByItemId: Map<string, Block>;
};

type AgentMessageStreamState = {
  rawText: string;
  emittedText: string;
};

export type CodexNormalizerOptions = {
  sessionName?: string;
  cwd?: string;
  model?: string;
  providerMeta?: Record<string, unknown>;
};

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractReasoningText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const content = Array.isArray(item.content) ? item.content : [];

  const summaryText = summary
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const record = entry as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.summary === "string") return record.summary;
      return "";
    })
    .filter(Boolean)
    .join("\n");

  const contentText = content
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const record = entry as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");

  return [summaryText, contentText].filter(Boolean).join("\n\n").trim();
}

function extractTextDelta(params: Record<string, unknown>): string {
  if (typeof params.delta === "string") return params.delta;
  if (typeof params.text === "string") return params.text;
  const delta = params.delta as Record<string, unknown> | undefined;
  if (typeof delta?.text === "string") return delta.text;
  const content = Array.isArray(params.content) ? params.content : [];
  const first = content[0] as Record<string, unknown> | undefined;
  if (typeof first?.text === "string") return first.text;
  return "";
}

function renderActionOutput(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  if (typeof item.aggregatedOutput === "string") return item.aggregatedOutput;
  if (item.action !== undefined) return stringifyValue(item.action);
  if (item.output !== undefined) return stringifyValue(item.output);
  return stringifyValue(item);
}

function commandText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").join(" ");
  }
  return "";
}

function actionStatusFromItem(item: Record<string, unknown>): Action["status"] {
  if (item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0)) {
    return "failed";
  }
  return item.status === "completed" || item.exitCode === 0 ? "completed" : "running";
}

function threadStatusToSessionStatus(status: string | undefined): SessionStatus {
  switch (status) {
    case "active":
      return "active";
    case "idle":
      return "idle";
    case "error":
      return "error";
    default:
      return "connecting";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function notificationShape(payload: unknown): { method: string; params: Record<string, unknown> } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const method = typeof record.method === "string" ? record.method : null;
  if (!method) return null;
  return {
    method,
    params: asRecord(record.params) ?? {},
  };
}

export class CodexEventNormalizer implements HarnessEventNormalizer {
  private readonly context: HarnessEventNormalizerContext;
  private session: Session;
  private currentTurnState: ActiveTurnState | null = null;
  private codexHostMetadataRaw = new Set<string>();
  private agentMessageStreams = new Map<string, AgentMessageStreamState>();
  private blockIndex = 0;
  private currentThreadId: string | null = null;
  private currentThreadPath: string | null = null;

  constructor(context: HarnessEventNormalizerContext, options: CodexNormalizerOptions = {}) {
    this.context = context;
    this.session = {
      id: context.sessionId,
      name: options.sessionName ?? "codex",
      adapterType: "codex",
      status: "idle",
      cwd: options.cwd,
      model: options.model,
      providerMeta: options.providerMeta ? { ...options.providerMeta } : undefined,
    };
  }

  get turnOpen(): boolean {
    return this.currentTurnState !== null
      && (this.currentTurnState.turn.status === "started"
        || this.currentTurnState.turn.status === "streaming");
  }

  getSession(): Session {
    return {
      ...this.session,
      providerMeta: this.session.providerMeta ? { ...this.session.providerMeta } : undefined,
    };
  }

  ingest(record: AdapterReplayRecord): readonly AgentSessionStreamEvent[] {
    if (record.source === "adapter_control") {
      return this.ingestControl(record);
    }
    return this.ingestHarness(record.payload);
  }

  finishReplay(): readonly AgentSessionStreamEvent[] {
    return [];
  }

  private ingestControl(
    record: Extract<AdapterReplayRecord, { source: "adapter_control" }>,
  ): readonly AgentSessionStreamEvent[] {
    switch (record.event) {
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
        const turnState = this.currentTurnState;
        if (!turnState) return [];
        const events: AgentSessionStreamEvent[] = [];
        events.push(...this.closeOpenBlocks(turnState, "failed"));
        events.push(...this.finishTurn(turnState, "stopped"));
        this.session.status = "idle";
        events.push(this.sessionUpdateEvent());
        return events;
      }
      case "transport_error": {
        const message = typeof record.payload === "object" && record.payload !== null
          && typeof (record.payload as { message?: unknown }).message === "string"
          ? (record.payload as { message: string }).message
          : "Codex transport error.";
        return this.failTurn(message);
      }
      case "transport_closed": {
        const turnState = this.currentTurnState;
        if (!turnState) {
          this.session.status = "closed";
          return [this.sessionUpdateEvent()];
        }
        const events: AgentSessionStreamEvent[] = [];
        events.push(...this.closeOpenBlocks(turnState, "failed"));
        events.push(...this.finishTurn(turnState, "stopped"));
        this.session.status = "closed";
        events.push(this.sessionUpdateEvent());
        return events;
      }
      default:
        return [];
    }
  }

  private ingestHarness(payload: unknown): readonly AgentSessionStreamEvent[] {
    const message = notificationShape(payload);
    if (!message) {
      // Unknown / non-notification records do not terminate replay.
      return [];
    }

    const { method, params } = message;
    const turnId = typeof params.turnId === "string" ? params.turnId : null;

    switch (method) {
      case "thread/started":
      case "thread/name/updated": {
        const thread = asRecord(params.thread);
        if (thread) {
          return this.updateSessionFromThread(thread);
        }
        return [];
      }
      case "thread/status/changed": {
        const status = asRecord(params.status)?.type;
        this.session.status = threadStatusToSessionStatus(typeof status === "string" ? status : undefined);
        return [this.sessionUpdateEvent()];
      }
      case "turn/started": {
        const turn = asRecord(params.turn);
        const startedTurnId = typeof turn?.id === "string" ? turn.id : turnId;
        if (!startedTurnId) return [];
        const events = this.ensureTurn(startedTurnId);
        this.session.status = "active";
        events.push(this.sessionUpdateEvent());
        return events;
      }
      case "item/started":
        return this.handleItemStarted(params);
      case "item/agentMessage/delta":
        return this.handleAgentMessageDelta(params);
      case "item/reasoning/delta":
      case "item/reasoning/summaryTextDelta":
        return this.handleReasoningDelta(params);
      case "item/fileChange/outputDelta":
      case "item/commandExecution/outputDelta":
      case "item/toolCall/outputDelta":
        return this.handleActionOutputDelta(method, params);
      case "item/commandExecution/terminalInteraction":
        return this.handleActionTerminalInteraction(params);
      case "item/completed":
        return this.handleItemCompleted(params);
      case "turn/completed":
        return this.handleTurnCompleted(params as TurnCompletedParams);
      case "error": {
        const detail = typeof params.message === "string"
          ? params.message
          : "Codex app-server reported an error.";
        // Emit as turn error block when a turn is open; otherwise ignore terminal failure.
        if (this.currentTurnState) {
          return this.failTurn(detail);
        }
        return [];
      }
      default:
        return [];
    }
  }

  private failTurn(message: string): AgentSessionStreamEvent[] {
    const turnState = this.currentTurnState;
    if (!turnState) return [];
    const events: AgentSessionStreamEvent[] = [];
    events.push(...this.emitErrorBlock(turnState.turn, message));
    events.push(...this.closeOpenBlocks(turnState, "failed"));
    events.push(...this.finishTurn(turnState, "failed"));
    this.session.status = "error";
    events.push(this.sessionUpdateEvent());
    return events;
  }

  private handleItemStarted(params: Record<string, unknown>): AgentSessionStreamEvent[] {
    const item = asRecord(params.item);
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const itemId = typeof item?.id === "string" ? item.id : null;
    const itemType = typeof item?.type === "string" ? item.type : null;

    if (!turnId || !item || !itemId || !itemType || itemType === "userMessage") {
      return [];
    }

    const events = this.ensureTurn(turnId);
    const turnState = this.currentTurnState!;
    switch (itemType) {
      case "agentMessage": {
        const initialText = typeof item.text === "string"
          ? this.projectAgentMessageStreamText(itemId, item.text, events)
          : "";
        const inline = utf8ByteLength(JSON.stringify(initialText))
          <= MAX_OPAQUE_BLOCK_VALUE_UTF8_BYTES;
        const block = this.ensureTextBlock(turnState, itemId, inline ? initialText : "", events);
        if (!inline) this.emitTextDelta(turnState.turn, block, initialText, events);
        return events;
      }
      case "reasoning": {
        const text = extractReasoningText(item);
        if (text) {
          const inline = utf8ByteLength(JSON.stringify(text))
            <= MAX_OPAQUE_BLOCK_VALUE_UTF8_BYTES;
          const block = this.ensureReasoningBlock(turnState, itemId, inline ? text : "", events);
          if (!inline) this.emitTextDelta(turnState.turn, block, text, events);
        }
        return events;
      }
      default:
        this.ensureActionBlock(turnState, itemId, this.buildActionFromItem(item, itemId), events);
        return events;
    }
  }

  private handleAgentMessageDelta(params: Record<string, unknown>): AgentSessionStreamEvent[] {
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const itemId = typeof params.itemId === "string" ? params.itemId : null;
    const delta = extractTextDelta(params);
    if (!turnId || !itemId || !delta) return [];

    const events = this.ensureTurn(turnId);
    const turnState = this.currentTurnState!;
    const block = this.ensureTextBlock(turnState, itemId, "", events);
    const nextText = this.projectAgentMessageStreamText(itemId, delta, events, { append: true });
    if (nextText.startsWith(block.text)) {
      this.emitTextDelta(turnState.turn, block, nextText.slice(block.text.length), events);
    }
    return events;
  }

  private handleReasoningDelta(params: Record<string, unknown>): AgentSessionStreamEvent[] {
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const itemId = typeof params.itemId === "string" ? params.itemId : null;
    const delta = extractTextDelta(params);
    if (!turnId || !itemId || !delta) return [];

    const events = this.ensureTurn(turnId);
    const turnState = this.currentTurnState!;
    const block = this.ensureReasoningBlock(turnState, itemId, "", events);
    this.emitTextDelta(turnState.turn, block, delta, events);
    return events;
  }

  private handleActionOutputDelta(method: string, params: Record<string, unknown>): AgentSessionStreamEvent[] {
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const itemId = typeof params.itemId === "string" ? params.itemId : null;
    const output = extractTextDelta(params) || stringifyValue(params.output);
    if (!turnId || !itemId || !output) return [];

    const events = this.ensureTurn(turnId);
    const turnState = this.currentTurnState!;
    const block = this.ensureActionBlock(
      turnState,
      itemId,
      this.buildActionFromMethod(method, params, itemId),
      events,
    );
    this.emitActionOutput(turnState.turn, block, output, events);
    return events;
  }

  private handleActionTerminalInteraction(params: Record<string, unknown>): AgentSessionStreamEvent[] {
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const itemId = typeof params.itemId === "string" ? params.itemId : null;
    if (!turnId || !itemId) return [];

    const events = this.ensureTurn(turnId);
    const turnState = this.currentTurnState!;
    const block = turnState.blocksByItemId.get(itemId);
    if (block?.type !== "action") return events;

    const exitCode = typeof params.exitCode === "number"
      ? params.exitCode
      : typeof asRecord(params.status)?.exitCode === "number"
        ? Number(asRecord(params.status)!.exitCode)
        : undefined;
    if (exitCode === undefined) return events;
    this.emitActionStatus(
      turnState.turn,
      block,
      exitCode === 0 ? "completed" : "failed",
      exitCode === undefined ? undefined : { exitCode },
      events,
    );
    return events;
  }

  private handleItemCompleted(params: Record<string, unknown>): AgentSessionStreamEvent[] {
    const item = asRecord(params.item);
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    const itemId = typeof item?.id === "string" ? item.id : null;
    const itemType = typeof item?.type === "string" ? item.type : null;

    if (!turnId || !item || !itemId || !itemType || itemType === "userMessage") {
      return [];
    }

    const events = this.ensureTurn(turnId);
    const turnState = this.currentTurnState!;
    switch (itemType) {
      case "agentMessage": {
        const block = this.ensureTextBlock(turnState, itemId, "", events);
        const finalText = typeof item.text === "string" ? this.projectAgentMessageText(item.text, events) : "";
        this.emitMissingText(turnState.turn, block, finalText, events);
        this.completeBlock(turnState.turn, block, "completed", events);
        turnState.blocksByItemId.delete(itemId);
        this.agentMessageStreams.delete(itemId);
        return events;
      }
      case "reasoning": {
        const finalText = extractReasoningText(item);
        if (!finalText && !turnState.blocksByItemId.has(itemId)) {
          return events;
        }
        const block = this.ensureReasoningBlock(turnState, itemId, "", events);
        this.emitMissingText(turnState.turn, block, finalText, events);
        this.completeBlock(turnState.turn, block, "completed", events);
        turnState.blocksByItemId.delete(itemId);
        return events;
      }
      default: {
        const block = this.ensureActionBlock(
          turnState,
          itemId,
          this.buildActionFromItem(item, itemId),
          events,
        );
        this.emitMissingActionOutput(turnState.turn, block, renderActionOutput(item), events);
        const actionStatus = actionStatusFromItem(item);
        this.emitActionStatus(turnState.turn, block, actionStatus, this.buildActionMeta(item), events);
        this.completeBlock(turnState.turn, block, actionStatus === "failed" ? "failed" : "completed", events);
        turnState.blocksByItemId.delete(itemId);
        return events;
      }
    }
  }

  private handleTurnCompleted(params: TurnCompletedParams): AgentSessionStreamEvent[] {
    const turnId = params.turn?.id;
    const turnState = this.currentTurnState;
    if (!turnState || !turnId || turnState.turn.id !== turnId) {
      return [];
    }

    const events: AgentSessionStreamEvent[] = [];
    switch (params.turn.status) {
      case "failed": {
        const message = params.turn.error?.message
          || params.turn.error?.additionalDetails
          || `Turn failed for ${this.session.name}.`;
        events.push(...this.emitErrorBlock(turnState.turn, String(message)));
        events.push(...this.closeOpenBlocks(turnState, "failed"));
        events.push(...this.finishTurn(turnState, "failed"));
        this.session.status = "error";
        events.push(this.sessionUpdateEvent());
        return events;
      }
      case "interrupted":
        events.push(...this.closeOpenBlocks(turnState, "failed"));
        events.push(...this.finishTurn(turnState, "stopped"));
        this.session.status = "idle";
        events.push(this.sessionUpdateEvent());
        return events;
      default:
        events.push(...this.closeOpenBlocks(turnState, "completed"));
        events.push(...this.finishTurn(turnState, "completed"));
        this.session.status = "idle";
        events.push(this.sessionUpdateEvent());
        return events;
    }
  }

  private ensureTurn(turnId: string): AgentSessionStreamEvent[] {
    const events: AgentSessionStreamEvent[] = [];
    const current = this.currentTurnState;
    if (current?.turn.id === turnId) {
      return events;
    }

    if (current) {
      events.push(...this.closeOpenBlocks(current, "failed"));
      events.push(...this.finishTurn(current, "stopped"));
    }

    const turn: Turn = {
      id: turnId,
      sessionId: this.session.id,
      status: "started",
      startedAt: this.context.now(),
      blocks: [],
    };
    this.currentTurnState = {
      turn,
      blocksByItemId: new Map(),
    };
    this.blockIndex = 0;
    events.push({
      event: "turn:start",
      sessionId: this.session.id,
      turn: snapshotNormalizedValue(turn),
    });
    return events;
  }

  private ensureTextBlock(
    turnState: ActiveTurnState,
    itemId: string,
    initialText: string,
    events: AgentSessionStreamEvent[],
  ): Extract<Block, { type: "text" }> {
    const existing = turnState.blocksByItemId.get(itemId);
    if (existing?.type === "text") return existing;

    const block = this.startBlock<Extract<Block, { type: "text" }>>(turnState, {
      id: itemId,
      type: "text",
      text: initialText,
      status: "streaming",
    }, events);
    turnState.blocksByItemId.set(itemId, block);
    return block;
  }

  private ensureReasoningBlock(
    turnState: ActiveTurnState,
    itemId: string,
    initialText: string,
    events: AgentSessionStreamEvent[],
  ): Extract<Block, { type: "reasoning" }> {
    const existing = turnState.blocksByItemId.get(itemId);
    if (existing?.type === "reasoning") return existing;

    const block = this.startBlock<Extract<Block, { type: "reasoning" }>>(turnState, {
      id: itemId,
      type: "reasoning",
      text: initialText,
      status: "streaming",
    }, events);
    turnState.blocksByItemId.set(itemId, block);
    return block;
  }

  private ensureActionBlock(
    turnState: ActiveTurnState,
    itemId: string,
    action: Action,
    events: AgentSessionStreamEvent[],
  ): ActionBlock {
    const existing = turnState.blocksByItemId.get(itemId);
    if (existing?.type === "action") return existing;

    const block = this.startBlock<ActionBlock>(turnState, {
      id: itemId,
      type: "action",
      action: boundActionInlineText(action, `block:${itemId}`),
      status: "streaming",
    }, events);
    turnState.blocksByItemId.set(itemId, block);
    return block;
  }

  private startBlock<T extends Block>(
    turnState: ActiveTurnState,
    partial: Omit<T, "turnId" | "index">,
    events: AgentSessionStreamEvent[],
  ): T {
    const block = {
      ...partial,
      turnId: turnState.turn.id,
      index: this.blockIndex++,
    } as T;

    turnState.turn.blocks.push(block);
    events.push({
      event: "block:start",
      sessionId: this.session.id,
      turnId: turnState.turn.id,
      block: snapshotNormalizedValue(block),
    });
    return block;
  }

  private emitTextDelta(
    turn: Turn,
    block: Extract<Block, { type: "text" | "reasoning" }>,
    text: string,
    events: AgentSessionStreamEvent[],
  ): void {
    if (!text) return;
    block.text += text;
    block.status = "streaming";
    events.push(...splitTextForSessionEvents(text, (chunk) => ({
      event: "block:delta" as const,
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      text: chunk,
    })));
  }

  private emitMissingText(
    turn: Turn,
    block: Extract<Block, { type: "text" | "reasoning" }>,
    finalText: string,
    events: AgentSessionStreamEvent[],
  ): void {
    if (!finalText || block.text === finalText) return;
    if (!block.text) {
      this.emitTextDelta(turn, block, finalText, events);
      return;
    }
    if (finalText.startsWith(block.text)) {
      this.emitTextDelta(turn, block, finalText.slice(block.text.length), events);
    }
  }

  private projectAgentMessageText(rawText: string, events: AgentSessionStreamEvent[]): string {
    const projected = projectCodexAssistantText(rawText);
    if (this.recordCodexHostMetadata(projected.hostMetadata)) {
      events.push(this.sessionUpdateEvent());
    }
    return projected.text;
  }

  private projectAgentMessageStreamText(
    itemId: string,
    text: string,
    events: AgentSessionStreamEvent[],
    options: { append?: boolean } = {},
  ): string {
    const state = this.agentMessageStreams.get(itemId) ?? {
      rawText: "",
      emittedText: "",
    };
    state.rawText = options.append ? state.rawText + text : text;

    const projected = projectCodexAssistantStreamText(state.rawText);
    if (this.recordCodexHostMetadata(projected.hostMetadata)) {
      events.push(this.sessionUpdateEvent());
    }
    if (projected.text.startsWith(state.emittedText)) {
      state.emittedText = projected.text;
    }
    this.agentMessageStreams.set(itemId, state);
    return state.emittedText;
  }

  private recordCodexHostMetadata(entries: CodexHostMetadata[]): boolean {
    if (entries.length === 0) return false;

    const fresh = entries.filter((entry) => {
      if (this.codexHostMetadataRaw.has(entry.raw)) return false;
      this.codexHostMetadataRaw.add(entry.raw);
      return true;
    });
    if (fresh.length === 0) return false;

    const providerMeta: Record<string, unknown> = {
      ...(this.session.providerMeta ?? {}),
    };
    const metadata = typeof providerMeta.observeHostMetadata === "object"
      && providerMeta.observeHostMetadata !== null
      && !Array.isArray(providerMeta.observeHostMetadata)
      ? providerMeta.observeHostMetadata as Record<string, unknown>
      : {};
    const directives = Array.isArray(metadata.directives)
      ? metadata.directives.filter((entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry))
      : [];
    const memoryCitations = Array.isArray(metadata.memoryCitations)
      ? metadata.memoryCitations.filter((entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry))
      : [];

    for (const entry of fresh) {
      if (entry.kind === "directive") {
        directives.push({ name: entry.name, raw: entry.raw });
      } else {
        memoryCitations.push({
          raw: entry.raw,
          citationEntries: entry.citationEntries,
          rolloutIds: entry.rolloutIds,
        });
      }
    }

    if (directives.length > 0) metadata.directives = directives;
    if (memoryCitations.length > 0) metadata.memoryCitations = memoryCitations;
    providerMeta.observeHostMetadata = metadata;
    this.session.providerMeta = providerMeta;
    return true;
  }

  private emitActionOutput(
    turn: Turn,
    block: ActionBlock,
    output: string,
    events: AgentSessionStreamEvent[],
  ): void {
    if (!output) return;

    const truncated = truncateUtf8(
      block.action.output + output,
      MAX_ACTION_OUTPUT_EVENT_UTF8_BYTES,
    );
    const previous = block.action.output;
    const delta = truncated.text.startsWith(previous)
      ? truncated.text.slice(previous.length)
      : truncated.text;
    block.action.output = truncated.text;
    block.action.status = "running";

    const priorOmitted = block.action.truncation?.omittedBytes ?? 0;
    if (truncated.omittedBytes > 0) {
      block.action.truncation = {
        omittedBytes: priorOmitted + truncated.omittedBytes,
        maxRetainedBytes: MAX_ACTION_OUTPUT_EVENT_UTF8_BYTES,
        sourceRef: `block:${block.id}`,
      };
    }

    if (!delta && truncated.omittedBytes === 0) return;

    const outputEvents = splitTextForSessionEvents<
      Extract<AgentSessionStreamEvent, { event: "block:action:output" }>
    >(delta, (chunk) => ({
      event: "block:action:output" as const,
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      output: chunk,
    }), MAX_SESSION_EVENT_UTF8_BYTES - ACTION_OUTPUT_EVENT_METADATA_RESERVE_UTF8_BYTES);
    if (truncated.omittedBytes > 0) {
      const truncation = {
        omittedBytes: truncated.omittedBytes,
        maxRetainedBytes: MAX_ACTION_OUTPUT_EVENT_UTF8_BYTES,
        sourceRef: `block:${block.id}`,
      };
      const last = outputEvents.at(-1);
      if (last) {
        last.truncation = truncation;
      } else {
        outputEvents.push({
          event: "block:action:output",
          sessionId: this.session.id,
          turnId: turn.id,
          blockId: block.id,
          output: "",
          truncation,
        });
      }
    }
    events.push(...outputEvents);
  }

  private emitMissingActionOutput(
    turn: Turn,
    block: ActionBlock,
    finalOutput: string,
    events: AgentSessionStreamEvent[],
  ): void {
    if (!finalOutput || block.action.output === finalOutput) return;
    if (!block.action.output) {
      this.emitActionOutput(turn, block, finalOutput, events);
      return;
    }
    if (finalOutput.startsWith(block.action.output)) {
      this.emitActionOutput(turn, block, finalOutput.slice(block.action.output.length), events);
    }
  }

  private emitActionStatus(
    turn: Turn,
    block: ActionBlock,
    status: Action["status"],
    meta: Record<string, unknown> | undefined,
    events: AgentSessionStreamEvent[],
  ): void {
    block.action.status = status;
    events.push({
      event: "block:action:status",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      status,
      ...(meta ? { meta } : {}),
    });
  }

  private completeBlock(
    turn: Turn,
    block: Block,
    status: BlockStatus,
    events: AgentSessionStreamEvent[],
  ): void {
    block.status = status;
    events.push({
      event: "block:end",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      status,
    });
  }

  private closeOpenBlocks(
    turnState: ActiveTurnState,
    actionStatus: Extract<Action["status"], "completed" | "failed">,
  ): AgentSessionStreamEvent[] {
    const events: AgentSessionStreamEvent[] = [];
    const seen = new Set<string>();
    for (const block of turnState.blocksByItemId.values()) {
      if (seen.has(block.id)) continue;
      seen.add(block.id);
      if (block.type === "action" && block.action.status !== actionStatus) {
        this.emitActionStatus(turnState.turn, block, actionStatus, undefined, events);
      }
      this.completeBlock(
        turnState.turn,
        block,
        actionStatus === "completed" ? "completed" : "failed",
        events,
      );
    }
    turnState.blocksByItemId.clear();
    return events;
  }

  private emitErrorBlock(turn: Turn, message: string): AgentSessionStreamEvent[] {
    const turnState = this.currentTurnState;
    if (!turnState || turnState.turn.id !== turn.id) return [];

    const events: AgentSessionStreamEvent[] = [];
    const truncated = truncateUtf8(message, MAX_DIAGNOSTIC_UTF8_BYTES);
    const block = this.startBlock<Extract<Block, { type: "error" }>>(turnState, {
      id: this.context.nextId("block"),
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
    this.completeBlock(turn, block, "completed", events);
    return events;
  }

  private finishTurn(turnState: ActiveTurnState, status: TurnStatus): AgentSessionStreamEvent[] {
    turnState.turn.status = status;
    turnState.turn.endedAt = this.context.now();
    if (this.currentTurnState?.turn.id === turnState.turn.id) {
      this.currentTurnState = null;
    }
    return [{
      event: "turn:end",
      sessionId: this.session.id,
      turnId: turnState.turn.id,
      status,
    }];
  }

  private buildActionFromItem(item: Record<string, unknown>, itemId: string): Action {
    const itemType = typeof item.type === "string" ? item.type : "toolCall";
    switch (itemType) {
      case "commandExecution":
        return {
          kind: "command",
          command: commandText(item.command),
          output: "",
          status: "running",
        };
      case "fileChange":
        return {
          kind: "file_change",
          path: typeof item.filePath === "string"
            ? item.filePath
            : typeof item.path === "string"
              ? item.path
              : "",
          diff: typeof item.diff === "string" ? item.diff : undefined,
          output: "",
          status: "running",
        };
      case "subagent":
        return {
          kind: "subagent",
          agentId: typeof item.agentId === "string" ? item.agentId : itemId,
          agentName: typeof item.agentName === "string" ? item.agentName : undefined,
          prompt: typeof item.prompt === "string" ? item.prompt : undefined,
          output: "",
          status: "running",
        };
      default:
        return {
          kind: "tool_call",
          toolName: itemType,
          toolCallId: itemId,
          input: boundOpaqueValue(
            item,
            MAX_OPAQUE_BLOCK_VALUE_UTF8_BYTES,
            `tool:${itemId}:input`,
          ),
          output: "",
          status: "running",
        };
    }
  }

  private buildActionFromMethod(
    method: string,
    params: Record<string, unknown>,
    itemId: string,
  ): Action {
    if (method === "item/commandExecution/outputDelta") {
      return {
        kind: "command",
        command: commandText(params.command),
        output: "",
        status: "running",
      };
    }
    if (method === "item/fileChange/outputDelta") {
      return {
        kind: "file_change",
        path: typeof params.filePath === "string"
          ? params.filePath
          : typeof params.path === "string"
            ? params.path
            : "",
        output: "",
        status: "running",
      };
    }
    return {
      kind: "tool_call",
      toolName: typeof params.toolName === "string"
        ? params.toolName
        : typeof params.name === "string"
          ? params.name
          : method.replace(/^item\//, "").replace(/\/outputDelta$/, ""),
      toolCallId: typeof params.toolCallId === "string" ? params.toolCallId : itemId,
      input: boundOpaqueValue(
        params.input,
        MAX_OPAQUE_BLOCK_VALUE_UTF8_BYTES,
        `tool:${itemId}:input`,
      ),
      output: "",
      status: "running",
    };
  }

  private buildActionMeta(item: Record<string, unknown>): Record<string, unknown> | undefined {
    const exitCode = typeof item.exitCode === "number"
      ? item.exitCode
      : typeof asRecord(item.status)?.exitCode === "number"
        ? Number(asRecord(item.status)!.exitCode)
        : undefined;
    return exitCode !== undefined ? { exitCode } : undefined;
  }

  private updateSessionFromThread(thread: Record<string, unknown>): AgentSessionStreamEvent[] {
    const threadId = typeof thread.id === "string" ? thread.id : null;
    const threadPath = typeof thread.path === "string" ? thread.path : null;
    const threadName = typeof thread.name === "string" && thread.name.trim().length > 0
      ? thread.name.trim()
      : null;
    const cwd = typeof thread.cwd === "string" && thread.cwd.trim().length > 0
      ? thread.cwd.trim()
      : null;

    if (threadId) this.currentThreadId = threadId;
    if (threadPath !== null) this.currentThreadPath = threadPath;
    if (threadName) this.session.name = threadName;
    if (cwd) this.session.cwd = cwd;

    const nextProviderMeta: Record<string, unknown> = {
      ...(this.session.providerMeta ?? {}),
    };
    if (this.currentThreadId) nextProviderMeta.threadId = this.currentThreadId;
    if (this.currentThreadPath) nextProviderMeta.threadPath = this.currentThreadPath;
    this.session.providerMeta = Object.keys(nextProviderMeta).length > 0 ? nextProviderMeta : undefined;
    return [this.sessionUpdateEvent()];
  }

  private sessionUpdateEvent(): AgentSessionStreamEvent {
    return {
      event: "session:update",
      session: this.getSession(),
    };
  }
}

export function createCodexEventNormalizer(
  context: HarnessEventNormalizerContext,
  options?: CodexNormalizerOptions,
): CodexEventNormalizer {
  return new CodexEventNormalizer(context, options);
}
