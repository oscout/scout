import { describe, expect, test } from "bun:test";

import type { SessionAttentionItem } from "@openscout/runtime";

import {
  applyAgentAttention,
  buildAgentAttentionIndex,
} from "./core/attention/agent-attention.ts";
import type { WebAgent } from "./db/types/web.ts";

function sessionItem(overrides: Partial<SessionAttentionItem>): SessionAttentionItem {
  return {
    id: "session-question:sess-1:turn-1:block-1",
    kind: "question",
    title: "Session needs input",
    summary: "Should I drop the index before migrating?",
    detail: null,
    sessionId: "sess-1",
    sessionName: "claude — openscout",
    adapterType: "claude",
    turnId: "turn-1",
    blockId: "block-1",
    version: null,
    updatedAt: 1_000,
    severity: "warning",
    sourceLabel: "claude question",
    ...overrides,
  };
}

function webAgent(overrides: Partial<WebAgent>): WebAgent {
  return {
    id: "agent-1",
    definitionId: "agent-1",
    name: "Scout",
    handle: null,
    agentClass: "session",
    harness: "claude",
    state: "working",
    projectRoot: null,
    cwd: null,
    updatedAt: null,
    createdAt: null,
    transport: null,
    selector: null,
    defaultSelector: null,
    nodeQualifier: null,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    project: null,
    branch: null,
    role: null,
    model: null,
    harnessSessionId: null,
    terminalSurface: null,
    harnessLogPath: null,
    conversationId: null,
    authorityNodeId: null,
    authorityNodeName: null,
    homeNodeId: null,
    homeNodeName: null,
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
    ...overrides,
  };
}

describe("buildAgentAttentionIndex", () => {
  test("joins a session question to its agent and carries the question text", () => {
    const index = buildAgentAttentionIndex({
      sessionItems: [sessionItem({})],
      agentIdBySessionId: new Map([["sess-1", "agent-1"]]),
      collaborationRows: [],
    });
    expect(index.get("agent-1")?.ask).toBe("Should I drop the index before migrating?");
  });

  test("approval asks read as title — summary", () => {
    const index = buildAgentAttentionIndex({
      sessionItems: [
        sessionItem({
          kind: "approval",
          title: "Run terminal command",
          summary: "rm -rf dist && vite build",
        }),
      ],
      agentIdBySessionId: new Map([["sess-1", "agent-1"]]),
      collaborationRows: [],
    });
    expect(index.get("agent-1")?.ask).toBe("Run terminal command — rm -rf dist && vite build");
  });

  test("diagnostic kinds do not flip agents into needs_attention", () => {
    const index = buildAgentAttentionIndex({
      sessionItems: [
        sessionItem({ kind: "failed_turn" }),
        sessionItem({ kind: "failed_action", blockId: "block-2" }),
        sessionItem({ kind: "session_error", blockId: "block-3" }),
      ],
      agentIdBySessionId: new Map([["sess-1", "agent-1"]]),
      collaborationRows: [],
    });
    expect(index.size).toBe(0);
  });

  test("sessions without a matching agent are ignored", () => {
    const index = buildAgentAttentionIndex({
      sessionItems: [sessionItem({ sessionId: "unknown-session" })],
      agentIdBySessionId: new Map([["sess-1", "agent-1"]]),
      collaborationRows: [],
    });
    expect(index.size).toBe(0);
  });

  test("collaboration rows index by owning agent, newest entry wins", () => {
    const index = buildAgentAttentionIndex({
      sessionItems: [sessionItem({ updatedAt: 1_000 })],
      agentIdBySessionId: new Map([["sess-1", "agent-1"]]),
      collaborationRows: [
        { agentId: "agent-1", title: "Review the migration plan", summary: null, updatedAt: 2_000 },
        { agentId: null, title: "Orphan row", summary: null, updatedAt: 9_000 },
      ],
    });
    expect(index.get("agent-1")?.ask).toBe("Review the migration plan");
  });

  test("host prompts index directly by owning agent", () => {
    const index = buildAgentAttentionIndex({
      sessionItems: [],
      agentIdBySessionId: new Map(),
      collaborationRows: [],
      hostRows: [{
        agentId: "agent-1",
        summary: "Permission rule Bash(curl:*) requires confirmation.",
        updatedAt: 3_000,
      }],
    });

    expect(index.get("agent-1")).toEqual({
      ask: "Permission rule Bash(curl:*) requires confirmation.",
      updatedAt: 3_000,
    });
  });

  test("a collaboration row with no title or summary raises no attention", () => {
    const index = buildAgentAttentionIndex({
      sessionItems: [],
      agentIdBySessionId: new Map(),
      collaborationRows: [{
        agentId: "agent-1",
        title: "   ",
        summary: null,
        updatedAt: 2_000,
      }],
    });

    // Reported from iOS: a "needs you" card naming no question, whose
    // conversation had no message behind it. An alert the operator cannot act
    // on is worse than no alert.
    expect(index.has("agent-1")).toBe(false);
  });

  test("a contentless row does not evict a real ask that arrived earlier", () => {
    const index = buildAgentAttentionIndex({
      sessionItems: [sessionItem({ updatedAt: 1_000 })],
      agentIdBySessionId: new Map([["sess-1", "agent-1"]]),
      // Newer, so it wins the recency check — and would blank the question the
      // operator still owes an answer to if empty entries were admitted.
      collaborationRows: [{
        agentId: "agent-1",
        title: "",
        summary: "   ",
        updatedAt: 9_000,
      }],
    });

    expect(index.get("agent-1")).toEqual({
      ask: "Should I drop the index before migrating?",
      updatedAt: 1_000,
    });
  });

  test("a session item with neither summary nor title raises no attention", () => {
    const index = buildAgentAttentionIndex({
      sessionItems: [sessionItem({ title: "", summary: null })],
      agentIdBySessionId: new Map([["sess-1", "agent-1"]]),
      collaborationRows: [],
    });

    expect(index.has("agent-1")).toBe(false);
  });
});

describe("applyAgentAttention", () => {
  test("attention outranks working and carries pendingAsk", () => {
    const decorated = applyAgentAttention(
      [webAgent({ state: "working" }), webAgent({ id: "agent-2", state: "available" })],
      new Map([["agent-1", { ask: "Should I proceed?", updatedAt: 1_000 }]]),
    );
    expect(decorated[0]?.state).toBe("needs_attention");
    expect(decorated[0]?.pendingAsk).toBe("Should I proceed?");
    expect(decorated[1]?.state).toBe("available");
    expect(decorated[1]?.pendingAsk).toBeUndefined();
  });

  test("empty index returns agents untouched", () => {
    const agents = [webAgent({})];
    expect(applyAgentAttention(agents, new Map())).toBe(agents);
  });
});
