import type { RuntimeEnv } from "../portable-types.js";
import type {
  CursorLocalTransportMode,
  CursorTransportSpikeResult,
} from "@openscout/protocol";

import { resolveCursorApiKey } from "./auth.js";
import {
  createCursorCliChatSession,
  runCursorCliTransportSpike,
} from "./cli-transport.js";
import {
  runCursorSdkPersistentTurnSpike,
  runCursorSdkTransportSpike,
} from "./sdk-transport.js";

export type CursorTransportSpikePlan = {
  cwd: string;
  prompt: string;
  followUpPrompt?: string;
  modes?: CursorLocalTransportMode[];
  env?: RuntimeEnv;
  timeoutMs?: number;
  modelId?: string;
};

export type CursorTransportSpikeReport = {
  cwd: string;
  auth: Awaited<ReturnType<typeof resolveCursorApiKey>>;
  results: CursorTransportSpikeResult[];
  sharedSessionId?: string;
  sharedAgentId?: string;
};

const DEFAULT_MODES: CursorLocalTransportMode[] = [
  "cursor_cli_text",
  "cursor_cli_stream_json",
  "cursor_sdk_local_no_key",
  "cursor_sdk_local",
];

function requestedModes(plan: CursorTransportSpikePlan): CursorLocalTransportMode[] {
  return plan.modes?.length ? [...plan.modes] : [...DEFAULT_MODES];
}

export async function runCursorTransportSpike(
  plan: CursorTransportSpikePlan,
): Promise<CursorTransportSpikeReport> {
  const auth = await resolveCursorApiKey(plan.env);
  const results: CursorTransportSpikeResult[] = [];
  const modes = requestedModes(plan);

  let sharedSessionId: string | undefined;
  if (
    auth.apiKey
    && modes.some((mode) => mode === "cursor_cli_text" || mode === "cursor_cli_stream_json")
  ) {
    try {
      sharedSessionId = await createCursorCliChatSession({
        env: plan.env,
        apiKey: auth.apiKey,
      });
    } catch (error) {
      results.push({
        mode: "cursor_cli_stream_json",
        ok: false,
        durationMs: 0,
        authSource: auth.source,
        errorCode: "create_chat_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        notes: ["Failed to pre-create CLI chat session for resume-based turns."],
      });
    }
  }

  for (const mode of modes) {
    if (mode === "cursor_cli_text" || mode === "cursor_cli_stream_json") {
      results.push(await runCursorCliTransportSpike({
        mode,
        cwd: plan.cwd,
        prompt: plan.prompt,
        apiKey: auth.apiKey,
        authSource: auth.apiKey ? auth.source : "none",
        sessionId: sharedSessionId,
        timeoutMs: plan.timeoutMs,
        env: plan.env,
      }));
      continue;
    }

    if (mode === "cursor_sdk_local_no_key") {
      results.push(await runCursorSdkTransportSpike({
        mode,
        cwd: plan.cwd,
        prompt: plan.prompt,
        authSource: "none",
        modelId: plan.modelId,
      }));
      continue;
    }

    if (mode === "cursor_sdk_local") {
      const persistent = await runCursorSdkPersistentTurnSpike({
        cwd: plan.cwd,
        prompts: plan.followUpPrompt
          ? [plan.prompt, plan.followUpPrompt]
          : [plan.prompt],
        apiKey: auth.apiKey,
        authSource: auth.apiKey ? auth.source : "none",
        modelId: plan.modelId,
      });
      results.push(...persistent.turns);
      continue;
    }
  }

  const sharedAgentId = results.find((result) => result.agentId)?.agentId;

  return {
    cwd: plan.cwd,
    auth,
    results,
    sharedSessionId,
    sharedAgentId,
  };
}

export function formatCursorTransportSpikeReport(report: CursorTransportSpikeReport): string {
  const lines = [
    `Cursor transport spike`,
    `cwd: ${report.cwd}`,
    `auth: ${report.auth.source}${report.auth.apiKey ? " (key present)" : " (no key)"}`,
  ];

  if (report.sharedSessionId) {
    lines.push(`cli session: ${report.sharedSessionId}`);
  }
  if (report.sharedAgentId) {
    lines.push(`sdk agent: ${report.sharedAgentId}`);
  }

  lines.push("");

  for (const result of report.results) {
    lines.push(`[${result.mode}] ${result.ok ? "OK" : "FAIL"} (${result.durationMs}ms)`);
    if (result.outputText) {
      lines.push(`  output: ${JSON.stringify(result.outputText)}`);
    }
    if (result.sessionId) {
      lines.push(`  session: ${result.sessionId}`);
    }
    if (result.agentId) {
      lines.push(`  agent: ${result.agentId}`);
    }
    if (result.runId) {
      lines.push(`  run: ${result.runId}`);
    }
    if (typeof result.eventCount === "number") {
      lines.push(`  events: ${result.eventCount}`);
    }
    if (result.errorCode || result.errorMessage) {
      lines.push(`  error: ${result.errorCode ?? "error"} ${result.errorMessage ?? ""}`.trim());
    }
    if (result.notes?.length) {
      lines.push(`  notes: ${result.notes.join("; ")}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export * from "./auth.js";
export * from "./cli-transport.js";
export * from "./sdk-transport.js";
