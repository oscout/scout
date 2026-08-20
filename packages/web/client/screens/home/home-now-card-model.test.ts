import { describe, expect, test } from "bun:test";

import type { Agent, ObserveData } from "../../lib/types.ts";
import { homeNowCardHasDetail, homeNowCardLaneModel } from "./home-now-card-model.ts";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    definitionId: "agent-1",
    name: "codex.main",
    handle: null,
    agentClass: "general",
    state: "available",
    harness: "codex",
    project: "openscout",
    projectRoot: "/Users/dev/openscout",
    cwd: "/Users/dev/openscout",
    updatedAt: Date.now(),
    createdAt: null,
    transport: null,
    selector: null,
    defaultSelector: null,
    nodeQualifier: null,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    branch: null,
    role: null,
    model: null,
    harnessSessionId: null,
    terminalSurface: null,
    harnessLogPath: null,
    conversationId: null,
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

describe("homeNowCardLaneModel", () => {
  test("builds stats and pops from observe data", () => {
    const observeData: ObserveData = {
      events: [
        { kind: "tool", tool: "Read", arg: "packages/web/client/screens/home/content.tsx" },
        { kind: "tool", tool: "Grep", arg: "home-moving" },
      ],
      files: [{
        path: "packages/web/client/screens/home/content.tsx",
        state: "read",
      }],
    };
    const model = homeNowCardLaneModel(agent(), observeData, true, Date.now());
    expect(model.stats.tools).toBeGreaterThan(0);
    expect(model.pops.tools.rows.length).toBeGreaterThan(0);
    expect(model.harness).toBe("codex");
  });
});

describe("homeNowCardHasDetail", () => {
  test("true when tool stats exist", () => {
    expect(homeNowCardHasDetail({
      stats: { tools: 2, edits: 0, reads: 0, files: 0 },
      pops: {
        tools: { rows: [{ mark: "▸", tone: "tool", text: "grep" }], more: 0 },
        edits: { rows: [], more: 0 },
        reads: { rows: [], more: 0 },
        files: { rows: [], more: 0 },
      },
      context: null,
    } as ReturnType<typeof homeNowCardLaneModel>)).toBe(true);
  });
});
