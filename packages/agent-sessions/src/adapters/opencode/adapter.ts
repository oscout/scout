// OpenCode adapter — persistent headless server.
//
// Spawns `opencode serve` once on start(), connects via HTTP + SSE for the
// lifetime of the session. Sends prompts via POST, receives streaming events
// via the SSE event bus.
//
// API surface:
//   POST /session                → create session
//   POST /session/:id/message    → send message (parts array)
//   GET  /session                → list sessions
//   GET  /session/:id/message    → get messages
//   GET  /event?sessionID=:id    → SSE event stream
//
// Events (SSE):
//   message.updated       → new/updated message (user or assistant)
//   message.part.updated  → streaming part (text, tool_use, thinking)
//   session.status        → busy/idle
//   session.updated       → session metadata changes
//   session.diff          → file diffs
//
// Faithful harness: opencode serve loads the project's .opencode config,
// plugins, MCP servers, and LSP from cwd automatically.

import { BaseAdapter } from "../../protocol/adapter.js";
import type { AdapterConfig } from "../../protocol/adapter.js";
import type {
  Action,
  Block,
  BlockStatus,
  Prompt,
  Turn,
  TurnStatus,
} from "../../protocol/primitives.js";
import {
  spawnHarnessProcess,
  type HarnessProcess,
} from "../../runtime/process.js";

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenCodeAdapter extends BaseAdapter {
  readonly type = "opencode";

  private serverProcess: HarnessProcess | null = null;
  private serverPort: number = 0;
  private serverUrl: string = "";
  private currentTurn: Turn | null = null;
  private blockIndex = 0;
  private openCodeSessionId: string | null = null;
  private eventSource: AbortController | null = null;

  // Track blocks by part ID.
  private blockByPartId = new Map<string, Block>();
  private lastSeenRole: string | null = null;

  constructor(config: AdapterConfig) {
    super(config);
  }

  async start(): Promise<void> {
    // Pick a random port for the server.
    this.serverPort = 10000 + Math.floor(Math.random() * 50000);
    this.serverUrl = `http://127.0.0.1:${this.serverPort}`;

    const args = ["serve", "--port", String(this.serverPort)];

    const child = await spawnHarnessProcess("opencode", args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
    });
    this.serverProcess = child;
    child.drainStdout();
    child.drainStderr();

    let startupComplete = false;
    let startupErrorReported = false;
    const startupAbort = new AbortController();
    const reportStartupError = (error: Error) => {
      if (this.serverProcess !== child || this.session.status === "closed") {
        return;
      }
      startupErrorReported = true;
      this.emit("error", error);
      this.setStatus("error");
    };

    const startupFailure = new Promise<never>((_, reject) => {
      const failStartup = (error: Error) => {
        if (!startupComplete) {
          startupAbort.abort(error);
          reject(error);
        }
      };

      child.onError((error) => {
        reportStartupError(error);
        failStartup(error);
      });

      child.onExit((code, signal) => {
        if (this.serverProcess !== child || this.session.status === "closed") {
          return;
        }
        if (code !== 0) {
          const error = new Error(
            `opencode serve exited`
            + (code !== null ? ` with code ${code}` : "")
            + (signal ? ` (${signal})` : ""),
          );
          reportStartupError(error);
          failStartup(error);
          return;
        }
        if (!startupComplete) {
          const error = new Error("opencode serve exited before startup completed");
          reportStartupError(error);
          failStartup(error);
        }
      });
    });

    try {
      // Wait for the server to be ready.
      await Promise.race([this.waitForServer(15_000, startupAbort.signal), startupFailure]);

      // Create or resume a session.
      await Promise.race([this.ensureSession(startupAbort.signal), startupFailure]);

      // Connect to the SSE event stream.
      this.connectEventStream();
      startupComplete = true;
      this.setStatus("active");
    } catch (error) {
      startupComplete = true;
      const startupError = error instanceof Error ? error : new Error(String(error));
      if (!startupErrorReported) {
        reportStartupError(startupError);
      }
      if (this.serverProcess === child) {
        this.serverProcess = null;
      }
      if (!child.killed) {
        child.kill();
      }
      await child.waitForExit(250);
      throw startupError;
    }

  }

  send(prompt: Prompt): void {
    if (!this.openCodeSessionId) {
      this.emit("error", new Error("No OpenCode session"));
      return;
    }

    this.blockIndex = 0;
    this.blockByPartId.clear();

    const turn: Turn = {
      id: crypto.randomUUID(),
      sessionId: this.session.id,
      status: "started",
      startedAt: new Date().toISOString(),
      blocks: [],
    };
    this.currentTurn = turn;
    this.emit("event", { event: "turn:start", sessionId: this.session.id, turn });

    // Build parts array.
    const parts: Array<Record<string, unknown>> = [
      { type: "text", text: prompt.text },
    ];

    if (prompt.images?.length) {
      for (const img of prompt.images) {
        parts.push({
          type: "image",
          mimeType: img.mimeType,
          data: img.data,
        });
      }
    }

    // Fire and forget — events come through SSE.
    fetch(`${this.serverUrl}/session/${this.openCodeSessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts }),
    }).catch((err) => {
      this.emitError(turn, err.message ?? "Failed to send message");
      this.endTurn(turn, "failed");
    });
  }

  interrupt(): void {
    // Kill the current generation by sending abort.
    if (this.openCodeSessionId) {
      fetch(`${this.serverUrl}/session/${this.openCodeSessionId}/abort`, {
        method: "POST",
      }).catch(() => {});
    }
    if (this.currentTurn) {
      this.endTurn(this.currentTurn, "stopped");
    }
  }

  async shutdown(): Promise<void> {
    this.eventSource?.abort();
    this.eventSource = null;
    if (this.serverProcess && !this.serverProcess.killed) {
      this.serverProcess.kill();
    }
    this.serverProcess = null;
    this.setStatus("closed");
  }

  // ---------------------------------------------------------------------------
  // Server lifecycle
  // ---------------------------------------------------------------------------

  private async waitForServer(timeoutMs = 15000, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      try {
        const res = await fetch(`${this.serverUrl}/session`, { signal });
        if (res.ok) return;
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal);
      }
      await delay(200, signal);
    }
    throw new Error("OpenCode server did not start in time");
  }

  private async ensureSession(signal?: AbortSignal): Promise<void> {
    // Check for existing sessions to resume.
    const resume = this.config.options?.["resume"] as boolean | undefined;
    const sessionId = this.config.options?.["session"] as string | undefined;

    if (sessionId) {
      this.openCodeSessionId = sessionId;
      return;
    }

    if (resume) {
      const res = await fetch(`${this.serverUrl}/session`, { signal });
      const sessions = (await res.json()) as any[];
      if (sessions.length > 0) {
        this.openCodeSessionId = sessions[0].id;
        return;
      }
    }

    // Create a new session.
    const res = await fetch(`${this.serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal,
    });
    const session = (await res.json()) as any;
    this.openCodeSessionId = session.id;
  }

  // ---------------------------------------------------------------------------
  // SSE event stream
  // ---------------------------------------------------------------------------

  private connectEventStream(): void {
    if (!this.openCodeSessionId) return;

    this.eventSource = new AbortController();
    const url = `${this.serverUrl}/event?sessionID=${this.openCodeSessionId}`;

    this.readSSE(url, this.eventSource.signal);
  }

  private async readSSE(url: string, signal: AbortSignal): Promise<void> {
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal,
      });

      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (!data) continue;
            try {
              this.handleSSEEvent(JSON.parse(data));
            } catch { /* skip malformed */ }
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        // Reconnect on error.
        setTimeout(() => {
          if (!signal.aborted) this.readSSE(url, signal);
        }, 2000);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SSE event handling
  // ---------------------------------------------------------------------------

  private handleSSEEvent(event: any): void {
    const type: string = event.type ?? "";
    const props = event.properties ?? {};

    switch (type) {
      case "session.status": {
        const status = props.status?.type;
        if (status === "idle" && this.currentTurn) {
          // Turn completed — session went from busy to idle.
          this.closeOpenBlocks();
          this.endTurn(this.currentTurn, "completed");
        }
        break;
      }

      case "message.part.updated": {
        this.handlePartUpdated(props);
        break;
      }

      case "message.updated": {
        const info = props.info;
        if (info?.role === "assistant" && info?.modelID) {
          (this.session as any).model = info.modelID;
        }
        break;
      }

      // session.updated, session.diff — no Pairing mapping needed.
    }
  }

  private handlePartUpdated(props: any): void {
    if (!this.currentTurn) return;

    const part = props.part;
    if (!part) return;

    const partId: string = part.id ?? "";
    const partType: string = part.type ?? "";

    switch (partType) {
      case "text": {
        let block = this.blockByPartId.get(partId);
        if (!block) {
          block = this.startBlock(this.currentTurn, {
            type: "text",
            text: part.text ?? "",
            status: "streaming",
          });
          this.blockByPartId.set(partId, block);
        } else {
          // Updated text — emit delta.
          this.emit("event", {
            event: "block:delta",
            sessionId: this.session.id,
            turnId: this.currentTurn.id,
            blockId: block.id,
            text: part.text ?? "",
          });
        }
        break;
      }

      case "thinking": {
        let block = this.blockByPartId.get(partId);
        if (!block) {
          block = this.startBlock(this.currentTurn, {
            type: "reasoning",
            text: part.text ?? "",
            status: "streaming",
          });
          this.blockByPartId.set(partId, block);
        } else {
          this.emit("event", {
            event: "block:delta",
            sessionId: this.session.id,
            turnId: this.currentTurn.id,
            blockId: block.id,
            text: part.text ?? "",
          });
        }
        break;
      }

      case "step-start": {
        // New reasoning/execution step — informational.
        break;
      }

      case "step-finish": {
        // Step completed. Close streaming blocks from this step.
        break;
      }

      case "tool": {
        let block = this.blockByPartId.get(partId);
        const state = part.state ?? {};
        const toolName: string = part.tool ?? "unknown";
        const callId: string = part.callID ?? partId;

        if (!block) {
          // New tool use.
          let action: Action;
          const input = state.input ?? {};
          const output: string = state.output ?? "";

          if (toolName === "edit" || toolName === "write" || toolName === "multi_edit") {
            action = {
              kind: "file_change",
              path: input.filePath ?? input.file_path ?? "",
              diff: output,
              status: state.status === "completed" ? "completed" : "running",
              output,
            };
          } else if (toolName === "bash") {
            action = {
              kind: "command",
              command: input.command ?? "",
              exitCode: state.metadata?.exitCode,
              status: state.status === "completed" ? "completed" : "running",
              output,
            };
          } else {
            action = {
              kind: "tool_call",
              toolName,
              toolCallId: callId,
              input,
              status: state.status === "completed" ? "completed" : "running",
              output,
            };
          }

          block = this.startBlock(this.currentTurn, {
            type: "action",
            action,
            status: state.status === "completed" ? "completed" : "streaming",
          });
          this.blockByPartId.set(partId, block);

          if (state.status === "completed") {
            if (output) {
              this.emit("event", {
                event: "block:action:output",
                sessionId: this.session.id,
                turnId: this.currentTurn.id,
                blockId: block.id,
                output,
              });
            }
            this.emit("event", {
              event: "block:action:status",
              sessionId: this.session.id,
              turnId: this.currentTurn.id,
              blockId: block.id,
              status: state.status === "error" ? "failed" : "completed",
            });
            this.emitBlockEnd(this.currentTurn, block, state.status === "error" ? "failed" : "completed");
          }
        } else {
          // Updated tool — emit output delta and status change.
          const output: string = state.output ?? "";
          if (output) {
            this.emit("event", {
              event: "block:action:output",
              sessionId: this.session.id,
              turnId: this.currentTurn.id,
              blockId: block.id,
              output,
            });
          }

          if (state.status === "completed" || state.status === "error") {
            this.emit("event", {
              event: "block:action:status",
              sessionId: this.session.id,
              turnId: this.currentTurn.id,
              blockId: block.id,
              status: state.status === "error" ? "failed" : "completed",
            });
            this.emitBlockEnd(this.currentTurn, block, state.status === "error" ? "failed" : "completed");
          }
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private closeOpenBlocks(): void {
    if (!this.currentTurn) return;
    for (const [, block] of this.blockByPartId) {
      if (block.status !== "completed" && block.status !== "failed") {
        this.emitBlockEnd(this.currentTurn, block, "completed");
      }
    }
    this.blockByPartId.clear();
  }

  private startBlock(turn: Turn, partial: Record<string, unknown> & { type: string; status: BlockStatus }): Block {
    const block: Block = {
      ...partial,
      id: crypto.randomUUID(),
      turnId: turn.id,
      index: this.blockIndex++,
    } as Block;

    turn.blocks.push(block);

    this.emit("event", {
      event: "block:start",
      sessionId: this.session.id,
      turnId: turn.id,
      block,
    });

    return block;
  }

  private emitBlockEnd(turn: Turn, block: Block, status: BlockStatus): void {
    this.emit("event", {
      event: "block:end",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      status,
    });
  }

  private emitError(turn: Turn, message: string): void {
    const block = this.startBlock(turn, {
      type: "error",
      message,
      status: "completed",
    });
    this.emitBlockEnd(turn, block, "completed");
  }

  private endTurn(turn: Turn, status: TurnStatus): void {
    turn.status = status;
    turn.endedAt = new Date().toISOString();
    this.currentTurn = null;
    this.emit("event", {
      event: "turn:end",
      sessionId: this.session.id,
      turnId: turn.id,
      status,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory export
// ---------------------------------------------------------------------------

export const createAdapter = (config: AdapterConfig) => new OpenCodeAdapter(config);

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === "string" ? signal.reason : "OpenCode startup cancelled");
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
