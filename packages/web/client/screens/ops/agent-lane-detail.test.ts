import { describe, expect, test } from "bun:test";

import type { Agent, ObserveData, PlanDocument } from "../../lib/types.ts";
import {
  buildLaneSessionStats,
  buildLaneTouchedFiles,
  docExcerpt,
  laneProjectPath,
  relatedLaneDocs,
  relatedLanePlans,
  relatedLaneSessionDocuments,
  scorePlanForLane,
} from "./agent-lane-detail.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "Grok 0f8eddbb",
    harness: "grok",
    project: "openscout",
    state: "in_flight",
    agentClass: "organic",
    ...overrides,
  } as Agent;
}

function makeLane(observe: ObserveData | null, overrides: Partial<AgentLane> = {}): AgentLane {
  return {
    id: "lane-1",
    agent: makeAgent(),
    source: "native",
    observe,
    lastActiveAt: Date.now(),
    current: true,
    ...overrides,
  };
}

function makePlanDocument(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    id: "plan-a",
    title: "Agent lanes rollout",
    summary: "Lane sheet and stats",
    source: "openscout",
    documentKind: "openscout_plan",
    status: "active",
    confidence: "native",
    path: "docs/agent-lanes-plan.md",
    workspacePath: "/Users/art/dev/openscout",
    workspaceName: "openscout",
    agentId: null,
    agentName: null,
    tags: ["lanes"],
    body: "ship lane sheet",
    rawText: "ship lane sheet",
    steps: [{ id: "s1", order: 0, text: "Add inspect sheet", status: "in_progress", rawMarker: ">" }],
    createdAt: 1,
    updatedAt: 2,
    provenance: { root: "/Users/art/dev/openscout", rootKind: "workspace", relativePath: "docs/agent-lanes-plan.md" },
    ...overrides,
  };
}

describe("buildLaneSessionStats", () => {
  test("aggregates session activity and metadata", () => {
    const lane = makeLane({
      events: [
        { id: "tool-read", t: 1, kind: "tool", text: "", tool: "read", arg: "README.md" },
        { id: "tool-edit", t: 2, kind: "tool", text: "", tool: "edit", arg: "router.ts" },
        { id: "think", t: 3, kind: "think", text: "plan next step" },
      ],
      files: [
        { path: "README.md", state: "read", touches: 1, lastT: 1 },
        { path: "router.ts", state: "modified", touches: 1, lastT: 2 },
      ],
      metadata: {
        session: {
          model: "grok-3",
          gitBranch: "main",
          cwd: "/Users/art/dev/openscout",
          externalSessionId: "sess-abc",
        },
        usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
      },
    });

    const stats = buildLaneSessionStats(lane);
    expect(stats.tools).toBe(2);
    expect(stats.edits).toBe(1);
    expect(stats.reads).toBe(1);
    expect(stats.thinks).toBe(1);
    expect(stats.files).toBe(2);
    expect(stats.events).toBe(3);
    expect(stats.model).toBe("grok-3");
    expect(stats.branch).toBe("main");
    expect(stats.harness).toBe("grok");
    expect(stats.cwd).toBe("/Users/art/dev/openscout");
    expect(stats.sessionId).toBe("sess-abc");
    expect(stats.usage?.totalTokens).toBe(1540);
  });

  test("uses one observed project path for both pin state and mutation", () => {
    const lane = makeLane({
      events: [],
      files: [],
      metadata: { session: { cwd: "/work/observed" } },
    }, {
      agent: makeAgent({ cwd: "/work/agent", projectRoot: "/work/root" }),
      facts: {
        cwd: "/work/event-derived",
        touchedFiles: [],
        turn: { phase: "idle" },
      },
    });

    expect(laneProjectPath(lane)).toBe("/work/observed");
  });
});

