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

function semanticForClaudeType(type: string | undefined): SemanticEventKind {
  switch (type) {
    case "system":
      return "session";
    case "user":
      return "prompt";
    case "assistant":
      return "agent_response";
    case "tool_use":
      return "tool_call";
    case "tool_result":
      return "tool_result";
    case "stream_event":
      return "metadata";
    case "rate_limit_event":
    case "rate_limits.updated":
    case "rate_limit":
    case "quota_event":
    case "usage_limit_event":
      return "usage";
    case "result":
      return "turn";
    case "error":
      return "error";
    case "attachment":
    case "ai-title":
    case "last-prompt":
    case "mode":
    case "permission-mode":
    case "file-history-snapshot":
    case "queue-operation":
    case "agent-name":
    case "pr-link":
      return "metadata";
    default:
      return "unknown";
  }
}

function contentSemantic(recordType: string, contentType: string | undefined, toolName: string | undefined): SemanticEventKind {
  switch (contentType) {
    case "text":
      return recordType === "user" ? "prompt" : "agent_response";
    case "image":
      return "prompt";
    case "thinking":
    case "reasoning":
      return "reasoning";
    case "tool_use":
      return semanticForToolName(toolName);
    case "tool_result":
      return "tool_result";
    default:
      return "unknown";
  }
}

function extractMessageContent(recordType: string, message: Record<string, unknown> | undefined): AdapterEventExtraction[] {
  return arrayValue(message?.content)
    .map((part) => recordValue(part))
    .filter((part): part is Record<string, unknown> => Boolean(part))
    .map((part) => {
      const contentType = stringValue(part.type);
      const toolName = stringValue(part.name);
      return extraction("claude-jsonl", `${recordType}.content:${contentType ?? "unknown"}`, contentSemantic(recordType, contentType, toolName), {
        detail: toolName ?? contentType,
        rawSubtype: contentType,
      });
    });
}

function extractStreamEvent(record: Record<string, unknown>): AdapterEventExtraction[] {
  const streamEvent = recordValue(record.event);
  const streamType = stringValue(streamEvent?.type);
  const contentBlock = recordValue(streamEvent?.content_block);
  const delta = recordValue(streamEvent?.delta);
  const contentType = stringValue(contentBlock?.type) ?? stringValue(delta?.type);
  const semantic = contentType === "text" || contentType === "text_delta"
    ? "agent_response"
    : contentType === "thinking" || contentType === "thinking_delta"
      ? "reasoning"
      : "metadata";
  return [
    extraction("claude-jsonl", "stream_event", semantic, {
      detail: contentType ?? streamType,
      rawSubtype: streamType,
    }),
  ];
}

export const claudeCodeEventInventoryAdapter: EventInventoryAdapter = {
  id: "claude-code",
  label: "Claude Code",
  defaultRoots(home) {
    return [
      join(home, ".claude", "projects"),
      join(home, ".claude", "history.jsonl"),
      join(home, ".scout", "pairing", "claude"),
    ];
  },
  matchesFile(filePath) {
    const path = normalizedPath(filePath);
    return path.includes("/.claude/") || path.includes("/.scout/pairing/claude/");
  },
  extract(record) {
    const type = stringValue(record.type);
    if (!type) return [];

    if (type === "stream_event") {
      return extractStreamEvent(record);
    }

    const message = recordValue(record.message);
    const role = stringValue(message?.role);
    const attachment = recordValue(record.attachment);
    const attachmentType = stringValue(attachment?.type);
    const subtype = stringValue(record.subtype) ?? role ?? attachmentType;
    const entries: AdapterEventExtraction[] = [
      extraction("claude-jsonl", type, semanticForClaudeType(type), {
        detail: subtype,
        rawSubtype: subtype,
      }),
    ];

    entries.push(...extractMessageContent(type, message));

    return entries;
  },
};
