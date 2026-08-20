// Echo adapter — a simple adapter for integration testing.
//
// When it receives a prompt, it emits a complete turn lifecycle:
//   1. turn:start
//   2. reasoning block ("Thinking about: <prompt text>")
//   3. text block ("Echo: <prompt text>")
//   4. action block (tool_call kind, toolName: "echo")
//   5. turn:end (completed)
//
// Each block follows the full block:start -> block:delta -> block:end lifecycle.
// Supports interrupt() — stops mid-stream and emits turn:end with "stopped".

import { BaseAdapter, type AdapterConfig } from "../../protocol/adapter.js";
import type { Prompt, Turn, Block } from "../../protocol/primitives.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Delay between emitted events (ms). Set to 0 for instant responses in tests. */
const DEFAULT_STEP_DELAY_MS = 5;

// ---------------------------------------------------------------------------
// EchoAdapter
// ---------------------------------------------------------------------------

export class EchoAdapter extends BaseAdapter {
  readonly type = "echo";

  private interrupted = false;
  private stepping = false;
  private stepDelay: number;
  private requireApproval: boolean;

  /** Pending approval resolvers, keyed by blockId. */
  private pendingApprovals = new Map<string, {
    resolve: (decision: "approve" | "deny") => void;
    reason?: string;
  }>();

  constructor(config: AdapterConfig) {
    super(config);
    this.stepDelay =
      typeof config.options?.stepDelay === "number" ? config.options.stepDelay : DEFAULT_STEP_DELAY_MS;
    this.requireApproval = config.options?.requireApproval === true;
  }

  async start(): Promise<void> {
    this.setStatus("active");
  }

  send(prompt: Prompt): void {
    this.interrupted = false;
    this.stepping = true;
    this.runTurn(prompt.text).finally(() => {
      this.stepping = false;
    });
  }

  interrupt(): void {
    this.interrupted = true;
    // Reject any pending approvals.
    for (const [, pending] of this.pendingApprovals) {
      pending.resolve("deny");
    }
    this.pendingApprovals.clear();
  }

  async shutdown(): Promise<void> {
    this.interrupted = true;
    // Reject any pending approvals.
    for (const [, pending] of this.pendingApprovals) {
      pending.resolve("deny");
    }
    this.pendingApprovals.clear();
    this.setStatus("closed");
  }

  decide(turnId: string, blockId: string, decision: "approve" | "deny", reason?: string): void {
    const pending = this.pendingApprovals.get(this.approvalKey(turnId, blockId));
    if (!pending) return;
    pending.reason = reason;
    pending.resolve(decision);
    this.pendingApprovals.delete(this.approvalKey(turnId, blockId));
  }

  // ---------------------------------------------------------------------------
  // Turn execution
  // ---------------------------------------------------------------------------

