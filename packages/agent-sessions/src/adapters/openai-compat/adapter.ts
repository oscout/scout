// OpenAI-compatible adapter — covers any backend speaking the OpenAI
// chat completions streaming format (GPT, Groq, Together, LM Studio,
// Ollama, vLLM, etc.).
//
// Uses native fetch + manual SSE parsing.  No external dependencies.
// Credentials stay local — apiKey lives in the adapter config, never
// leaves the bridge process.

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

// ---------------------------------------------------------------------------
// OpenAI streaming types — minimal surface for what we actually read
// ---------------------------------------------------------------------------

/** A single delta inside a streamed chat completion chunk. */
interface ChatCompletionDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCallChunk[];
}

interface ToolCallChunk {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatCompletionChunk {
  id: string;
  object: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionDelta;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Configuration extracted from AdapterConfig.options
// ---------------------------------------------------------------------------

interface OpenAIOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

function parseOptions(raw: Record<string, unknown> | undefined): OpenAIOptions {
  if (!raw) {
    throw new Error("openai adapter requires options with at least baseUrl and model");
  }

  const baseUrl = raw["baseUrl"] as string | undefined;
  const model = raw["model"] as string | undefined;

  if (!baseUrl || !model) {
    throw new Error("openai adapter requires options.baseUrl and options.model");
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""), // strip trailing slashes
    apiKey: raw["apiKey"] as string | undefined,
    model,
    maxTokens: raw["maxTokens"] as number | undefined,
    temperature: raw["temperature"] as number | undefined,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAICompatAdapter extends BaseAdapter {
  readonly type = "openai";

  private options: OpenAIOptions;
  private currentTurn: Turn | null = null;
  private blockIndex = 0;
  private abortController: AbortController | null = null;

  constructor(config: AdapterConfig) {
    super(config);
    this.options = parseOptions(config.options);
    // Expose the model on the session.
    (this.session as { model: string }).model = this.options.model;
  }

  async start(): Promise<void> {
    this.setStatus("active");
  }

  send(prompt: Prompt): void {
    this.abortController = new AbortController();
    this.blockIndex = 0;

    const turn: Turn = {
      id: crypto.randomUUID(),
      sessionId: this.session.id,
      status: "started",
      startedAt: new Date().toISOString(),
      blocks: [],
    };
    this.currentTurn = turn;
    this.emit("event", { event: "turn:start", sessionId: this.session.id, turn });

    // Fire and forget — stream processing runs asynchronously.
    this.executeRequest(turn, prompt).catch((err: Error) => {
      this.emit("error", err);
    });
  }

  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.currentTurn) {
      this.endTurn(this.currentTurn, "stopped");
    }
  }

  async shutdown(): Promise<void> {
    this.interrupt();
    this.setStatus("closed");
  }

  // ---------------------------------------------------------------------------
  // Request execution — build messages, fetch, parse SSE
  // ---------------------------------------------------------------------------

  private async executeRequest(turn: Turn, prompt: Prompt): Promise<void> {
    const { baseUrl, apiKey, model, maxTokens, temperature } = this.options;

    // Build the messages array.
    const messages = this.buildMessages(prompt);

    // Build the request body.
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };
    if (maxTokens !== undefined) body["max_tokens"] = maxTokens;
    if (temperature !== undefined) body["temperature"] = temperature;

    // Pass through any extra provider options.
    if (prompt.providerOptions) {
      for (const [key, value] of Object.entries(prompt.providerOptions)) {
        if (!(key in body)) body[key] = value;
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: this.abortController?.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        this.endTurn(turn, "stopped");
        return;
      }
      const message = err instanceof Error ? err.message : "Network request failed";
      this.emitError(turn, message);
      this.endTurn(turn, "failed");
      return;
    }

    if (!response.ok) {
      let errorText: string;
      try {
        const errorBody = await response.text();
        errorText = `HTTP ${response.status}: ${errorBody}`;
      } catch {
        errorText = `HTTP ${response.status}: ${response.statusText}`;
      }
      this.emitError(turn, errorText);
      this.endTurn(turn, "failed");
      return;
    }

