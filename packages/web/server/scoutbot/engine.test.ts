import { describe, expect, test } from "bun:test";

import {
  compareScoutbotEngines,
  createExternalScoutbotEngine,
  createNativeScoutbotEngine,
  type ScoutbotSituationInput,
} from "./engine.ts";

function makeInput(): ScoutbotSituationInput {
  const now = 2_000_000;
  return {
    request: {
      id: "req-scoutbot-compare",
      prompt: "what should I look at next?",
      createdAt: now,
    },
    generatedAt: now,
    currentDirectory: "/Users/arach/dev/openscout",
    currentRoute: { view: "ops", mode: "tail" },
    broker: {
      reachable: true,
      generatedAt: now - 1_000,
      counts: {
        agents: 4,
        flights: 2,
      },
    },
    attention: {
      since: now - 86_400_000,
      generatedAt: now - 2_000,
      brokerReachable: true,
      projects: [
        {
          projectRoot: "/Users/arach/dev/openscout",
          projectName: "openscout",
          status: "needs_attention",
          score: 70,
          reasons: ["work item waiting"],
          lastActivityAt: now - 10_000,
          git: {
            projectRoot: "/Users/arach/dev/openscout",
            branch: "codex/scoutbot-engine-comparison",
            upstream: "origin/main",
            ahead: 1,
            behind: 0,
            changedFiles: 2,
            stagedFiles: 0,
            unstagedFiles: 2,
            untrackedFiles: 0,
            hasChanges: true,
            lastCommitAt: now - 20_000,
            shortStatus: ["M packages/web/server/scoutbot/engine.ts"],
          },
          evidence: [
            {
              kind: "work_item",
              severity: "interrupt",
              id: "wrk-scoutbot",
              state: "waiting",
              summary: "Scoutbot engine comparison is waiting on operator review.",
              at: now - 10_000,
              agentId: "scoutbot",
              workId: "wrk-scoutbot",
            },
          ],
        },
      ],
    },
    worktrees: [
      {
        id: "wt-openscout",
        path: "/Users/arach/dev/openscout",
        projectName: "openscout",
        projectRoot: "/Users/arach/dev/openscout",
        branch: "codex/scoutbot-engine-comparison",
        upstream: "origin/main",
        ahead: 1,
        behind: 0,
        changedFiles: 2,
        stagedFiles: 0,
        unstagedFiles: 2,
        untrackedFiles: 0,
        hasChanges: true,
        lastCommitAt: now - 20_000,
        shortStatus: ["M packages/web/server/scoutbot/engine.ts"],
      },
    ],
    recentWork: [
      {
        id: "work-ios-tail",
        title: "Improve iOS mobile liveness and pairing",
        projectRoot: "/Users/arach/dev/openscout",
        status: "completed",
        summary: "PR checks passed, but operator review is still useful.",
        completedAt: now - 30_000,
        landedAt: null,
        source: "github",
        agentId: "codex",
      },
    ],
    allowedActions: ["review-worktree", "create-checkback", "ask-agent"],
    constraints: {
      enginesMayWrite: false,
      durableWritesRequireScoutBroker: true,
    },
  };
}

describe("Scoutbot engine contract", () => {
  test("native engine prioritizes recently completed unlanded work", async () => {
    const report = await createNativeScoutbotEngine().run(makeInput());

    expect(report.engineId).toBe("native");
    expect(report.headline).toContain("completed item");
    expect(report.confidence).toBe("high");
    expect(report.missingData).toEqual([]);
    expect(report.perspectives[0]?.kind).toBe("blocked_or_risky");
    expect(report.perspectives.some((perspective) => perspective.kind === "recent_unlanded")).toBe(true);
    expect(report.evidence.some((evidence) => evidence.kind === "recent_work")).toBe(true);
    expect(report.proposedActions).toContainEqual(expect.objectContaining({
      kind: "review-worktree",
      execution: "proposed",
      requiresBrokerWrite: false,
    }));
    expect(report.proposedActions).toContainEqual(expect.objectContaining({
      kind: "create-checkback",
      execution: "proposed",
      requiresBrokerWrite: true,
    }));
  });

  test("external engine wrapper preserves the Scout-owned output boundary", async () => {
    const engine = createExternalScoutbotEngine({
      id: "mastra",
      displayName: "Scoutbot Mastra",
      describe: () => ({
        summary: "Mastra candidate behind the Scoutbot engine seam.",
        capabilities: ["external-runtime", "workflows", "observability"],
      }),
      invoke: async (input) => ({
        engineId: "native",
        generatedAt: input.generatedAt,
        headline: "Mastra candidate report",
        summary: "A candidate external runtime response.",
        perspectives: [],
        evidence: [],
        proposedActions: [{
          id: "action.ask",
          kind: "ask-agent",
          label: "Ask an agent",
          rationale: "Candidate wants a durable ask.",
          execution: "proposed",
          requiresBrokerWrite: true,
          evidenceIds: [],
        }],
        missingData: [],
        confidence: "medium",
      }),
    });

    const capabilities = engine.describe();
    const report = await engine.run(makeInput());

    expect(capabilities.canExecuteDurableWrites).toBe(false);
    expect(report.engineId).toBe("mastra");
    expect(report.proposedActions[0]).toMatchObject({
      execution: "proposed",
      requiresBrokerWrite: true,
    });
  });

  test("comparison runner isolates failed engines", async () => {
    const comparison = await compareScoutbotEngines(makeInput(), [
      createNativeScoutbotEngine(),
      {
        id: "broken",
        displayName: "Broken Engine",
        describe: () => ({
          id: "broken",
          displayName: "Broken Engine",
          summary: "Always fails.",
          capabilities: ["external-runtime"],
          canExecuteDurableWrites: false,
        }),
        run: async () => {
          throw new Error("adapter unavailable");
        },
      },
    ]);

    expect(comparison.runs).toHaveLength(2);
    expect(comparison.runs.find((run) => run.engineId === "native")?.report?.engineId).toBe("native");
    expect(comparison.runs.find((run) => run.engineId === "broken")?.error).toBe("adapter unavailable");
  });
});
