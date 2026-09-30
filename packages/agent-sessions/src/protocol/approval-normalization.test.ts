import { describe, expect, test } from "bun:test";

import { extractPendingApprovalRequests, normalizeApprovalRequest } from "./approval-normalization.ts";
import type { SessionState } from "../state.ts";

describe("normalizeApprovalRequest", () => {
  test("uses approval description when present", () => {
    const approval = normalizeApprovalRequest(
      {
        id: "session-1",
        name: "Claude Code",
        adapterType: "claude-code",
        status: "active",
      },
      "turn-1",
      {
        id: "block-1",
        turnId: "turn-1",
        type: "action",
        status: "streaming",
        index: 0,
        action: {
          kind: "command",
          status: "awaiting_approval",
          output: "",
          command: "rm -rf /tmp/build",
          approval: {
            version: 3,
            description: "Allow deleting the temporary build directory?",
            risk: "high",
          },
        },
      },
    );

    expect(approval).toEqual({
      sessionId: "session-1",
      sessionName: "Claude Code",
      adapterType: "claude-code",
      turnId: "turn-1",
      blockId: "block-1",
      version: 3,
      risk: "high",
      title: "Approve Command",
      description: "Allow deleting the temporary build directory?",
      detail: "rm -rf /tmp/build",
      actionKind: "command",
      actionStatus: "awaiting_approval",
    });
  });

  test("falls back to action detail when description is absent", () => {
    const approval = normalizeApprovalRequest(
      {
        id: "session-2",
        name: "Codex",
        adapterType: "codex",
        status: "active",
      },
      "turn-2",
      {
        id: "block-2",
        turnId: "turn-2",
        type: "action",
        status: "streaming",
        index: 1,
        action: {
          kind: "tool_call",
          status: "awaiting_approval",
          output: "",
          toolName: "Bash",
          toolCallId: "call-1",
          approval: {
            version: 1,
          },
        },
      },
    );

    expect(approval?.title).toBe("Approve Tool Call");
    expect(approval?.description).toBe("Bash");
    expect(approval?.detail).toBe("Bash");
    expect(approval?.risk).toBe("medium");
  });
});

describe("extractPendingApprovalRequests", () => {
  test("returns only awaiting approval action blocks", () => {
    const snapshot: SessionState = {
      session: {
        id: "session-1",
        name: "Scout Pairing",
        adapterType: "echo",
        status: "active",
      },
      turns: [
        {
          id: "turn-1",
          status: "streaming",
          startedAt: 1720000000000,
          blocks: [
            {
              status: "streaming",
              block: {
                id: "text-1",
                turnId: "turn-1",
                type: "text",
                status: "streaming",
                index: 0,
                text: "Thinking…",
              },
            },
            {
              status: "streaming",
              block: {
                id: "action-1",
                turnId: "turn-1",
                type: "action",
                status: "streaming",
                index: 1,
                action: {
                  kind: "subagent",
                  status: "awaiting_approval",
                  output: "",
                  agentId: "hudson",
                  approval: {
                    version: 2,
                    risk: "low",
                  },
                },
              },
            },
          ],
        },
      ],
      currentTurnId: "turn-1",
    };

    expect(extractPendingApprovalRequests(snapshot)).toHaveLength(1);
    expect(extractPendingApprovalRequests(snapshot)[0]).toMatchObject({ description: "hudson", turnId: "turn-1", turnStartedAt: 1720000000000, version: 2 });
    // Unknown source timing must remain unknown, never become the current clock.
    snapshot.turns[0]!.startedAt = Number.NaN;
    expect(extractPendingApprovalRequests(snapshot)[0]).not.toHaveProperty("turnStartedAt");
    snapshot.turns[0]!.startedAt = -1;
    expect(extractPendingApprovalRequests(snapshot)[0]).not.toHaveProperty("turnStartedAt");
  });
});
