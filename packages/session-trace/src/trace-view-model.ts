import type { Block, SessionSnapshot, TurnState } from "./trace-types.js";
import {
  formatTraceActionStatus,
  formatTraceApprovalRisk,
  formatTraceBlockLabel,
  formatTraceBlockStatus,
  formatTraceBlockSummary,
  formatTraceDuration,
  formatTraceQuestionStatus,
  formatTraceTimestamp,
  formatTraceTurnStatus,
  shouldCollapseReasoningBlock,
} from "./trace-formatters.js";
import {
  selectCurrentTurn,
  selectSessionTurns,
  selectTurnBlocks,
} from "./trace-selectors.js";

export interface TraceViewModelOptions {
  collapseCompletedReasoning?: boolean;
  locale?: string | readonly string[];
}

export interface TraceBlockViewModel {
  sessionId: string;
  id: string;
  turnId: string;
  type: Block["type"];
  status: Block["status"];
  index: number;
  label: string;
  summary: string;
  collapsed: boolean;
  block: Block;
}

export interface TraceTurnViewModel {
  sessionId: string;
  id: string;
  status: TurnState["status"];
  statusLabel: string;
  isCurrent: boolean;
  startedAt: TurnState["startedAt"];
  startedAtLabel: string;
  endedAt: TurnState["endedAt"];
  endedAtLabel: string | null;
  durationLabel: string;
  blocks: TraceBlockViewModel[];
}

export interface TraceTimelineViewModel {
  session: SessionSnapshot["session"];
  currentTurnId: SessionSnapshot["currentTurnId"] | null;
  turns: TraceTurnViewModel[];
}

export interface TraceSessionSummaryViewModel {
  sessionId: string;
  name: string;
  adapterType: string;
  status: SessionSnapshot["session"]["status"];
  turnCount: number;
  currentTurnStatus: TurnState["status"] | null;
  startedAtLabel: string;
  lastActivityAtLabel: string;
}

export function createTraceBlockViewModel(
  sessionId: string,
  block: Block,
  options: TraceViewModelOptions = {},
): TraceBlockViewModel {
  const collapseCompletedReasoning = options.collapseCompletedReasoning ?? true;
  return {
    sessionId,
    id: block.id,
    turnId: block.turnId,
    type: block.type,
    status: block.status,
    index: block.index,
    label: formatTraceBlockLabel(block),
    summary: formatTraceBlockSummary(block),
    collapsed: collapseCompletedReasoning && shouldCollapseReasoningBlock(block),
    block,
  };
}

export function createTraceTurnViewModel(
  turn: TurnState,
  sessionId: string,
  currentTurnId: string | null | undefined,
  options: TraceViewModelOptions = {},
): TraceTurnViewModel {
  const blocks = selectTurnBlocks(turn).map((blockState) =>
    createTraceBlockViewModel(sessionId, blockState.block, options),
  );
  const endedAtLabel = turn.endedAt ? formatTraceTimestamp(turn.endedAt, options.locale) : null;
  return {
    sessionId,
    id: turn.id,
    status: turn.status,
    statusLabel: formatTraceTurnStatus(turn.status),
    isCurrent: turn.id === currentTurnId,
    startedAt: turn.startedAt,
    startedAtLabel: formatTraceTimestamp(turn.startedAt, options.locale),
    endedAt: turn.endedAt,
    endedAtLabel,
    durationLabel: formatTraceDuration(turn.startedAt, turn.endedAt ?? null),
    blocks,
  };
}

export function createTraceTimelineViewModel(
  snapshot: SessionSnapshot,
  options: TraceViewModelOptions = {},
): TraceTimelineViewModel {
  const currentTurn = selectCurrentTurn(snapshot);
  const turns = selectSessionTurns(snapshot).map((turn) => createTraceTurnViewModel(turn, snapshot.session.id, currentTurn?.id ?? snapshot.currentTurnId, options));

  return {
    session: snapshot.session,
    currentTurnId: snapshot.currentTurnId ?? currentTurn?.id ?? null,
    turns,
  };
}

export function selectTraceSessionSummary(
  snapshot: SessionSnapshot,
  options: TraceViewModelOptions = {},
): TraceSessionSummaryViewModel {
  const turns = selectSessionTurns(snapshot);
  const currentTurn = selectCurrentTurn(snapshot);
  const firstTurn = turns[0] ?? null;
  const lastTurn = turns.at(-1) ?? null;
  return {
    sessionId: snapshot.session.id,
    name: snapshot.session.name,
    adapterType: snapshot.session.adapterType,
    status: snapshot.session.status,
    turnCount: turns.length,
    currentTurnStatus: currentTurn?.status ?? null,
    startedAtLabel: formatTraceTimestamp(firstTurn?.startedAt ?? null, options.locale),
    lastActivityAtLabel: formatTraceTimestamp(lastTurn?.endedAt ?? lastTurn?.startedAt ?? null, options.locale),
  };
}

export function describeTraceActionStatus(status: TraceBlockViewModel["status"]): string {
  return formatTraceBlockStatus(status);
}

export function describeTraceQuestionSummary(status: string): string {
  return formatTraceQuestionStatus(status as Parameters<typeof formatTraceQuestionStatus>[0]);
}

export function describeTraceActionSummary(actionStatus: Parameters<typeof formatTraceActionStatus>[0]): string {
  return formatTraceActionStatus(actionStatus);
}

export function describeTraceApprovalSummary(risk: Parameters<typeof formatTraceApprovalRisk>[0]): string {
  return formatTraceApprovalRisk(risk);
}
