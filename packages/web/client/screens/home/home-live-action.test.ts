import { describe, expect, test } from "bun:test";

import type { Agent, ObserveData } from "../../lib/types.ts";
import {
  contextActivityLine,
  homeCardPeekEnabled,
  homeCardRoute,
  homeCardTerminalEnabled,
  isPlaceholderText,
  liveActionSummary,
  prettifyToolLine,
  usefulHeadline,
} from "./home-live-action.ts";

const tmuxSurface = {
  backend: "tmux",
  sessionName: "scout-1",
  paneId: null,
  socketDir: null,
} as const;

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

describe("isPlaceholderText / usefulHeadline", () => {
  test("drops discovery, turn lifecycle, and tool-count noise", () => {
    expect(isPlaceholderText("Native claude transcript discovered.")).toBe(true);
    expect(isPlaceholderText("Turn complete")).toBe(true);
    expect(isPlaceholderText("Turn complete · 0 tool calls")).toBe(true);
    expect(isPlaceholderText("turn 3 · 0 tool calls")).toBe(true);
    expect(isPlaceholderText("bash · bun test")).toBe(false);
    expect(usefulHeadline("Native claude transcript discovered")).toBeNull();
    expect(usefulHeadline("bash")).toBeNull();
    expect(usefulHeadline("bash · bun test home-live-action")).toBe(
      "bash · bun test home-live-action",
    );
  });
});

describe("prettifyToolLine", () => {
  test("returns null for bare tool names without args", () => {
    expect(prettifyToolLine("bash", "")).toBeNull();
    expect(prettifyToolLine("bash", null)).toBeNull();
  });

  test("keeps command body for shell tools", () => {
    expect(prettifyToolLine("bash", "bun test home-live-action.test.ts"))
      .toBe("bash · bun test home-live-action.test.ts");
  });
});

describe("liveActionSummary", () => {
  test("prefers checkpoint over observe events", () => {
    const observeData: ObserveData = {
      events: [{ kind: "tool", tool: "Read", arg: "content.tsx" }],
      files: [],
    };
    expect(
      liveActionSummary({
        checkpoint: "Indexing home surface",
        observeData,
      }),
    ).toBe("Indexing home surface");
  });

  test("uses latest meaningful observe event", () => {
    const observeData: ObserveData = {
      events: [
        { kind: "system", text: "session started" },
        { kind: "tool", tool: "Grep", arg: "home-moving" },
      ],
      files: [],
    };
    expect(liveActionSummary({ observeData })).toBe("Grep · home-moving");
  });

  test("prettifies path-heavy file tools to basename", () => {
    const observeData: ObserveData = {
      events: [{
        kind: "tool",
        tool: "ReadMediaFile",
        arg: "/var/tmp/study-a-detail2.png",
      }],
      files: [],
    };
    expect(liveActionSummary({ observeData })).toBe("ReadMediaFile · study-a-detail2.png");
  });

  test("falls back to task when live", () => {
    expect(
      liveActionSummary({
        fallbackTask: "Home layout pass",
        observeLive: true,
      }),
    ).toBe("Home layout pass");
  });

  test("does not surface empty session-trace placeholders", () => {
    const observeData: ObserveData = {
      events: [{
        kind: "system",
        text: "No session trace is available for this agent yet.",
      }],
      files: [],
    };
    expect(liveActionSummary({ observeData })).toBeNull();
    expect(
      liveActionSummary({
        fallbackTask: "No session trace is available for this agent yet.",
        observeLive: true,
      }),
    ).toBeNull();
  });

  test("skips native transcript discovery and turn lifecycle noise", () => {
    const observeData: ObserveData = {
      events: [
        { kind: "system", text: "Native claude transcript discovered." },
        { kind: "note", text: "Turn complete" },
      ],
      files: [],
    };
    expect(liveActionSummary({ observeData, skipLifecycleTokens: true })).toBeNull();
    expect(liveActionSummary({ observeData })).toBeNull();
  });

  test("prefers a real tool line over transcript discovery", () => {
    const observeData: ObserveData = {
      events: [
        { kind: "system", text: "Native claude transcript discovered." },
        { kind: "tool", tool: "ReadMediaFile", arg: "img/study-a-detail2.png" },
        { kind: "note", text: "Turn complete" },
      ],
      files: [],
    };
    expect(liveActionSummary({ observeData, skipLifecycleTokens: true }))
      .toBe("ReadMediaFile · study-a-detail2.png");
  });

  test("skips bare bash without args and falls through to context-worthy null", () => {
    const observeData: ObserveData = {
      events: [
        { kind: "system", text: "Native claude transcript discovered." },
        { kind: "tool", tool: "bash", arg: "" },
        { kind: "note", text: "Turn complete · 0 tool calls" },
      ],
      files: [],
    };
    expect(liveActionSummary({ observeData, skipLifecycleTokens: true })).toBeNull();
  });

  test("humanizes a bare protocol token instead of surfacing the raw bracket", () => {
    const observeData: ObserveData = {
      events: [{ kind: "system", text: "[turn_ended]" }],
      files: [],
    };
    expect(liveActionSummary({ observeData })).toBe("turn ended");
    expect(liveActionSummary({ observeData, skipLifecycleTokens: true })).toBeNull();
  });

  test("prefers a real meaningful line over a trailing protocol token", () => {
    const observeData: ObserveData = {
      events: [
        { kind: "tool", tool: "Edit", arg: "home-now-card.tsx" },
        { kind: "system", text: "[turn_ended]" },
      ],
      files: [],
    };
    expect(liveActionSummary({ observeData })).toBe("Edit · home-now-card.tsx");
  });

  test("when live, prefers current tool over older conversation", () => {
    const observeData: ObserveData = {
      events: [
        { kind: "ask", text: "Please polish the home signal list" },
        { kind: "tool", tool: "Edit", arg: "home-moving-signal.tsx" },
      ],
      files: [],
    };
    expect(liveActionSummary({ observeData, observeLive: true }))
      .toBe("Edit · home-moving-signal.tsx");
    expect(liveActionSummary({ observeData, observeLive: false }))
      .toBe("Please polish the home signal list");
  });
});

