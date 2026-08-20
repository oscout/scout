// Pure OpenCode product-v2 event normalizer.
//
// This module deliberately knows nothing about service discovery, HTTP, the
// filesystem, or the process environment. The adapter shell owns those side
// effects and feeds the official @opencode-ai/client event union into this
// state machine.

import type {
  Action,
  AgentSessionStreamEvent,
  Block,
  BlockStatus,
  QuestionBlock,
  Turn,
  TurnStatus,
} from "../../protocol/primitives.js";
import type {
  AdapterReplayRecord,
  HarnessEventNormalizer,
  HarnessEventNormalizerContext,
} from "../../protocol/normalizer.js";
import type { OpenCodeEvent } from "./upstream.js";
import {
  boundActionInlineText,
  boundOpaqueValue,
  MAX_ACTION_OUTPUT_EVENT_UTF8_BYTES,
  MAX_DIAGNOSTIC_UTF8_BYTES,
  MAX_INLINE_ACTION_TEXT_UTF8_BYTES,
  snapshotNormalizedValue,
  splitTextForSessionEvents,
  truncateUtf8,
  utf8ByteLength,
} from "../../protocol/normalizer.js";

const MAX_TOOL_INPUT_UTF8_BYTES = 48 * 1024;
const MAX_TOOL_METADATA_UTF8_BYTES = 32 * 1024;
const MAX_FILE_DATA_UTF8_BYTES = 48 * 1024;
const MAX_QUESTION_OPTIONS = 16;
const MAX_QUESTION_OPTION_TEXT_UTF8_BYTES = 1024;
const MAX_SEEN_EVENT_IDS = 4_096;

type TextStreamKind = "text" | "reasoning";

type TextStreamState = {
  kind: TextStreamKind;
  blockId: string | null;
  emitted: string;
  ended: boolean;
};

type ToolState = {
  id: string;
  name: string;
  inputText: string;
  blockId: string | null;
  ended: boolean;
};

type ActiveTurnState = {
  turn: Turn;
  blockIndex: number;
  streams: Map<string, TextStreamState>;
  tools: Map<string, ToolState>;
  endedBlockIds: Set<string>;
  emittedFiles: Set<string>;
  permissionBlocks: Map<string, string>;
  permissionRequestsByBlock: Map<string, string>;
  resolvedPermissionRequests: Set<string>;
  approvalVersionByBlock: Map<string, number>;
  questionBlocks: Map<string, string[]>;
  questionRequestByBlock: Map<string, { requestId: string; index: number }>;
};

type BlockDraft = Block extends infer Candidate
  ? Candidate extends Block
    ? Omit<Candidate, "id" | "turnId" | "index">
    : never
  : never;

export type OpenCodeV2NormalizerOptions = {
  /** Exact native session id. Events from every other server session are ignored. */
  remoteSessionId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function eventShape(value: unknown): OpenCodeEvent | null {
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.data)) {
    return null;
  }
  return value as OpenCodeEvent;
}

function eventSessionId(event: OpenCodeEvent): string | undefined {
  return stringValue((event.data as { sessionID?: unknown }).sessionID);
}

function streamKey(
  kind: TextStreamKind,
  data: { assistantMessageID: string; ordinal: number },
): string {
  return `${kind}:${data.assistantMessageID}:${data.ordinal}`;
}

function toolNameLooksLikeCommand(name: string): boolean {
  return ["bash", "command", "shell", "terminal"].includes(name.toLowerCase());
}

function toolNameLooksLikeFileChange(name: string): boolean {
  return ["apply_patch", "edit", "multi_edit", "patch", "write"].includes(name.toLowerCase());
}

function toolNameLooksLikeSubagent(name: string): boolean {
  return ["agent", "subagent", "task"].includes(name.toLowerCase());
}

