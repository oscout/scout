import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createAskRoutes } from "./ask.ts";
import {
  buildScoutAskCommand,
  parseAskApiBody,
} from "./ask-contract.ts";
import type { ScoutAskCommand } from "../../core/broker/ask-types.ts";

function createAskRouteTestApp(options: {
  scoutAskHandler?: (input: ScoutAskCommand) => Promise<{
    ok: boolean;
    state: "queued" | "completed" | "failed" | "ambiguous";
    ids: {
      targetAgentId?: string;
      invocationId?: string;
      flightId?: string;
      workId?: string;
    };
    next?: {
      tool: "agents_resolve" | "agents_search" | "agents_start";
      arguments: Record<string, unknown>;
      reason: string;
    };
  }>;
} = {}) {
  const app = new Hono();
  const calls: ScoutAskCommand[] = [];
  app.route(
    "/api",
    createAskRoutes({
      currentDirectory: "/tmp/openscout-test",
      dependencies: {
        resolveSenderId: async (senderId) => senderId?.trim() || "operator.main",
        scoutAskHandler: async (input) => {
          calls.push(input);
          return options.scoutAskHandler
            ? options.scoutAskHandler(input)
            : {
                ok: true,
                state: "queued",
                ids: {
                  targetAgentId: "talkie.main",
                  invocationId: "inv-1",
                  flightId: "flt-1",
                },
              };
        },
      },
    }),
  );
  return { app, calls };
}

