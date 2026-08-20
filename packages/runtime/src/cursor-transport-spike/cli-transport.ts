import type { RuntimeEnv } from "../portable-types.js";
import { spawn } from "node:child_process";

import type {
  CursorLocalTransportMode,
  CursorTransportAuthSource,
  CursorTransportSpikeResult,
} from "@openscout/protocol";

import { resolveCursorAgentExecutable } from "./auth.js";

export type CursorCliSpikeOptions = {
  mode: Extract<CursorLocalTransportMode, "cursor_cli_text" | "cursor_cli_stream_json">;
  cwd: string;
  prompt: string;
  apiKey?: string;
  authSource: CursorTransportAuthSource;
  sessionId?: string;
  timeoutMs?: number;
  env?: RuntimeEnv;
};

type CursorCliStreamEvent =
  | { type: "system"; subtype?: string; session_id?: string }
  | { type: "assistant"; message?: { content?: Array<{ type?: string; text?: string }> }; session_id?: string }
  | { type: "result"; subtype?: string; result?: string; is_error?: boolean; session_id?: string; message?: string }
  | { type: string; session_id?: string };

function buildCursorAgentArgs(options: CursorCliSpikeOptions): string[] {
  const args = [
    "--print",
    "--output-format",
    options.mode === "cursor_cli_stream_json" ? "stream-json" : "text",
    "--force",
    "--approve-mcps",
  ];

  if (options.mode === "cursor_cli_stream_json") {
    args.push("--stream-partial-output");
  }

  if (options.apiKey) {
    args.push("--api-key", options.apiKey);
  }

  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  }

  args.push(options.prompt);
  return args;
}

export function parseCursorCliStreamJsonOutput(raw: string): {
  outputText: string;
  sessionId?: string;
  eventCount: number;
  errorMessage?: string;
} {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const textParts: string[] = [];
  let sessionId: string | undefined;
  let resultText: string | undefined;
  let errorMessage: string | undefined;

  for (const line of lines) {
    let event: CursorCliStreamEvent;
    try {
      event = JSON.parse(line) as CursorCliStreamEvent;
    } catch {
      continue;
    }

    if (typeof event.session_id === "string" && event.session_id) {
      sessionId = event.session_id;
    }

    if (event.type === "assistant") {
      const assistant = event as Extract<CursorCliStreamEvent, { type: "assistant" }>;
      for (const block of assistant.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        }
      }
    }

    if (event.type === "result") {
      const resultEvent = event as Extract<CursorCliStreamEvent, { type: "result" }>;
      if (typeof resultEvent.result === "string" && resultEvent.result.trim()) {
        resultText = resultEvent.result.trim();
      }
      if (resultEvent.is_error === true) {
        errorMessage = resultEvent.message || resultEvent.subtype || "cursor stream-json result error";
      }
    }
  }

  const joined = textParts.join("");
  const outputText = resultText || joined.trim();
  return {
    outputText,
    sessionId,
    eventCount: lines.length,
    errorMessage,
  };
}

async function spawnCursorAgentCapture(
  options: CursorCliSpikeOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; durationMs: number }> {
  const startedAt = Date.now();
  const command = resolveCursorAgentExecutable(options.env);
  const args = buildCursorAgentArgs(options);

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timeoutMs = options.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export async function runCursorCliTransportSpike(
  options: CursorCliSpikeOptions,
): Promise<CursorTransportSpikeResult> {
  const notes: string[] = [];
  if (!options.apiKey) {
    notes.push("No CURSOR_API_KEY supplied; cursor-agent --print expects login or API key in headless mode.");
  }

  try {
    const captured = await spawnCursorAgentCapture(options);
    const failureText = captured.stderr.trim() || captured.stdout.trim();

    if (captured.exitCode !== 0) {
      return {
        mode: options.mode,
        ok: false,
        durationMs: captured.durationMs,
        authSource: options.authSource,
        sessionId: options.sessionId,
        errorCode: "cli_exit_nonzero",
        errorMessage: failureText.slice(0, 500) || `cursor-agent exited with code ${String(captured.exitCode)}`,
        notes,
      };
    }

    if (options.mode === "cursor_cli_stream_json") {
      const parsed = parseCursorCliStreamJsonOutput(captured.stdout);
      if (parsed.errorMessage) {
        return {
          mode: options.mode,
          ok: false,
          durationMs: captured.durationMs,
          authSource: options.authSource,
          sessionId: parsed.sessionId ?? options.sessionId,
          eventCount: parsed.eventCount,
          errorCode: "cli_stream_json_error",
          errorMessage: parsed.errorMessage,
          notes,
        };
      }

      return {
        mode: options.mode,
        ok: Boolean(parsed.outputText),
        durationMs: captured.durationMs,
        authSource: options.authSource,
        sessionId: parsed.sessionId ?? options.sessionId,
        outputText: parsed.outputText,
        eventCount: parsed.eventCount,
        notes,
      };
    }

    return {
      mode: options.mode,
      ok: Boolean(captured.stdout.trim()),
      durationMs: captured.durationMs,
      authSource: options.authSource,
      sessionId: options.sessionId,
      outputText: captured.stdout.trim(),
      notes,
    };
  } catch (error) {
    return {
      mode: options.mode,
      ok: false,
      durationMs: 0,
      authSource: options.authSource,
      sessionId: options.sessionId,
      errorCode: "cli_spawn_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      notes,
    };
  }
}

export async function createCursorCliChatSession(
  options: { env?: RuntimeEnv; apiKey?: string } = {},
): Promise<string> {
  const command = resolveCursorAgentExecutable(options.env);
  const args = ["create-chat"];
  if (options.apiKey) {
    args.push("--api-key", options.apiKey);
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const chatId = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim();
      if (exitCode === 0 && chatId) {
        resolve(chatId);
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `create-chat failed (${String(exitCode)})`));
    });
  });
}
