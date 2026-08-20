// Claude Code adapter — persistent process with bidirectional stream-json.
//
// Ownership boundary: Claude Code owns its own ecosystem. This adapter may read
// Claude-owned state to resolve or explain sessions, but it must not write
// `.claude` project files, agent definitions, team config, task lists, or MCP
// settings. Setup flows that intentionally install Scout into a Claude host live
// outside this adapter and must be explicit user actions.
//
// Spawns `claude --print --input-format stream-json --output-format stream-json`
// once on start(), keeps it alive, and sends turns by writing JSON messages to
// stdin.  Claude Code streams responses on stdout as newline-delimited JSON.
//
// Input format:
//   {"type":"user","message":{"role":"user","content":"..."},"session_id":"","parent_tool_use_id":null}
//
// Output events:
//   system (init, hooks)  → session metadata
//   assistant             → text/reasoning blocks and nested tool_use records
//   user                  → nested tool_result records
//   tool_use/tool_result  → legacy top-level action records
//   stream_event          → partial deltas
//   result                → turn complete
//   error                 → error blocks

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { BaseAdapter } from "../../protocol/adapter.js";
import type { AdapterConfig } from "../../protocol/adapter.js";
import { createLiveNormalizerContext } from "../../protocol/live-normalizer-context.js";
import type {
  AgentSessionStreamEvent,
  Prompt,
  QuestionAnswer,
  Turn,
} from "../../protocol/primitives.js";
import { readClaudeAgentTeamTopology } from "./team-topology.js";
import {
  ClaudeCodeEventNormalizer,
  createClaudeCodeEventNormalizer,
} from "./normalizer.js";
import {
  spawnHarnessProcess,
  type HarnessProcess,
} from "../../runtime/process.js";

interface ClaudeResumeContext {
  cwd: string;
  resumeId: string;
  sessionPath: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeCodeAdapter extends BaseAdapter {
  readonly type = "claude-code";

  private process: HarnessProcess | null = null;
  private currentTurn: Turn | null = null;
  private claudeSessionId: string | null = null;

  // Resolvers waiting for the user's answer: blockId → resolve fn
  private pendingAnswers = new Map<string, (answer: string[]) => void>();

  /** Pure normalizer shared with fixture replay (SCO-042). */
  private readonly normalizer: ClaudeCodeEventNormalizer;
  private sequence = 0;

  constructor(config: AdapterConfig) {
    const resumeContext = resolveClaudeResumeContext(config);
    const resolvedConfig: AdapterConfig = resumeContext
      ? {
          ...config,
          cwd: resumeContext.cwd,
          options: {
            ...config.options,
            resume: resumeContext.resumeId,
          },
        }
      : config;

    super(resolvedConfig);

    if (resumeContext) {
      this.session.providerMeta = {
        ...(this.session.providerMeta ?? {}),
        resumeSessionPath: resumeContext.sessionPath,
        resumeProjectCwd: resumeContext.cwd,
      };
    }

    this.normalizer = createClaudeCodeEventNormalizer(
      createLiveNormalizerContext(this.session.id),
      {
        sessionName: this.session.name,
        cwd: this.session.cwd ?? this.config.cwd,
        model: this.session.model,
        providerMeta: this.session.providerMeta,
      },
    );
  }

  async start(): Promise<void> {
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
    ];

    const model = this.config.options?.["model"] as string | undefined;
    if (model) {
      args.push("--model", model);
    }

    // Resume an existing Claude Code session if specified.
    const resumeId = this.config.options?.["resume"] as string | undefined;
    if (resumeId) {
      args.push("--resume", resumeId);
    }

    const env = { ...process.env, ...this.config.env };
    const claudeExecutable = resolveExecutableFromPath("claude", env);

    const child = await spawnHarnessProcess(claudeExecutable, args, {
      cwd: this.config.cwd,
      env,
    });
    this.process = child;

    this.readStdout();
    child.drainStderr();

    child.onError((error) => {
      if (this.process === child && this.session.status !== "closed") {
        this.failSession(error);
      }
    });
    child.onExit((code, signal) => {
      if (this.process !== child || this.session.status === "closed") {
        return;
      }
      if (code !== 0) {
        this.failSession(new Error(
          `claude exited`
          + (code !== null ? ` with code ${code}` : "")
          + (signal ? ` (${signal})` : ""),
        ));
      } else {
        this.emitNormalized(this.normalizer.ingest({
          source: "adapter_control",
          sequence: this.sequence++,
          event: "transport_closed",
        }));
        this.setStatus("closed");
      }
    });

    this.setStatus("active");
  }

