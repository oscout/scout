import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSessionStreamEvent } from "../../protocol/primitives.js";
import { createAdapter } from "./adapter.js";

const tempPaths = new Set<string>();

afterEach(() => {
  for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
  tempPaths.clear();
});

test("Cursor ACP uses cursor_login and safely resolves blocking extensions headlessly", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "openscout-cursor-acp-"));
  tempPaths.add(tempRoot);
  const executable = join(tempRoot, "fake-cursor-agent");
  const logPath = join(tempRoot, "methods.log");
  writeFileSync(executable, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const log = process.env.METHOD_LOG;
appendFileSync(log, "argv:" + process.argv.slice(2).join(" ") + "\\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptId;
let extensionResponses = 0;
for await (const line of rl) {
  const message = JSON.parse(line);
  if (message.method) appendFileSync(log, message.method + "\\n");
  if (message.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      authMethods: [{ id: "cursor_login" }]
    }}));
  } else if (message.method === "authenticate") {
    appendFileSync(log, "auth:" + message.params.methodId + "\\n");
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  } else if (message.method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "cursor-provider-1" } }));
  } else if (message.method === "session/prompt") {
    promptId = message.id;
    console.log(JSON.stringify({ jsonrpc: "2.0", id: 900, method: "cursor/ask_question", params: {
      toolCallId: "ask-1", title: "Choose", questions: [{ id: "q1", prompt: "Which?", options: [{ id: "a", label: "A" }], allowMultiple: false }]
    }}));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: 901, method: "cursor/create_plan", params: {
      toolCallId: "plan-1", name: "Plan", overview: "Do the work", plan: "1. Work"
    }}));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: 902, method: "session/request_permission", params: {
      toolCall: { toolCallId: "shell-1", title: "Run command", kind: "execute", status: "pending" },
      options: [
        { optionId: "allow-1", name: "Allow", kind: "allow_once" },
        { optionId: "reject-1", name: "Reject", kind: "reject_once" }
      ]
    }}));
  } else if (message.id === 900 || message.id === 901 || message.id === 902) {
    appendFileSync(log, "extension:" + message.id + ":" + JSON.stringify(message.result) + "\\n");
    extensionResponses += 1;
    if (extensionResponses === 3) {
      console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cursor done" } }
      }}));
      console.log(JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } }));
    }
  } else if (message.method === "session/close") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
  }
}
`, "utf8");
  chmodSync(executable, 0o755);

  const sessionId = `cursor-test-${crypto.randomUUID()}`;
  const adapter = createAdapter({
    sessionId,
    name: "Cursor",
    cwd: tempRoot,
    env: { METHOD_LOG: logPath },
    options: {
      command: executable,
      cursorInteractionMode: "safe_reject",
      permissionMode: "safe_reject",
      startupTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    },
  });
  const events: AgentSessionStreamEvent[] = [];
  adapter.on("event", (event) => events.push(event));

  await adapter.start();
  adapter.send({ sessionId, text: "go" });
  const deadline = Date.now() + 5_000;
  while (!events.some((event) => event.event === "turn:end") && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  await adapter.shutdown();

  const log = readFileSync(logPath, "utf8");
  expect(log).toContain("argv:acp");
  expect(log).toContain("auth:cursor_login");
  expect(log).toContain('extension:900:{"outcome":{"outcome":"skipped"');
  expect(log).toContain('extension:901:{"outcome":{"outcome":"rejected"');
  expect(log).toContain('extension:902:{"outcome":{"outcome":"selected","optionId":"reject-1"');
  expect(events.some((event) => event.event === "turn:end")).toBe(true);
});
