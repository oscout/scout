import { afterEach, describe, expect, test } from "bun:test";

import type { Agent } from "./types.ts";
import {
  buildProjectLaunchTargets,
  chooseInitialProjectLaunchTarget,
  harnessFromAdapterType,
  invokeSession,
  orderProjectLaunchTargetsByRecency,
  resumeAgentSession,
  resumableHarnessFromAdapterType,
  searchProjectLaunchTargets,
  startAgentSession,
  startProjectSession,
} from "./session-start.ts";

const agent = {
  id: "agent:openscout",
  name: "OpenScout",
  harness: "codex",
  model: "gpt-5",
  projectRoot: "/work/openscout",
  cwd: "/work/openscout",
} as Agent;

describe("startAgentSession", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("seeds a new session with its capture instead of sending to an unindexed chat", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        path: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({
        conversationId: "chat:new",
        agentId: agent.id,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await startAgentSession(agent, {
      instructions: "Inspect this screenshot",
      attachments: [{
        id: "capture-1",
        url: "http://localhost:43122/api/blobs/capture-1",
        mediaType: "image/png",
        fileName: "capture.png",
      }],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      path: "/api/sessions",
      body: {
        target: {
          agentId: agent.id,
          projectPath: "/work/openscout",
        },
        execution: {
          session: "new",
          harness: "codex",
          model: "gpt-5",
        },
        seed: {
          instructions: "Inspect this screenshot",
          attachments: [{
            id: "capture-1",
            url: "http://localhost:43122/api/blobs/capture-1",
            mediaType: "image/png",
            fileName: "capture.png",
          }],
        },
      },
    });
  });

  test("resumes an observed harness session when no conversation is attached", async () => {
    let requestBody: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({
        conversationId: "chat:resumed",
        agentId: agent.id,
        sessionId: "harness-session-1",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await resumeAgentSession({
      agentId: agent.id,
      sessionId: "harness-session-1",
      instructions: "Review PR 369 and merge it if it is ready.",
    });

    expect(requestBody).toEqual({
      target: { agentId: agent.id },
      execution: {
        session: "existing",
        targetSessionId: "harness-session-1",
      },
      seed: {
        instructions: "Review PR 369 and merge it if it is ready.",
      },
    });
    expect(result.conversationId).toBe("chat:resumed");
  });

  test("starts a one-time project-routed chat without requiring an existing agent", async () => {
    let requestBody: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({
        conversationId: "chat:project",
        agentId: "agent:provisional",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await startProjectSession({
      projectPath: " /work/any-project ",
      harness: " codex ",
      model: " gpt-5.6-sol ",
      reasoningEffort: " high ",
      instructions: " Start here. ",
      fromMessageId: " message:source ",
      fromConversationId: " chat:source ",
      attachments: [{
        id: "capture-2",
        url: "http://localhost:43122/api/blobs/capture-2",
        mediaType: "image/png",
        fileName: "capture.png",
      }],
    });

    expect(requestBody).toEqual({
      target: { projectPath: "/work/any-project" },
      execution: {
        session: "new",
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
      agent: { persistence: "one_time" },
      seed: {
        instructions: "Start here.",
        attachments: [{
          id: "capture-2",
          url: "http://localhost:43122/api/blobs/capture-2",
          mediaType: "image/png",
          fileName: "capture.png",
        }],
        fromMessageId: "message:source",
        fromConversationId: "chat:source",
      },
    });
  });

  test("invokes a bare observed session using its own execution metadata", async () => {
    let requestBody: unknown = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({
        conversationId: "chat:invoked",
        agentId: "agent:minted",
        sessionId: "harness-session-1",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await invokeSession({
      projectPath: "/work/openscout",
      sessionId: "harness-session-1",
      harness: "claude",
      model: "opus",
      reasoningEffort: "high",
      instructions: "Continue the implementation.",
    });

    expect(requestBody).toEqual({
      target: { projectPath: "/work/openscout" },
      execution: {
        session: "existing",
        targetSessionId: "harness-session-1",
        harness: "claude",
        model: "opus",
        reasoningEffort: "high",
      },
      seed: { instructions: "Continue the implementation." },
    });
  });

  test("maps transcript adapter types only to known broker harnesses", () => {
    expect(harnessFromAdapterType("claude-code")).toBe("claude");
    expect(harnessFromAdapterType("CODEX_APP_SERVER")).toBe("codex");
    expect(harnessFromAdapterType("kimi")).toBe("kimi");
    expect(harnessFromAdapterType("opencode_acp")).toBe("opencode");
    expect(harnessFromAdapterType("grok_acp")).toBe("grok-acp");
    expect(harnessFromAdapterType("unknown-adapter")).toBeUndefined();
    expect(resumableHarnessFromAdapterType("codex")).toBe("codex");
    expect(resumableHarnessFromAdapterType("opencode_acp")).toBe("opencode");
    expect(resumableHarnessFromAdapterType("kimi")).toBeUndefined();
    expect(resumableHarnessFromAdapterType("grok_acp")).toBeUndefined();
  });
});

describe("project-routed New Chat targets", () => {
  const inventory = [
    {
      id: "project:arc",
      title: "Arc",
      root: "/Users/test/dev/arc",
      source: "inferred",
      registrationKind: "discovered",
      defaultHarness: "claude",
      projectConfigPath: null,
    },
    {
      id: "project:openscout",
      title: "OpenScout",
      root: "/Users/test/dev/openscout/",
      source: "manifest",
      registrationKind: "configured",
      defaultHarness: "codex",
      projectConfigPath: "/Users/test/dev/openscout/.openscout/project.json",
    },
  ];

  test("uses the full project inventory and only fills missing roots from agents", () => {
    const targets = buildProjectLaunchTargets(inventory, [
      agent,
      {
        ...agent,
        id: "agent:arc-old",
        project: "Old Arc",
        projectRoot: "/Users/test/dev/arc",
      },
    ] as Agent[]);

    expect(targets.map((target) => target.root)).toEqual([
      "/Users/test/dev/arc",
      "/Users/test/dev/openscout",
      "/work/openscout",
    ]);
    expect(targets.find((target) => target.root.endsWith("/arc"))).toMatchObject({
      title: "Arc",
      source: "inventory",
      defaultHarness: "claude",
    });
  });

  test("searches names and full paths with exact matches ranked first", () => {
    const targets = buildProjectLaunchTargets(inventory, []);
    expect(searchProjectLaunchTargets(targets, "open").map((target) => target.title)).toEqual(["OpenScout"]);
    expect(searchProjectLaunchTargets(targets, "dev arc").map((target) => target.title)).toEqual(["Arc"]);
  });

  test("prefers route context, then the deepest project containing cwd", () => {
    const targets = buildProjectLaunchTargets([
      ...inventory,
      { ...inventory[0]!, id: "project:nested", title: "Nested", root: "/Users/test/dev/arc/packages/nested" },
    ], []);
    expect(chooseInitialProjectLaunchTarget(targets, {
      preferredRoot: "/Users/test/dev/openscout",
      currentDirectory: "/Users/test/dev/arc/packages/nested/src",
    })?.title).toBe("OpenScout");
    expect(chooseInitialProjectLaunchTarget(targets, {
      currentDirectory: "/Users/test/dev/arc/packages/nested/src",
    })?.title).toBe("Nested");
  });

  test("the last project actually picked outranks cwd, and route context outranks both", () => {
    const targets = buildProjectLaunchTargets([
      ...inventory,
      { ...inventory[0]!, id: "project:nested", title: "Nested", root: "/Users/test/dev/arc/packages/nested" },
    ], []);
    expect(chooseInitialProjectLaunchTarget(targets, {
      currentDirectory: "/Users/test/dev/arc/packages/nested/src",
      recentRoots: ["/Users/test/dev/openscout"],
    })?.title).toBe("OpenScout");
    expect(chooseInitialProjectLaunchTarget(targets, {
      preferredRoot: "/Users/test/dev/arc",
      currentDirectory: "/Users/test/dev/arc/packages/nested/src",
      recentRoots: ["/Users/test/dev/openscout"],
    })?.title).toBe("Arc");
  });

  test("a stale recent root is skipped rather than blocking the fallbacks", () => {
    const targets = buildProjectLaunchTargets(inventory, []);
    expect(chooseInitialProjectLaunchTarget(targets, {
      currentDirectory: "/Users/test/dev/arc/src",
      recentRoots: ["/Users/test/dev/deleted", "  "],
    })?.title).toBe("Arc");
  });

  test("recently picked projects lead the standing list; the rest stay alphabetical", () => {
    const targets = buildProjectLaunchTargets(inventory, [agent] as Agent[]);
    expect(
      orderProjectLaunchTargetsByRecency(targets, ["/work/openscout", "/Users/test/dev/gone"])
        .map((target) => target.root),
    ).toEqual([
      "/work/openscout",
      "/Users/test/dev/arc",
      "/Users/test/dev/openscout",
    ]);
    // No recency yet is the only case that should look alphabetical.
    expect(orderProjectLaunchTargetsByRecency(targets, []).map((target) => target.root))
      .toEqual(targets.map((target) => target.root));
  });

  test("an unfiltered search preserves the caller's recency order", () => {
    const targets = orderProjectLaunchTargetsByRecency(
      buildProjectLaunchTargets(inventory, []),
      ["/Users/test/dev/openscout"],
    );
    expect(searchProjectLaunchTargets(targets, "").map((target) => target.title))
      .toEqual(["OpenScout", "Arc"]);
  });
});
