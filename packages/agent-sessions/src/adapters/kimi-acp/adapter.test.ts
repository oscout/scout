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
  const executablePath = join(baseDirectory, `fake-kimi-${crypto.randomUUID()}`);
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
      for (const listener of listeners) listener();
    },
    async waitFor(predicate: (events: AgentSessionStreamEvent[]) => boolean, timeoutMs = 5_000): Promise<void> {
      if (predicate(events)) return;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Timed out waiting for events after ${timeoutMs}ms.`));
        }, timeoutMs);
        const check = () => {
          if (!predicate(events)) return;
          clearTimeout(timeout);
          listeners.delete(check);
          resolve();
        };
        listeners.add(check);
      });
    },
  };
}

describe("KimiAcpAdapter", () => {
  test("launches kimi acp with cached-login auth and reports a kimi-acp session", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-kimi-acp-adapter-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");

    const executable = writeFakeAcpExecutable(tempRoot, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const methodLogPath = process.env.METHOD_LOG;
appendFileSync(methodLogPath, \`argv:\${process.argv.slice(2).join(" ")}\\n\`);
appendFileSync(methodLogPath, \`home:\${process.env.KIMI_CODE_HOME ?? ""}\\n\`);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const message = JSON.parse(line);
  const { id, method } = message;
  const params = message.params ?? {};
  appendFileSync(methodLogPath, method + "\\n");

  if (method === "initialize") {
    console.log(JSON.stringify({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { close: {} },
          loadSession: true
        },
        agentInfo: { name: "Kimi Code CLI", version: "test" },
        authMethods: [{ id: "login" }]
      }
    }));
    continue;
  }
  if (method === "authenticate") {
    appendFileSync(methodLogPath, \`auth:\${params.methodId}\\n\`);
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    continue;
  }
  if (method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "kimi-session-1" } }));
    continue;
  }
  if (method === "session/prompt") {
    console.log(JSON.stringify({
      jsonrpc: "2.0", method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from kimi" } }
      }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    continue;
  }
  if (method === "session/close") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  }
}
`);

    const sessionId = `kimi-test-${crypto.randomUUID()}`;
    const adapter = createAdapter({
      sessionId,
      name: "Kimi Code",
      cwd: tempRoot,
      env: { METHOD_LOG: methodLogPath, KIMI_CODE_HOME: join(tempRoot, "kimi-home") },
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

    const sessionUpdate = collector.events.filter((event) => event.event === "session:update").at(-1);
    const text = collector.events
      .filter((event) => event.event === "block:delta")
      .map((event) => event.text)
      .join("");
    const methodLog = readFileSync(methodLogPath, "utf8");

    expect(sessionUpdate).toBeDefined();
    if (sessionUpdate?.event === "session:update") {
      expect(sessionUpdate.session.adapterType).toBe("kimi-acp");
      expect(sessionUpdate.session.providerMeta?.acp).toMatchObject({
        acpSessionId: "kimi-session-1",
        authMethodId: "login",
      });
    }
    expect(text).toBe("hello from kimi");
    expect(methodLog).toContain("argv:acp");
    expect(methodLog).toContain(`home:${join(tempRoot, "kimi-home")}`);
    expect(methodLog).toContain("initialize\nauthenticate\nauth:login\nsession/new\n");

    await adapter.shutdown();
  });
});
