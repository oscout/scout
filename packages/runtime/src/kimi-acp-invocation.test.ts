import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invokeKimiAcpAgent } from "./kimi-acp-invocation.js";
import { shutdownAllAcpAgentSessions, shutdownAcpAgentSession } from "./acp-agent-invocation.js";

const originalKimiCliBin = process.env.KIMI_CLI_BIN;
const originalLog = process.env.OPENSCOUT_TEST_KIMI_LOG;
const tempDirs = new Set<string>();

afterEach(async () => {
  await shutdownAllAcpAgentSessions();
  if (originalKimiCliBin === undefined) delete process.env.KIMI_CLI_BIN;
  else process.env.KIMI_CLI_BIN = originalKimiCliBin;
  if (originalLog === undefined) delete process.env.OPENSCOUT_TEST_KIMI_LOG;
  else process.env.OPENSCOUT_TEST_KIMI_LOG = originalLog;
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs.clear();
});

describe("invokeKimiAcpAgent", () => {
  test("keeps Kimi attached and cold-loads its provider session after detachment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openscout-kimi-acp-"));
    tempDirs.add(directory);
    const logPath = join(directory, "kimi.log");
    const kimiPath = join(directory, "kimi");
    writeFileSync(kimiPath, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const logPath = process.env.OPENSCOUT_TEST_KIMI_LOG;
appendFileSync(logPath, \`argv:\${process.argv.slice(2).join(" ")}\\n\`);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptRequestId = null;
for await (const line of rl) {
  const message = JSON.parse(line);
  const { id, method } = message;
  const params = message.params ?? {};
  if (method) appendFileSync(logPath, method + ":" + (params.sessionId ?? "") + "\\n");
  if (method === "initialize") {
    console.log(JSON.stringify({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { close: {} }, loadSession: true },
        agentInfo: { name: "Kimi Code CLI", version: "test" },
        authMethods: [{ id: "login" }]
      }
    }));
  } else if (method === "authenticate") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  } else if (method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "fake-kimi-session" } }));
  } else if (method === "session/load") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  } else if (method === "session/prompt") {
    promptRequestId = id;
    console.log(JSON.stringify({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: params.sessionId, update: {
        sessionUpdate: "tool_call", toolCallId: "kimi-tool-1",
        title: "Write proof file", kind: "edit", status: "pending"
      } }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0", id: "kimi-permission-1", method: "session/request_permission",
      params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "kimi-tool-1", title: "Write proof file", status: "pending" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      }
    }));
  } else if (id === "kimi-permission-1" && message.result) {
    appendFileSync(logPath, "permission:" + JSON.stringify(message.result) + "\\n");
    console.log(JSON.stringify({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "fake-kimi-session", update: {
        sessionUpdate: "tool_call_update", toolCallId: "kimi-tool-1",
        status: "completed", content: [{ type: "content", content: { type: "text", text: "written" } }]
      } }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "fake-kimi-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "kimi-acp-ok" } } }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } }));
  } else if (method === "session/close") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  }
}
`, "utf8");
    chmodSync(kimiPath, 0o755);
    process.env.KIMI_CLI_BIN = kimiPath;
    process.env.OPENSCOUT_TEST_KIMI_LOG = logPath;

    const result = await invokeKimiAcpAgent({
      sessionId: "kimi-runtime-test",
      cwd: directory,
      prompt: "reply",
      timeoutMs: 2_000,
    });

    expect(result.output).toContain("kimi-acp-ok");
    expect(result.sessionId).toBe("fake-kimi-session");
    expect(result.metadata).toMatchObject({ adapterType: "kimi-acp" });
    const initialLog = readFileSync(logPath, "utf8");
    expect(initialLog).toContain("argv:acp");
    expect(initialLog).toContain('permission:{"outcome":{"outcome":"selected","optionId":"allow-once"}}');
    expect(initialLog).not.toContain("session/close:");

    await shutdownAcpAgentSession({
      adapterType: "kimi-acp",
      sessionId: "kimi-runtime-test",
    });
    await invokeKimiAcpAgent({
      sessionId: "kimi-runtime-test",
      resumeSessionId: result.sessionId,
      cwd: directory,
      prompt: "reply after restart",
      timeoutMs: 2_000,
    });

    const log = readFileSync(logPath, "utf8");
    expect(log.match(/initialize:/g)).toHaveLength(2);
    expect(log.match(/session\/new:/g)).toHaveLength(1);
    expect(log).toContain("session/load:fake-kimi-session");
    expect(log.match(/permission:/g)).toHaveLength(2);
    expect(log).toContain("session/close:");
  });
});
