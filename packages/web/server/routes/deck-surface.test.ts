import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { TailEvent } from "@openscout/runtime/tail";

import type { ScoutSurfaceRequest } from "../../client/surface-contract/scout-surface-contract.ts";
import type { WebAgent } from "../db/types/web.ts";
import {
  createScoutDeckSurfaceService,
  mountScoutDeckSurfaceRoutes,
} from "./deck-surface.ts";

const hostId = "web:air.scout.local";
const currentDirectory = "/workspace/openscout";

function agent(overrides: Partial<WebAgent> = {}): WebAgent {
  return {
    id: "agent-codex",
    definitionId: "definition-codex",
    name: "OpenScout",
    handle: "openscout",
    agentClass: "project",
    harness: "codex",
    state: "available",
    projectRoot: currentDirectory,
    cwd: currentDirectory,
    updatedAt: 100,
    createdAt: 10,
    transport: "codex_app_server",
    selector: "@openscout",
    defaultSelector: "@openscout",
    nodeQualifier: "air-local",
    workspaceQualifier: "openscout",
    wakePolicy: null,
    capabilities: [],
    project: "openscout",
    branch: "codex/deck",
    role: null,
    model: "gpt-5.6",
    harnessSessionId: "thread-live",
    terminalSurface: null,
    harnessLogPath: null,
    conversationId: "conversation-live",
    authorityNodeId: "air-local",
    authorityNodeName: "Air",
    homeNodeId: "air-local",
    homeNodeName: "Air",
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
    ...overrides,
  };
}

function tail(overrides: Partial<TailEvent> = {}): TailEvent {
  return {
    id: "tail-1",
    ts: 1_000,
    source: "codex",
    sessionId: "thread-live",
    pid: 10,
    parentPid: null,
    project: "openscout",
    cwd: currentDirectory,
    harness: "scout-managed",
    kind: "tool",
    summary: "Running focused tests",
    ...overrides,
  };
}

function request(
  method: ScoutSurfaceRequest["method"],
  params: Record<string, unknown> = {},
  scoped = false,
): ScoutSurfaceRequest {
  return {
    v: 1,
    id: `request-${method}`,
    surface: "deck",
    method,
    params,
    ...(scoped ? { hostIds: [hostId] } : {}),
  } as ScoutSurfaceRequest;
}

function snapshot(agentId = "agent-codex") {
  return {
    adapter: "codex_app_server" as const,
    agentId,
    threadId: "thread-live",
    turnId: null,
    state: "idle" as const,
    capabilities: { connect: true, start: true, steer: true, interrupt: true, queue: false as const, approvals: false as const },
    capabilityNotes: { queue: "No queue.", approvals: "Runtime-owned." },
    snapshot: null,
  };
}

