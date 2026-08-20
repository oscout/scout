// State tracker — accumulates session state from streaming session events.
//
// The embedding runtime feeds every AgentSessionStreamEvent into the tracker.  At any
// point, a client can request a full snapshot (all turns + accumulated block
// content) to recover state after reconnect.  This is the "pull" complement
// to the "push" event stream.
//
// In-memory only — no persistence, no external dependencies.

import type {
  ActionBlock,
  Block,
  AgentSessionStreamEvent,
  QuestionBlock,
  Session,
  TextBlock,
  ReasoningBlock,
} from "./protocol/index.js";
import {
  MAX_RETAINED_ACTION_OUTPUT_UTF8_BYTES,
  snapshotNormalizedValue,
  truncateUtf8,
} from "./protocol/normalizer.js";

// ---------------------------------------------------------------------------
// State shapes
// ---------------------------------------------------------------------------

export interface SessionState {
  session: Session;
  turns: TurnState[];
  currentTurnId?: string;
}

export interface TurnState {
  id: string;
  status: "streaming" | "completed" | "interrupted" | "error";
  blocks: BlockState[];
  startedAt: number;
  endedAt?: number;
}

export interface BlockState {
  block: Block;
  status: "streaming" | "completed";
}

export interface SessionSummary {
  sessionId: string;
  name: string;
  adapterType: string;
  status: string;
  turnCount: number;
  currentTurnStatus?: string;
  startedAt: number;
  lastActivityAt: number;
}

function normalizeTrackedTimestamp(value: number | string | Date | undefined | null): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value < 1e12 ? value * 1000 : value;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

// ---------------------------------------------------------------------------
// StateTracker
// ---------------------------------------------------------------------------

export class StateTracker {
  private states = new Map<string, SessionState>();

  /** Initialize state for a newly created session. */
  createSession(sessionId: string, session: Session): void {
    this.states.set(sessionId, {
      session: snapshotNormalizedValue(session),
      turns: [],
    });
  }

