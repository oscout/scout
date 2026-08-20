import { afterEach, describe, expect, test } from "bun:test";

import { createScoutCommandContext } from "../context.ts";
import { renderAliasCommandHelp, runAliasCommand } from "./alias.ts";

const originalFetch = globalThis.fetch;
const originalBrokerUrl = process.env.OPENSCOUT_BROKER_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBrokerUrl === undefined) delete process.env.OPENSCOUT_BROKER_URL;
  else process.env.OPENSCOUT_BROKER_URL = originalBrokerUrl;
});
describe("scout alias", () => {
  test("documents pointer semantics and management operations", () => {
    const help = renderAliasCommandHelp();
    expect(help).toContain("scout alias set");
    expect(help).toContain("scout alias repoint");
    expect(help).toContain("do not create or rename agent cards");
  });

  test("set sends a structured route target, inferred caller scope, expiry, and CAS", async () => {
    process.env.OPENSCOUT_BROKER_URL = "http://127.0.0.1:43110";
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({
        binding: {
          id: "alias-1",
          alias: "patch",
          ownerRealmId: "realm",
          scopeProjectKey: "project:alpha",
          scopeProjectRoot: "/work/alpha",
          scopeNodeId: "node-1",
          target: { kind: "session", sessionId: "session-1", agentId: "agent-1", endpointId: "ep-1", nodeId: "node-1", harness: "codex" },
          targetSnapshot: {},
          state: "active",
          revision: 1,
          createdByActorId: "operator",
          updatedByActorId: "operator",
          createdAt: 1,
          updatedAt: 1,
        },
      }), { status: 201, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const output: string[] = [];
    const context = createScoutCommandContext({ cwd: "/work/alpha", stdout: (line) => output.push(line) });

    await runAliasCommand(context, ["set", "patch", "--to", "session:session-1", "--expires-in", "8h"]);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(expect.objectContaining({
      url: "http://127.0.0.1:43110/v1/aliases",
      method: "POST",
      body: expect.objectContaining({
        alias: "patch",
        target: { kind: "session_id", sessionId: "session-1", value: "session:session-1" },
        caller: expect.objectContaining({ actorId: "operator", currentDirectory: "/work/alpha" }),
      }),
    }));
    expect(output.join("\n")).toContain("alias patch → session:session-1");
  });
});
