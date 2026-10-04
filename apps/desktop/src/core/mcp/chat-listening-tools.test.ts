import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerChatListeningTools } from "./chat-listening-tools.ts";
test("MCP exposes exactly three one-shot tools, forwards exact scope and requires explicit ack", async () => {
  const server = new McpServer({ name: "test", version: "1" }), client = new Client({ name: "test", version: "1" });
  const calls: unknown[] = [];
  registerChatListeningTools(server, async (operation, body) => { calls.push({ operation, body }); return { ack: "receipt", messages: [] }; });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
  try {
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(["chat_ack", "chat_catch_up", "chat_status"]);
    await client.callTool({ name: "chat_status", arguments: { sessionId: "native" } });
    await client.callTool({ name: "chat_catch_up", arguments: { sessionId: "native", subscriptionId: "sub", limit: 5 } });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ operation: "catch-up", body: { agentId: "session:native", subscriptionId: "sub", limit: 5 } });
    await client.callTool({ name: "chat_ack", arguments: { agentId: "durable", subscriptionId: "sub", receipt: "receipt" } });
    expect(calls[2]).toEqual({ operation: "ack", body: { agentId: "durable", subscriptionId: "sub", receipt: "receipt" } });
    expect((await client.callTool({ name: "chat_status", arguments: { agentId: "a", sessionId: "b" } })).isError).toBe(true);
    expect(calls).toHaveLength(3);
  } finally { await client.close(); await server.close(); }
});
