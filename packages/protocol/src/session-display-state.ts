import type { MetadataMap, ScoutId } from "./common.js";

export type ScoutSessionDisplayPhase =
  | "idle"
  | "running"
  | "waiting"
  | "failed"
  | "completed";

export interface ScoutDisplayMessage {
  id: ScoutId;
  role: "user" | "assistant" | "system";
  text?: string;
  updatedAt: number;
  metadata?: MetadataMap;
}

export interface ScoutDisplayTool {
  id: ScoutId;
  name: string;
  status: "running" | "completed" | "failed";
  summary?: string;
  updatedAt: number;
  metadata?: MetadataMap;
}

export interface ScoutDisplayAttentionItem {
  id: ScoutId;
  kind: "question" | "approval" | "permission" | "waiting";
  title: string;
  summary?: string;
  sourceRef?: string;
  updatedAt: number;
  metadata?: MetadataMap;
}

export interface ScoutDisplaySubagent {
  id: ScoutId;
  agentType?: string;
  title: string;
  status: "running" | "completed" | "failed";
  summary?: string;
  updatedAt: number;
  metadata?: MetadataMap;
}

export interface ScoutDisplayTask {
  id: ScoutId;
  title: string;
  status: "pending" | "in_progress" | "completed";
  updatedAt: number;
  metadata?: MetadataMap;
}

export interface ScoutDisplayUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  source?: "provider_exact" | "tokenizer_estimate" | "char_heuristic" | "manual_estimate";
}

export interface ScoutDisplayTurn {
  id: ScoutId;
  status: "streaming" | "completed" | "interrupted" | "error";
  startedAt: number;
  endedAt?: number;
  blockCount: number;
  messageCount: number;
  toolCount: number;
  attentionCount: number;
  summary?: string;
  updatedAt: number;
  metadata?: MetadataMap;
}

export interface ScoutSessionDisplayState {
  sessionId: ScoutId;
  phase: ScoutSessionDisplayPhase;
  currentMessage: ScoutDisplayMessage | null;
  activeTools: Record<ScoutId, ScoutDisplayTool>;
  attention: Record<ScoutId, ScoutDisplayAttentionItem>;
  activeSubagents: Record<ScoutId, ScoutDisplaySubagent>;
  turns: ScoutDisplayTurn[];
  tasks: ScoutDisplayTask[];
  usage?: ScoutDisplayUsage;
  updatedAt: number;
  metadata?: MetadataMap;
}

export type ScoutSessionDisplayEvent =
  | { type: "phase_changed"; phase: ScoutSessionDisplayPhase; at: number }
  | { type: "message_updated"; message: ScoutDisplayMessage; at?: number }
  | { type: "tool_started"; tool: ScoutDisplayTool; at?: number }
  | { type: "tool_finished"; toolId: ScoutId; failed?: boolean; summary?: string; at: number }
  | { type: "attention_opened"; item: ScoutDisplayAttentionItem; at?: number }
  | { type: "attention_closed"; itemId: ScoutId; at: number }
  | { type: "subagent_started"; subagent: ScoutDisplaySubagent; at?: number }
  | { type: "subagent_finished"; subagentId: ScoutId; failed?: boolean; summary?: string; at: number }
  | { type: "turns_snapshot"; turns: ScoutDisplayTurn[]; at: number }
  | { type: "tasks_snapshot"; tasks: ScoutDisplayTask[]; at: number }
  | { type: "usage_updated"; usage: ScoutDisplayUsage; at: number }
  | { type: "reset_thread"; at: number };

export function createScoutSessionDisplayState(input: {
  sessionId: ScoutId;
  now?: number;
}): ScoutSessionDisplayState {
  return {
    sessionId: input.sessionId,
    phase: "idle",
    currentMessage: null,
    activeTools: {},
    attention: {},
    activeSubagents: {},
    turns: [],
    tasks: [],
    updatedAt: input.now ?? 0,
  };
}

export function reduceScoutSessionDisplayState(
  state: ScoutSessionDisplayState,
  event: ScoutSessionDisplayEvent,
): ScoutSessionDisplayState {
  switch (event.type) {
    case "phase_changed":
      return { ...state, phase: event.phase, updatedAt: event.at };
    case "message_updated":
      return { ...state, currentMessage: event.message, updatedAt: event.at ?? event.message.updatedAt };
    case "tool_started":
      return {
        ...state,
        activeTools: { ...state.activeTools, [event.tool.id]: event.tool },
        updatedAt: event.at ?? event.tool.updatedAt,
      };
    case "tool_finished": {
      const current = state.activeTools[event.toolId];
      if (!current) return { ...state, updatedAt: event.at };
      return {
        ...state,
        activeTools: {
          ...state.activeTools,
          [event.toolId]: {
            ...current,
            status: event.failed ? "failed" : "completed",
            summary: event.summary ?? current.summary,
            updatedAt: event.at,
          },
        },
        updatedAt: event.at,
      };
    }
    case "attention_opened":
      return {
        ...state,
        phase: state.phase === "idle" ? "waiting" : state.phase,
        attention: { ...state.attention, [event.item.id]: event.item },
        updatedAt: event.at ?? event.item.updatedAt,
      };
    case "attention_closed": {
      const next = { ...state.attention };
      delete next[event.itemId];
      return {
        ...state,
        attention: next,
        phase: state.phase === "waiting" && Object.keys(next).length === 0 ? "idle" : state.phase,
        updatedAt: event.at,
      };
    }
    case "subagent_started":
      return {
        ...state,
        activeSubagents: { ...state.activeSubagents, [event.subagent.id]: event.subagent },
        updatedAt: event.at ?? event.subagent.updatedAt,
      };
    case "subagent_finished": {
      const current = state.activeSubagents[event.subagentId];
      if (!current) return { ...state, updatedAt: event.at };
      return {
        ...state,
        activeSubagents: {
          ...state.activeSubagents,
          [event.subagentId]: {
            ...current,
            status: event.failed ? "failed" : "completed",
            summary: event.summary ?? current.summary,
            updatedAt: event.at,
          },
        },
        updatedAt: event.at,
      };
    }
    case "turns_snapshot":
      return { ...state, turns: [...event.turns], updatedAt: event.at };
    case "tasks_snapshot":
      return { ...state, tasks: [...event.tasks], updatedAt: event.at };
    case "usage_updated":
      return { ...state, usage: event.usage, updatedAt: event.at };
    case "reset_thread":
      return createScoutSessionDisplayState({ sessionId: state.sessionId, now: event.at });
  }
}
