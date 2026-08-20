import type {
  ActionBlock,
  Block,
  BlockState,
  SessionState,
  TurnState,
} from "@openscout/agent-sessions";
import {
  type ScoutDisplayAttentionItem,
  type ScoutDisplayMessage,
  type ScoutDisplaySubagent,
  type ScoutDisplayTask,
  type ScoutDisplayTool,
  type ScoutDisplayTurn,
  type ScoutDisplayUsage,
  type ScoutSessionDisplayPhase,
  type ScoutSessionDisplayState,
} from "@openscout/protocol";

import { projectSessionAttention } from "./session-attention.js";

export interface SessionDisplayProjectionOptions {
  now?: number;
  maxTurns?: number;
  pendingApprovalIds?: Iterable<string>;
}

const DEFAULT_MAX_TURNS = 50;

export function projectSessionDisplayState(
  snapshot: SessionState,
  options: SessionDisplayProjectionOptions = {},
): ScoutSessionDisplayState {
  const now = options.now ?? Date.now();
  const turns = projectTurns(snapshot.turns, options.maxTurns ?? DEFAULT_MAX_TURNS);
  const attentionItems = projectSessionAttention(snapshot, {
    now,
    pendingApprovalIds: options.pendingApprovalIds,
  }).map((item): ScoutDisplayAttentionItem => ({
    id: item.id,
    kind: displayAttentionKind(item.kind),
    title: item.title,
    summary: item.summary ?? undefined,
    sourceRef: item.blockId ?? item.turnId ?? item.sessionId,
    updatedAt: item.updatedAt,
    metadata: {
      adapterType: item.adapterType,
      blockId: item.blockId,
      detail: item.detail,
      severity: item.severity,
      sourceKind: item.kind,
      sourceLabel: item.sourceLabel,
      turnId: item.turnId,
      version: item.version,
    },
  }));
  const activeTurn = currentTurn(snapshot);
  const activeTools = projectActiveTools(snapshot.turns);
  const activeSubagents = projectActiveSubagents(snapshot.turns);
  const usage = projectUsage(snapshot.session.providerMeta);
  const updatedAt = Math.max(
    now,
    ...turns.map((turn) => turn.updatedAt),
    ...attentionItems.map((item) => item.updatedAt),
  );

  return {
    sessionId: snapshot.session.id,
    phase: projectDisplayPhase(snapshot, attentionItems.length),
    currentMessage: projectCurrentMessage(activeTurn ?? snapshot.turns.at(-1), now),
    activeTools,
    attention: Object.fromEntries(attentionItems.map((item) => [item.id, item])),
    activeSubagents,
    turns,
    tasks: projectTasks(snapshot.session.providerMeta, now),
    usage,
    updatedAt,
    metadata: {
      adapterType: snapshot.session.adapterType,
      cwd: snapshot.session.cwd,
      currentTurnId: snapshot.currentTurnId,
      model: snapshot.session.model,
      provider: metadataString(snapshot.session.providerMeta, "provider"),
      sessionName: snapshot.session.name,
      sessionStatus: snapshot.session.status,
      turnCount: snapshot.turns.length,
    },
  };
}

function projectDisplayPhase(
  snapshot: SessionState,
  attentionCount: number,
): ScoutSessionDisplayPhase {
  if (snapshot.session.status === "error" || snapshot.turns.at(-1)?.status === "error") {
    return "failed";
  }
  if (attentionCount > 0) {
    return "waiting";
  }
  const current = currentTurn(snapshot);
  if (current?.status === "streaming") {
    return "running";
  }
  if (snapshot.session.status === "closed") {
    return "completed";
  }
  if (snapshot.turns.at(-1)?.status === "completed") {
    return "completed";
  }
  return "idle";
}

