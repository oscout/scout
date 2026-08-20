import { Agent } from "@cursor/sdk";

export const JSON_PREFIX = "__SCOUT_CURSOR_SPIKE_JSON__";

export function writeSpikeJson(value) {
  process.stdout.write(`${JSON_PREFIX}${JSON.stringify(value)}\n`);
}

export async function runCursorSdkTransportSpike(options) {
  const startedAt = Date.now();
  const notes = [];
  const useApiKey = options.mode !== "cursor_sdk_local_no_key";
  const apiKey = useApiKey ? options.apiKey : undefined;

  if (useApiKey && !apiKey) {
    return {
      mode: options.mode,
      ok: false,
      durationMs: Date.now() - startedAt,
      authSource: options.mode === "cursor_sdk_local_no_key" ? "none" : options.authSource,
      errorCode: "missing_api_key",
      errorMessage: "cursor_sdk_local requires CURSOR_API_KEY (env or ~/.cursor/api_key.env).",
      notes,
    };
  }

  const agentOptions = {
    ...(apiKey ? { apiKey } : {}),
    model: { id: options.modelId ?? "composer-2.5" },
    local: {
      cwd: options.cwd,
      settingSources: ["project", "user"],
    },
  };

  let agent;
  try {
    agent = options.resumeAgentId
      ? await Agent.resume(options.resumeAgentId, agentOptions)
      : await Agent.create(agentOptions);

    const run = await agent.send(options.prompt);
    let outputText = "";
    let eventCount = 0;

    for await (const event of run.stream()) {
      eventCount += 1;
      if (event.type !== "assistant") {
        continue;
      }
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          outputText += block.text;
        }
      }
    }

    const result = await run.wait();
    const normalized = outputText.trim() || (typeof result.result === "string" ? result.result.trim() : "");

    return {
      mode: options.mode,
      ok: result.status === "finished" && Boolean(normalized),
      durationMs: Date.now() - startedAt,
      authSource: options.mode === "cursor_sdk_local_no_key" ? "none" : options.authSource,
      agentId: agent.agentId,
      runId: result.id,
      outputText: normalized,
      eventCount,
      notes: [
        ...notes,
        `sdk_status=${result.status}`,
        options.resumeAgentId ? `resumed=${options.resumeAgentId}` : "created_new_agent",
      ],
    };
  } catch (error) {
    const sdkError = error;
    const cause = sdkError?.cause;
    return {
      mode: options.mode,
      ok: false,
      durationMs: Date.now() - startedAt,
      authSource: options.mode === "cursor_sdk_local_no_key" ? "none" : options.authSource,
      agentId: agent?.agentId,
      errorCode: cause?.code || sdkError.code || sdkError.name || "sdk_error",
      errorMessage: cause?.message || sdkError.message || String(error),
      notes: [
        ...notes,
        cause?.isRetryable === false || sdkError.isRetryable === false ? "not_retryable" : "retryable_unknown",
      ],
    };
  } finally {
    try {
      await agent?.[Symbol.asyncDispose]?.();
    } catch {
      // Ignore dispose failures after failed runs.
    }
  }
}

export async function runCursorSdkPersistentTurnSpike(input) {
  const turns = [];
  let agentId;

  for (const [index, prompt] of input.prompts.entries()) {
    const result = await runCursorSdkTransportSpike({
      mode: "cursor_sdk_local",
      cwd: input.cwd,
      prompt,
      apiKey: input.apiKey,
      authSource: input.authSource,
      resumeAgentId: agentId,
      modelId: input.modelId,
    });
    turns.push({
      ...result,
      notes: [...(result.notes ?? []), `turn=${index + 1}`],
    });
    if (!result.ok) {
      break;
    }
    agentId = result.agentId ?? agentId;
  }

  return { agentId, turns };
}
