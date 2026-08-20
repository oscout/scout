import { join } from "node:path";

import {
  arrayValue,
  extraction,
  recordValue,
  semanticForToolName,
  stringValue,
  type AdapterEventExtraction,
  type EventInventoryAdapter,
  type SemanticEventKind,
} from "../event-inventory.js";

function normalizedPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function semanticForGrokTool(toolName: string | undefined): SemanticEventKind {
  const name = toolName?.trim().toLowerCase();
  if (!name) return "tool_call";
  if (name === "search" || name === "glob" || name === "grep" || name === "read" || name === "read_file" || name === "list_dir") {
    return "file_read";
  }
  if (name === "strreplace" || name === "str_replace" || name === "edit") {
    return "file_edit";
  }
  return semanticForToolName(name);
}

function semanticForGrokEvent(type: string | undefined, toolName: string | undefined): SemanticEventKind {
  switch (type) {
    case "assistant":
      return "agent_response";
    case "user":
    case "system":
      return "prompt";
    case "reasoning":
      return "reasoning";
    case "tool_result":
      return "tool_result";
    case "turn_started":
    case "turn_completed":
    case "turn_ended":
    case "loop_started":
    case "phase_changed":
    case "first_token":
      return "turn";
    case "tool_started":
      return semanticForGrokTool(toolName);
    case "tool_completed":
      return "tool_result";
    case "permission_requested":
    case "permission_resolved":
      return "approval";
    case "mcp_config_resolved":
    case "mcp_managed_config_result":
    case "mcp_server_starting":
    case "mcp_server_connected":
    case "mcp_init_completed":
      return "metadata";
    case "error":
    case "tool_error":
      return "error";
    default:
      return toolName ? semanticForGrokTool(toolName) : "unknown";
  }
}

function toolLabelFromTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\s+/)[0]?.replace(/[`"'/:]/g, "") || undefined;
}

function extractGrokUpdate(record: Record<string, unknown>): AdapterEventExtraction[] {
  const method = stringValue(record.method);
  if (!method) return [];

  const params = recordValue(record.params);
  const update = recordValue(params?.update);
  const sessionUpdate = stringValue(update?.sessionUpdate);
  const updateKind = stringValue(update?.kind);
  const toolTitle = toolLabelFromTitle(stringValue(update?.title));
  const toolName = updateKind ?? toolTitle;
  const status = stringValue(update?.status);
  const rawType = sessionUpdate ? `${method}:${sessionUpdate}` : method;

  switch (sessionUpdate) {
    case "user_message_chunk":
      return [extraction("grok-updates-jsonl", rawType, "prompt", { detail: sessionUpdate, rawSubtype: sessionUpdate })];
    case "agent_message_chunk":
      return [extraction("grok-updates-jsonl", rawType, "agent_response", { detail: sessionUpdate, rawSubtype: sessionUpdate })];
    case "agent_thought_chunk":
      return [extraction("grok-updates-jsonl", rawType, "reasoning", { detail: sessionUpdate, rawSubtype: sessionUpdate })];
    case "tool_call":
    case "tool_call_update": {
      const hasRawOutput = Object.prototype.hasOwnProperty.call(update ?? {}, "rawOutput");
      const semantic = status === "completed" || hasRawOutput ? "tool_result" : semanticForGrokTool(toolName);
      return [extraction("grok-updates-jsonl", rawType, semantic, {
        detail: toolName ?? status ?? sessionUpdate,
        rawSubtype: sessionUpdate,
      })];
    }
    case "turn_completed":
      return [extraction("grok-updates-jsonl", rawType, "turn", {
        detail: stringValue(update?.stop_reason) ?? sessionUpdate,
        rawSubtype: sessionUpdate,
      })];
    default:
      return [extraction("grok-updates-jsonl", rawType, "metadata", {
        detail: sessionUpdate ?? method,
        rawSubtype: sessionUpdate,
      })];
  }
}

export const grokAcpEventInventoryAdapter: EventInventoryAdapter = {
  id: "grok-acp",
  label: "Grok ACP",
  defaultRoots(home) {
    return [
      join(home, ".grok", "sessions"),
      join(home, ".scout", "pairing", "grok-acp"),
    ];
  },
  matchesFile(filePath) {
    const path = normalizedPath(filePath);
    return path.includes("/.grok/") || path.includes("/.scout/pairing/grok");
  },
  extract(record, context) {
    const type = stringValue(record.type) ?? stringValue(record.event);
    const message = recordValue(record.message);
    const role = stringValue(record.role) ?? stringValue(message?.role);
    const toolName = stringValue(record.tool_name) ?? stringValue(record.toolName) ?? stringValue(record.name);
    const path = normalizedPath(context.filePath);

    if (path.endsWith("/hunk_records.jsonl")) {
      return [extraction("grok-hunks-jsonl", stringValue(record.eventType) ?? "hunk_record", "file_edit", { detail: "hunk_record" })];
    }
    if (path.endsWith("/rewind_points.jsonl")) {
      return [extraction("grok-rewind-jsonl", "rewind_point", "metadata", { detail: "rewind_point" })];
    }
    if (stringValue(record.prompt)) {
      return [extraction("grok-prompt-history-jsonl", "prompt_history", "prompt", {
        detail: record.is_bash === true ? "bash_prompt" : "prompt",
      })];
    }
    if (stringValue(record.method)) {
      return extractGrokUpdate(record);
    }
    if (role === "user") {
      return [extraction("grok-jsonl", type ?? "message", "prompt", { detail: role, rawSubtype: role })];
    }
    if (role === "assistant") {
      return [extraction("grok-jsonl", type ?? "message", "agent_response", { detail: role, rawSubtype: role })];
    }

    const entries = [
      extraction("grok-jsonl", type, semanticForGrokEvent(type, toolName), {
        detail: toolName ?? stringValue(record.phase) ?? stringValue(record.status) ?? type,
        rawSubtype: stringValue(record.status),
      }),
    ];

    if (type === "assistant") {
      for (const call of arrayValue(record.tool_calls)) {
        const callRecord = recordValue(call);
        const callName = stringValue(callRecord?.name) ?? stringValue(recordValue(callRecord?.function)?.name);
        entries.push(extraction("grok-jsonl", "assistant.tool_call", semanticForGrokTool(callName), {
          detail: callName,
          rawSubtype: "tool_call",
        }));
      }
    }

    return entries;
  },
};
