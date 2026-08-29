import { describe, expect, test } from "bun:test";
import type { Agent } from "../../lib/types.ts";
import {
  isLaneSyntheticAgent,
  laneProfileRoute,
  laneSessionRoute,
  laneTraceRoute,
} from "./agent-lane-navigation.ts";
import type { AgentLane } from "./agent-lanes-model.ts";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "scope.main",
    definitionId: "scope",
    name: "scope",
    handle: null,
    agentClass: "general",
    harness: "grok",
    state: "working",
    projectRoot: "/Users/art/dev/openscout",
    cwd: "/Users/art/dev/openscout",
    updatedAt: Date.now(),
    createdAt: null,
    transport: null,
    selector: null,
    defaultSelector: null,
    nodeQualifier: null,
    workspaceQualifier: null,
    wakePolicy: null,
    capabilities: [],
    project: "openscout",
    branch: null,
    role: null,
    model: null,
    harnessSessionId: "sess-live-1",
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
    terminalSurface: null,
    ...overrides,
  };
}

function lane(overrides: Partial<AgentLane> & { agent: Agent }): AgentLane {
  return {
    id: overrides.agent.id,
    source: "scout",
    observe: {
      events: [],
      files: [],
      metadata: {
        session: {
          externalSessionId: "sess-live-1",
          cwd: "/Users/art/dev/openscout",
          model: "grok",
          adapterType: "grok",
          gitBranch: undefined,
        },
        usage: undefined,
      },
      live: true,
    },
    lastActiveAt: Date.now(),
    current: true,
    ...overrides,
  };
}

describe("agent lane navigation", () => {
  test("detects synthetic lane agents", () => {
    expect(isLaneSyntheticAgent(agent({ id: "native:grok:sess-1" }))).toBe(true);
    expect(isLaneSyntheticAgent(agent({ id: "scope.main" }))).toBe(false);
  });

  test("builds a scoped session route for registered agents", () => {
    expect(laneSessionRoute(lane({ agent: agent() }))).toEqual({
      view: "sessions",
      sessionId: "sess-live-1",
      agentId: "scope.main",
    });
  });

  test("builds an unscoped session route for synthetic agents", () => {
    const sessionId = "1e753cef-92ae-4e22-a365-0f5d23a07652";
    const synthetic = agent({
      id: `native:claude:${sessionId}`,
      harnessSessionId: sessionId,
    });
    const nativeLane = lane({
      agent: synthetic,
      source: "native",
      observe: {
        events: [],
        files: [],
        metadata: {
          session: {
            externalSessionId: sessionId,
            cwd: "/Users/art/dev/openscout",
            model: "claude",
            adapterType: "claude",
            gitBranch: undefined,
          },
          usage: undefined,
        },
        live: true,
      },
    });
    expect(laneSessionRoute(nativeLane)).toEqual({
      view: "sessions",
      sessionId,
    });
  });

  test("routes traces through the session surface for every lane", () => {
    const scoutLane = lane({ agent: agent() });
    const sessionId = "1e753cef-92ae-4e22-a365-0f5d23a07652";
    const synthetic = agent({
      id: `native:claude:${sessionId}`,
      harnessSessionId: sessionId,
    });
    const nativeLane = lane({
      agent: synthetic,
      source: "native",
      observe: {
        events: [],
        files: [],
        metadata: {
          session: {
            externalSessionId: sessionId,
            cwd: "/Users/art/dev/openscout",
            model: "claude",
            adapterType: "claude",
            gitBranch: undefined,
          },
          usage: undefined,
        },
        live: true,
      },
    });

    expect(laneTraceRoute(scoutLane)).toEqual(laneSessionRoute(scoutLane));
    expect(laneTraceRoute(nativeLane)).toEqual(laneSessionRoute(nativeLane));
    expect(laneTraceRoute(nativeLane)).toEqual({
      view: "sessions",
      sessionId,
    });
  });

  test("omits profile routes for synthetic agents", () => {
    const synthetic = agent({ id: "native:grok:sess-live-1" });
    const target = lane({ agent: synthetic, source: "native" });
    expect(laneProfileRoute(target)).toBeNull();
  });

  test("builds profile routes for registered agents", () => {
    const target = lane({ agent: agent() });
    expect(laneProfileRoute(target)).toEqual({
      view: "agents-v2",
      agentId: "scope.main",
      tab: "profile",
    });
  });
});