  /** Remove all state for a session. */
  removeSession(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** Return the full accumulated state for a session. */
  getSessionState(sessionId: string): SessionState | null {
    return this.states.get(sessionId) ?? null;
  }

  /** Return lightweight summaries for every tracked session. */
  getAllSessionSummaries(): SessionSummary[] {
    const summaries: SessionSummary[] = [];

    for (const state of this.states.values()) {
      const currentTurn = state.currentTurnId
        ? state.turns.find((t) => t.id === state.currentTurnId)
        : undefined;

      const lastTurn = state.turns[state.turns.length - 1];
      const startedAt = state.turns[0]?.startedAt ?? Date.now();
      const lastActivityAt = lastTurn?.endedAt ?? lastTurn?.startedAt ?? startedAt;

      summaries.push({
        sessionId: state.session.id,
        name: state.session.name,
        adapterType: state.session.adapterType,
        status: state.session.status,
        turnCount: state.turns.length,
        currentTurnStatus: currentTurn?.status,
        startedAt,
        lastActivityAt,
      });
    }

    return summaries;
  }

  /** Process one session event and update internal state. */
  trackEvent(
    sessionId: string,
    event: AgentSessionStreamEvent,
    capturedAt?: number | string | Date,
  ): void {
    const state = this.states.get(sessionId);
    if (!state) return;

    switch (event.event) {
      // -- Session lifecycle --------------------------------------------------
      case "session:update":
        state.session = snapshotNormalizedValue(event.session);
        break;

      case "session:closed":
        state.session = { ...state.session, status: "closed" };
        break;

      // -- Turn lifecycle -----------------------------------------------------
      case "turn:start":
        this.handleTurnStart(state, event, capturedAt);
        break;

      case "turn:end":
        this.handleTurnEnd(state, event, capturedAt);
        break;

      case "turn:error":
        this.handleTurnError(state, event, capturedAt);
        break;

      // -- Block lifecycle ----------------------------------------------------
      case "block:start":
        this.handleBlockStart(state, event);
        break;

      case "block:delta":
        this.handleBlockTextDelta(state, event);
        break;

      case "block:action:output":
        this.handleBlockActionOutput(state, event);
        break;

      case "block:action:status":
        this.handleBlockActionStatus(state, event);
        break;

      case "block:action:approval":
        this.handleBlockActionApproval(state, event);
        break;

      case "block:question:answer":
        this.handleBlockQuestionAnswer(state, event);
        break;

      case "block:end":
        this.handleBlockEnd(state, event);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Turn handlers
  // ---------------------------------------------------------------------------

  private handleTurnStart(
    state: SessionState,
    event: Extract<AgentSessionStreamEvent, { event: "turn:start" }>,
    capturedAt?: number | string | Date,
  ): void {
    const turn: TurnState = {
      id: event.turn.id,
      status: "streaming",
      blocks: [],
      startedAt: normalizeTrackedTimestamp(event.turn.startedAt)
        ?? normalizeTrackedTimestamp(capturedAt)
        ?? Date.now(),
    };
    state.turns.push(turn);
    state.currentTurnId = turn.id;
  }

  private handleTurnEnd(
    state: SessionState,
    event: Extract<AgentSessionStreamEvent, { event: "turn:end" }>,
    capturedAt?: number | string | Date,
  ): void {
    const turn = this.findTurn(state, event.turnId);
    if (!turn) return;

    // Map protocol TurnStatus to our simplified TurnState status.
    switch (event.status) {
      case "completed":
        turn.status = "completed";
        break;
      case "stopped":
        turn.status = "interrupted";
        break;
      case "failed":
        turn.status = "error";
        break;
      default:
        // "started" and "streaming" don't represent terminal states,
        // but handle gracefully.
        turn.status = "completed";
        break;
    }

    turn.endedAt = normalizeTrackedTimestamp(capturedAt) ?? Date.now();

    if (state.currentTurnId === event.turnId) {
      state.currentTurnId = undefined;
    }
  }

  private handleTurnError(
    state: SessionState,
    event: Extract<AgentSessionStreamEvent, { event: "turn:error" }>,
    capturedAt?: number | string | Date,
  ): void {
    const turn = this.findTurn(state, event.turnId);
    if (!turn) return;

    turn.status = "error";
    turn.endedAt = normalizeTrackedTimestamp(capturedAt) ?? Date.now();

    if (state.currentTurnId === event.turnId) {
      state.currentTurnId = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Block handlers
  // ---------------------------------------------------------------------------

  private handleBlockStart(
    state: SessionState,
    event: Extract<AgentSessionStreamEvent, { event: "block:start" }>,
  ): void {
    const turn = this.findTurn(state, event.turnId);
    if (!turn) return;

    const blockState: BlockState = {
      block: snapshotNormalizedValue(event.block),
      status: event.block.status === "completed" ? "completed" : "streaming",
    };

    turn.blocks.push(blockState);
  }

  private handleBlockTextDelta(
    state: SessionState,
    event: Extract<AgentSessionStreamEvent, { event: "block:delta" }>,
  ): void {
    const blockState = this.findBlock(state, event.turnId, event.blockId);
    if (!blockState) return;

    const block = blockState.block;

    // Append text delta to text or reasoning blocks.
    if (block.type === "text") {
      (block as TextBlock).text += event.text;
    } else if (block.type === "reasoning") {
      (block as ReasoningBlock).text += event.text;
    }
  }

  private handleBlockActionOutput(
    state: SessionState,
    event: Extract<AgentSessionStreamEvent, { event: "block:action:output" }>,
  ): void {
    const blockState = this.findBlock(state, event.turnId, event.blockId);
    if (!blockState) return;

    const block = blockState.block;
    if (block.type === "action") {
      const actionBlock = block as ActionBlock;
      const combined = actionBlock.action.output + event.output;
      const truncated = truncateUtf8(combined, MAX_RETAINED_ACTION_OUTPUT_UTF8_BYTES);
      actionBlock.action.output = truncated.text;
      if (event.truncation || truncated.omittedBytes > 0) {
        actionBlock.action.truncation = {
          omittedBytes: (actionBlock.action.truncation?.omittedBytes ?? 0)
            + (event.truncation?.omittedBytes ?? 0)
            + truncated.omittedBytes,
          maxRetainedBytes: MAX_RETAINED_ACTION_OUTPUT_UTF8_BYTES,
          sourceRef: event.truncation?.sourceRef
            ?? actionBlock.action.truncation?.sourceRef
            ?? `block:${event.blockId}`,
        };
      }
    }
  }

  private handleBlockActionStatus(
    state: SessionState,
    event: Extract<AgentSessionStreamEvent, { event: "block:action:status" }>,
  ): void {
    const blockState = this.findBlock(state, event.turnId, event.blockId);
    if (!blockState) return;

    const block = blockState.block;
    if (block.type === "action") {
      (block as ActionBlock).action.status = event.status;
    }
  }

  private handleBlockActionApproval(
    state: SessionState,
    event: Extract<AgentSessionStreamEvent, { event: "block:action:approval" }>,
  ): void {
    const blockState = this.findBlock(state, event.turnId, event.blockId);
    if (!blockState) return;

    const block = blockState.block;
    if (block.type === "action") {
      (block as ActionBlock).action.status = "awaiting_approval";
      (block as ActionBlock).action.approval = { ...event.approval };
    }
  }

  private handleBlockQuestionAnswer(
    state: SessionState,
    event: Extract<AgentSessionStreamEvent, { event: "block:question:answer" }>,
  ): void {
    const blockState = this.findBlock(state, event.turnId, event.blockId);
    if (!blockState) return;

    const block = blockState.block;
    if (block.type === "question") {
      const questionBlock = block as QuestionBlock;
      questionBlock.questionStatus = event.questionStatus;
      questionBlock.answer = event.answer ? [...event.answer] : undefined;
    }
  }

  private handleBlockEnd(
    state: SessionState,
    event: Extract<AgentSessionStreamEvent, { event: "block:end" }>,
  ): void {
    const blockState = this.findBlock(state, event.turnId, event.blockId);
    if (!blockState) return;

    blockState.status = "completed";
    blockState.block.status = event.status;
  }

  // ---------------------------------------------------------------------------
  // Lookup helpers
  // ---------------------------------------------------------------------------

  private findTurn(state: SessionState, turnId: string): TurnState | undefined {
    return state.turns.find((t) => t.id === turnId);
  }

  private findBlock(
    state: SessionState,
    turnId: string,
    blockId: string,
  ): BlockState | undefined {
    const turn = this.findTurn(state, turnId);
    if (!turn) return undefined;
    return turn.blocks.find((b) => b.block.id === blockId);
  }
}