function actionForTool(name: string, id: string, inputValue: unknown): Action {
  const input = isRecord(inputValue) ? inputValue : {};
  const boundedInput = boundOpaqueValue(inputValue, MAX_TOOL_INPUT_UTF8_BYTES, `opencode-v2:tool:${id}:input`);

  if (toolNameLooksLikeCommand(name)) {
    const command = stringValue(input.command)
      ?? (Array.isArray(input.command)
        ? input.command.filter((entry): entry is string => typeof entry === "string").join(" ")
        : stringify(inputValue));
    return {
      kind: "command",
      command,
      status: "running",
      output: "",
    };
  }

  if (toolNameLooksLikeFileChange(name)) {
    const path = stringValue(input.filePath)
      ?? stringValue(input.file_path)
      ?? stringValue(input.path)
      ?? stringValue(input.file)
      ?? "";
    const diff = stringValue(input.diff) ?? stringValue(input.patch);
    // A tool name alone is not sufficient evidence for a file change. Keep
    // malformed or novel V2 tool payloads generic rather than fabricating an
    // empty path that downstream diff views would treat as authoritative.
    if (path) {
      return {
        kind: "file_change",
        path,
        ...(diff ? { diff } : {}),
        status: "running",
        output: "",
      };
    }
  }

  if (toolNameLooksLikeSubagent(name)) {
    return {
      kind: "subagent",
      agentId: stringValue(input.agentId) ?? stringValue(input.agent) ?? id,
      agentName: stringValue(input.agentName) ?? stringValue(input.name),
      prompt: stringValue(input.prompt),
      status: "running",
      output: "",
    };
  }

  return {
    kind: "tool_call",
    toolName: name || "unknown",
    toolCallId: id,
    input: boundedInput,
    status: "running",
    output: "",
  };
}

function structuredErrorMessage(value: unknown): string {
  if (!isRecord(value)) return stringify(value) || "OpenCode execution failed.";
  const message = stringValue(value.message) ?? "OpenCode execution failed.";
  const type = stringValue(value.type);
  return type && !message.includes(type) ? `${message} (${type})` : message;
}

function boundedText(value: string | undefined, maxBytes: number): string | undefined {
  return value === undefined ? undefined : truncateUtf8(value, maxBytes).text;
}

function boundedDiagnostic(message: string, sourceRef: string): {
  message: string;
  truncation?: { omittedBytes: number; maxRetainedBytes: number; sourceRef: string };
} {
  const result = truncateUtf8(message, MAX_DIAGNOSTIC_UTF8_BYTES);
  return {
    message: result.text,
    ...(result.omittedBytes > 0
      ? {
          truncation: {
            omittedBytes: result.omittedBytes,
            maxRetainedBytes: MAX_DIAGNOSTIC_UTF8_BYTES,
            sourceRef,
          },
        }
      : {}),
  };
}

function boundedFileData(data: string, sourceRef: string): string {
  const bytes = utf8ByteLength(data);
  if (bytes <= MAX_FILE_DATA_UTF8_BYTES) return data;
  return `urn:openscout:truncated?source=${encodeURIComponent(sourceRef)}&omittedBytes=${bytes}`;
}

/**
 * Normalize current product-v2 events (`session.text.*`, not the older
 * preview `session.next.*` family) onto OpenScout's single session grammar.
 */