describe("contextActivityLine", () => {
  test("describes live watching with project context", () => {
    expect(contextActivityLine({
      harness: "claude",
      project: "openscout",
      live: true,
    })).toBe("Watching claude in ~/openscout");
  });

  test("describes attached-only sessions", () => {
    expect(contextActivityLine({
      harness: "claude",
      project: "openscout",
      attachedOnly: true,
    })).toBe("claude session attached · ~/openscout");
  });
});

describe("homeCardRoute", () => {
  test("routes managed agents to profile, observe, and peek", () => {
    const managed = agent({ id: "managed-1" });
    expect(homeCardRoute(managed, "profile")).toEqual({
      view: "agents-v2",
      agentId: "managed-1",
      tab: "profile",
    });
    expect(homeCardRoute(managed, "observe")).toEqual({
      view: "agents-v2",
      agentId: "managed-1",
      tab: "observe",
    });
    expect(homeCardRoute(managed, "peek")).toEqual({
      view: "agents-v2",
      selectedAgentId: "managed-1",
    });
  });

  test("routes managed agents straight to their terminal in observe mode", () => {
    const managed = agent({ id: "managed-1" });
    expect(homeCardRoute(managed, "terminal")).toEqual({
      view: "terminal",
      agentId: "managed-1",
      mode: "observe",
    });
  });

  test("routes synthetic agents to sessions when possible", () => {
    const synthetic = agent({
      id: "native:grok:019f1b71-e561-7c62-a028-c3f977c41b25",
      harnessSessionId: "019f1b71-e561-7c62-a028-c3f977c41b25",
    });
    expect(homeCardRoute(synthetic, "observe")).toEqual({
      view: "sessions",
      sessionId: "019f1b71-e561-7c62-a028-c3f977c41b25",
    });
  });
});

describe("homeCardPeekEnabled", () => {
  test("enabled when tmux surface or harness session exists", () => {
    expect(homeCardPeekEnabled(agent({ terminalSurface: tmuxSurface }))).toBe(true);
    expect(homeCardPeekEnabled(agent({ harnessSessionId: "sess-1" }))).toBe(true);
    expect(homeCardPeekEnabled(agent())).toBe(false);
  });
});

describe("homeCardTerminalEnabled", () => {
  test("enabled only when the agent has a live terminal surface", () => {
    expect(homeCardTerminalEnabled(agent({ terminalSurface: tmuxSurface }))).toBe(true);
    expect(homeCardTerminalEnabled(agent({ terminalSurface: null }))).toBe(false);
    expect(homeCardTerminalEnabled(agent())).toBe(false);
  });
});