function projectTurns(turns: readonly TurnState[], maxTurns: number): ScoutDisplayTurn[] {
  return turns.slice(-maxTurns).map((turn) => {
    const attentionCount = turn.blocks.filter((blockState) => blockNeedsAttention(blockState.block)).length;
    return {
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      blockCount: turn.blocks.length,
      messageCount: turn.blocks.filter((blockState) => isMessageBlock(blockState.block)).length,
      toolCount: turn.blocks.filter((blockState) => blockState.block.type === "action").length,
      attentionCount,
      summary: turnSummary(turn),
      updatedAt: turnUpdatedAt(turn),
      metadata: {
        hasActiveTool: turn.blocks.some((blockState) => activeActionBlock(blockState.block)),
      },
    };
  });
}

function projectCurrentMessage(
  turn: TurnState | undefined,
  fallbackTime: number,
): ScoutDisplayMessage | null {
  if (!turn) return null;
  const blockState = [...turn.blocks].reverse().find((candidate) => isMessageBlock(candidate.block));
  if (!blockState) return null;
  const block = blockState.block;
  const text = block.type === "text" || block.type === "reasoning" ? block.text : "";
  return {
    id: `${turn.id}:${block.id}`,
    role: block.type === "reasoning" ? "system" : "assistant",
    text: compactText(text, 4_000),
    updatedAt: turnUpdatedAt(turn) || fallbackTime,
    metadata: {
      blockId: block.id,
      blockType: block.type,
      turnId: turn.id,
    },
  };
}

function projectActiveTools(turns: readonly TurnState[]): Record<string, ScoutDisplayTool> {
  const entries: Array<[string, ScoutDisplayTool]> = [];
  for (const turn of turns) {
    for (const blockState of turn.blocks) {
      const block = blockState.block;
      if (block.type !== "action" || !activeActionBlock(block)) {
        continue;
      }
      const id = displayBlockId(turn, block);
      entries.push([id, {
        id,
        name: actionName(block),
        status: block.action.status === "failed" ? "failed" : "running",
        summary: actionSummary(block),
        updatedAt: turnUpdatedAt(turn),
        metadata: {
          actionKind: block.action.kind,
          blockId: block.id,
          nativeStatus: block.action.status,
          turnId: turn.id,
        },
      }]);
    }
  }
  return Object.fromEntries(entries);
}

function projectActiveSubagents(turns: readonly TurnState[]): Record<string, ScoutDisplaySubagent> {
  const entries: Array<[string, ScoutDisplaySubagent]> = [];
  for (const turn of turns) {
    for (const blockState of turn.blocks) {
      const block = blockState.block;
      if (block.type !== "action" || block.action.kind !== "subagent" || !activeActionBlock(block)) {
        continue;
      }
      const id = displayBlockId(turn, block);
      entries.push([id, {
        id,
        agentType: block.action.agentId,
        title: block.action.agentName ?? block.action.agentId,
        status: block.action.status === "failed" ? "failed" : "running",
        summary: block.action.prompt ? compactText(block.action.prompt, 240) : undefined,
        updatedAt: turnUpdatedAt(turn),
        metadata: {
          blockId: block.id,
          nativeStatus: block.action.status,
          turnId: turn.id,
        },
      }]);
    }
  }
  return Object.fromEntries(entries);
}

function projectTasks(providerMeta: Record<string, unknown> | undefined, fallbackTime: number): ScoutDisplayTask[] {
  const topology = metadataRecord(providerMeta?.observedTopology);
  const tasks = Array.isArray(topology?.tasks) ? topology.tasks : [];
  return tasks.flatMap((value): ScoutDisplayTask[] => {
    const task = metadataRecord(value);
    const id = metadataString(task, "id");
    if (!task || !id) return [];
    return [{
      id,
      title: metadataString(task, "title") ?? id,
      status: taskStatus(metadataString(task, "state")),
      updatedAt: metadataTimestamp(task, fallbackTime) ?? fallbackTime,
      metadata: {
        assigneeId: metadataString(task, "assigneeId"),
        sourceRef: metadataString(task, "sourceRef"),
      },
    }];
  });
}

