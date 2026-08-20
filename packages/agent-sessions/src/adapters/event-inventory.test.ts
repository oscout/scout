import { describe, expect, test } from "bun:test";

import { claudeCodeEventInventoryAdapter } from "./claude-code/event-inventory.js";
import { codexEventInventoryAdapter } from "./codex/event-inventory.js";
import { grokAcpEventInventoryAdapter } from "./grok-acp/event-inventory.js";

const context = {
  filePath: "/tmp/session.jsonl",
  lineNumber: 1,
};

describe("adapter event inventory extraction", () => {
  test("maps Codex JSONL records into semantic buckets", () => {
    expect(codexEventInventoryAdapter.extract({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
      },
    }, context)).toEqual([
      expect.objectContaining({
        rawType: "response_item",
        rawSubtype: "custom_tool_call",
        semanticType: "file_edit",
        detail: "apply_patch",
      }),
    ]);

    expect(codexEventInventoryAdapter.extract({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text" }],
      },
    }, context)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rawType: "response_item",
        semanticType: "prompt",
      }),
      expect.objectContaining({
        rawType: "response_item:input_text",
        semanticType: "prompt",
      }),
    ]));
  });

  test("maps Claude Code transcript records into semantic buckets", () => {
    expect(claudeCodeEventInventoryAdapter.extract({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text" }],
      },
    }, context)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rawType: "user",
        semanticType: "prompt",
      }),
      expect.objectContaining({
        rawType: "user.content:text",
        semanticType: "prompt",
      }),
    ]));

    expect(claudeCodeEventInventoryAdapter.extract({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read" }],
      },
    }, context)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rawType: "assistant.content:tool_use",
        semanticType: "file_read",
        detail: "Read",
      }),
    ]));
  });

  test("maps Grok session files into semantic buckets", () => {
    expect(grokAcpEventInventoryAdapter.extract({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          kind: "read",
          rawInput: {},
          toolCallId: "call-1",
        },
      },
    }, context)).toEqual([
      expect.objectContaining({
        sourceKind: "grok-updates-jsonl",
        semanticType: "file_read",
        detail: "read",
      }),
    ]);

    expect(grokAcpEventInventoryAdapter.extract({
      type: "assistant",
      content: [],
      tool_calls: [{ name: "StrReplace" }],
    }, context)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rawType: "assistant",
        semanticType: "agent_response",
      }),
      expect.objectContaining({
        rawType: "assistant.tool_call",
        semanticType: "file_edit",
        detail: "StrReplace",
      }),
    ]));
  });
});
