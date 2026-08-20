import { resolveCodexExecutable } from "@openscout/agent-sessions/codex-executable";
import {
  execSystemFile,
  readTmuxSessionExists,
} from "@openscout/runtime/system-probes";

export type SessionCompactionRequest = {
  harness?: string | null;
  sessionId?: string | null;
  transcriptPath?: string | null;
  tmuxSessionName?: string | null;
  agentId?: string | null;
};

export type SessionCompactionResult = {
  ok: boolean;
  delivered: boolean;
  method?: "codex-app-server" | "tmux-slash-command";
  command?: string;
  error?: string;
};

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  return await readTmuxSessionExists(sessionName, { maxAgeMs: 5_000 });
}

async function sendTmuxSlashCommand(sessionName: string, command: string): Promise<boolean> {
  try {
    await execSystemFile("tmux", ["send-keys", "-t", sessionName, "-l", command], { timeoutMs: 2_000 });
    await execSystemFile("tmux", ["send-keys", "-t", sessionName, "Enter"], { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function parseJsonRpcLine(output: string): { result?: unknown; error?: { message?: string } } | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { result?: unknown; error?: { message?: string } };
      if ("result" in parsed || "error" in parsed) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function requestCodexThreadCompaction(threadId: string): Promise<SessionCompactionResult> {
  const trimmed = threadId.trim();
  if (!trimmed) {
    return { ok: false, delivered: false, error: "missing codex thread id" };
  }

  let codexExecutable: string;
  try {
    codexExecutable = resolveCodexExecutable();
  } catch (error) {
    return {
      ok: false,
      delivered: false,
      error: error instanceof Error ? error.message : "Codex executable is unavailable",
    };
  }

  const request = `${JSON.stringify({
    id: 1,
    method: "thread/compact/start",
    params: { threadId: trimmed },
  })}\n`;

  let combined = "";
  try {
    const result = await execSystemFile(codexExecutable, ["app-server", "proxy"], {
      input: request,
      timeoutMs: 15_000,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    });
    combined = `${result.stdout ?? ""}
${result.stderr ?? ""}`.trim();
  } catch (error) {
    return {
      ok: false,
      delivered: false,
      method: "codex-app-server",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const response = parseJsonRpcLine(combined);
  if (response?.error?.message) {
    return {
      ok: false,
      delivered: false,
      method: "codex-app-server",
      error: response.error.message,
    };
  }

  return {
    ok: true,
    delivered: true,
    method: "codex-app-server",
  };
}

export async function requestHarnessSessionCompaction(
  input: SessionCompactionRequest,
): Promise<SessionCompactionResult> {
  const harness = input.harness?.trim().toLowerCase() ?? "";
  const sessionId = input.sessionId?.trim() ?? "";
  const tmuxSessionName = input.tmuxSessionName?.trim() ?? "";

  if (harness === "codex" && sessionId) {
    return await requestCodexThreadCompaction(sessionId);
  }

  const slashCommand = harness === "claude" || harness === "claude-code"
    ? "/compact"
    : null;
  if (slashCommand && tmuxSessionName && await tmuxSessionExists(tmuxSessionName)) {
    const delivered = await sendTmuxSlashCommand(tmuxSessionName, slashCommand);
    return delivered
      ? {
          ok: true,
          delivered: true,
          method: "tmux-slash-command",
          command: slashCommand,
        }
      : {
          ok: false,
          delivered: false,
          method: "tmux-slash-command",
          command: slashCommand,
          error: `failed to send ${slashCommand} to tmux session ${tmuxSessionName}`,
        };
  }

  if (slashCommand) {
    return {
      ok: false,
      delivered: false,
      method: "tmux-slash-command",
      command: slashCommand,
      error: "no reachable tmux surface for this session",
    };
  }

  return {
    ok: false,
    delivered: false,
    error: `compaction is not supported for harness ${harness || "unknown"}`,
  };
}
