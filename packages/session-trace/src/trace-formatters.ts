import type { Action, ActionStatus, Block, BlockStatus, QuestionBlockStatus, SessionStatus, TurnStatus } from "./trace-types.js";

const DEFAULT_LOCALE: string | readonly string[] | undefined = undefined;

export function normalizeTraceTimestamp(value: number | string | Date | undefined | null): number | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatTraceTimestamp(
  value: number | string | Date | undefined | null,
  locale: string | readonly string[] | undefined = DEFAULT_LOCALE,
): string {
  const timestamp = normalizeTraceTimestamp(value);
  if (timestamp == null) {
    return "—";
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function formatTraceDuration(
  startedAt: number | string | Date | undefined | null,
  endedAt: number | string | Date | undefined | null,
): string {
  const start = normalizeTraceTimestamp(startedAt);
  const end = normalizeTraceTimestamp(endedAt);
  if (start == null || end == null) {
    return "—";
  }

  const elapsed = Math.max(0, end - start);
  if (elapsed < 1_000) {
    return `${elapsed}ms`;
  }

  const totalSeconds = Math.floor(elapsed / 1_000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatTraceSessionStatus(status: SessionStatus): string {
  return status;
}

export function formatTraceTurnStatus(status: TurnStatus): string {
  return status;
}

export function formatTraceBlockStatus(status: BlockStatus): string {
  return status;
}

export function formatTraceActionStatus(status: ActionStatus): string {
  return status === "awaiting_approval" ? "awaiting approval" : status;
}

export function formatTraceQuestionStatus(status: QuestionBlockStatus): string {
  switch (status) {
    case "awaiting_answer":
      return "awaiting answer";
    case "answered":
      return "answered";
    case "denied":
      return "denied";
  }
}

export function formatTraceActionKind(kind: Action["kind"]): string {
  switch (kind) {
    case "command":
      return "Command";
    case "file_change":
      return "File change";
    case "tool_call":
      return "Tool call";
    case "subagent":
      return "Subagent";
  }
}

export function formatTraceApprovalRisk(risk: "low" | "medium" | "high" | undefined): string {
  return risk ? `${risk} risk` : "medium risk";
}

export function formatTraceBlockLabel(block: Block): string {
  switch (block.type) {
    case "text":
      return "Text";
    case "reasoning":
      return "Reasoning";
    case "action":
      return formatTraceActionKind(block.action.kind);
    case "file":
      return block.name?.trim() || "File";
    case "error":
      return "Error";
    case "question":
      return block.header?.trim() || "Question";
  }
}

export function formatTraceBlockSummary(block: Block): string {
  switch (block.type) {
    case "text":
      return block.text.trim() || "No text";
    case "reasoning":
      return block.text.trim() || "No reasoning";
    case "action":
      switch (block.action.kind) {
        case "command":
          return block.action.command.trim() || "No command";
        case "file_change":
          return block.action.path.trim() || "No path";
        case "tool_call":
          return block.action.toolName.trim() || "No tool";
        case "subagent":
          return block.action.agentName?.trim() || block.action.agentId.trim() || "Subagent";
      }
    case "file":
      return block.mimeType;
    case "error":
      return block.message.trim() || "Unknown error";
    case "question":
      return block.question.trim() || "No question";
  }
}

export function shouldCollapseReasoningBlock(block: Block): boolean {
  return block.type === "reasoning" && block.status === "completed";
}