  send(prompt: Prompt): void {
    if (!this.process?.stdin.writable) {
      this.emit("error", new Error("Claude Code process not running"));
      return;
    }

    // Adapter shell opens the turn; the pure normalizer owns stream events.
    this.emitNormalized(this.normalizer.ingest({
      source: "adapter_control",
      sequence: this.sequence++,
      event: "prompt_accepted",
      payload: { text: prompt.text },
    }));

    // Build the content — text or array with images/files. (stdin side effect)
    let content: string | Array<Record<string, unknown>> = prompt.text;

    if (prompt.images?.length || prompt.files?.length) {
      const parts: Array<Record<string, unknown>> = [];
      parts.push({ type: "text", text: prompt.text });

      if (prompt.images?.length) {
        for (const img of prompt.images) {
          parts.push({
            type: "image",
            source: { type: "base64", media_type: img.mimeType, data: img.data },
          });
        }
      }

      if (prompt.files?.length) {
        parts.push({ type: "text", text: `\n\nReferenced files: ${prompt.files.join(", ")}` });
      }

      content = parts;
    }

    const msg = JSON.stringify({
      type: "user",
      session_id: this.claudeSessionId ?? this.normalizer.getClaudeSessionId() ?? "",
      message: { role: "user", content },
      parent_tool_use_id: null,
    }) + "\n";

    this.process.stdin.write(msg);
  }

  interrupt(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGINT");
    }
    this.emitNormalized(this.normalizer.ingest({
      source: "adapter_control",
      sequence: this.sequence++,
      event: "interrupt",
    }));
  }

  async shutdown(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (child) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      const exited = await waitForSubprocessExit(child, 1_000);
      if (!exited) {
        child.kill("SIGKILL");
        await waitForSubprocessExit(child, 250);
      }
    }
    this.setStatus("closed");
  }

  // ---------------------------------------------------------------------------
  // Persistent stdout reader
  // ---------------------------------------------------------------------------

  private readStdout(): void {
    this.process?.readStdoutLines(
      (line) => this.handleStdoutLine(line),
      // Wait for onExit before classifying an open turn. Stdout EOF can arrive
      // before the process exit code; only the exit status distinguishes a
      // clean transport close from a failed transport.
      () => undefined,
    );
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      this.handleHarnessPayload(JSON.parse(trimmed));
    } catch {
      // Ignore malformed harness output.
    }
  }

  /**
   * Decode harness stdout and feed the shared pure normalizer.
   * Filesystem topology and stdin writeback remain shell side effects.
   */
  private handleHarnessPayload(payload: unknown): void {
    const events = this.normalizer.ingest({
      source: "harness",
      sequence: this.sequence++,
      payload,
    });
    this.emitNormalized(events);

    const record = asRecord(payload);
    if (!record) return;

    // Keep shell claudeSessionId for topology file discovery.
    if (record.type === "system" && record.subtype === "init") {
      const sid = record.session_id ?? record.sessionId;
      if (typeof sid === "string" && sid.trim()) {
        this.claudeSessionId = sid;
      }
      this.pushObservedTopology();
    }

    if (record.type === "result") {
      this.pushObservedTopology();
    }

    // Shell owns stdin writeback for AskUserQuestion. Modern Claude Code nests
    // tool_use records in assistant.message.content; older builds emitted them
    // as top-level records.
    const toolUses: Record<string, unknown>[] = [];
    if (record.type === "tool_use") {
      toolUses.push(record);
    } else if (record.type === "assistant") {
      const content = asRecord(record.message)?.content ?? record.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const toolUse = asRecord(part);
          if (toolUse?.type === "tool_use") toolUses.push(toolUse);
        }
      }
    }
    const questionStarts = events.filter(
      (event): event is Extract<AgentSessionStreamEvent, { event: "block:start" }> =>
        event.event === "block:start" && event.block.type === "question",
    );
    let questionIndex = 0;
    for (const toolUse of toolUses) {
      const toolName = typeof toolUse.tool_name === "string"
        ? toolUse.tool_name
        : typeof toolUse.name === "string"
          ? toolUse.name
          : "";
      if (toolName === "AskUserQuestion") {
        const toolCallId = typeof toolUse.tool_use_id === "string"
          ? toolUse.tool_use_id
          : typeof toolUse.id === "string"
            ? toolUse.id
            : "";
        const questionStart = questionStarts[questionIndex++];
        if (questionStart && toolCallId) {
          void this.awaitAndSendAnswer(questionStart.block.id, toolCallId);
        }
      }
    }
  }

  answerQuestion(answer: QuestionAnswer): void {
    const resolve = this.pendingAnswers.get(answer.blockId);
    if (!resolve) return;
    this.pendingAnswers.delete(answer.blockId);
    resolve(answer.answer);

    this.emitNormalized(this.normalizer.ingest({
      source: "adapter_control",
      sequence: this.sequence++,
      event: "question_answered",
      payload: {
        blockId: answer.blockId,
        answer: answer.answer,
      },
    }));
  }

  private async awaitAndSendAnswer(blockId: string, toolCallId: string): Promise<void> {
    const answer = await new Promise<string[]>((resolve) => {
      this.pendingAnswers.set(blockId, resolve);
    });

    if (!this.process?.stdin.writable) return;
    const response = JSON.stringify({
      type: "user",
      session_id: this.claudeSessionId ?? this.normalizer.getClaudeSessionId() ?? "",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolCallId,
          content: answer.join(", "),
          is_error: false,
        }],
      },
      parent_tool_use_id: null,
    });
    this.process.stdin.write(response + "\n");
  }

  private pushObservedTopology(): void {
    const homeDir = typeof this.config.env?.HOME === "string" && this.config.env.HOME.trim()
      ? this.config.env.HOME
      : process.env.HOME;
    const topology = readClaudeAgentTeamTopology({
      homeDir,
      cwd: this.session.cwd ?? this.config.cwd,
      claudeSessionId: this.claudeSessionId ?? this.normalizer.getClaudeSessionId(),
    });
    this.emitNormalized(this.normalizer.ingest({
      source: "adapter_control",
      sequence: this.sequence++,
      event: "topology_observed",
      payload: topology ?? null,
    }));
  }

  private emitNormalized(events: readonly AgentSessionStreamEvent[]): void {
    for (const event of events) {
      if (event.event === "session:update") {
        this.session.name = event.session.name;
        this.session.status = event.session.status;
        this.session.cwd = event.session.cwd;
        this.session.model = event.session.model;
        this.session.providerMeta = event.session.providerMeta;
      }
      if (event.event === "turn:start") {
        this.currentTurn = event.turn;
      }
      if (event.event === "turn:end") {
        this.currentTurn = null;
      }
      this.emit("event", event);
    }
  }

  private failSession(error: Error): void {
    this.emitNormalized(this.normalizer.ingest({
      source: "adapter_control",
      sequence: this.sequence++,
      event: "transport_error",
      payload: { message: error.message },
    }));
    this.emit("error", error);
    this.setStatus("error");
  }
}


