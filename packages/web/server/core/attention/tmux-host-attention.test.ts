import { describe, expect, test } from "bun:test";

import type { WebAgent } from "../../db/types/web.ts";
import {
  collectTmuxHostAttention,
  detectClaudeTmuxHostAttention,
} from "./tmux-host-attention.ts";

const SESSION_ID = "relay-paper-screen-fable-work-hud-013-voice-settings-arachs-mac-mini-local-claude";

function agent(overrides: Partial<WebAgent> = {}): WebAgent {
  return {
    id: "paper-screen-fable.work-hud-013-voice-settings.arachs-mac-mini-local",
    definitionId: "paper-screen-fable",
    name: "Paper Screen Fable",
    handle: "paper-screen-fable",
    agentClass: "general",
    harness: "claude",
    state: "working",
    projectRoot: "/Users/arach/dev/hudson",
    cwd: "/Users/arach/dev/hudson",
    updatedAt: 1,
    createdAt: 1,
    transport: "tmux",
    selector: "@paper-screen-fable",
    defaultSelector: "@paper-screen-fable",
    nodeQualifier: "local",
    workspaceQualifier: "work-hud-013-voice-settings",
    wakePolicy: "on_demand",
    capabilities: ["chat", "invoke", "deliver"],
    project: "Hudson",
    branch: "work/hud-013-voice-settings",
    role: "Agent",
    model: "fable",
    harnessSessionId: null,
    terminalSurface: {
      backend: "tmux",
      sessionName: SESSION_ID,
      paneId: SESSION_ID,
      socketDir: null,
    },
    harnessLogPath: null,
    conversationId: null,
    authorityNodeId: null,
    authorityNodeName: null,
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

const livePermissionPrompt = `
⏺ Bash(curl -s -m 5 http://127.0.0.1:29980/api/files)

────────────────────────────────────────────────────────
 Bash command

   curl -s -m 5 http://127.0.0.1:29980/api/files
   Check Paper API and Studio dev server are up

 Permission rule Bash(curl:*) requires confirmation for this command.
 /permissions to update rules

 Do you want to proceed?
   1. Yes
 ❯ 2. No

 Esc to cancel · Tab to amend · ctrl+e to explain

  4 tasks (0 done, 1 in progress, 3 open)
  ◼ Orient: Paper host renderer, MCP protocol, current page tree
  ◻ Compose Candidate·Orientation CompNode tree via Paper tools
`;

describe("Claude tmux host attention", () => {
  test("detects the active permission prompt from the reported pane", () => {
    expect(detectClaudeTmuxHostAttention(livePermissionPrompt, {
      agentId: "agent-1",
      agentName: "Paper Screen Fable",
      sessionId: SESSION_ID,
      now: 1_700_000_000_000,
    })).toEqual({
      id: `tmux-host-permission:agent-1:${SESSION_ID}`,
      agentId: "agent-1",
      agentName: "Paper Screen Fable",
      sessionId: SESSION_ID,
      title: "Claude needs permission",
      summary: "Permission rule Bash(curl:*) requires confirmation.",
      detail: "curl -s -m 5 http://127.0.0.1:29980/api/files",
      updatedAt: 1_700_000_000_000,
      sourceLabel: "Claude terminal prompt",
    });
  });

  test("does not resurrect an old prompt once output follows it", () => {
    expect(detectClaudeTmuxHostAttention(`${livePermissionPrompt}\n⏺ Read(src/model.ts)\n  ⎿ Read 20 lines`, {
      agentId: "agent-1",
      agentName: "Paper Screen Fable",
      sessionId: SESSION_ID,
    })).toBeNull();
  });

  test.each([
    ["inline", "❯ "],
    ["boxed", "│ > "],
  ])("clears a resolved prompt when Claude returns to its %s composer", (_kind, composer) => {
    expect(detectClaudeTmuxHostAttention(`${livePermissionPrompt}\n${composer}`, {
      agentId: "agent-1",
      agentName: "Paper Screen Fable",
      sessionId: SESSION_ID,
    })).toBeNull();
  });

  test("scans live Claude tmux panes even when broker state is available", async () => {
    const captures: string[] = [];
    const items = await collectTmuxHostAttention([
      agent(),
      agent({ id: "idle", state: "available" }),
      agent({ id: "retired", state: "available", retiredFromFleet: true }),
      agent({ id: "codex", harness: "codex" }),
    ], async (candidate) => {
      captures.push(candidate.id);
      return livePermissionPrompt;
    }, { now: 1_700_000_000_000 });

    expect(captures).toEqual([
      "paper-screen-fable.work-hud-013-voice-settings.arachs-mac-mini-local",
      "idle",
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        agentId: "paper-screen-fable.work-hud-013-voice-settings.arachs-mac-mini-local",
        title: "Claude needs permission",
      }),
      expect.objectContaining({
        agentId: "idle",
        title: "Claude needs permission",
      }),
    ]);
  });

  test("bounds a stalled pane capture", async () => {
    const startedAt = Date.now();
    const items = await collectTmuxHostAttention(
      [agent()],
      async () => await new Promise<string>(() => {}),
      { captureTimeoutMs: 5 },
    );

    expect(items).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  test("bounds host scans and prioritizes active recent sessions", async () => {
    const captures: string[] = [];
    const agents = Array.from({ length: 30 }, (_, index) => agent({
      id: `agent-${index}`,
      state: index === 29 ? "working" : "available",
      updatedAt: index,
    }));

    await collectTmuxHostAttention(agents, async (candidate) => {
      captures.push(candidate.id);
      return null;
    }, { maxCandidates: 5, captureConcurrency: 1 });

    expect(captures).toEqual([
      "agent-29",
      "agent-28",
      "agent-27",
      "agent-26",
      "agent-25",
    ]);
  });
});
