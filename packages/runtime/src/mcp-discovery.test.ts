import { describe, expect, test } from "bun:test";

import {
  discoverConfiguredMcpServers,
  type McpDiscoveryJsonRpcTransport,
  type RuntimeMcpServerConfig,
} from "./mcp-discovery.js";
import { buildRuntimeCapabilityMatrixSnapshot } from "./capability-matrix.js";

class FakeMcpTransport implements McpDiscoveryJsonRpcTransport {
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  readonly notifications: Array<{ method: string; params?: unknown }> = [];
  closed = false;

  constructor(
    private readonly handler: (method: string, params?: unknown) => unknown | Promise<unknown>,
  ) {}

  async request<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
    this.requests.push({ method, params });
    return await this.handler(method, params) as TResult;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("MCP discovery", () => {
  test("discovers initialize and tools/list metadata without invoking tools", async () => {
    const transports: FakeMcpTransport[] = [];
    const result = await discoverConfiguredMcpServers({
      now: () => 1710000001000,
      scope: { projectRoot: "/repo" },
      requestedProtocolVersion: "2025-11-25",
      servers: [{
        id: "filesystem",
        name: "Filesystem",
        command: "ignored",
      }],
      createTransport: () => {
        const transport = new FakeMcpTransport((method) => {
          if (method === "initialize") {
            return {
              protocolVersion: "2025-11-25",
              capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true },
              },
              serverInfo: {
                name: "filesystem-server",
              },
            };
          }
          if (method === "tools/list") {
            return {
              tools: [{
                name: "read_file",
                description: "Read a file.",
                annotations: {
                  readOnlyHint: true,
                },
              }],
            };
          }
          throw new Error(`unexpected method ${method}`);
        });
        transports.push(transport);
        return transport;
      },
    });

    expect(result.warnings).toEqual([]);
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]).toMatchObject({
      kind: "mcp_tools",
      serverId: "filesystem",
      serverName: "Filesystem",
      protocolVersion: "2025-11-25",
      capturedAt: 1710000001000,
      scope: { projectRoot: "/repo" },
      enabled: true,
    });
    expect(transports[0]?.requests.map((request) => request.method)).toEqual([
      "initialize",
      "tools/list",
    ]);
    expect(transports[0]?.notifications.map((notification) => notification.method)).toEqual([
      "notifications/initialized",
    ]);
    expect(transports[0]?.closed).toBe(true);

    const snapshot = buildRuntimeCapabilityMatrixSnapshot({
      generatedAt: 1710000001000,
      inputs: result.inputs,
    });
    expect(snapshot.capabilities.map((capability) => capability.id)).toEqual([
      "cap:mcp:filesystem:tool:read_file",
    ]);
    expect(snapshot.capabilities[0]?.methods[0]?.effects).toEqual(["read"]);
    expect(snapshot.capabilities[0]?.readiness).toMatchObject({
      state: "ready",
      detail: "MCP server responded to initialize and tools/list.",
      checkedAt: 1710000001000,
    });
    expect(snapshot.capabilities[0]?.readiness.evidence).toContainEqual(
      expect.objectContaining({
        kind: "runtime_probe",
        ref: "mcp:filesystem:initialize+tools/list",
        trust: "observed",
      }),
    );
  });

  test("follows tools/list cursors up to completion", async () => {
    const transport = new FakeMcpTransport((method, params) => {
      if (method === "initialize") {
        return { protocolVersion: "2025-11-25", capabilities: { tools: {} } };
      }
      if (method === "tools/list") {
        if (!params) {
          return {
            tools: [{ name: "first" }],
            nextCursor: "page-2",
          };
        }
        return {
          tools: [{ name: "second" }],
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await discoverConfiguredMcpServers({
      now: () => 1710000001001,
      servers: [{ id: "paged", command: "ignored" }],
      createTransport: () => transport,
    });

    expect(transport.requests).toMatchObject([
      { method: "initialize" },
      { method: "tools/list", params: undefined },
      { method: "tools/list", params: { cursor: "page-2" } },
    ]);
    expect(result.inputs[0]).toMatchObject({
      kind: "mcp_tools",
      tools: {
        tools: [
          { name: "first" },
          { name: "second" },
        ],
      },
    });
  });

  test("records disabled servers as probe inputs without creating a transport", async () => {
    let created = false;
    const result = await discoverConfiguredMcpServers({
      now: () => 1710000001002,
      servers: [{
        id: "disabled",
        command: "ignored",
        disabled: true,
      }],
      createTransport: () => {
        created = true;
        throw new Error("should not be called");
      },
    });

    expect(created).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.inputs).toEqual([{
      kind: "runtime_probe",
      id: "mcp:disabled",
      name: undefined,
      capturedAt: 1710000001002,
      raw: {
        target: "mcp_server",
        serverId: "disabled",
        state: "disabled",
        reason: "MCP server is disabled.",
      },
    }]);
  });

  test("records failed servers as warnings and probe inputs", async () => {
    const result = await discoverConfiguredMcpServers({
      now: () => 1710000001003,
      servers: [{
        id: "broken",
        name: "Broken",
        command: "ignored",
      }],
      createTransport: () => new FakeMcpTransport((method) => {
        if (method === "initialize") {
          throw new Error("connection refused");
        }
        throw new Error(`unexpected method ${method}`);
      }),
    });

    expect(result.warnings).toEqual([
      "MCP server broken discovery failed: connection refused",
    ]);
    expect(result.inputs).toEqual([{
      kind: "runtime_probe",
      id: "mcp:broken",
      name: "Broken",
      capturedAt: 1710000001003,
      raw: {
        target: "mcp_server",
        serverId: "broken",
        state: "failed",
        reason: "connection refused",
      },
    }]);
  });

  test("records transport creation failures per server and continues", async () => {
    const servers: RuntimeMcpServerConfig[] = [
      { id: "throws", command: "ignored" },
      { id: "works", command: "ignored" },
    ];

    const result = await discoverConfiguredMcpServers({
      now: () => 1710000001004,
      servers,
      createTransport: (server) => {
        if (server.id === "throws") {
          throw new Error("missing binary");
        }
        return new FakeMcpTransport((method) => {
          if (method === "initialize") {
            return { protocolVersion: "2025-11-25", capabilities: { tools: {} } };
          }
          if (method === "tools/list") {
            return { tools: [{ name: "ok" }] };
          }
          throw new Error(`unexpected method ${method}`);
        });
      },
    });

    expect(result.warnings).toEqual([
      "MCP server throws discovery failed: missing binary",
    ]);
    expect(result.inputs.map((input) => input.kind)).toEqual([
      "runtime_probe",
      "mcp_tools",
    ]);
  });
});
