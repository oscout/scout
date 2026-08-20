import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  invokeAcpAgent,
  shutdownAcpAgentSession,
  shutdownAllAcpAgentSessions,
} from "./acp-agent-invocation.js";

const tempPaths = new Set<string>();

afterEach(async () => {
  await shutdownAllAcpAgentSessions();
  for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
  tempPaths.clear();
});

test("returns the provider ACP session id and loads it on a follow-up invocation", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "openscout-acp-continuity-"));
  tempPaths.add(tempRoot);
  const executable = join(tempRoot, "fake-acp");
  const logPath = join(tempRoot, "methods.log");
  writeFileSync(executable, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const log = process.env.METHOD_LOG;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const message = JSON.parse(line);
  const params = message.params ?? {};
  if (message.method) appendFileSync(log, message.method + ":" + (params.sessionId ?? "") + "\\n");
  if (message.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }));
  } else if (message.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: process.env.NEW_SESSION_ID ?? "provider-session-42" } }));
  } else if (message.method === "session/load") {
    console.log(JSON.stringify(process.env.FAIL_LOAD === "1"
      ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "session not found" } }
      : { jsonrpc: "2.0", id: message.id, result: {} }));
  } else if (message.method === "session/prompt") {
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }));
  }
}
`, "utf8");
  chmodSync(executable, 0o755);

  const common = {
    adapterType: "cursor-acp" as const,
    label: "Cursor ACP test",
    sessionId: "scout-session",
    poolKey: "endpoint-cursor",
    cwd: tempRoot,
    prompt: "hello",
    adapterOptions: {
      command: executable,
      args: [],
      env: { METHOD_LOG: logPath },
      requireAuth: false,
      startupTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
    },
  };
  const originalEnv = process.env.METHOD_LOG;
  process.env.METHOD_LOG = logPath;
  try {
    const first = await invokeAcpAgent(common);
    expect(first.sessionId).toBe("provider-session-42");

    const second = await invokeAcpAgent({ ...common, prompt: "hello again" });
    expect(second.sessionId).toBe("provider-session-42");
    let log = readFileSync(logPath, "utf8");
    expect(log.match(/initialize:/g)).toHaveLength(1);
    expect(log.match(/session\/prompt:/g)).toHaveLength(2);
    expect(log).not.toContain("session/load:");

    await shutdownAcpAgentSession({
      adapterType: "cursor-acp",
      sessionId: common.sessionId,
      poolKey: common.poolKey,
    });
    const resumed = await invokeAcpAgent({ ...common, resumeSessionId: first.sessionId });
    expect(resumed.sessionId).toBe("provider-session-42");

    await shutdownAcpAgentSession({
      adapterType: "cursor-acp",
      sessionId: common.sessionId,
      poolKey: common.poolKey,
    });

    process.env.FAIL_LOAD = "1";
    process.env.NEW_SESSION_ID = "provider-session-43";
    const recovered = await invokeAcpAgent({ ...common, resumeSessionId: first.sessionId });
    expect(recovered.sessionId).toBe("provider-session-43");
    expect(recovered.metadata?.providerMeta).toMatchObject({
      acp: {
        sessionRecovery: {
          requestedSessionId: "provider-session-42",
          outcome: "new_session",
        },
      },
    });
    log = readFileSync(logPath, "utf8");
    expect(log).toContain("session/load:provider-session-42");
  } finally {
    delete process.env.FAIL_LOAD;
    delete process.env.NEW_SESSION_ID;
    if (originalEnv === undefined) delete process.env.METHOD_LOG;
    else process.env.METHOD_LOG = originalEnv;
  }
});