  private async runTurn(text: string): Promise<void> {
    const turnId = crypto.randomUUID();
    const sessionId = this.config.sessionId;
    let blockIndex = 0;

    // -- turn:start -----------------------------------------------------------

    const turn: Turn = {
      id: turnId,
      sessionId,
      status: "started",
      startedAt: new Date().toISOString(),
      blocks: [],
    };

    this.emit("event", { event: "turn:start", sessionId, turn });

    if (this.interrupted) {
      this.emitTurnEnd(sessionId, turnId, "stopped");
      return;
    }

    await this.delay();

    // -- reasoning block ------------------------------------------------------

    const reasoningId = crypto.randomUUID();
    const reasoningText = `Thinking about: ${text}`;

    if (this.interrupted) { this.emitTurnEnd(sessionId, turnId, "stopped"); return; }

    this.emitBlockStart(sessionId, turnId, {
      id: reasoningId,
      turnId,
      type: "reasoning",
      text: "",
      status: "streaming",
      index: blockIndex++,
    });

    await this.delay();
    if (this.interrupted) { this.emitTurnEnd(sessionId, turnId, "stopped"); return; }

    this.emit("event", {
      event: "block:delta",
      sessionId,
      turnId,
      blockId: reasoningId,
      text: reasoningText,
    });

    await this.delay();
    if (this.interrupted) { this.emitTurnEnd(sessionId, turnId, "stopped"); return; }

    this.emitBlockEnd(sessionId, turnId, reasoningId, "completed");

    await this.delay();

    // -- text block -----------------------------------------------------------

    const textId = crypto.randomUUID();
    const echoText = `Echo: ${text}`;

    if (this.interrupted) { this.emitTurnEnd(sessionId, turnId, "stopped"); return; }

    this.emitBlockStart(sessionId, turnId, {
      id: textId,
      turnId,
      type: "text",
      text: "",
      status: "streaming",
      index: blockIndex++,
    });

    await this.delay();
    if (this.interrupted) { this.emitTurnEnd(sessionId, turnId, "stopped"); return; }

    this.emit("event", {
      event: "block:delta",
      sessionId,
      turnId,
      blockId: textId,
      text: echoText,
    });

    await this.delay();
    if (this.interrupted) { this.emitTurnEnd(sessionId, turnId, "stopped"); return; }

    this.emitBlockEnd(sessionId, turnId, textId, "completed");

    await this.delay();

    // -- action block (tool_call) ---------------------------------------------

    const actionId = crypto.randomUUID();
    const toolCallId = crypto.randomUUID();

    if (this.interrupted) { this.emitTurnEnd(sessionId, turnId, "stopped"); return; }

    const initialActionStatus = this.requireApproval ? "awaiting_approval" as const : "running" as const;

    this.emitBlockStart(sessionId, turnId, {
      id: actionId,
      turnId,
      type: "action",
      status: "streaming",
      index: blockIndex++,
      action: {
        kind: "tool_call",
        toolName: "echo",
        toolCallId,
        status: initialActionStatus,
        output: "",
        ...(this.requireApproval ? {
          approval: { version: 1, description: `Run echo tool with: ${text}`, risk: "low" as const },
        } : {}),
      },
    });

    // If approval is required, emit the approval delta and wait for decision.
    if (this.requireApproval) {
      this.emit("event", {
        event: "block:action:approval",
        sessionId,
        turnId,
        blockId: actionId,
        approval: { version: 1, description: `Run echo tool with: ${text}`, risk: "low" },
      });

      const decision = await new Promise<"approve" | "deny">((resolve) => {
        this.pendingApprovals.set(this.approvalKey(turnId, actionId), { resolve });
      });

      if (this.interrupted) { this.emitTurnEnd(sessionId, turnId, "stopped"); return; }

      if (decision === "deny") {
        this.emit("event", {
          event: "block:action:status",
          sessionId,
          turnId,
          blockId: actionId,
          status: "failed",
        });
        this.emitBlockEnd(sessionId, turnId, actionId, "failed");
        await this.delay();
        this.emitTurnEnd(sessionId, turnId, "completed");
        return;
      }

      // Approved — transition to running.
      this.emit("event", {
        event: "block:action:status",
        sessionId,
        turnId,
        blockId: actionId,
        status: "running",
      });
    }

    await this.delay();
    if (this.interrupted) { this.emitTurnEnd(sessionId, turnId, "stopped"); return; }

    this.emit("event", {
      event: "block:action:output",
      sessionId,
      turnId,
      blockId: actionId,
      output: text,
    });

    await this.delay();
    if (this.interrupted) { this.emitTurnEnd(sessionId, turnId, "stopped"); return; }

    this.emit("event", {
      event: "block:action:status",
      sessionId,
      turnId,
      blockId: actionId,
      status: "completed",
    });

    await this.delay();
    if (this.interrupted) { this.emitTurnEnd(sessionId, turnId, "stopped"); return; }

    this.emitBlockEnd(sessionId, turnId, actionId, "completed");

    await this.delay();

    // -- turn:end -------------------------------------------------------------

    this.emitTurnEnd(sessionId, turnId, "completed");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private emitBlockStart(sessionId: string, turnId: string, block: Block): void {
    this.emit("event", { event: "block:start", sessionId, turnId, block });
  }

  private approvalKey(turnId: string, blockId: string): string {
    return `${turnId}:${blockId}`;
  }

  private emitBlockEnd(
    sessionId: string,
    turnId: string,
    blockId: string,
    status: "completed" | "failed",
  ): void {
    this.emit("event", { event: "block:end", sessionId, turnId, blockId, status });
  }

  private emitTurnEnd(
    sessionId: string,
    turnId: string,
    status: "completed" | "stopped" | "failed",
  ): void {
    this.emit("event", { event: "turn:end", sessionId, turnId, status });
  }

  private delay(): Promise<void> {
    if (this.stepDelay <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.stepDelay));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createAdapter = (config: AdapterConfig): EchoAdapter => new EchoAdapter(config);