// ---------------------------------------------------------------------------
// Factory export
// ---------------------------------------------------------------------------

export const createAdapter = (config: AdapterConfig) => new ClaudeCodeAdapter(config);

async function waitForSubprocessExit(child: HarnessProcess, timeoutMs: number): Promise<boolean> {
  return await child.waitForExit(timeoutMs);
}

function resolveClaudeResumeContext(config: AdapterConfig): ClaudeResumeContext | null {
  const rawResumeId = config.options?.["resume"];
  const resumeId = typeof rawResumeId === "string" ? rawResumeId.trim().replace(/\.jsonl$/u, "") : "";
  if (!resumeId) {
    return null;
  }

  const projectsRoot = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsRoot)) {
    return null;
  }

  let projectSlugs: string[];
  try {
    projectSlugs = readdirSync(projectsRoot);
  } catch {
    return null;
  }

  for (const slug of projectSlugs) {
    const sessionPath = join(projectsRoot, slug, `${resumeId}.jsonl`);
    if (!existsSync(sessionPath)) {
      continue;
    }

    const cwd = decodeClaudeProjectsSlug(slug);
    if (!cwd) {
      continue;
    }

    try {
      if (!statSync(cwd).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    return {
      cwd,
      resumeId,
      sessionPath,
    };
  }

  return null;
}

function decodeClaudeProjectsSlug(slug: string): string | null {
  if (!slug.startsWith("-")) {
    return null;
  }

  const tail = slug.slice(1);
  if (!tail) {
    return null;
  }

  return `/${tail.replace(/-/g, "/")}`;
}

function resolveExecutableFromPath(command: string, env: Record<string, string | undefined>): string {
  if (command.includes("/")) {
    return command;
  }

  const pathValue = env.PATH ?? process.env.PATH ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep searching.
    }
  }

  return command;
}
