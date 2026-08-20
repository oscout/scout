import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type {
  CursorLocalTransportMode,
  CursorTransportAuthSource,
  CursorTransportSpikeResult,
} from "@openscout/protocol";

const JSON_PREFIX = "__SCOUT_CURSOR_SPIKE_JSON__";

const CHILD_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/cursor-transport-spike/sdk-spike-child.mjs",
);

const CHILD_CWD = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/cursor-transport-spike",
);

function nodeExecutable(): string {
  return process.env.OPENSCOUT_CURSOR_SPIKE_NODE?.trim() || "node";
}

async function runSdkChild<T>(payload: unknown): Promise<T> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      nodeExecutable(),
      [CHILD_SCRIPT, JSON.stringify(payload)],
      {
        cwd: CHILD_CWD,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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
      const trimmed = stdout.trim();
      const jsonLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith(JSON_PREFIX))
        ?.slice(JSON_PREFIX.length);
      if (!jsonLine) {
        reject(new Error(stderr.trim() || `sdk child exited ${String(exitCode)}`));
        return;
      }
      try {
        resolve(JSON.parse(jsonLine) as T);
      } catch (error) {
        reject(new Error(
          `Failed to parse sdk child output: ${error instanceof Error ? error.message : String(error)}\n${jsonLine.slice(0, 500)}`,
        ));
      }
    });
  });
}

export type CursorSdkSpikeOptions = {
  mode: Extract<CursorLocalTransportMode, "cursor_sdk_local" | "cursor_sdk_local_no_key">;
  cwd: string;
  prompt: string;
  apiKey?: string;
  authSource: CursorTransportAuthSource;
  resumeAgentId?: string;
  modelId?: string;
};

export async function runCursorSdkTransportSpike(
  options: CursorSdkSpikeOptions,
): Promise<CursorTransportSpikeResult> {
  return await runSdkChild<CursorTransportSpikeResult>({
    kind: "single",
    payload: options,
  });
}

export async function runCursorSdkPersistentTurnSpike(input: {
  cwd: string;
  prompts: string[];
  apiKey?: string;
  authSource: CursorTransportAuthSource;
  modelId?: string;
}): Promise<{
  agentId?: string;
  turns: CursorTransportSpikeResult[];
}> {
  return await runSdkChild<{
    agentId?: string;
    turns: CursorTransportSpikeResult[];
  }>({
    kind: "persistent",
    payload: input,
  });
}

export { resolveCursorApiKey } from "./auth.js";
