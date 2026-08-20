import { join } from "node:path";

import {
  arrayValue,
  extraction,
  lower,
  recordValue,
  semanticForToolName,
  stringValue,
  type AdapterEventExtraction,
  type EventInventoryAdapter,
  type SemanticEventKind,
} from "../event-inventory.js";

const CODEX_ADAPTER_ID = "codex";

function normalizedPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function semanticForCodexItemType(itemType: string | undefined): SemanticEventKind {
  switch (itemType) {
    case "userMessage":
      return "prompt";
    case "agentMessage":
      return "agent_response";
    case "reasoning":
      return "reasoning";
    case "commandExecution":
      return "command";
    case "fileChange":
      return "file_edit";
    case "subagent":
      return "subagent";
    case "webSearch":
      return "web";
    default:
      return itemType ? "tool_call" : "unknown";
  }
}

function semanticForCodexRecordType(type: string | undefined, role: string | undefined): SemanticEventKind {
  switch (type) {
    case "session_meta":
      return "session";
    case "turn_context":
      return "metadata";
    case "event_msg":
      return "metadata";
    case "compacted":
      return "metadata";
    case "response_item":
      break;
    default:
      return "unknown";
  }

  switch (role) {
    case "assistant":
      return "agent_response";
    case "user":
    case "developer":
    case "system":
      return "prompt";
    default:
      return "unknown";
  }
}

function semanticForCodexPayloadType(payloadType: string | undefined): SemanticEventKind {
  switch (payloadType) {
    case "message":
      return "agent_response";
    case "reasoning":
      return "reasoning";
    case "function_call":
    case "custom_tool_call":
      return "tool_call";
    case "function_call_output":
    case "custom_tool_call_output":
    case "tool_search_output":
    case "mcp_tool_call_end":
      return "tool_result";
    case "web_search_call":
    case "web_search_end":
      return "web";
    case "tool_search_call":
    case "mcp_tool_call_begin":
      return "tool_call";
    case "agent_message":
      return "agent_response";
    case "user_message":
    case "input_text":
    case "input_image":
      return "prompt";
    case "token_count":
      return "usage";
    case "task_started":
    case "task_complete":
      return "turn";
    case "exec_command_begin":
    case "exec_command_end":
      return "command";
    case "patch_apply_begin":
    case "patch_apply_end":
      return "file_edit";
    case "view_image_tool_call":
      return "file_read";
    case "compacted":
    case "context_compacted":
    case "thread_name_updated":
    case "turn_aborted":
      return "metadata";
    default:
      return payloadType ? "metadata" : "unknown";
  }
}

function extractFromAppServer(record: Record<string, unknown>): AdapterEventExtraction[] {
  const method = stringValue(record.method);
  if (!method) return [];

  const params = recordValue(record.params);
  const item = recordValue(params?.item);
  const itemType = stringValue(item?.type);
  const toolName = stringValue(item?.name) ?? stringValue(item?.toolName) ?? stringValue(params?.toolName);
  const entries: AdapterEventExtraction[] = [];
  const detail = toolName ?? itemType;

  if (method.startsWith("thread/")) {
    entries.push(extraction("codex-app-server", method, "session", { detail }));
  } else if (method.startsWith("turn/")) {
    entries.push(extraction("codex-app-server", method, "turn", { detail }));
  } else if (method === "item/started" || method === "item/completed") {
    entries.push(extraction("codex-app-server", method, semanticForCodexItemType(itemType), {
      detail,
      rawSubtype: itemType,
    }));
  } else if (method.startsWith("item/agentMessage/")) {
    entries.push(extraction("codex-app-server", method, "agent_response"));
  } else if (method.startsWith("item/reasoning/")) {
    entries.push(extraction("codex-app-server", method, "reasoning"));
  } else if (method.startsWith("item/commandExecution/")) {
    entries.push(extraction("codex-app-server", method, "command", { detail }));
  } else if (method.startsWith("item/fileChange/")) {
    entries.push(extraction("codex-app-server", method, "file_edit", { detail }));
  } else if (method.startsWith("item/toolCall/")) {
    entries.push(extraction("codex-app-server", method, "tool_result", { detail }));
  } else if (method.startsWith("mcpServer/") || method.startsWith("remoteControl/")) {
    entries.push(extraction("codex-app-server", method, "metadata", { detail }));
  } else if (method === "error") {
    entries.push(extraction("codex-app-server", method, "error", { detail }));
  } else {
    entries.push(extraction("codex-app-server", method, "unknown", { detail }));
  }

  return entries;
}

