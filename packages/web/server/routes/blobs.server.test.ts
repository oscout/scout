import { describe, expect, test } from "bun:test";
import {
  stubs,
  askScoutQuestionCalls,
  createOpenScoutWebServer,
  makeStaticRoot,
  queryRunsCalls,
  sendScoutConversationMessageCalls,
  sendScoutConversationSteerCalls,
  sendScoutDirectMessageCalls,
  sendScoutMessageCalls,
  installWebServerTestHooks,
  loadWebServerUnderTest,
} from "../web-server-test-harness.ts";

// Loads the server modules behind the harness mocks (see the harness for why
// this is awaited here rather than at the harness top level).
await loadWebServerUnderTest();
installWebServerTestHooks();

describe("createOpenScoutWebServer: blobs routes", () => {
  test("invokes direct DM sends in the selected Chat by default", async () => {
    stubs.querySessionByIdImpl = () => ({
      kind: "direct",
      agentId: "agent-1",
      participantIds: ["operator", "agent-1"],
    });

    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });
    const response = await server.app.request("http://localhost/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Status update",
        chatId: "c.agent-1",
        attachments: [
          {
            id: "att-1",
            mediaType: "image/png",
            fileName: "screenshot.png",
            url: "http://127.0.0.1:3200/api/blobs/blob-1",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(sendScoutConversationSteerCalls).toEqual([
      expect.objectContaining({
        conversationId: "c.agent-1",
        senderId: "operator",
        body: "Status update",
        attachments: [
          {
            id: "att-1",
            mediaType: "image/png",
            fileName: "screenshot.png",
            url: "http://127.0.0.1:3200/api/blobs/blob-1",
          },
        ],
        intent: "invoke",
        currentDirectory: "/tmp/openscout",
        source: "scout-web",
      }),
    ]);
    expect(sendScoutDirectMessageCalls).toHaveLength(0);
    expect(sendScoutConversationMessageCalls).toHaveLength(0);
    expect(sendScoutMessageCalls).toHaveLength(0);
    expect(queryRunsCalls).toEqual([{
      conversationId: "c.agent-1",
      active: true,
      limit: 100,
    }]);
  });

  test("routes session initiation effort and fork source through askScoutQuestion", async () => {
    process.env.OPENSCOUT_OPERATOR_NAME = "operator";
    const server = await createOpenScoutWebServer({
      currentDirectory: "/tmp/openscout",
      assetMode: "static",
      staticRoot: makeStaticRoot(),
    });

    const response = await server.app.request("http://localhost/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { projectPath: "/tmp/openscout" },
        execution: {
          harness: "codex",
          model: "gpt-5.5",
          reasoningEffort: "high",
          session: "fork",
          forkFromSessionId: "session-source-1",
        },
        agent: { persistence: "sticky", handle: "hudson" },
        seed: {
          instructions: "Pick this up from the prior run.",
          attachments: [
            {
              mediaType: "text/markdown",
              url: "http://127.0.0.1:3200/api/blobs/blob-1",
              fileName: "notes.md",
            },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: true,
      conversationId: "c.agent-1",
      flightId: "flt-ask-1",
      handle: "hudson",
    }));
    expect(askScoutQuestionCalls).toEqual([
      {
        senderId: expect.any(String),
        target: { kind: "project_path", projectPath: "/tmp/openscout" },
        body: "Pick this up from the prior run.",
        executionHarness: "codex",
        executionModel: "gpt-5.5",
        executionReasoningEffort: "high",
        executionSession: "fork",
        executionForkFromSessionId: "session-source-1",
        attachments: [
          {
            mediaType: "text/markdown",
            url: "http://127.0.0.1:3200/api/blobs/blob-1",
            fileName: "notes.md",
          },
        ],
        projectAgent: { persistence: "sticky", handle: "hudson" },
        currentDirectory: "/tmp/openscout",
        source: "scout-session-initiation",
      },
    ]);
  });
});