function projectUsage(providerMeta: Record<string, unknown> | undefined): ScoutDisplayUsage | undefined {
  const usage = metadataRecord(providerMeta?.observeUsage) ?? metadataRecord(providerMeta?.usage);
  if (!usage) return undefined;
  const inputTokens = metadataNumber(usage, "inputTokens")
    ?? metadataNumber(usage, "input_tokens")
    ?? metadataNumber(usage, "input");
  const outputTokens = metadataNumber(usage, "outputTokens")
    ?? metadataNumber(usage, "output_tokens")
    ?? metadataNumber(usage, "output");
  const totalTokens = metadataNumber(usage, "totalTokens")
    ?? metadataNumber(usage, "total_tokens")
    ?? ((inputTokens ?? 0) + (outputTokens ?? 0) || undefined);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    source: "provider_exact",
  };
}

function currentTurn(snapshot: SessionState): TurnState | undefined {
  return snapshot.currentTurnId
    ? snapshot.turns.find((turn) => turn.id === snapshot.currentTurnId)
    : undefined;
}

function turnSummary(turn: TurnState): string | undefined {
  for (const blockState of [...turn.blocks].reverse()) {
    const block = blockState.block;
    if ((block.type === "text" || block.type === "reasoning") && block.text.trim()) {
      return compactText(block.text, 180);
    }
    if (block.type === "error" && block.message.trim()) {
      return compactText(block.message, 180);
    }
    if (block.type === "action") {
      const summary = actionSummary(block);
      if (summary) return compactText(summary, 180);
    }
    if (block.type === "question" && block.question.trim()) {
      return compactText(block.question, 180);
    }
  }
  return undefined;
}

function isMessageBlock(block: Block): boolean {
  return block.type === "text" || block.type === "reasoning";
}

function blockNeedsAttention(block: Block): boolean {
  if (block.type === "question") {
    return block.questionStatus === "awaiting_answer";
  }
  return block.type === "action" && block.action.status === "awaiting_approval";
}

function activeActionBlock(block: Block): block is ActionBlock {
  return block.type === "action"
    && (block.action.status === "pending"
      || block.action.status === "running"
      || block.action.status === "awaiting_approval");
}

function actionName(block: ActionBlock): string {
  switch (block.action.kind) {
    case "command":
      return "command";
    case "file_change":
      return "file_change";
    case "tool_call":
      return block.action.toolName;
    case "subagent":
      return block.action.agentName ?? block.action.agentId;
  }
}

function actionSummary(block: ActionBlock): string | undefined {
  switch (block.action.kind) {
    case "command":
      return block.action.command;
    case "file_change":
      return block.action.path;
    case "tool_call":
      return block.action.output || block.action.toolName;
    case "subagent":
      return block.action.prompt ?? block.action.agentName ?? block.action.agentId;
  }
}

function taskStatus(value: string | null): ScoutDisplayTask["status"] {
  switch (value) {
    case "done":
    case "completed":
    case "complete":
    case "closed":
      return "completed";
    case "working":
    case "running":
    case "in_progress":
    case "active":
      return "in_progress";
    default:
      return "pending";
  }
}

function displayAttentionKind(kind: string): ScoutDisplayAttentionItem["kind"] {
  switch (kind) {
    case "question":
      return "question";
    case "approval":
      return "approval";
    case "native_attention":
      return "waiting";
    default:
      return "waiting";
  }
}

function displayBlockId(turn: TurnState, block: ActionBlock | BlockState["block"]): string {
  return `${turn.id}:${block.id}`;
}

function turnUpdatedAt(turn: TurnState): number {
  return turn.endedAt ?? turn.startedAt;
}

function compactText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function metadataString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function metadataNumber(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataTimestamp(
  record: Record<string, unknown> | null | undefined,
  fallback: number,
): number | null {
  const value = record?.updatedAt ?? record?.updated_at ?? record?.timestamp ?? record?.ts;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return null;
}