function extractContentParts(
  sourceKind: string,
  rawPrefix: string,
  content: unknown,
): AdapterEventExtraction[] {
  return arrayValue(content)
    .map((part) => recordValue(part))
    .filter((part): part is Record<string, unknown> => Boolean(part))
    .map((part) => {
      const contentType = stringValue(part.type);
      const toolName = stringValue(part.name);
      const semantic = contentType === "text" || contentType === "output_text"
        ? "agent_response"
        : contentType === "input_text" || contentType === "input_image"
          ? "prompt"
        : contentType === "reasoning" || contentType === "thinking"
          ? "reasoning"
          : contentType === "tool_use" || contentType === "function_call"
            ? semanticForToolName(toolName)
            : "unknown";
      return extraction(sourceKind, `${rawPrefix}:${contentType ?? "unknown"}`, semantic, {
        detail: toolName ?? contentType,
        rawSubtype: contentType,
      });
    });
}

function extractFromCodexJsonl(record: Record<string, unknown>): AdapterEventExtraction[] {
  const type = stringValue(record.type);
  if (!type) return [];

  const payload = recordValue(record.payload);
  const payloadType = stringValue(payload?.type);
  const payloadRole = stringValue(payload?.role);
  const payloadName = stringValue(payload?.name);
  const eventType = payloadType ?? type;
  const entries: AdapterEventExtraction[] = [];

  if (type === "response_item") {
    const semantic = payloadType === "function_call" || payloadType === "custom_tool_call"
      ? semanticForToolName(payloadName)
      : payloadType === "message"
        ? semanticForCodexRecordType(type, payloadRole)
        : semanticForCodexPayloadType(payloadType);
    entries.push(extraction("codex-jsonl", type, semantic, {
      detail: payloadName ?? payloadRole ?? payloadType,
      rawSubtype: payloadType,
    }));
    entries.push(...extractContentParts("codex-jsonl", type, payload?.content));
    return entries;
  }

  if (type === "event_msg") {
    entries.push(extraction("codex-jsonl", type, semanticForCodexPayloadType(payloadType), {
      detail: payloadName ?? payloadType,
      rawSubtype: payloadType,
    }));
    return entries;
  }

  entries.push(extraction("codex-jsonl", type, semanticForCodexRecordType(type, payloadRole), {
    detail: payloadName ?? payloadRole ?? eventType,
    rawSubtype: payloadType,
  }));
  return entries;
}

export const codexEventInventoryAdapter: EventInventoryAdapter = {
  id: CODEX_ADAPTER_ID,
  label: "Codex",
  defaultRoots(home) {
    return [
      join(home, ".codex", "sessions"),
      join(home, ".codex", "archived_sessions"),
      join(home, ".openai-codex", "sessions"),
      join(home, ".scout", "pairing", "codex"),
    ];
  },
  matchesFile(filePath) {
    const path = normalizedPath(filePath);
    return path.includes("/.codex/")
      || path.includes("/.openai-codex/")
      || path.includes("/.scout/pairing/codex/");
  },
  extract(record) {
    const appServerEntries = extractFromAppServer(record);
    if (appServerEntries.length > 0) {
      return appServerEntries;
    }

    const type = stringValue(record.type);
    if (type && (lower(type).includes("codex") || recordValue(record.payload))) {
      return extractFromCodexJsonl(record);
    }

    return extractFromCodexJsonl(record);
  },
};