describe("createAskRoutes", () => {
  test("posts a clean ask through the ask service", async () => {
    const { app, calls } = createAskRouteTestApp();

    const response = await app.request("http://localhost/api/ask", {
      method: "POST",
      body: JSON.stringify({
        to: "talkie",
        body: "How did you handle auth?",
        harness: "claude",
        workspace: "new_worktree",
        session: "new",
        workItem: {
          title: "Compare auth approaches",
          priority: "normal",
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      state: "queued",
      ids: {
        targetAgentId: "talkie.main",
        invocationId: "inv-1",
        flightId: "flt-1",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      senderId: "operator.main",
      to: "talkie",
      body: "How did you handle auth?",
      harness: "claude",
      workspace: "new_worktree",
      session: "new",
      currentDirectory: "/tmp/openscout-test",
      source: "scout-control-plane-ask",
      workItem: {
        title: "Compare auth approaches",
        priority: "normal",
      },
    });
  });

  test("returns one next call when ask routing is ambiguous", async () => {
    const { app } = createAskRouteTestApp({
      scoutAskHandler: async () => ({
        ok: false,
        state: "ambiguous",
        ids: {},
        next: {
          tool: "agents_resolve",
          arguments: {
            label: "vox",
            currentDirectory: "/tmp/openscout-test",
          },
          reason: "Choose one concrete target, then retry the ask.",
        },
      }),
    });

    const response = await app.request("http://localhost/api/ask", {
      method: "POST",
      body: JSON.stringify({
        to: "vox",
        body: "Review this.",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      state: "ambiguous",
      ids: {},
      next: {
        tool: "agents_resolve",
        arguments: {
          label: "vox",
          currentDirectory: "/tmp/openscout-test",
        },
        reason: "Choose one concrete target, then retry the ask.",
      },
    });
  });

  test("posts a project-path ask without an agent label", async () => {
    const { app, calls } = createAskRouteTestApp();

    const response = await app.request("http://localhost/api/ask", {
      method: "POST",
      body: JSON.stringify({
        projectPath: "/tmp/talkie",
        body: "How did you handle auth?",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    expect(calls[0]).toMatchObject({
      senderId: "operator.main",
      projectPath: "/tmp/talkie",
      body: "How did you handle auth?",
      currentDirectory: "/tmp/openscout-test",
      source: "scout-control-plane-ask",
    });
  });

  test("rejects ambiguous ask targets at the contract boundary", async () => {
    const { app, calls } = createAskRouteTestApp();

    const response = await app.request("http://localhost/api/ask", {
      method: "POST",
      body: JSON.stringify({
        to: "talkie",
        projectPath: "/tmp/talkie",
        body: "Review this.",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "invalid_field",
        message: "to cannot be combined with projectPath or profile",
        field: "projectPath",
      },
    });
    expect(calls).toEqual([]);
  });

  test("validates the ask shape before routing", async () => {
    const { app, calls } = createAskRouteTestApp();

    const response = await app.request("http://localhost/api/ask", {
      method: "POST",
      body: JSON.stringify({
        body: "Review this.",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "missing_field",
        message: "to, projectPath, profile, runtime, or harness is required",
        field: "to",
      },
    });
    expect(calls).toEqual([]);
  });
});

describe("ask route contract", () => {
  test("allows a profile launch narrowed to a project", () => {
    const parsed = parseAskApiBody({
      projectPath: "/tmp/talkie",
      profile: "fable",
      body: "Review this",
    });
    expect(parsed).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        projectPath: "/tmp/talkie",
        profile: "fable",
      }),
    }));
    if (parsed.ok) {
      expect(buildScoutAskCommand({
        payload: parsed.value,
        senderId: "operator.main",
        currentDirectory: "/tmp/openscout",
      })).toEqual(expect.objectContaining({
        projectPath: "/tmp/talkie",
        runtimeProfile: "fable",
      }));
    }
  });

  test("normalizes ask input without Hono state", () => {
    const payload = parseAskApiBody({
      senderId: " operator.main ",
      to: " talkie ",
      body: " Review this ",
      workspace: "new_worktree",
      shouldSpeak: false,
      workItem: {
        title: " Auth review ",
        labels: [" api ", ""],
      },
    });

    expect(payload).toEqual({
      ok: true,
      value: {
        senderId: "operator.main",
        to: "talkie",
        body: "Review this",
        workspace: "new_worktree",
        shouldSpeak: false,
        workItem: {
          title: "Auth review",
          labels: ["api"],
        },
      },
    });
    if (!payload.ok) {
      throw new Error("expected ask payload to parse");
    }

    expect(
      buildScoutAskCommand({
        payload: payload.value,
        senderId: "operator.main",
        currentDirectory: "/tmp/openscout-test",
      }),
    ).toEqual({
      senderId: "operator.main",
      to: "talkie",
      body: "Review this",
      harness: undefined,
      model: undefined,
      reasoningEffort: undefined,
      runtimeLiteral: undefined,
      workspace: "new_worktree",
      session: undefined,
      channel: undefined,
      shouldSpeak: false,
      workItem: {
        title: "Auth review",
        labels: ["api"],
      },
      replyMode: "none",
      currentDirectory: "/tmp/openscout-test",
      source: "scout-control-plane-ask",
    });
  });

  test("carries foreground placement into the broker ask command", () => {
    const payload = parseAskApiBody({
      projectPath: "/tmp/talkie",
      harness: "codex",
      placement: "foreground",
      body: "Review this where I can chime in",
    });
    expect(payload).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ placement: "foreground" }),
    }));
    if (!payload.ok) throw new Error("expected foreground ask payload to parse");
    expect(buildScoutAskCommand({
      payload: payload.value,
      senderId: "operator",
      currentDirectory: "/tmp/openscout-test",
    })).toEqual(expect.objectContaining({ placement: "foreground" }));

    expect(parseAskApiBody({
      projectPath: "/tmp/talkie",
      placement: "visible",
      body: "Review this",
    })).toEqual(expect.objectContaining({ ok: false }));
  });

  test("desugars RuntimeSpec and rejects conflicting dimensions", () => {
    const payload = parseAskApiBody({
      runtime: "codex/gpt-5.6-sol/xhigh",
      body: "Review this",
    });
    expect(payload).toEqual({
      ok: true,
      value: {
        runtime: "codex/gpt-5.6-sol/xhigh",
        body: "Review this",
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        executionSource: {
          harness: "literal",
          model: "literal",
          reasoningEffort: "literal",
        },
      },
    });
    if (!payload.ok) throw new Error("expected RuntimeSpec payload to parse");
    expect(buildScoutAskCommand({
      payload: payload.value,
      senderId: "operator",
      currentDirectory: "/tmp/openscout-test",
    })).toEqual(expect.objectContaining({
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      runtimeLiteral: "codex/gpt-5.6-sol/xhigh",
    }));

    expect(parseAskApiBody({
      runtime: "codex/gpt-5.6-sol/xhigh",
      model: "gpt-5.6-terra",
      body: "Review this",
    })).toEqual(expect.objectContaining({ ok: false }));
  });
});
