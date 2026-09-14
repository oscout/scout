import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { digestHerdrTopology, type HerdrPaneProjection, type HerdrSessionTopology } from "@openscout/protocol";

import {
  herdrWorkspacesDependencies,
  registerHerdrWorkspaceTools,
  type HerdrWorkspacesDependencies,
} from "./herdr-workspaces.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function clientFor(deps: HerdrWorkspacesDependencies) {
  const server = new McpServer({ name: "test", version: "1" });
  registerHerdrWorkspaceTools(server, deps);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  cleanups.push(async () => { await client.close(); await server.close(); });
  return client;
}

function pane(paneId: string, overrides: Partial<HerdrPaneProjection> = {}): HerdrPaneProjection {
  return {
    paneId, terminalId: `term-${paneId}`, tabId: "w1:t1", workspaceId: "w1", label: null,
    agent: "claude", agentStatus: "idle", agentSession: null, cwd: "/Users/art/dev/openscout",
    foregroundCwd: null, focused: false, scroll: null, ...overrides,
  };
}

function topology(session: string, panes: HerdrPaneProjection[], running = true): HerdrSessionTopology {
  return {
    session, running, observedAt: 1,
    workspaces: [{
      workspaceId: "w1", label: "main", number: 1, focused: true, activeTabId: "w1:t1", agentStatus: "idle",
      tabs: [{ tabId: "w1:t1", workspaceId: "w1", label: "build", number: 1, focused: true, agentStatus: "idle", panes, layout: null }],
    }],
  };
}

function dependencies(overrides: Partial<HerdrWorkspacesDependencies> = {}): HerdrWorkspacesDependencies {
  return {
    readDigests: async () => ({
      digests: [digestHerdrTopology(topology("openscout", [pane("w1:p1", { agentStatus: "blocked" })]))],
      truncated: false,
      available: true,
    }),
    ...overrides,
  };
}

describe("herdr_workspaces", () => {
  test("leads with what is blocked and carries the digest as structured content", async () => {
    const client = await clientFor(dependencies());
    const result = await client.callTool({ name: "herdr_workspaces", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("herdr · openscout — live");
    expect(text.indexOf("Waiting on you")).toBeLessThan(text.indexOf("Grouped by directory"));
    expect(result.structuredContent).toMatchObject({
      source: "herdr_topology_projection",
      available: true,
      coverage: "this_host_only",
      truncated: false,
    });
  });

  test("an unreachable herdr reports unavailable, never an empty workspace list", async () => {
    const client = await clientFor(dependencies({
      readDigests: async () => ({ digests: [], truncated: false, available: false }),
    }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: {} });
    expect(result.structuredContent).toMatchObject({ available: false, reason: "herdr_unavailable" });
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("not evidence that there are no workspaces");
  });

  test("no sessions is an ordinary empty state, distinct from unavailable", async () => {
    const client = await clientFor(dependencies({
      readDigests: async () => ({ digests: [], truncated: false, available: true }),
    }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: {} });
    expect(result.structuredContent).toMatchObject({ available: true, sessions: [] });
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe("No herdr sessions on this host.");
  });

  test("orders sessions by what is waiting and declares its own truncation", async () => {
    const client = await clientFor(dependencies({
      readDigests: async () => ({
        digests: [
          digestHerdrTopology(topology("quiet", [pane("w1:p1"), pane("w1:p2"), pane("w1:p3")])),
          digestHerdrTopology(topology("busy", [pane("w1:p1", { agentStatus: "blocked" })])),
        ],
        truncated: false,
        available: true,
      }),
    }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: { limit: 1 } });
    const data = result.structuredContent as { truncated: boolean; sessions: Array<{ session: string }> };
    expect(data.sessions.map((entry) => entry.session)).toEqual(["busy"]);
    expect(data.truncated).toBe(true);
  });

  test("a stopped session is presented as last known, not as running work", async () => {
    const client = await clientFor(dependencies({
      readDigests: async () => ({
        digests: [digestHerdrTopology({ ...topology("parked", [pane("w1:p1")], false), savedAt: 5 })],
        truncated: false,
        available: true,
      }),
    }));
    const result = await client.callTool({ name: "herdr_workspaces", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("herdr · parked — not running");
    expect(text).toContain("persisted last-known layout");
  });

  test("bounds its inputs", async () => {
    const client = await clientFor(dependencies({
      readDigests: async () => { throw new Error("must not read"); },
    }));
    for (const args of [{ limit: 9 }, { limit: 0 }, { session: "x".repeat(121) }]) {
      expect((await client.callTool({ name: "herdr_workspaces", arguments: args })).isError).toBe(true);
    }
  });

  test("the tool is read-only and offers no mutation verb", async () => {
    const client = await clientFor(dependencies());
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === "herdr_workspaces");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tools.map((entry) => entry.name)).toEqual(["herdr_workspaces"]);
  });
});

describe("herdrWorkspacesDependencies", () => {
  test("asks the web server for the digest and never shells herdr itself", async () => {
    const seen: string[] = [];
    const deps = herdrWorkspacesDependencies("http://localhost:43120", {
      env: {},
      fetchImpl: (async (input: unknown) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ ok: true, digests: [], truncated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    const result = await deps.readDigests("openscout");
    expect(seen[0]).toBe("http://localhost:43120/api/terminal-hosts/herdr/workspaces?session=openscout");
    expect(result).toEqual({ digests: [], truncated: true, available: true });
  });

  test("a failed read is unavailable, not empty", async () => {
    const deps = herdrWorkspacesDependencies("http://localhost:43120", {
      env: {},
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(await deps.readDigests()).toEqual({ digests: [], truncated: false, available: false });
  });
});
