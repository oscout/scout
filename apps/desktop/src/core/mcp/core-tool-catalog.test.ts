import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SCOUT_MCP_CORE_TOOL_CATALOG } from "@openscout/protocol";

import { createScoutMcpServer } from "./scout-mcp.ts";
import { SCOUT_MCP_CORE_TOOLS } from "./mesh-bridge.ts";

// The hosted gateway's directory listing and docs are generated from the
// protocol catalog, so it must describe exactly what the bridge serves.
test("mcp:core catalog matches the tools the hosted bridge registers", async () => {
  const server = createScoutMcpServer({
    defaultCurrentDirectory: "/tmp",
    env: {},
    toolFilter: (name) => (SCOUT_MCP_CORE_TOOLS as readonly string[]).includes(name),
  });
  const client = new Client({ name: "core-catalog-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const registered = new Map(tools.map((tool) => [tool.name, tool]));

    expect([...registered.keys()].sort()).toEqual(SCOUT_MCP_CORE_TOOL_CATALOG.map((tool) => tool.name).sort());
    for (const entry of SCOUT_MCP_CORE_TOOL_CATALOG) {
      const tool = registered.get(entry.name)!;
      expect({ name: entry.name, title: tool.title }).toEqual({ name: entry.name, title: entry.title });
      expect({ name: entry.name, readOnly: tool.annotations?.readOnlyHint === true })
        .toEqual({ name: entry.name, readOnly: entry.access === "read" });
      expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
      expect(entry.name.length).toBeLessThanOrEqual(64);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("hosted tier descriptions never point at tools it does not expose", async () => {
  const server = createScoutMcpServer({
    defaultCurrentDirectory: "/tmp",
    env: {},
    toolFilter: (name) => (SCOUT_MCP_CORE_TOOLS as readonly string[]).includes(name),
  });
  const client = new Client({ name: "core-description-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const exposed = new Set(tools.map((tool) => tool.name));
    for (const tool of tools) {
      const mentioned = (tool.description ?? "").match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
      for (const name of mentioned) {
        if (/^(agents|messages|sessions|invocations|labels|broker|tail|work|notify|consult|feedback|current)_/.test(name)) {
          expect({ tool: tool.name, mentions: name, exposed: exposed.has(name) }).toEqual({ tool: tool.name, mentions: name, exposed: true });
        }
      }
    }
  } finally {
    await client.close();
    await server.close();
  }
});
