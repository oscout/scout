import { afterEach, describe, expect, test } from "bun:test";

import { namedChannelNaturalKey, stableChannelId } from "@openscout/protocol";

import { createScoutCommandContext } from "../context.ts";
import { renderBroadcastCommandHelp, runBroadcastCommand } from "./broadcast.ts";

const originalBrokerUrl = process.env.OPENSCOUT_BROKER_URL;
const originalBrokerSocketPath = process.env.OPENSCOUT_BROKER_SOCKET_PATH;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalBrokerUrl === undefined) {
    delete process.env.OPENSCOUT_BROKER_URL;
  } else {
    process.env.OPENSCOUT_BROKER_URL = originalBrokerUrl;
  }
  if (originalBrokerSocketPath === undefined) {
    delete process.env.OPENSCOUT_BROKER_SOCKET_PATH;
  } else {
    process.env.OPENSCOUT_BROKER_SOCKET_PATH = originalBrokerSocketPath;
  }
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("broadcast command helpers", () => {
  test("documents shared-broadcast-only semantics", () => {
    const help = renderBroadcastCommandHelp();

    expect(help).toContain("Broadcast to channel.shared.");
    expect(help).toContain("Do not use broadcast for ordinary one-to-one delegation");
    expect(help).toContain("--message-file <path>");
  });

  test("rejects an explicit channel override", async () => {
    const context = createScoutCommandContext({
      cwd: "/tmp/openscout-test",
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
      isTty: false,
    });

    await expect(runBroadcastCommand(context, ["--channel", "triage", "hello"]))
      .rejects
      .toThrow("broadcast always targets channel.shared; do not pass --channel");
  });

  test("posts once to channel.shared with multiple known agents", async () => {
    process.env.OPENSCOUT_BROKER_URL = "http://broker.test";
    process.env.OPENSCOUT_BROKER_SOCKET_PATH = "/nonexistent/openscout-broadcast-test.sock";
    const sharedConversationId = stableChannelId(namedChannelNaturalKey("shared"));
    const requests: Array<{ method: string; path: string }> = [];
    const postedConversations: unknown[] = [];
    const postedMessages: Array<{
      conversationId: string;
      body: string;
      mentions?: unknown;
      audience?: unknown;
    }> = [];
    const agents = Object.fromEntries(
      ["agent-one", "agent-two", "agent-three"].map((id) => [
        id,
        {
          id,
          kind: "agent",
          displayName: id,
          handle: id,
          homeNodeId: "node-1",
          authorityNodeId: "node-1",
          wakePolicy: "on_demand",
        },
      ]),
    );

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true, nodeId: "node-1", meshId: "mesh-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/node") {
        return jsonResponse({ id: "node-1" });
      }
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        return jsonResponse({
          actors: {
            operator: {
              id: "operator",
              kind: "person",
              displayName: "Operator",
              handle: "operator",
            },
          },
          agents,
          endpoints: {},
          conversations: {},
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        postedConversations.push(await request.json());
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        postedMessages.push(await request.json() as (typeof postedMessages)[number]);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const output: string[] = [];
    const context = createScoutCommandContext({
      cwd: "/worktree/project",
      env: {},
      stdout: (line) => output.push(line),
      stderr: () => undefined,
      isTty: false,
    });

    await runBroadcastCommand(context, ["--as", "operator", "test"]);

    expect(postedConversations).toHaveLength(1);
    expect(postedConversations[0]).toMatchObject({
      id: sharedConversationId,
      participantIds: ["agent-one", "agent-three", "agent-two", "operator"],
      metadata: { channel: "shared" },
    });
    expect(postedMessages).toEqual([
      expect.objectContaining({
        conversationId: sharedConversationId,
        body: "test",
        mentions: [],
      }),
    ]);
    expect(postedMessages[0]?.audience).toBeUndefined();
    expect(
      requests.filter((request) => request.method === "POST" && request.path === "/v1/messages"),
    ).toHaveLength(1);
    expect(requests.some((request) => request.path === "/v1/deliver")).toBe(false);
    expect(output).toEqual(["Broadcast: test\nRoute: broadcast"]);
  });
});