export class OpenCodeV2EventNormalizer implements HarnessEventNormalizer {
  private readonly context: HarnessEventNormalizerContext;
  private remoteSessionId: string | null;
  private current: ActiveTurnState | null = null;
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];

  constructor(context: HarnessEventNormalizerContext, options: OpenCodeV2NormalizerOptions = {}) {
    this.context = context;
    this.remoteSessionId = options.remoteSessionId?.trim() || null;
  }

  get turnOpen(): boolean {
    return this.current !== null;
  }

  get currentTurnId(): string | null {
    return this.current?.turn.id ?? null;
  }

  setRemoteSessionId(sessionId: string): void {
    this.remoteSessionId = sessionId;
  }

  permissionBlockId(requestId: string): string | undefined {
    return this.current?.permissionBlocks.get(requestId);
  }

  permissionRequestForBlock(blockId: string): string | undefined {
    return this.current?.permissionRequestsByBlock.get(blockId);
  }

  questionBlockIds(requestId: string): readonly string[] {
    return this.current?.questionBlocks.get(requestId) ?? [];
  }

  questionRequestForBlock(blockId: string): { requestId: string; index: number } | undefined {
    return this.current?.questionRequestByBlock.get(blockId);
  }

  ingest(record: AdapterReplayRecord): readonly AgentSessionStreamEvent[] {
    if (record.source === "adapter_control") {
      return this.ingestControl(record);
    }

    const event = eventShape(record.payload);
    if (!event) return [];
    const nativeSessionId = eventSessionId(event);
    if (!nativeSessionId || !this.remoteSessionId || nativeSessionId !== this.remoteSessionId) {
      return [];
    }
    if (this.hasSeen(event.id)) return [];
    this.remember(event.id);
    if (!this.current) return [];

    switch (event.type) {
      case "session.execution.started":
        return [];
      case "session.execution.succeeded":
        return this.finishTurn("completed");
      case "session.execution.interrupted":
        return this.finishTurn("stopped");
      case "session.execution.failed":
        return this.finishTurn("failed", structuredErrorMessage(event.data.error));
      case "session.idle":
        // Compatibility fallback. The current product-v2 server emits an
        // execution terminal event; idle is accepted only if that edge was
        // absent, and the exactly-once guard makes a later terminal harmless.
        return this.finishTurn("completed");
      case "session.text.started":
        this.noteStream("text", event.data);
        return [];
      case "session.text.delta":
        return this.appendStream("text", event.data, event.data.delta);
      case "session.text.ended":
        return this.endStream("text", event.data, event.data.text);
      case "session.reasoning.started":
        this.noteStream("reasoning", event.data);
        return [];
      case "session.reasoning.delta":
        return this.appendStream("reasoning", event.data, event.data.delta);
      case "session.reasoning.ended":
        return this.endStream("reasoning", event.data, event.data.text);

      case "session.tool.input.started":
        this.noteTool(event.data.id, event.data.name);
        return [];
      case "session.tool.input.delta": {
        const tool = this.noteTool(event.data.id, "unknown");
        tool.inputText = truncateUtf8(
          tool.inputText + event.data.delta,
          MAX_TOOL_INPUT_UTF8_BYTES,
        ).text;
        return [];
      }
      case "session.tool.input.ended": {
        const tool = this.noteTool(event.data.id, "unknown");
        tool.inputText = truncateUtf8(event.data.text, MAX_TOOL_INPUT_UTF8_BYTES).text;
        return [];
      }
      case "session.tool.called":
        return this.startTool(event.data.id, event.data.input);
      case "session.tool.progress":
        // Progress metadata is replacement state (for example {shellID}), not
        // an append-only output delta. The durable success/failure event owns
        // the normalized output.
        return [];
      case "session.tool.success":
        return this.finishTool(event.data.id, "completed", event.data.content, event.data.metadata);
      case "session.tool.failed":
        return this.finishTool(
          event.data.id,
          "failed",
          event.data.content ?? [],
          event.data.metadata,
          structuredErrorMessage(event.data.error),
        );

      case "session.step.ended":
        return this.emitFiles(event.data.files ?? [], event.id);
      case "session.step.failed":
        return this.emitFiles(event.data.files ?? [], event.id);

      case "permission.asked":
        return this.openPermission(event.data);
      case "permission.replied":
        return this.resolvePermission(event.data.requestID, event.data.reply === "reject" ? "deny" : "approve");
      case "question.asked":
        return this.openQuestions(event.data.id, event.data.questions);
      case "question.replied":
        return this.resolveQuestions(event.data.requestID, event.data.answers, "answered");
      case "question.rejected":
        return this.resolveQuestions(event.data.requestID, [], "denied");

      default:
        return [];
    }
  }

  finishReplay(): readonly AgentSessionStreamEvent[] {
    return this.current
      ? this.finishTurn("failed", "OpenCode event replay ended before the turn completed.")
      : [];
  }

  resolvePermission(
    requestId: string,
    decision: "approve" | "deny",
  ): readonly AgentSessionStreamEvent[] {
    const current = this.current;
    const blockId = current?.permissionBlocks.get(requestId);
    if (
      !current
      || !blockId
      || current.endedBlockIds.has(blockId)
      || current.resolvedPermissionRequests.has(requestId)
    ) return [];
    current.resolvedPermissionRequests.add(requestId);
    current.permissionBlocks.delete(requestId);
    current.permissionRequestsByBlock.delete(blockId);

    const events: AgentSessionStreamEvent[] = [{
      event: "block:action:status",
      sessionId: this.context.sessionId,
      turnId: current.turn.id,
      blockId,
      status: decision === "approve" ? "running" : "failed",
    }];
    // A denied native tool emits its own durable session.tool.failed event.
    // Keep the block open so that terminal error/content can be normalized
    // before block:end; execution termination remains the fallback closer.
    return events;
  }

  resolveQuestions(
    requestId: string,
    answers: readonly (readonly string[])[],
    status: "answered" | "denied" = "answered",
  ): readonly AgentSessionStreamEvent[] {
    const current = this.current;
    const blockIds = current?.questionBlocks.get(requestId);
    if (!current || !blockIds) return [];
    current.questionBlocks.delete(requestId);
    for (const blockId of blockIds) current.questionRequestByBlock.delete(blockId);

    const events: AgentSessionStreamEvent[] = [];
    for (const [index, blockId] of blockIds.entries()) {
      if (current.endedBlockIds.has(blockId)) continue;
      events.push({
        event: "block:question:answer",
        sessionId: this.context.sessionId,
        turnId: current.turn.id,
        blockId,
        questionStatus: status,
        ...(status === "answered" ? { answer: [...(answers[index] ?? [])] } : {}),
      });
      events.push(...this.endBlock(blockId, status === "answered" ? "completed" : "failed"));
    }
    return events;
  }

  private ingestControl(
    record: Extract<AdapterReplayRecord, { source: "adapter_control" }>,
  ): readonly AgentSessionStreamEvent[] {
    if (record.event === "prompt_accepted") {
      const payload = isRecord(record.payload) ? record.payload : {};
      const remoteSessionId = stringValue(payload.remoteSessionId);
      if (remoteSessionId) this.remoteSessionId = remoteSessionId;
      const events = this.current
        ? [...this.finishTurn("failed", "A new prompt replaced an unfinished OpenCode turn.")]
        : [];
      const turn: Turn = {
        id: record.turnId ?? this.context.nextId("turn"),
        sessionId: this.context.sessionId,
        status: "started",
        startedAt: this.context.now(),
        blocks: [],
      };
      this.current = {
        turn,
        blockIndex: 0,
        streams: new Map(),
        tools: new Map(),
        endedBlockIds: new Set(),
        emittedFiles: new Set(),
        permissionBlocks: new Map(),
        permissionRequestsByBlock: new Map(),
        resolvedPermissionRequests: new Set(),
        approvalVersionByBlock: new Map(),
        questionBlocks: new Map(),
        questionRequestByBlock: new Map(),
      };
      events.push({
        event: "turn:start",
        sessionId: this.context.sessionId,
        turn: snapshotNormalizedValue(turn),
      });
      return events;
    }

    if (record.event === "interrupt" || record.event === "transport_closed") {
      return this.finishTurn("stopped");
    }
    if (record.event === "transport_error") {
      const message = isRecord(record.payload)
        ? stringValue(record.payload.message)
        : stringValue(record.payload);
      return this.finishTurn("failed", message ?? "OpenCode event transport failed.");
    }
    if (record.event === "question_answered" && isRecord(record.payload)) {
      const blockId = stringValue(record.payload.blockId);
      const answer = Array.isArray(record.payload.answer)
        ? record.payload.answer.filter((entry): entry is string => typeof entry === "string")
        : [];
      const request = blockId ? this.questionRequestForBlock(blockId) : undefined;
      return request ? this.resolveQuestions(request.requestId, [answer]) : [];
    }
    return [];
  }

  private hasSeen(eventId: string): boolean {
    return this.seenEventIds.has(eventId);
  }

  private remember(eventId: string): void {
    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);
    if (this.seenEventOrder.length <= MAX_SEEN_EVENT_IDS) return;
    const removed = this.seenEventOrder.shift();
    if (removed) this.seenEventIds.delete(removed);
  }

  private noteStream(
    kind: TextStreamKind,
    data: { assistantMessageID: string; ordinal: number },
  ): TextStreamState {
    const current = this.current!;
    const key = streamKey(kind, data);
    let stream = current.streams.get(key);
    if (!stream) {
      stream = { kind, blockId: null, emitted: "", ended: false };
      current.streams.set(key, stream);
    }
    return stream;
  }

  private ensureStreamBlock(
    stream: TextStreamState,
  ): { blockId: string; events: AgentSessionStreamEvent[] } {
    if (stream.blockId) return { blockId: stream.blockId, events: [] };
    const block = this.startBlock({
      type: stream.kind,
      text: "",
      status: "streaming",
    });
    stream.blockId = block.block.id;
    return { blockId: block.block.id, events: block.events };
  }

  private appendStream(
    kind: TextStreamKind,
    data: { assistantMessageID: string; ordinal: number },
    delta: string,
  ): readonly AgentSessionStreamEvent[] {
    const stream = this.noteStream(kind, data);
    if (stream.ended || !delta) return [];
    const { blockId, events } = this.ensureStreamBlock(stream);
    stream.emitted += delta;
    return [
      ...events,
      ...splitTextForSessionEvents(delta, (text): AgentSessionStreamEvent => ({
        event: "block:delta",
        sessionId: this.context.sessionId,
        turnId: this.current!.turn.id,
        blockId,
        text,
      })),
    ];
  }

  private endStream(
    kind: TextStreamKind,
    data: { assistantMessageID: string; ordinal: number },
    finalText: string,
  ): readonly AgentSessionStreamEvent[] {
    const stream = this.noteStream(kind, data);
    if (stream.ended) return [];
    const events: AgentSessionStreamEvent[] = [];
    if (!stream.blockId && !finalText) {
      stream.ended = true;
      return [];
    }
    const ensured = this.ensureStreamBlock(stream);
    events.push(...ensured.events);
    if (finalText.startsWith(stream.emitted)) {
      const missing = finalText.slice(stream.emitted.length);
      if (missing) {
        stream.emitted += missing;
        events.push(...splitTextForSessionEvents(missing, (text): AgentSessionStreamEvent => ({
          event: "block:delta",
          sessionId: this.context.sessionId,
          turnId: this.current!.turn.id,
          blockId: ensured.blockId,
          text,
        })));
      }
    }
    stream.ended = true;
    events.push(...this.endBlock(ensured.blockId, "completed"));
    return events;
  }

  private noteTool(id: string, name: string): ToolState {
    const current = this.current!;
    let tool = current.tools.get(id);
    if (!tool) {
      tool = { id, name, inputText: "", blockId: null, ended: false };
      current.tools.set(id, tool);
    } else if (tool.name === "unknown" && name !== "unknown") {
      tool.name = name;
    }
    return tool;
  }

  private startTool(id: string, input: unknown): readonly AgentSessionStreamEvent[] {
    const tool = this.noteTool(id, "unknown");
    if (tool.blockId) return [];
    const parsedInput = input ?? (() => {
      try {
        return JSON.parse(tool.inputText);
      } catch {
        return tool.inputText;
      }
    })();
    const started = this.startBlock({
      type: "action",
      action: boundActionInlineText(
        actionForTool(tool.name, id, parsedInput),
        `opencode-v2:tool:${id}`,
      ),
      status: "streaming",
    });
    tool.blockId = started.block.id;
    return started.events;
  }

  private ensureTool(id: string): { tool: ToolState; events: AgentSessionStreamEvent[] } {
    const tool = this.noteTool(id, "unknown");
    if (tool.blockId) return { tool, events: [] };
    const events = [...this.startTool(id, undefined)];
    return { tool, events };
  }

  private finishTool(
    id: string,
    status: "completed" | "failed",
    content: ReadonlyArray<{ type: string; text?: string; uri?: string; mime?: string; name?: string }>,
    metadata: unknown,
    errorMessage?: string,
  ): readonly AgentSessionStreamEvent[] {
    const current = this.current!;
    const ensured = this.ensureTool(id);
    const tool = ensured.tool;
    if (!tool.blockId || tool.ended) return ensured.events;
    const events: AgentSessionStreamEvent[] = [...ensured.events];
    const text = content
      .filter((item): item is { type: string; text: string } => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n");
    const output = [text, errorMessage].filter(Boolean).join(text && errorMessage ? "\n" : "");
    if (output) {
      events.push(...splitTextForSessionEvents(
        output,
        (chunk): AgentSessionStreamEvent => ({
          event: "block:action:output",
          sessionId: this.context.sessionId,
          turnId: current.turn.id,
          blockId: tool.blockId!,
          output: chunk,
        }),
        MAX_ACTION_OUTPUT_EVENT_UTF8_BYTES,
      ));
    }
    for (const [index, item] of content.entries()) {
      if (item.type !== "file" || !item.uri) continue;
      events.push(...this.emitFile({
        key: `${id}:${index}:${item.uri}`,
        name: item.name,
        mimeType: item.mime || "application/octet-stream",
        data: boundedFileData(item.uri, `opencode-v2:tool:${id}:file:${index}`),
      }));
    }
    const meta = isRecord(metadata)
      ? boundOpaqueValue(
          metadata,
          MAX_TOOL_METADATA_UTF8_BYTES,
          `opencode-v2:tool:${id}:metadata`,
        ) as Record<string, unknown>
      : undefined;
    events.push({
      event: "block:action:status",
      sessionId: this.context.sessionId,
      turnId: current.turn.id,
      blockId: tool.blockId,
      status,
      ...(meta ? { meta: snapshotNormalizedValue(meta) } : {}),
    });
    tool.ended = true;
    events.push(...this.endBlock(tool.blockId, status));
    return events;
  }

  private emitFiles(paths: readonly string[], eventId: string): readonly AgentSessionStreamEvent[] {
    return paths.flatMap((path, index) => this.emitFile({
      key: `step:${eventId}:${index}:${path}`,
      name: path,
      mimeType: "application/octet-stream",
      data: boundedFileData(path, `opencode-v2:step:${eventId}:file:${index}`),
    }));
  }

  private emitFile(file: {
    key: string;
    name?: string;
    mimeType: string;
    data: string;
  }): AgentSessionStreamEvent[] {
    const current = this.current!;
    if (current.emittedFiles.has(file.key)) return [];
    current.emittedFiles.add(file.key);
    const started = this.startBlock({
      type: "file",
      ...(file.name ? { name: boundedText(file.name, MAX_INLINE_ACTION_TEXT_UTF8_BYTES) } : {}),
      mimeType: boundedText(file.mimeType, 256) ?? "application/octet-stream",
      data: boundedFileData(file.data, `opencode-v2:file:${file.key}`),
      status: "completed",
    });
    return [...started.events, ...this.endBlock(started.block.id, "completed")];
  }

  private openPermission(data: {
    id: string;
    action: string;
    resources: string[];
    source?: { type: "tool"; id: string; messageID: string };
  }): readonly AgentSessionStreamEvent[] {
    const current = this.current!;
    if (current.permissionBlocks.has(data.id) || current.resolvedPermissionRequests.has(data.id)) {
      return [];
    }
    const toolId = data.source?.id ?? `permission:${data.id}`;
    const tool = this.noteTool(toolId, data.action || "permission");
    const events: AgentSessionStreamEvent[] = [];
    if (!tool.blockId) {
      const started = this.startBlock({
        type: "action",
        action: boundActionInlineText(
          actionForTool(tool.name, toolId, { resources: data.resources }),
          `opencode-v2:permission:${data.id}`,
        ),
        status: "streaming",
      });
      tool.blockId = started.block.id;
      events.push(...started.events);
    }
    current.permissionBlocks.set(data.id, tool.blockId);
    current.permissionRequestsByBlock.set(tool.blockId, data.id);
    const version = (current.approvalVersionByBlock.get(tool.blockId) ?? 0) + 1;
    current.approvalVersionByBlock.set(tool.blockId, version);
    events.push({
      event: "block:action:approval",
      sessionId: this.context.sessionId,
      turnId: current.turn.id,
      blockId: tool.blockId,
      approval: {
        version,
        description: truncateUtf8(
          [data.action, ...data.resources].filter(Boolean).join("\n"),
          MAX_INLINE_ACTION_TEXT_UTF8_BYTES,
        ).text,
        risk: "medium",
      },
    });
    return events;
  }

  private openQuestions(
    requestId: string,
    questions: ReadonlyArray<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiple?: boolean;
    }>,
  ): readonly AgentSessionStreamEvent[] {
    const current = this.current!;
    if (current.questionBlocks.has(requestId)) return [];
    const blockIds: string[] = [];
    const events: AgentSessionStreamEvent[] = [];
    for (const [index, question] of questions.entries()) {
      const block: QuestionBlock = {
        id: this.context.nextId("block"),
        turnId: current.turn.id,
        type: "question",
        status: "streaming",
        index: current.blockIndex++,
        header: boundedText(question.header, MAX_INLINE_ACTION_TEXT_UTF8_BYTES),
        question: boundedText(question.question, MAX_INLINE_ACTION_TEXT_UTF8_BYTES) ?? "",
        options: question.options.slice(0, MAX_QUESTION_OPTIONS).map((option) => ({
          label: boundedText(option.label, MAX_QUESTION_OPTION_TEXT_UTF8_BYTES) ?? "",
          description: boundedText(option.description, MAX_QUESTION_OPTION_TEXT_UTF8_BYTES),
        })),
        multiSelect: question.multiple === true,
        questionStatus: "awaiting_answer",
      };
      blockIds.push(block.id);
      current.questionRequestByBlock.set(block.id, { requestId, index });
      events.push({
        event: "block:start",
        sessionId: this.context.sessionId,
        turnId: current.turn.id,
        block: snapshotNormalizedValue(block),
      });
    }
    current.questionBlocks.set(requestId, blockIds);
    return events;
  }

  private startBlock(
    partial: BlockDraft,
  ): { block: Block; events: AgentSessionStreamEvent[] } {
    const current = this.current!;
    const block = {
      ...partial,
      id: this.context.nextId("block"),
      turnId: current.turn.id,
      index: current.blockIndex++,
    } as Block;
    current.turn.blocks.push(snapshotNormalizedValue(block));
    return {
      block,
      events: [{
        event: "block:start",
        sessionId: this.context.sessionId,
        turnId: current.turn.id,
        block: snapshotNormalizedValue(block),
      }],
    };
  }

  private endBlock(blockId: string, status: BlockStatus): AgentSessionStreamEvent[] {
    const current = this.current;
    if (!current || current.endedBlockIds.has(blockId)) return [];
    current.endedBlockIds.add(blockId);
    return [{
      event: "block:end",
      sessionId: this.context.sessionId,
      turnId: current.turn.id,
      blockId,
      status,
    }];
  }

  private finishTurn(status: TurnStatus, errorMessage?: string): readonly AgentSessionStreamEvent[] {
    const current = this.current;
    if (!current) return [];
    const events: AgentSessionStreamEvent[] = [];

    if (errorMessage) {
      const diagnostic = boundedDiagnostic(errorMessage, `turn:${current.turn.id}`);
      const started = this.startBlock({
        type: "error",
        message: diagnostic.message,
        ...(diagnostic.truncation ? { truncation: diagnostic.truncation } : {}),
        status: "completed",
      });
      events.push(...started.events, ...this.endBlock(started.block.id, "completed"));
      events.push({
        event: "turn:error",
        sessionId: this.context.sessionId,
        turnId: current.turn.id,
        message: diagnostic.message,
      });
    }

    for (const stream of current.streams.values()) {
      if (stream.blockId && !stream.ended) {
        stream.ended = true;
        events.push(...this.endBlock(stream.blockId, "completed"));
      }
    }
    for (const tool of current.tools.values()) {
      if (!tool.blockId || tool.ended || current.endedBlockIds.has(tool.blockId)) continue;
      const actionStatus = status === "completed" ? "completed" : "failed";
      events.push({
        event: "block:action:status",
        sessionId: this.context.sessionId,
        turnId: current.turn.id,
        blockId: tool.blockId,
        status: actionStatus,
      });
      tool.ended = true;
      events.push(...this.endBlock(tool.blockId, actionStatus));
    }
    for (const blockIds of current.questionBlocks.values()) {
      for (const blockId of blockIds) {
        if (current.endedBlockIds.has(blockId)) continue;
        events.push({
          event: "block:question:answer",
          sessionId: this.context.sessionId,
          turnId: current.turn.id,
          blockId,
          questionStatus: "denied",
        });
        events.push(...this.endBlock(blockId, "failed"));
      }
    }

    current.turn.status = status;
    current.turn.endedAt = this.context.now();
    events.push({
      event: "turn:end",
      sessionId: this.context.sessionId,
      turnId: current.turn.id,
      status,
    });
    this.current = null;
    return events;
  }
}

export function createOpenCodeV2EventNormalizer(
  context: HarnessEventNormalizerContext,
  options?: OpenCodeV2NormalizerOptions,
): OpenCodeV2EventNormalizer {
  return new OpenCodeV2EventNormalizer(context, options);
}
