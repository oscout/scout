import { describe, expect, test } from "bun:test";

import { brokerInvocationRequestSchema } from "./broker-command-boundary-schemas.js";

const baseInvocation = {
  id: "inv-1",
  requesterId: "actor-a",
  requesterNodeId: "node-a",
  targetAgentId: "agent-b",
  action: "execute",
  task: "do the thing",
  ensureAwake: true,
  stream: false,
  createdAt: 1_700_000_000_000,
};

describe("brokerInvocationRequestSchema execution.turnBudgetMs", () => {
  test("accepts an execution turn budget up to the 6 h bound", () => {
    const parsed = brokerInvocationRequestSchema.safeParse({
      ...baseInvocation,
      execution: { turnBudgetMs: 6 * 60 * 60_000 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.execution?.turnBudgetMs).toBe(6 * 60 * 60_000);
    }
  });

  test("rejects a turn budget above 6 hours", () => {
    const parsed = brokerInvocationRequestSchema.safeParse({
      ...baseInvocation,
      execution: { turnBudgetMs: 6 * 60 * 60_000 + 1 },
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects non-positive and non-integer turn budgets", () => {
    for (const turnBudgetMs of [0, -1, 1.5]) {
      const parsed = brokerInvocationRequestSchema.safeParse({
        ...baseInvocation,
        execution: { turnBudgetMs },
      });
      expect(parsed.success).toBe(false);
    }
  });
});
