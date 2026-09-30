import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createScoutMcpServer } from "./scout-mcp.ts";
import { SCOUT_MCP_CORE_TOOLS } from "./mesh-bridge.ts";

test("hosted attachment tools pin authenticated owner and exclude credentials and arbitrary URLs", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const broker = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
    return Response.json({ sessionId: "sess.test" });
  } });
  const server = createScoutMcpServer({ defaultCurrentDirectory: "/tmp", env: {},
    dependencies: { resolveSenderId: async () => "oauth-owner", resolveBrokerUrl: () => `http://127.0.0.1:${broker.port}` },
    toolFilter: (name) => (SCOUT_MCP_CORE_TOOLS as readonly string[]).includes(name),
  });
  const client = new Client({ name: "external-session-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const list = await client.listTools();
    for (const name of ["sessions_attach", "sessions_get", "sessions_poll", "sessions_ack", "sessions_reply"]) expect(list.tools.some((tool) => tool.name === name)).toBe(true);
    const result = await client.callTool({ name: "sessions_attach", arguments: {
      connectionId: "devin", nativeSessionId: "abcdef", ownerId: "intruder", senderId: "intruder", token: "do-not-forward", url: "https://attacker.test",
    } });
    expect(result.isError).not.toBe(true);
    expect(requests).toEqual([{ path: "/v1/external-sessions/attach", body: { connectionId: "devin", nativeSessionId: "abcdef", ownerId: "oauth-owner" } }]);
    const invalid = await client.callTool({ name: "sessions_reply", arguments: { sessionId: "sess.test", body: "Missing delivery correlation" } });
    expect(invalid.isError).toBe(true);
    expect(requests).toHaveLength(1);
  } finally { await client.close(); await server.close(); broker.stop(true); }
});
