import { describe, expect, test } from "bun:test";

import { canTakeoverTerminalSession } from "./lib/terminal-takeover.ts";
import type { Agent, SessionCatalogWithResume } from "./lib/types.ts";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    definitionId: "agent",
    name: "Agent",
    handle: null,
    agentClass: "general",
    harness: "codex",
    state: "working",
    projectRoot: "/tmp/project",
    cwd: "/tmp/project",
    updatedAt: null,
    createdAt: null,
    transport: "codex_app_server",
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
    harnessSessionId: "session-1",
    terminalSurface: null,
    harnessLogPath: null,
    conversationId: "dm.operator.agent-1",
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

function catalog(overrides: Partial<SessionCatalogWithResume> = {}): SessionCatalogWithResume {
  return {
    agentId: "agent-1",
    harness: "codex",
    activeSessionId: "session-1",
    resumeCommand: "codex resume -C /tmp/project session-1",
    resumeCwd: "/tmp/project",
    sessions: [
      {
        id: "session-1",
        startedAt: 1_700_000_000_000,
        cwd: "/tmp/project",
        harness: "codex",
        transport: "codex_app_server",
        canObserve: true,
        canTakeover: false,
      },
    ],
    ...overrides,
  };
}

describe("terminal takeover capability", () => {
  test("does not infer takeover from a protocol session resume command", () => {
    const sessionCatalog = catalog();
    expect(canTakeoverTerminalSession({
      agent: agent({}),
      catalog: sessionCatalog,
      session: sessionCatalog.sessions[0],
    })).toBe(false);
  });

  test("allows takeover when the active session advertises terminal takeover", () => {
    const sessionCatalog = catalog({
      sessions: [
        {
          id: "session-1",
          startedAt: 1_700_000_000_000,
          cwd: "/tmp/project",
          harness: "codex",
          transport: "codex_exec",
          canTakeover: true,
        },
      ],
    });
    expect(canTakeoverTerminalSession({
      agent: agent({ transport: "codex_exec" }),
      catalog: sessionCatalog,
      session: sessionCatalog.sessions[0],
    })).toBe(true);
  });

  test("allows tmux takeover from the attached tmux session id", () => {
    expect(canTakeoverTerminalSession({
      agent: agent({ transport: "tmux", harnessSessionId: "relay-agent-1" }),
      catalog: null,
    })).toBe(true);
  });
});