    await this.parseSSEStream(turn, response);
  }

  // ---------------------------------------------------------------------------
  // Message builder — Prompt -> OpenAI messages array
  // ---------------------------------------------------------------------------

  private buildMessages(prompt: Prompt): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];

    // Build user message content parts.
    const contentParts: Array<Record<string, unknown>> = [];

    // Text content.
    if (prompt.text) {
      contentParts.push({ type: "text", text: prompt.text });
    }

    // Image attachments (vision API format).
    if (prompt.images?.length) {
      for (const img of prompt.images) {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${img.mimeType};base64,${img.data}`,
          },
        });
      }
    }

    // File mentions appended as text context.
    if (prompt.files?.length) {
      contentParts.push({
        type: "text",
        text: `\n\nReferenced files: ${prompt.files.join(", ")}`,
      });
    }

    // If single text-only content, use the simple string format for
    // maximum compatibility across providers.
    if (contentParts.length === 1 && contentParts[0]!["type"] === "text") {
      messages.push({ role: "user", content: contentParts[0]!["text"] });
    } else {
      messages.push({ role: "user", content: contentParts });
    }

    return messages;
  }

  // ---------------------------------------------------------------------------
  // SSE stream parser — reads the response body line by line
  // ---------------------------------------------------------------------------

  private async parseSSEStream(turn: Turn, response: Response): Promise<void> {
    const body = response.body;
    if (!body) {
      this.emitError(turn, "Response body is null");
      this.endTurn(turn, "failed");
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Active streaming blocks — we track these so we can emit proper
    // block:delta and block:end events.
    let textBlock: Block | null = null;
    let reasoningBlock: Block | null = null;

    // Tool call accumulation — tool_calls arrive across many chunks.
    // We accumulate per-index and emit blocks on finish_reason=tool_calls.
    const toolCalls = new Map<number, {
      id: string;
      name: string;
      arguments: string;
    }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();

          // SSE stream terminator.
          if (trimmed === "data: [DONE]") {
            continue;
          }

          // Only process data lines.
          if (!trimmed.startsWith("data: ")) {
            continue;
          }

          const jsonStr = trimmed.slice(6); // strip "data: " prefix
          let chunk: ChatCompletionChunk;
          try {
            chunk = JSON.parse(jsonStr);
          } catch {
            // Skip malformed JSON lines.
            continue;
          }

          const choice = chunk.choices[0];
          if (!choice) continue;

          const delta = choice.delta;

          // -- Reasoning content (e.g. DeepSeek R1, o1-style models) ------
          if (delta.reasoning_content) {
            if (!reasoningBlock) {
              reasoningBlock = this.startBlock(turn, {
                type: "reasoning",
                text: "",
                status: "streaming",
              });
            }
            this.emitBlockDelta(turn, reasoningBlock, delta.reasoning_content);
          }

          // -- Text content -----------------------------------------------
          if (delta.content) {
            // If reasoning was streaming and text content starts, close
            // the reasoning block first.
            if (reasoningBlock) {
              this.emitBlockEnd(turn, reasoningBlock, "completed");
              reasoningBlock = null;
            }

            if (!textBlock) {
              textBlock = this.startBlock(turn, {
                type: "text",
                text: "",
                status: "streaming",
              });
            }
            this.emitBlockDelta(turn, textBlock, delta.content);
          }

          // -- Tool calls -------------------------------------------------
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCalls.get(tc.index);
              if (existing) {
                // Accumulate function arguments.
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments;
                }
              } else {
                // New tool call at this index.
                toolCalls.set(tc.index, {
                  id: tc.id ?? crypto.randomUUID(),
                  name: tc.function?.name ?? "unknown",
                  arguments: tc.function?.arguments ?? "",
                });
              }
            }
          }

          // -- Finish reason — close open blocks --------------------------
          if (choice.finish_reason) {
            // Close reasoning block if still open.
            if (reasoningBlock) {
              this.emitBlockEnd(turn, reasoningBlock, "completed");
              reasoningBlock = null;
            }

            // Close text block if still open.
            if (textBlock) {
              this.emitBlockEnd(turn, textBlock, "completed");
              textBlock = null;
            }

            // Emit accumulated tool call blocks.
            if (choice.finish_reason === "tool_calls" || toolCalls.size > 0) {
              this.emitToolCallBlocks(turn, toolCalls);
              toolCalls.clear();
            }
          }
        }
      }

      // Process remaining buffer for any final data.
      if (buffer.trim().startsWith("data: ") && buffer.trim() !== "data: [DONE]") {
        try {
          const chunk: ChatCompletionChunk = JSON.parse(buffer.trim().slice(6));
          const choice = chunk.choices[0];
          if (choice?.finish_reason) {
            if (reasoningBlock) {
              this.emitBlockEnd(turn, reasoningBlock, "completed");
              reasoningBlock = null;
            }
            if (textBlock) {
              this.emitBlockEnd(turn, textBlock, "completed");
              textBlock = null;
            }
            if (toolCalls.size > 0) {
              this.emitToolCallBlocks(turn, toolCalls);
              toolCalls.clear();
            }
          }
        } catch { /* skip malformed trailing data */ }
      }

      // Safety net: close any blocks left open (e.g. if the stream ended
      // without a finish_reason, which some providers do).
      if (reasoningBlock) {
        this.emitBlockEnd(turn, reasoningBlock, "completed");
      }
      if (textBlock) {
        this.emitBlockEnd(turn, textBlock, "completed");
      }
      if (toolCalls.size > 0) {
        this.emitToolCallBlocks(turn, toolCalls);
      }

      // Mark turn as completed.
      if (turn.status !== "stopped" && turn.status !== "failed") {
        this.endTurn(turn, "completed");
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        // Close any open blocks on abort.
        if (reasoningBlock) this.emitBlockEnd(turn, reasoningBlock, "completed");
        if (textBlock) this.emitBlockEnd(turn, textBlock, "completed");
        this.endTurn(turn, "stopped");
      } else {
        const message = err instanceof Error ? err.message : "Stream read error";
        // Close any open blocks before emitting error.
        if (reasoningBlock) this.emitBlockEnd(turn, reasoningBlock, "failed");
        if (textBlock) this.emitBlockEnd(turn, textBlock, "failed");
        this.emitError(turn, message);
        this.endTurn(turn, "failed");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tool call emission — accumulated tool_calls → ActionBlock(s)
  // ---------------------------------------------------------------------------

  private emitToolCallBlocks(
    turn: Turn,
    toolCalls: Map<number, { id: string; name: string; arguments: string }>,
  ): void {
    for (const [, tc] of toolCalls) {
      let parsedInput: unknown;
      try {
        parsedInput = JSON.parse(tc.arguments);
      } catch {
        parsedInput = tc.arguments;
      }

      const action: Action = {
        kind: "tool_call",
        toolName: tc.name,
        toolCallId: tc.id,
        input: parsedInput,
        status: "completed",
        output: "",
      };

      const block = this.startBlock(turn, {
        type: "action",
        action,
        status: "completed",
      });

      this.emitBlockEnd(turn, block, "completed");
    }
  }

  // ---------------------------------------------------------------------------
  // Block helpers — mirrors the Claude Code adapter patterns.
  // ---------------------------------------------------------------------------

  private startBlock(
    turn: Turn,
    partial: Record<string, unknown> & { type: string; status: BlockStatus },
  ): Block {
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

  private emitBlockDelta(turn: Turn, block: Block, text: string): void {
    this.emit("event", {
      event: "block:delta",
      sessionId: this.session.id,
      turnId: turn.id,
      blockId: block.id,
      text,
    });
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

export const createAdapter = (config: AdapterConfig) => new OpenAICompatAdapter(config);
