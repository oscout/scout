import { describe, expect, test } from "bun:test";

import { renderScoutActivityList, renderScoutAgentList, renderScoutMessagePostResult } from "./broker.ts";

describe("renderScoutAgentList", () => {
  test("renders agent and exact-session route aliases as secondary pointers, not roster rows", () => {
    const rendered = renderScoutAgentList([{
      agentId: "agent-reviewer",
      state: "active",
      messages: 0,
      lastSeen: null,
      registrationKind: "configured",
      aliases: [
        {
          id: "alias-1",
          alias: "review",
          revision: 2,
          state: "active",
          scopeProjectKey: "project:alpha",
          scopeProjectRoot: "/work/alpha",
          scopeNodeId: "node-1",
          target: { kind: "agent", agentId: "agent-reviewer", nodeId: "node-1" },
        },
        {
          id: "alias-2",
          alias: "patch",
          revision: 1,
          state: "active",
          scopeProjectKey: "project:alpha",
          scopeProjectRoot: "/work/alpha",
          scopeNodeId: "node-1",
          target: {
            kind: "session",
            sessionId: "session-exact",
            agentId: "agent-reviewer",
            endpointId: "endpoint-exact",
            nodeId: "node-1",
            harness: "codex",
          },
        },
      ],
    }]);

    expect(rendered.match(/agent-reviewer/g)?.length).toBe(2);
    expect(rendered).toContain("Aliases: review → agent-reviewer (r2), patch → session:session-exact (r1)");
  });
});

describe("renderScoutMessagePostResult", () => {
  test("renders durable handles for normal sends", () => {
    expect(renderScoutMessagePostResult({
      message: "hello",
      senderId: "lattices.codex-event-tap-thread.mini",
      conversationId: "dm.operator.hudson.main.mini",
      messageId: "msg-1",
      invokedTargets: ["hudson.main.mini"],
      unresolvedTargets: [],
      routeKind: "dm",
    })).toBe("Sent.\nConversation: dm.operator.hudson.main.mini\nMessage: msg-1");
  });

  test("renders the local product target as Scout", () => {
    expect(renderScoutMessagePostResult({
      message: "hello",
      conversationId: "channel.shared",
      invokedTargets: ["scout"],
      unresolvedTargets: [],
      routeKind: "broadcast",
    })).toBe("Sent to Scout.\nConversation: channel.shared");
  });

  test("renders wake flight ids when a send queued work", () => {
    expect(renderScoutMessagePostResult({
      message: "hello",
      conversationId: "dm.operator.hudson",
      flightId: "flt-1",
      invokedTargets: ["hudson.main"],
      unresolvedTargets: [],
      routeKind: "dm",
    })).toBe("Sent.\nConversation: dm.operator.hudson\nDelivery flight: flt-1\nNext: scout wait flt-1 --timeout 600");
  });
});

describe("renderScoutActivityList", () => {
  test("handles empty activity", () => {
    expect(renderScoutActivityList([])).toBe("No Scout activity yet.");
  });

  test("renders recent ask activity with participants", () => {
    const rendered = renderScoutActivityList([
      {
        id: "activity:1",
        kind: "ask_opened",
        ts: 1_700_000_000,
        actorId: "operator",
        counterpartId: "vox",
        title: "Review the latest web server change",
      },
    ]);

    expect(rendered).toContain("asked");
    expect(rendered).toContain("operator -> vox");
    expect(rendered).toContain("Review the latest web server change");
  });
});
