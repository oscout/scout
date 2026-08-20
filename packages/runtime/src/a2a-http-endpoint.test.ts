import { afterEach, describe, expect, test } from "bun:test";

import type { AgentEndpoint, InvocationRequest } from "@openscout/protocol";

import {
  a2aExecutionUrlForEndpoint,
  invokeA2AHttpEndpoint,
  isA2AHttpEndpoint,
} from "./a2a-http-endpoint";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function startJsonServer(
  handler: (request: Request) => Response | Promise<Response>,
): string {
  const server = Bun.serve({
    port: 0,
    fetch: handler,
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function makeEndpoint(input: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return {
    id: "endpoint.a2a.local",
    agentId: "a2a-agent.local",
    nodeId: "node.local",
    harness: "http",
    transport: "http",
    state: "active",
    projectRoot: "/tmp/a2a-agent",
    cwd: "/tmp/a2a-agent",
    metadata: {},
    ...input,
  };
}

function makeInvocation(input: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    id: "inv-a2a",
    requesterId: "operator",
    requesterNodeId: "node.local",
    targetAgentId: "a2a-agent.local",
    action: "consult",
    task: "What is the weather in Montreal?",
    ensureAwake: true,
    stream: false,
    createdAt: 1,
    ...input,
  };
}

describe("A2A HTTP endpoints", () => {
  test("recognizes A2A execution URLs on HTTP endpoints", () => {
    const endpoint = makeEndpoint({
      metadata: {
        supportedInterfaces: [
          {
            protocol: "a2a",
            transport: "http",
            url: "http://127.0.0.1:4111/api/a2a/weather-agent",
          },
        ],
      },
    });

    expect(a2aExecutionUrlForEndpoint(endpoint)).toBe("http://127.0.0.1:4111/api/a2a/weather-agent");
    expect(isA2AHttpEndpoint(endpoint)).toBe(true);
    expect(isA2AHttpEndpoint({ ...endpoint, state: "offline" })).toBe(false);
    expect(isA2AHttpEndpoint({ ...endpoint, transport: "websocket" })).toBe(false);
  });

  test("posts message/send and extracts task artifact text", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const baseUrl = startJsonServer(async (request) => {
      requestBody = await request.json() as Record<string, unknown>;
      return Response.json({
        jsonrpc: "2.0",
        id: requestBody.id,
        result: {
          kind: "task",
          id: "task-123",
          contextId: "ctx-456",
          status: { state: "completed" },
          artifacts: [
            {
              parts: [
                {
                  kind: "text",
                  text: "Montreal is clear and 14.5C.",
                },
              ],
            },
          ],
          metadata: {
            provider: "test-a2a",
          },
        },
      });
    });

    const endpoint = makeEndpoint({
      metadata: {
        a2aExecutionUrl: `${baseUrl}/a2a/weather-agent`,
      },
    });
    const result = await invokeA2AHttpEndpoint(endpoint, makeInvocation());

    expect(result.output).toBe("Montreal is clear and 14.5C.");
    expect(result.externalSessionId).toBe("ctx-456");
    expect(result.metadata).toMatchObject({
      a2aExecutionUrl: `${baseUrl}/a2a/weather-agent`,
      a2aTaskId: "task-123",
      a2aContextId: "ctx-456",
      a2aState: "completed",
    });

    expect(requestBody).toMatchObject({
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        message: {
          kind: "message",
          role: "user",
          parts: [
            {
              kind: "text",
              text: "What is the weather in Montreal?",
            },
          ],
          metadata: {
            scoutInvocationId: "inv-a2a",
            scoutRequesterId: "operator",
            scoutAction: "consult",
          },
        },
      },
    });
  });

  test("uses v1 JSON-RPC methods for A2A protocol 1.x cards", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const baseUrl = startJsonServer(async (request) => {
      requestBody = await request.json() as Record<string, unknown>;
      return Response.json({
        jsonrpc: "2.0",
        id: requestBody.id,
        result: {
          task: {
            id: "task-v1",
            contextId: "ctx-v1",
            status: { state: "TASK_STATE_COMPLETED" },
            artifacts: [
              {
                artifactId: "artifact-v1",
                parts: [{ text: "A2A v1 response." }],
              },
            ],
          },
        },
      });
    });

    const endpoint = makeEndpoint({
      metadata: {
        a2aExecutionUrl: `${baseUrl}/a2a/weather-agent`,
        a2aAgentCard: {
          protocolVersion: "1.0",
        },
      },
    });
    const result = await invokeA2AHttpEndpoint(endpoint, makeInvocation());

    expect(result.output).toBe("A2A v1 response.");
    expect(requestBody).toMatchObject({
      method: "SendMessage",
      params: {
        message: {
          role: "ROLE_USER",
          parts: [
            {
              text: "What is the weather in Montreal?",
            },
          ],
        },
      },
    });
  });

  test("falls back to legacy message/send when a v1 endpoint rejects the canonical method", async () => {
    const methods: string[] = [];
    const baseUrl = startJsonServer(async (request) => {
      const body = await request.json() as { id?: string; method?: string };
      methods.push(String(body.method));
      if (body.method === "SendMessage") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "method not found" },
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          kind: "message",
          role: "agent",
          parts: [{ kind: "text", text: "legacy response" }],
        },
      });
    });

    const endpoint = makeEndpoint({
      metadata: {
        a2aExecutionUrl: `${baseUrl}/a2a/weather-agent`,
        a2aProtocolVersion: "1.0",
      },
    });

    const result = await invokeA2AHttpEndpoint(endpoint, makeInvocation());

    expect(result.output).toBe("legacy response");
    expect(methods).toEqual(["SendMessage", "message/send"]);
  });

  test("surfaces JSON-RPC errors", async () => {
    const baseUrl = startJsonServer(() => Response.json({
      jsonrpc: "2.0",
      id: "rpc-error",
      error: {
        code: -32603,
        message: "tool failed",
        data: { detail: "weather provider unavailable" },
      },
    }));
    const endpoint = makeEndpoint({
      metadata: {
        a2aExecutionUrl: `${baseUrl}/a2a/weather-agent`,
      },
    });

    await expect(invokeA2AHttpEndpoint(endpoint, makeInvocation()))
      .rejects
      .toThrow("tool failed (-32603)");
  });
});