describe("Scout Deck web surface", () => {
  test("bootstraps a live trusted-host surface", async () => {
    const service = createScoutDeckSurfaceService({
      currentDirectory,
      hostName: "air.scout.local",
      hostId,
      listAgents: () => [agent()],
      recentTail: () => [],
      codex: {
        snapshot: async (agentId) => snapshot(agentId),
        start: async (agentId) => ({ accepted: true, agentId, threadId: "thread-live", mode: "start" }),
        steer: async (agentId) => ({ accepted: true, agentId, threadId: "thread-live", mode: "steer" }),
        interrupt: async (agentId) => ({ accepted: true, agentId, threadId: "thread-live", mode: "interrupt" }),
      },
    });

    const reply = await service.handle(request("bootstrap"));
    expect("result" in reply).toBe(true);
    if (!("result" in reply) || !("hosts" in reply.result)) throw new Error("expected bootstrap result");
    expect(reply.result.hosts).toEqual([{ id: hostId, name: "air.scout.local", state: "connected" }]);
    expect(reply.result.capabilities).toContain("codex.turn.steer");
    expect(reply.result.capabilities).toContain("codex.session.start");
    expect(reply.result.capabilities).not.toContain("native.voice.toggleInput");
  });

  test("puts the web server workspace on deck and caps the channel bank", async () => {
    const others = Array.from({ length: 20 }, (_, index) => agent({
      id: `other-${index}`,
      name: `Other ${index}`,
      cwd: `/workspace/other-${index}`,
      projectRoot: `/workspace/other-${index}`,
      updatedAt: 2_000 + index,
    }));
    const service = createScoutDeckSurfaceService({
      currentDirectory,
      hostName: "air.scout.local",
      hostId,
      listAgents: () => [
        ...others,
        agent({
          id: "helper-cwd",
          name: "Helper",
          cwd: currentDirectory,
          projectRoot: "/workspace/helper",
          updatedAt: 9_000,
        }),
        agent({ id: "current", updatedAt: 1 }),
      ],
      recentTail: () => [],
      codex: {
        snapshot: async (agentId) => snapshot(agentId),
        start: async () => ({}),
        steer: async () => ({}),
        interrupt: async () => ({}),
      },
    });

    const reply = await service.handle(request("agents.list", {}, true));
    if (!("result" in reply) || !("hosts" in reply.result)) throw new Error("expected fleet result");
    const outcome = reply.result.hosts[0];
    if (!outcome?.ready || !("agents" in outcome.value)) throw new Error("expected host agents");
    expect(outcome.value.agents).toHaveLength(16);
    expect(outcome.value.agents[0]?.id).toBe("current");
  });

  test("maps live tail events onto the matching lane", async () => {
    const service = createScoutDeckSurfaceService({
      currentDirectory,
      hostName: "air.scout.local",
      hostId,
      listAgents: () => [agent()],
      recentTail: () => [tail()],
      codex: {
        snapshot: async (agentId) => snapshot(agentId),
        start: async () => ({}),
        steer: async () => ({}),
        interrupt: async () => ({}),
      },
    });

    const reply = await service.handle(request("tail.recent", { limit: 10 }, true));
    if (!("result" in reply) || !("hosts" in reply.result)) throw new Error("expected tail result");
    const outcome = reply.result.hosts[0];
    if (!outcome?.ready || !("events" in outcome.value)) throw new Error("expected host events");
    expect(outcome.value.events[0]).toMatchObject({
      id: "tail-1",
      agentId: "agent-codex",
      kind: "tool",
      text: "Running focused tests",
    });
  });

  test("forwards exact Codex task controls and rejects foreign hosts", async () => {
    const calls: string[] = [];
    const service = createScoutDeckSurfaceService({
      currentDirectory,
      hostName: "air.scout.local",
      hostId,
      listAgents: () => [agent()],
      recentTail: () => [],
      codex: {
        snapshot: async (agentId, connect) => {
          calls.push(`${connect ? "connect" : "snapshot"}:${agentId}`);
          return snapshot(agentId);
        },
        start: async (agentId, text) => {
          calls.push(`start:${agentId}:${text}`);
          return { accepted: true, agentId, threadId: "thread-live", mode: "start" };
        },
        steer: async () => ({}),
        interrupt: async () => ({}),
      },
    });

    const connected = await service.handle(request("codex.thread.connect", {
      route: { hostId, agentId: "agent-codex" },
    }));
    expect("result" in connected).toBe(true);
    await service.handle(request("codex.turn.start", {
      route: { hostId, agentId: "agent-codex" },
      text: "Make the Deck real.",
    }));
    expect(calls).toEqual([
      "connect:agent-codex",
      "start:agent-codex:Make the Deck real.",
    ]);

    const rejected = await service.handle(request("codex.thread.snapshot", {
      route: { hostId: "web:other", agentId: "agent-codex" },
    }));
    expect("error" in rejected && rejected.error.code).toBe("invalid_route");
  });

  test("accepts view-only lane selection without granting Codex controls", async () => {
    const service = createScoutDeckSurfaceService({
      currentDirectory,
      hostName: "air.scout.local",
      hostId,
      listAgents: () => [agent({ id: "view-only", harness: "claude", transport: "tmux" })],
      recentTail: () => [],
      codex: {
        snapshot: async (agentId) => snapshot(agentId),
        start: async () => ({}),
        steer: async () => ({}),
        interrupt: async () => ({}),
      },
    });

    const selected = await service.handle(request("native.setLaneSelection", {
      selection: { hostId, agentId: "view-only" },
    }));
    expect("result" in selected && selected.result).toEqual({ accepted: true });

    const control = await service.handle(request("codex.thread.connect", {
      route: { hostId, agentId: "view-only" },
    }));
    expect("error" in control && control.error.code).toBe("unsupported_capability");
  });

  test("starts a fresh Codex session for a view-only lane's workspace", async () => {
    const launched: string[] = [];
    const service = createScoutDeckSurfaceService({
      currentDirectory,
      hostName: "air.scout.local",
      hostId,
      listAgents: () => [agent({ id: "view-only", harness: "claude", transport: "tmux" })],
      recentTail: () => [],
      startCodexSession: async (source) => {
        launched.push(source.projectRoot ?? "");
        return { agentId: "agent-codex-new", conversationId: "conversation-new", sessionId: "session-new" };
      },
      codex: {
        snapshot: async (agentId) => snapshot(agentId),
        start: async () => ({}),
        steer: async () => ({}),
        interrupt: async () => ({}),
      },
    });

    const reply = await service.handle(request("codex.session.start", {
      route: { hostId, agentId: "view-only" },
    }));
    expect(launched).toEqual([currentDirectory]);
    expect("result" in reply && reply.result).toEqual({
      accepted: true,
      hostId,
      sourceAgentId: "view-only",
      agentId: "agent-codex-new",
      conversationId: "conversation-new",
      sessionId: "session-new",
    });
  });

  test("mounts a strict JSON endpoint", async () => {
    const app = new Hono();
    mountScoutDeckSurfaceRoutes(app, {
      currentDirectory,
      hostName: "air.scout.local",
      hostId,
      listAgents: () => [agent()],
      recentTail: () => [],
      codex: {
        snapshot: async (agentId) => snapshot(agentId),
        start: async () => ({}),
        steer: async () => ({}),
        interrupt: async () => ({}),
      },
    });

    const malformed = await app.request("http://localhost/api/surfaces/deck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(malformed.status).toBe(400);

    const valid = await app.request("http://localhost/api/surfaces/deck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request("bootstrap")),
    });
    expect(valid.status).toBe(200);
    expect((await valid.json() as { result: { surface: string } }).result.surface).toBe("deck");
  });
});
