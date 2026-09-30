/**
 * Builders that turn what the Mac already knows into an AgentNotification:
 * a session attention item (read against the session snapshot, where the
 * command, diff, and question options live) and an operator signal.
 *
 * Only declared asks are urgent. Inferred attention (`native_attention`) goes
 * out as quiet text, never as a Priority notification.
 */

import { hostname as osHostname } from "node:os";
import { basename } from "node:path";

import type {
  ActionBlock,
  Block,
  SessionState,
  TurnState,
} from "@openscout/agent-sessions";
import {
  AGENT_NOTIFICATION_VERSION,
  type AgentNotification,
  type AgentNotificationFileChange,
  type AgentNotificationRisk,
  type AgentNotificationView,
  type ScoutOperatorSignal,
} from "@openscout/protocol";

/** The fields every attention item carries (the mobile inbox item shape). */
export type AttentionNotificationItem = {
  id: string;
  kind: string;
  title: string;
  description: string;
  detail?: string | null;
  sessionId: string;
  sessionName: string;
  turnId: string | null;
  blockId: string | null;
  risk: AgentNotificationRisk;
  createdAt: number;
};

/** This Mac as the phone names it: the hostname without `.local`. */
export function notificationHostName(hostname = osHostname()): string {
  return hostname.replace(/\.local\.?$/i, "").trim();
}

function findTurn(snapshot: SessionState | null | undefined, turnId: string | null): TurnState | null {
  if (!snapshot || !turnId) return null;
  return snapshot.turns.find((turn) => turn.id === turnId) ?? null;
}

function findBlock(turn: TurnState | null, blockId: string | null): Block | null {
  if (!turn || !blockId) return null;
  return turn.blocks.find((state) => state.block.id === blockId)?.block ?? null;
}

/** Lines added and removed in a unified diff. */
export function countDiffLines(diff: string | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of (diff ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function lastLines(text: string, count: number): string[] {
  return text.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-count);
}

function formatElapsed(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function approvalView(
  block: ActionBlock,
  item: AttentionNotificationItem,
  snapshot: SessionState | null | undefined,
): AgentNotificationView {
  const action = block.action;
  const risk = action.approval?.risk ?? item.risk;
  const why = action.approval?.description?.trim() || undefined;
  switch (action.kind) {
    case "command":
      return {
        view: "turn.approve.command",
        command: action.command,
        risk,
        ...(snapshot?.session.cwd ? { cwd: snapshot.session.cwd } : {}),
        ...(why ? { why } : {}),
      };
    case "file_change": {
      const file: AgentNotificationFileChange = { path: action.path, ...countDiffLines(action.diff) };
      return { view: "turn.approve.edit", files: [file], risk, ...(why ? { summary: why } : {}) };
    }
    case "tool_call":
      return { view: "turn.approve.tool", tool: action.toolName, risk, ...(why ? { summary: why } : {}) };
    case "subagent":
      return {
        view: "turn.approve.tool",
        tool: action.agentName ?? "a subagent",
        risk,
        ...(why ?? action.prompt ? { summary: why ?? action.prompt } : {}),
      };
  }
}

function failedView(
  item: AttentionNotificationItem,
  turn: TurnState | null,
  block: Block | null,
): AgentNotificationView {
  const excerpt = block?.type === "action"
    ? lastLines(block.action.output, 4)
    : block?.type === "error"
      ? lastLines(block.message, 4)
      : [];
  const elapsed = turn ? formatElapsed((turn.endedAt ?? item.createdAt) - turn.startedAt) : undefined;
  const error = item.description.trim() || item.title.trim();
  return {
    view: "turn.failed",
    error,
    ...(excerpt.length > 0 ? { excerpt } : {}),
    ...(elapsed ? { elapsed } : {}),
  };
}

function viewForAttention(
  item: AttentionNotificationItem,
  snapshot: SessionState | null | undefined,
): { view: AgentNotificationView; urgent: boolean } {
  const turn = findTurn(snapshot, item.turnId);
  const block = findBlock(turn, item.blockId);

  switch (item.kind) {
    case "approval":
      if (block?.type === "action") {
        return { view: approvalView(block, item, snapshot), urgent: true };
      }
      break;
    case "question":
      if (block?.type === "question") {
        const context = block.header?.trim() || undefined;
        const options = block.options.map((option) => option.label).filter(Boolean);
        return {
          view: options.length > 0
            ? { view: "turn.question.choice", question: block.question, options, multiSelect: block.multiSelect, ...(context ? { context } : {}) }
            : { view: "turn.question.open", question: block.question, ...(context ? { context } : {}) },
          urgent: true,
        };
      }
      return { view: { view: "turn.question.open", question: item.description || item.title }, urgent: true };
    case "failed_action":
    case "failed_turn":
    case "session_error":
      return { view: failedView(item, turn, block), urgent: false };
    default:
      break;
  }

  const body = item.description && item.description !== item.title ? item.description : item.detail ?? undefined;
  return {
    view: { view: "text", title: item.title, ...(body ? { body } : {}) },
    // An approval we couldn't read is still a declared ask; inferred attention never is.
    urgent: item.kind === "approval",
  };
}

export function agentNotificationForSessionAttention(input: {
  item: AttentionNotificationItem;
  snapshot?: SessionState | null;
  host?: string;
}): AgentNotification {
  const { item, snapshot } = input;
  const { view, urgent } = viewForAttention(item, snapshot);
  const cwd = snapshot?.session.cwd;
  return {
    ...view,
    v: AGENT_NOTIFICATION_VERSION,
    itemId: item.id,
    sender: { name: item.sessionName || snapshot?.session.name || "Agent" },
    ...(cwd ? { project: basename(cwd) } : {}),
    host: input.host ?? notificationHostName(),
    urgent,
    createdAt: item.createdAt,
    route: {
      sessionId: item.sessionId,
      ...(item.turnId ? { turnId: item.turnId } : {}),
      ...(item.blockId ? { blockId: item.blockId } : {}),
    },
  };
}

/**
 * An operator signal an agent sent on its own, outside any turn. `need` and
 * `consult` are asks (only a need is urgent); `notify` goes out as quiet text.
 */
export function agentNotificationForOperatorSignal(input: {
  messageId: string;
  conversationId?: string | null;
  signal: ScoutOperatorSignal;
  agentName: string;
  agentId?: string | null;
  body: string;
  project?: string | null;
  host?: string;
  createdAt: number;
}): AgentNotification {
  const { signal } = input;
  const body = input.body.trim();
  let view: AgentNotificationView;
  if (signal.kind === "need") {
    const options = (signal.options ?? []).map((option) => option.trim()).filter(Boolean);
    view = { view: "ask", note: signal.question.trim() || body, ...(options.length > 0 ? { options } : {}) };
  } else if (signal.kind === "consult") {
    view = { view: "ask", note: body };
  } else {
    view = { view: "text", title: "Shared an update", ...(body ? { body } : {}) };
  }
  return {
    ...view,
    v: AGENT_NOTIFICATION_VERSION,
    itemId: input.messageId,
    sender: { name: input.agentName, ...(input.agentId ? { agentId: input.agentId } : {}) },
    ...(input.project ? { project: input.project } : {}),
    host: input.host ?? notificationHostName(),
    urgent: signal.kind === "need",
    createdAt: input.createdAt,
    route: {
      messageId: input.messageId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
  };
}