describe("buildLaneTouchedFiles", () => {
  test("prioritizes changed files and caps the list", () => {
    const observe: ObserveData = {
      events: [],
      files: [
        { path: "a.ts", state: "read", touches: 2, lastT: 1 },
        { path: "b.ts", state: "modified", touches: 1, lastT: 2 },
        { path: "c.ts", state: "created", touches: 1, lastT: 3 },
      ],
    };

    const files = buildLaneTouchedFiles(observe, 2);
    expect(files.map((file) => file.path)).toEqual(["c.ts", "b.ts"]);
  });

  test("drops mis-recorded bash tokens and dedupes duplicate paths", () => {
    const observe: ObserveData = {
      events: [],
      files: [
        { path: "necho", state: "read", touches: 1, lastT: 1 },
        { path: "nCHROME=", state: "read", touches: 1, lastT: 2 },
        { path: "Google", state: "read", touches: 1, lastT: 3 },
        { path: "run.sh", state: "read", touches: 1, lastT: 4 },
        { path: "run.sh", state: "read", touches: 1, lastT: 6 },
        { path: "line_strip.png", state: "read", touches: 1, lastT: 5 },
      ],
    };

    const files = buildLaneTouchedFiles(observe);
    expect(files.map((file) => file.path).sort()).toEqual([
      "line_strip.png",
      "run.sh",
    ]);
  });
});

describe("docExcerpt", () => {
  test("prefers summary and truncates long text", () => {
    const document = makePlanDocument({
      summary: "Short summary for the lane sheet.",
      body: "x".repeat(400),
    });
    expect(docExcerpt(document)).toBe("Short summary for the lane sheet.");
    expect(docExcerpt(makePlanDocument({ summary: null, body: "x".repeat(300) })).endsWith("…")).toBe(true);
  });
});

describe("relatedLanePlans", () => {
  test("ranks plans that match lane project and touched files", () => {
    const lane = makeLane({
      events: [
        { id: "tool", t: 2, kind: "tool", text: "", tool: "edit", arg: "docs/agent-lanes-plan.md" },
      ],
      files: [{ path: "docs/agent-lanes-plan.md", state: "modified", touches: 1, lastT: 2 }],
    });

    const documents: PlanDocument[] = [
      makePlanDocument(),
      makePlanDocument({
        id: "plan-b",
        title: "Unrelated billing work",
        path: "docs/billing.md",
        steps: [],
        body: "",
        rawText: "",
        provenance: { root: "/tmp", rootKind: "home", relativePath: "docs/billing.md" },
      }),
    ];

    expect(scorePlanForLane(documents[0]!, lane)).toBeGreaterThan(scorePlanForLane(documents[1]!, lane));
    expect(relatedLanePlans(documents, lane).map((plan) => plan.id)).toEqual(["plan-a"]);
  });
});

describe("relatedLaneDocs", () => {
  test("returns step-free documents with a match score", () => {
    const lane = makeLane({
      events: [
        { id: "tool", t: 2, kind: "tool", text: "", tool: "read", arg: "docs/architecture.md" },
      ],
      files: [{ path: "docs/architecture.md", state: "read", touches: 1, lastT: 2 }],
    });

    const documents: PlanDocument[] = [
      makePlanDocument({
        id: "doc-a",
        title: "Architecture notes",
        path: "docs/architecture.md",
        steps: [],
      }),
      makePlanDocument({ id: "plan-a", steps: [{ id: "s1", order: 0, text: "step", status: "pending", rawMarker: "-" }] }),
    ];

    expect(relatedLaneDocs(documents, lane).map((doc) => doc.id)).toEqual(["doc-a"]);
  });
});

describe("relatedLaneSessionDocuments", () => {
  test("splits ranked plans and docs", () => {
    const lane = makeLane({
      events: [
        { id: "tool", t: 2, kind: "tool", text: "", tool: "edit", arg: "docs/agent-lanes-plan.md" },
      ],
      files: [{ path: "docs/agent-lanes-plan.md", state: "modified", touches: 1, lastT: 2 }],
    });

    const documents: PlanDocument[] = [
      makePlanDocument(),
      makePlanDocument({
        id: "doc-a",
        title: "Agent lanes notes",
        path: "docs/agent-lanes-plan.md",
        steps: [],
      }),
    ];

    const related = relatedLaneSessionDocuments(documents, lane);
    expect(related.plans.map((plan) => plan.id)).toEqual(["plan-a"]);
    expect(related.docs.map((doc) => doc.id)).toEqual(["doc-a"]);
  });
});
