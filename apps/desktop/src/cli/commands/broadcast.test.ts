import { afterEach, describe, expect, test } from "bun:test";

import { namedChannelNaturalKey, stableChannelId, type ConversationDefinition } from "@openscout/protocol";

import { sendScoutMessage as sendRuntimeMessage } from "../../../../../packages/runtime/src/scout-broker.ts";
import { sendScoutMessage as sendWebMessage } from "../../../../../packages/web/server/core/broker/service.ts";

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

  for (const surface of ["desktop", "web", "runtime"] as const) test(`${surface} broadcasts snapshot live membership without accumulating old participants`, async () => {
    process.env.OPENSCOUT_BROKER_URL = "http://broker.test";
    process.env.OPENSCOUT_BROKER_SOCKET_PATH = "/nonexistent/openscout-broadcast-test.sock";
    const sharedConversationId = stableChannelId(namedChannelNaturalKey("broadcast"));
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

    const endpoints = {
      one: { id: "one", agentId: "agent-one", state: "active" },
      two: { id: "two", agentId: "agent-two", state: "offline" },
    };
    const oldId = stableChannelId(namedChannelNaturalKey("shared"));
    const legacy = {
      id: oldId, kind: "channel", title: "shared-channel", visibility: "workspace",
      shareMode: "shared", authorityNodeId: "node-1", participantIds: Object.keys(agents),
      metadata: { channel: "shared", naturalKey: namedChannelNaturalKey("shared") },
    } as ConversationDefinition;
    const conversations: Record<string, ConversationDefinition> = { [oldId]: legacy };
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
          endpoints,
          conversations,
          messages: {},
          flights: {},
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        const conversation = await request.json() as ConversationDefinition;
        postedConversations.push(conversation);
        conversations[conversation.id] = conversation;
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

    const senderId = surface === "runtime" ? "agent-three" : "operator";
    const participants = (live: string[]) => [...new Set(["operator", senderId, ...live])].sort();
    const send = () => surface === "desktop"
      ? runBroadcastCommand(context, ["--as", "operator", "test"])
      : (surface === "web" ? sendWebMessage : sendRuntimeMessage)({ senderId, channel: "shared", body: "test", currentDirectory: context.cwd });
    await send();

    expect(postedConversations).toHaveLength(1);
    expect(postedConversations[0]).toMatchObject({
      id: sharedConversationId,
      participantIds: participants(["agent-one"]),
      metadata: { channel: "broadcast" },
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
    if (surface === "desktop") expect(output).toEqual(["Broadcast: test\nRoute: broadcast"]);
    endpoints.one.state = "offline";
    endpoints.two.state = "active";
    await send();
    expect(conversations[sharedConversationId]?.participantIds).toEqual(participants(["agent-two"]));
    endpoints.two.state = "offline";
    await send();
    expect(conversations[sharedConversationId]?.participantIds).toEqual(participants([]));
    expect(conversations[oldId]).toBe(legacy);
    expect(postedConversations).toHaveLength(3);
  });
});
