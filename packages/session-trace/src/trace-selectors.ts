import type {
  ActionBlock,
  Block,
  BlockState,
  QuestionBlock,
  ReasoningBlock,
  SequencedSessionEvent,
  SessionSnapshot,
  TurnState,
} from "./trace-types.js";
import { normalizeTraceTimestamp } from "./trace-formatters.js";

function compareTraceTimestamps(
  left: number | string | Date | undefined | null,
  right: number | string | Date | undefined | null,
): number {
  const leftTime = normalizeTraceTimestamp(left);
  const rightTime = normalizeTraceTimestamp(right);

  if (leftTime == null && rightTime == null) return 0;
  if (leftTime == null) return 1;
  if (rightTime == null) return -1;
  return leftTime - rightTime;
}

export function selectSessionTurns(snapshot: SessionSnapshot): TurnState[] {
  return [...snapshot.turns].sort((left, right) => {
    const timeDelta = compareTraceTimestamps(left.startedAt, right.startedAt);
    return timeDelta !== 0 ? timeDelta : left.id.localeCompare(right.id);
  });
}

export function selectCurrentTurn(snapshot: SessionSnapshot): TurnState | null {
  if (!snapshot.currentTurnId) {
    return null;
  }

  return snapshot.turns.find((turn) => turn.id === snapshot.currentTurnId) ?? null;
}

export function selectLatestTurn(snapshot: SessionSnapshot): TurnState | null {
  const turns = selectSessionTurns(snapshot);
  return turns.at(-1) ?? null;
}

export function selectTurnBlocks(turn: TurnState): BlockState[] {
  return [...turn.blocks].sort(
    (left, right) =>
      left.block.index - right.block.index || left.block.id.localeCompare(right.block.id),
  );
}

export function selectBlocksByType<TBlock extends Block["type"]>(
  turn: TurnState,
  type: TBlock,
): BlockState[] {
  return selectTurnBlocks(turn).filter((blockState) => blockState.block.type === type);
}

export function selectActionBlocks(turn: TurnState): ActionBlock[] {
  return selectBlocksByType(turn, "action").map((blockState) => blockState.block as ActionBlock);
}

export function selectReasoningBlocks(turn: TurnState): ReasoningBlock[] {
  return selectBlocksByType(turn, "reasoning").map((blockState) => blockState.block as ReasoningBlock);
}

export function selectQuestionBlocks(turn: TurnState): QuestionBlock[] {
  return selectBlocksByType(turn, "question").map((blockState) => blockState.block as QuestionBlock);
}

export function selectPendingApprovals(snapshot: SessionSnapshot): ActionBlock[] {
  const approvals: ActionBlock[] = [];

  for (const turn of selectSessionTurns(snapshot)) {
    for (const block of selectActionBlocks(turn)) {
      if (block.action.status === "awaiting_approval" && block.action.approval) {
        approvals.push(block);
      }
    }
  }

  return approvals;
}

export function selectPendingQuestions(snapshot: SessionSnapshot): QuestionBlock[] {
  const pending: QuestionBlock[] = [];

  for (const turn of selectSessionTurns(snapshot)) {
    for (const block of selectQuestionBlocks(turn)) {
      if (block.questionStatus === "awaiting_answer") {
        pending.push(block);
      }
    }
  }

  return pending;
}

export function selectSequencedSessionEvents(events: readonly SequencedSessionEvent[]): SequencedSessionEvent[] {
  return [...events].sort((left, right) => left.sequence - right.sequence || compareTraceTimestamps(left.capturedAt, right.capturedAt));
}

export function selectLatestSequencedSessionEvent(
  events: readonly SequencedSessionEvent[],
): SequencedSessionEvent | null {
  const ordered = selectSequencedSessionEvents(events);
  return ordered.at(-1) ?? null;
}
