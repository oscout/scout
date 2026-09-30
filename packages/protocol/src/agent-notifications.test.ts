import { describe, expect, test } from "bun:test";

import {
  agentNotificationActions,
  clampAgentNotification,
  collapseAgentNotification,
  type AgentNotification,
} from "./agent-notifications.js";

const base = {
  v: 1 as const,
  itemId: "item-1",
  sender: { name: "machiavelli", agentId: "agent.machiavelli" },
  project: "openscout",
  host: "arts mini",
  urgent: true,
  createdAt: 1,
};

describe("agent notifications", () => {
  test("a command approval collapses to who, where, and the command with its risk", () => {
    const n: AgentNotification = { ...base, view: "turn.approve.command", command: "bash apps/ios/scripts/release.sh", risk: "high" };
    expect(collapseAgentNotification(n)).toEqual({
      title: "machiavelli",
      subtitle: "openscout · arts mini",
      body: "Wants to run a command\nbash apps/ios/scripts/release.sh · High risk",
      headline: "Wants to run a command",
      category: "scout.approval",
      threadId: "scout.agent.agent.machiavelli",
    });
    expect(agentNotificationActions(n)).toEqual(["approve", "deny"]);
  });

  test("an edit approval sums the diff", () => {
    const n: AgentNotification = {
      ...base,
      view: "turn.approve.edit",
      risk: "medium",
      files: [{ path: "a.ts", added: 3, removed: 1 }, { path: "b.ts", added: 2, removed: 0 }],
    };
    expect(collapseAgentNotification(n).body).toBe("Wants to edit 2 files\n+5 −1 · a.ts, b.ts");
  });

  test("a choice question lists its options and takes a reply", () => {
    const n: AgentNotification = { ...base, view: "turn.question.choice", question: "Which client?", options: ["In-process", "XPC"] };
    const collapsed = collapseAgentNotification(n);
    expect(collapsed.body).toBe("Which client?\nIn-process · XPC");
    expect(collapsed.category).toBe("scout.question");
    expect(agentNotificationActions(n)).toEqual(["reply"]);
  });

  test("an ask outside a turn is a question too", () => {
    const n: AgentNotification = { ...base, view: "ask", note: "I need you to look at the deploy before I go further." };
    expect(collapseAgentNotification(n).category).toBe("scout.question");
    expect(collapseAgentNotification(n).body).toBe("Asked for you\nI need you to look at the deploy before I go further.");
  });

  test("where drops missing parts and the thread falls back to the sender name", () => {
    const n: AgentNotification = { ...base, sender: { name: "pike" }, project: undefined, urgent: false, view: "turn.failed", error: "the operation timed out" };
    const collapsed = collapseAgentNotification(n);
    expect(collapsed.subtitle).toBe("arts mini");
    expect(collapsed.threadId).toBe("scout.agent.pike");
    expect(collapsed.body).toBe("Turn failed: the operation timed out\nThe session is still open.");
  });

  test("work.done offers the link first only when an artifact has one", () => {
    const withLink: AgentNotification = { ...base, view: "work.done", summary: "Trimmed cache", artifacts: [{ kind: "pr", label: "PR", url: "https://x" }] };
    const without: AgentNotification = { ...base, view: "work.done", summary: "Trimmed cache" };
    expect(agentNotificationActions(withLink)).toEqual(["open_link", "open_chat"]);
    expect(agentNotificationActions(without)).toEqual(["open_chat"]);
    expect(collapseAgentNotification(without).body).toBe("Done: Trimmed cache");
  });

  test("clamp bounds long fields and lists", () => {
    const n: AgentNotification = {
      ...base,
      view: "turn.question.choice",
      question: "q".repeat(2000),
      options: Array.from({ length: 10 }, (_, i) => `option ${i}`),
    };
    const clamped = clampAgentNotification(n);
    if (clamped.view !== "turn.question.choice") throw new Error("view changed");
    expect(clamped.question.length).toBe(400);
    expect(clamped.question.endsWith("…")).toBe(true);
    expect(clamped.options).toHaveLength(6);
  });
});
