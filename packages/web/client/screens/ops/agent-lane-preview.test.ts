import { describe, expect, test } from "bun:test";

import type { Agent, ObserveData, ObserveEvent } from "../../lib/types.ts";
import { buildAgentLanePreview, previewFocusEvent } from "./agent-lane-preview.ts";

function event(overrides: Partial<ObserveEvent> & Pick<ObserveEvent, "id" | "kind" | "t">): ObserveEvent {
  return {
    text: "",
    ...overrides,
  };
}

function agent(): Agent {
  return {
    id: "agent:preview",
    definitionId: "preview",
    name: "preview",
    handle: null,
    agentClass: "managed",
    harness: "codex",
    state: "working",
    projectRoot: null,
    cwd: null,
    updatedAt: 1,
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
    conversationId: "conv-preview",
    homeNodeId: null,
    homeNodeName: null,
    ownerId: null,
    ownerName: null,
    ownerHandle: null,
    staleLocalRegistration: false,
    retiredFromFleet: false,
    replacedByAgentId: null,
  };
}

describe("previewFocusEvent", () => {
  test("prefers live reasoning while a turn is active", () => {
    const events = [
      event({ id: "start", kind: "note", t: 1, text: "Turn started" }),
      event({ id: "tool", kind: "tool", t: 2, tool: "Shell", arg: "git status", text: "Shell · git status" }),
      event({ id: "think", kind: "think", t: 3, text: "Need to inspect lane facts first." }),
    ];

    expect(previewFocusEvent(events, true)?.id).toBe("think");
  });

  test("prefers recent live tools before older messages outside active turns", () => {
    const events = [
      event({ id: "msg", kind: "message", t: 10, text: "Earlier update" }),
      event({ id: "tool", kind: "tool", t: 36, tool: "Shell", arg: "rg LaneFacts", text: "Shell · rg LaneFacts" }),
      event({ id: "note", kind: "note", t: 40, text: "Turn complete" }),
    ];

    expect(previewFocusEvent(events, true)?.id).toBe("tool");
  });

  test("falls back to latest message ask or note when not live", () => {
    const events = [
      event({ id: "tool", kind: "tool", t: 1, tool: "Shell", arg: "rg LaneFacts", text: "Shell · rg LaneFacts" }),
      event({ id: "msg", kind: "message", t: 2, text: "Implemented facts layer" }),
    ];

    expect(previewFocusEvent(events, false)?.id).toBe("msg");
  });
});

describe("buildAgentLanePreview", () => {
  test("renders shell commands with lane-friendly separator", () => {
    const data: ObserveData = {
      events: [event({ id: "tool", kind: "tool", t: 1, tool: "Shell", arg: "git status --short", text: "Shell · git status --short" })],
      files: [],
    };

    expect(buildAgentLanePreview(data, agent())?.headline).toBe("Shell · git status --short");
  });
});
