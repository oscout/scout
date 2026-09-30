import { describe, expect, test } from "bun:test";

import type { Block, SessionState } from "@openscout/agent-sessions";

import {
  agentNotificationForOperatorSignal,
  agentNotificationForSessionAttention,
  countDiffLines,
  notificationHostName,
  type AttentionNotificationItem,
} from "./agent-notification-builders.js";

function snapshotWith(block: Block, turn: Partial<SessionState["turns"][number]> = {}): SessionState {
  return {
    session: { id: "s1", name: "machiavelli", adapterType: "claude-code", status: "active", cwd: "/Users/art/dev/openscout" },
    turns: [{ id: "t1", status: "streaming", startedAt: 1_000, blocks: [{ block, status: "streaming" }], ...turn }],
  } as SessionState;
}

function item(kind: string, extra: Partial<AttentionNotificationItem> = {}): AttentionNotificationItem {
  return {
    id: `item-${kind}`,
    kind,
    title: "Approve Command",
    description: "Run the release script",
    sessionId: "s1",
    sessionName: "machiavelli",
    turnId: "t1",
    blockId: "b1",
    risk: "high",
    createdAt: 5_000,
    ...extra,
  };
}

const base = { id: "b1", turnId: "t1", index: 0, status: "streaming" } as const;

describe("agent notification builders", () => {
  test("a command awaiting approval becomes turn.approve.command with its cwd and risk", () => {
    const block = {
      ...base,
      type: "action",
      action: { kind: "command", command: "bash release.sh", status: "awaiting_approval", output: "", approval: { version: 1, risk: "high", description: "Ship the build" } },
    } as unknown as Block;
    const n = agentNotificationForSessionAttention({ item: item("approval"), snapshot: snapshotWith(block), host: "arts mini" });
    expect(n).toMatchObject({
      view: "turn.approve.command",
      command: "bash release.sh",
      cwd: "/Users/art/dev/openscout",
      risk: "high",
      why: "Ship the build",
      sender: { name: "machiavelli" },
      project: "openscout",
      host: "arts mini",
      urgent: true,
      route: { sessionId: "s1", turnId: "t1", blockId: "b1" },
    });
  });

  test("a file change counts its diff", () => {
    const block = {
      ...base,
      type: "action",
      action: { kind: "file_change", path: "src/a.ts", diff: "--- a\n+++ b\n+one\n+two\n-three\n context", status: "awaiting_approval", output: "" },
    } as unknown as Block;
    const n = agentNotificationForSessionAttention({ item: item("approval", { risk: "medium" }), snapshot: snapshotWith(block) });
    expect(n).toMatchObject({ view: "turn.approve.edit", risk: "medium", files: [{ path: "src/a.ts", added: 2, removed: 1 }] });
    expect(countDiffLines(undefined)).toEqual({ added: 0, removed: 0 });
  });

  test("a question with options is a choice; without options it is open", () => {
    const withOptions = { ...base, type: "question", question: "Which client?", header: "Embedding", options: [{ label: "In-process" }, { label: "XPC" }], multiSelect: false, questionStatus: "awaiting_answer" } as unknown as Block;
    expect(agentNotificationForSessionAttention({ item: item("question"), snapshot: snapshotWith(withOptions) })).toMatchObject({
      view: "turn.question.choice", question: "Which client?", options: ["In-process", "XPC"], context: "Embedding", urgent: true,
    });
    const open = { ...base, type: "question", question: "What should it be called?", options: [], multiSelect: false, questionStatus: "awaiting_answer" } as unknown as Block;
    expect(agentNotificationForSessionAttention({ item: item("question"), snapshot: snapshotWith(open) })).toMatchObject({
      view: "turn.question.open", question: "What should it be called?",
    });
  });

  test("a failed action is quiet and carries the tail of its output and the elapsed time", () => {
    const block = { ...base, type: "action", action: { kind: "command", command: "probe", status: "failed", output: "a\nb\nc\nd\ne\n" } } as unknown as Block;
    const n = agentNotificationForSessionAttention({
      item: item("failed_action", { description: "The operation timed out" }),
      snapshot: snapshotWith(block, { endedAt: 121_000 }),
    });
    expect(n).toMatchObject({ view: "turn.failed", error: "The operation timed out", excerpt: ["b", "c", "d", "e"], elapsed: "2m", urgent: false });
  });

  test("inferred attention is quiet text", () => {
    const n = agentNotificationForSessionAttention({ item: item("native_attention", { title: "Waiting", description: "Looks idle" }), snapshot: null });
    expect(n).toMatchObject({ view: "text", title: "Waiting", body: "Looks idle", urgent: false });
  });

  test("an operator need is an urgent ask with its question and options", () => {
    const n = agentNotificationForOperatorSignal({
      messageId: "msg-1",
      conversationId: "dm",
      signal: { kind: "need", blocking: true, replyExpectation: "required", question: "Deploy now?", options: ["Yes", "Wait"] },
      agentName: "cajun",
      agentId: "agent.cajun",
      body: "Full message body",
      createdAt: 1,
      host: "mini",
    });
    expect(n).toMatchObject({ view: "ask", note: "Deploy now?", options: ["Yes", "Wait"], urgent: true, sender: { name: "cajun", agentId: "agent.cajun" } });
  });

  test("a consult is a quiet ask; a notify is quiet text", () => {
    const consult = agentNotificationForOperatorSignal({
      messageId: "m", signal: { kind: "consult", blocking: false, replyExpectation: "optional", defaultAction: "keep going" },
      agentName: "a", body: "Thoughts?", createdAt: 1, host: "mini",
    });
    expect(consult).toMatchObject({ view: "ask", note: "Thoughts?", urgent: false });
    const notify = agentNotificationForOperatorSignal({
      messageId: "m", signal: { kind: "notify", blocking: false, replyExpectation: "none" },
      agentName: "a", body: "Done with the pass.", createdAt: 1, host: "mini",
    });
    expect(notify).toMatchObject({ view: "text", title: "Shared an update", body: "Done with the pass.", urgent: false });
  });

  test("host name drops .local", () => {
    expect(notificationHostName("arts-mini.local")).toBe("arts-mini");
  });
});
