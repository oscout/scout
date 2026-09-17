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
  const executablePath = join(baseDirectory, `fake-devin-${crypto.randomUUID()}`);
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

// Mirrors the real agent: `devin acp` advertises only `devin-browser`, which
// needs an interactive browser flow, so the log proves whether we wrongly
// tried to authenticate in-band.
const FAKE_DEVIN = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const methodLogPath = process.env.METHOD_LOG;
appendFileSync(methodLogPath, \`argv:\${process.argv.slice(2).join(" ")}\\n\`);
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
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { list: {}, delete: {}, additionalDirectories: {} }
        },
        agentInfo: { name: "affogato", title: "Devin Agent", version: "test" },
        authMethods: [{ id: "devin-browser", name: "Log in with browser" }]
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
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "devin-acp-session-1" } }));
    continue;
  }
  if (method === "session/prompt") {
    console.log(JSON.stringify({
      jsonrpc: "2.0", method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from devin" } }
      }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    continue;
  }
}
`;

describe("DevinAcpAdapter", () => {
  test("launches devin acp without in-band auth and reports a devin-acp session", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-devin-acp-adapter-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");
    const executable = writeFakeAcpExecutable(tempRoot, FAKE_DEVIN);

    const sessionId = `devin-test-${crypto.randomUUID()}`;
    const adapter = createAdapter({
      sessionId,
      name: "Devin",
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

    const sessionUpdate = collector.events.filter((event) => event.event === "session:update").at(-1);
    const text = collector.events
      .filter((event) => event.event === "block:delta")
      .map((event) => event.text)
      .join("");
    const methodLog = readFileSync(methodLogPath, "utf8");

    expect(sessionUpdate).toBeDefined();
    if (sessionUpdate?.event === "session:update") {
      expect(sessionUpdate.session.adapterType).toBe("devin-acp");
      expect(sessionUpdate.session.providerMeta?.acp).toMatchObject({
        acpSessionId: "devin-acp-session-1",
      });
    }
    expect(text).toBe("hello from devin");
    expect(methodLog).toContain("argv:acp");
    expect(methodLog).toContain("initialize\nsession/new\n");
    // The advertised devin-browser method needs an interactive browser, so a
    // credential-cached install must go straight to session/new.
    expect(methodLog).not.toContain("authenticate");

    await adapter.shutdown();
  });

  test("passes a requested model through as a launch flag", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-devin-acp-model-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");
    const executable = writeFakeAcpExecutable(tempRoot, FAKE_DEVIN);

    const adapter = createAdapter({
      sessionId: `devin-model-${crypto.randomUUID()}`,
      name: "Devin",
      cwd: tempRoot,
      env: { METHOD_LOG: methodLogPath },
      options: {
        command: executable,
        model: "swe-2-high",
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        promptTimeoutMs: 2_000,
      },
    });

    await adapter.start();
    expect(readFileSync(methodLogPath, "utf8")).toContain("argv:acp --model swe-2-high");

    await adapter.shutdown();
  });

  test("leaves an explicit args override untouched", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-devin-acp-args-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");
    const executable = writeFakeAcpExecutable(tempRoot, FAKE_DEVIN);

    const adapter = createAdapter({
      sessionId: `devin-args-${crypto.randomUUID()}`,
      name: "Devin",
      cwd: tempRoot,
      env: { METHOD_LOG: methodLogPath },
      options: {
        command: executable,
        args: ["acp", "--agent-type", "review"],
        model: "swe-2-high",
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        promptTimeoutMs: 2_000,
      },
    });

    await adapter.start();
    expect(readFileSync(methodLogPath, "utf8")).toContain("argv:acp --agent-type review");

    await adapter.shutdown();
  });
});
