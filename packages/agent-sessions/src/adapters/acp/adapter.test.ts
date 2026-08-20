import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSessionStreamEvent } from "../../protocol/primitives.js";
import { createAdapter } from "./adapter.js";

const tempPaths = new Set<string>();

afterEach(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  tempPaths.clear();
});

function writeFakeAcpExecutable(baseDirectory: string, body: string): string {
  const executablePath = join(baseDirectory, `fake-acp-${crypto.randomUUID()}`);
  writeFileSync(executablePath, body, "utf8");
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function createEventCollector() {
  const events: AgentSessionStreamEvent[] = [];
  const listeners = new Set<() => void>();

  return {
    events,
    push(event: AgentSessionStreamEvent) {
      events.push(event);
      for (const listener of listeners) {
        listener();
      }
    },
    async waitFor(predicate: (events: AgentSessionStreamEvent[]) => boolean, timeoutMs = 5_000): Promise<void> {
      if (predicate(events)) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Timed out waiting for events after ${timeoutMs}ms.`));
        }, timeoutMs);

        const check = () => {
          if (!predicate(events)) {
            return;
          }
          clearTimeout(timeout);
          listeners.delete(check);
          resolve();
        };

        listeners.add(check);
      });
    },
  };
}

describe("AcpAdapter", () => {
  test("creates an ACP session and normalizes prompt updates", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-acp-adapter-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");

    const executable = writeFakeAcpExecutable(tempRoot, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const methodLogPath = process.env.METHOD_LOG;

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (methodLogPath && method) {
    appendFileSync(methodLogPath, \`\${method}\\n\`);
  }

  if (method === "initialize") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: true },
          sessionCapabilities: { close: {} }
        },
        agentInfo: { name: "fake-acp", title: "Fake ACP", version: "1.0.0" },
        authMethods: []
      }
    }));
    continue;
  }

  if (method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "acp-session-1" } }));
    continue;
  }

  if (method === "session/prompt") {
    appendFileSync(methodLogPath, \`prompt:\${params.prompt?.[0]?.text ?? ""}\\n\`);
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello from " }
        }
      }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "acp" }
        }
      }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "Inspect file",
          kind: "read",
          status: "pending"
        }
      }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "done" } }]
        }
      }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    continue;
  }

  if (method === "session/close") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    continue;
  }
}
`);

    const sessionId = `acp-test-${crypto.randomUUID()}`;
    const adapter = createAdapter({
      sessionId,
      name: "Fake ACP",
      cwd: tempRoot,
      env: { METHOD_LOG: methodLogPath },
      options: {
        command: executable,
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        promptTimeoutMs: 2_000,
      },
    });

    const collector = createEventCollector();
    adapter.on("event", (event) => collector.push(event));

    await adapter.start();
    adapter.send({ sessionId, text: "say hi" });

    await collector.waitFor((events) => events.some((event) => event.event === "turn:end"));

    const sessionUpdates = collector.events.filter((event) => event.event === "session:update");
    const sessionUpdate = sessionUpdates.at(-1);
    const textDeltas = collector.events
      .filter((event) => event.event === "block:delta")
      .map((event) => event.text)
      .join("");
    const actionOutput = collector.events.find((event) => event.event === "block:action:output");
    const turnEnd = collector.events.find((event) => event.event === "turn:end");
    const methodLog = readFileSync(methodLogPath, "utf8");

    expect(sessionUpdate).toBeDefined();
    if (sessionUpdate?.event === "session:update") {
      expect(sessionUpdate.session.adapterType).toBe("acp");
      expect(sessionUpdate.session.providerMeta?.acp).toMatchObject({
        acpSessionId: "acp-session-1",
      });
    }
    expect(textDeltas).toBe("hello from acp");
    expect(actionOutput).toEqual(expect.objectContaining({ output: "done" }));
    expect(turnEnd).toEqual(expect.objectContaining({ event: "turn:end", status: "completed" }));
    expect(methodLog).toContain("initialize\nsession/new\nsession/prompt\n");
    expect(methodLog).toContain("prompt:say hi");

    await adapter.shutdown();
  });

  test("answers ACP permission requests through decide()", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-acp-permission-"));
    tempPaths.add(tempRoot);
    const decisionLogPath = join(tempRoot, "decision.log");

    const executable = writeFakeAcpExecutable(tempRoot, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const decisionLogPath = process.env.DECISION_LOG;
let promptRequestId = null;
let acpSessionId = "acp-session-permission";

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-acp-permission", version: "1.0.0" },
        authMethods: []
      }
    }));
    continue;
  }

  if (method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: acpSessionId } }));
    continue;
  }

  if (method === "session/prompt") {
    promptRequestId = id;
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-perm",
          title: "Run protected action",
          kind: "execute",
          status: "pending"
        }
      }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "call-perm",
          title: "Run protected action",
          status: "pending"
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      }
    }));
    continue;
  }

  if (id === "permission-1" && message.result) {
    appendFileSync(decisionLogPath, JSON.stringify(message.result) + "\\n");
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-perm",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "approved" } }]
        }
      }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id: promptRequestId, result: { stopReason: "end_turn" } }));
    continue;
  }
}
`);

    const sessionId = `acp-permission-${crypto.randomUUID()}`;
    const adapter = createAdapter({
      sessionId,
      name: "Fake ACP Permission",
      cwd: tempRoot,
      env: { DECISION_LOG: decisionLogPath },
      options: {
        command: executable,
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        promptTimeoutMs: 5_000,
      },
    });

    const collector = createEventCollector();
    adapter.on("event", (event) => collector.push(event));

    await adapter.start();
    adapter.send({ sessionId, text: "run it" });

    await collector.waitFor((events) => events.some((event) => event.event === "block:action:approval"));
    const approval = collector.events.find((event) => event.event === "block:action:approval");
    expect(approval).toBeDefined();
    if (approval?.event !== "block:action:approval") {
      throw new Error("Expected approval event.");
    }

    adapter.decide(approval.turnId, approval.blockId, "approve");
    await collector.waitFor((events) => events.some((event) => event.event === "turn:end"));

    const decisionLog = readFileSync(decisionLogPath, "utf8");
    const turnEnd = collector.events.find((event) => event.event === "turn:end");
    const approvedOutput = collector.events.find(
      (event) => event.event === "block:action:output" && event.output === "approved",
    );

    expect(decisionLog).toContain('"optionId":"allow-once"');
    expect(approvedOutput).toBeDefined();
    expect(turnEnd).toEqual(expect.objectContaining({ event: "turn:end", status: "completed" }));

    await adapter.shutdown();
  });
});

describe("working directory validation", () => {
  // A cwd that does not exist makes `spawn` fail with ENOENT naming the
  // *command*, so a stale project path reads as a missing harness binary and
  // sends you hunting PATH, code signing, and TCC for a directory typo.
  test("names the missing directory instead of blaming the harness binary", async () => {
    const adapter = createAdapter({
      sessionId: `acp-badcwd-${crypto.randomUUID()}`,
      name: "Fake ACP",
      cwd: "/nonexistent-openscout-acp-probe",
      options: {
        command: process.execPath,
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        promptTimeoutMs: 2_000,
      },
    });

    await expect(adapter.start()).rejects.toThrow(
      /working directory does not exist: \/nonexistent-openscout-acp-probe/,
    );
  });
});
