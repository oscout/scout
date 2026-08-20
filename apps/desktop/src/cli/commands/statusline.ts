import { spawn } from "node:child_process";

import {
  captureClaudeStatuslineSnapshot,
  formatClaudeStatuslineFallback,
  isOpenScoutClaudeStatuslineCommand,
  parseClaudeStatuslinePayload,
  readClaudeStatuslineDelegate,
} from "@openscout/runtime/claude-statusline";

import type { ScoutCommandContext } from "../context.ts";

const DELEGATE_TIMEOUT_MS = 150;
const MAX_DELEGATE_OUTPUT_BYTES = 64 * 1024;

export async function runStatuslineCommand(context: ScoutCommandContext, args: string[]): Promise<void> {
  const [provider, ...rest] = args;
  if (provider !== "claude") {
    context.output.writeText("usage: scout statusline claude");
    return;
  }

  if (process.stdin.isTTY) {
    context.output.writeText("usage: scout statusline claude < statusline.json");
    return;
  }

  const delegateRequested = rest.includes("--delegate") || context.env.OPENSCOUT_STATUSLINE_RUN_DELEGATE === "1";
  const noDelegate = rest.includes("--no-delegate") || context.env.OPENSCOUT_STATUSLINE_DELEGATE === "1";
  const raw = await readStdin();
  const snapshot = parseClaudeStatuslinePayload(raw);

  try {
    // Claude waits on this command while refreshing the TUI; keep capture local and tiny.
    await captureClaudeStatuslineSnapshot(snapshot ?? raw);
  } catch {
    // Statusline execution should never make Claude's UI noisy.
  }

  // Preserved statusline delegates can be slow, so only run them when explicitly requested.
  if (delegateRequested && !noDelegate) {
    const delegate = await readClaudeStatuslineDelegate();
    if (delegate?.command && !isOpenScoutClaudeStatuslineCommand(delegate.command)) {
      const delegated = await runDelegateStatusline(delegate.command, raw, context.env);
      if (delegated) {
        writeStatusline(delegated);
        return;
      }
    }
  }

  writeStatusline(formatClaudeStatuslineFallback(snapshot));
}

async function readStdin(): Promise<string> {
  let out = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    out += typeof chunk === "string" ? chunk : String(chunk);
  }
  return out;
}

function writeStatusline(value: string): void {
  const normalized = value.trimEnd();
  process.stdout.write(`${normalized}\n`);
}

function runDelegateStatusline(
  command: string,
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", command], {
      env: {
        ...env,
        OPENSCOUT_STATUSLINE_DELEGATE: "1",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let stdout = "";
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value?.trimEnd() || null);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done(null);
    }, DELEGATE_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length >= MAX_DELEGATE_OUTPUT_BYTES) return;
      stdout += String(chunk).slice(0, MAX_DELEGATE_OUTPUT_BYTES - stdout.length);
    });
    child.once("error", () => done(null));
    child.once("close", (code) => done(code === 0 ? stdout : null));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
