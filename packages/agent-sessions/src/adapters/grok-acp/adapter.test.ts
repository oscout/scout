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
  const executablePath = join(baseDirectory, `fake-grok-${crypto.randomUUID()}`);
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

describe("GrokAcpAdapter", () => {
  test("launches Grok ACP with auth defaults and reports a grok-acp session", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-grok-acp-adapter-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");

    const executable = writeFakeAcpExecutable(tempRoot, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const methodLogPath = process.env.METHOD_LOG;
appendFileSync(methodLogPath, \`argv:\${process.argv.slice(2).join(" ")}\\n\`);
appendFileSync(methodLogPath, \`xai:\${process.env.XAI_API_KEY ?? ""}\\n\`);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const message = JSON.parse(trimmed);
  const id = message.id;
  const method = message.method;
  const params = message.params ?? {};

  if (method === "initialize") {
    appendFileSync(methodLogPath, "initialize\\n");
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: false },
          sessionCapabilities: { close: {} }
        },
        agentInfo: { name: "grok-acp", title: "Grok ACP", version: "test" },
        authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }]
      }
    }));
    continue;
  }

  if (method === "authenticate") {
    appendFileSync(methodLogPath, \`authenticate:\${params.methodId}\\n\`);
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
    continue;
  }

  if (method === "session/new") {
    appendFileSync(methodLogPath, "session/new\\n");
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "grok-session-1" } }));
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
          content: { type: "text", text: "hello from grok" }
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

    const sessionId = `grok-test-${crypto.randomUUID()}`;
    const adapter = createAdapter({
      sessionId,
      name: "Grok ACP",
      cwd: tempRoot,
      env: {
        METHOD_LOG: methodLogPath,
        SCOUT_XAI_API_KEY: "adapter-scout-xai-key",
      },
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

    const sessionUpdate = collector.events
      .filter((event) => event.event === "session:update")
      .at(-1);
    const text = collector.events
      .filter((event) => event.event === "block:delta")
      .map((event) => event.text)
      .join("");
    const methodLog = readFileSync(methodLogPath, "utf8");

    expect(sessionUpdate).toBeDefined();
    if (sessionUpdate?.event === "session:update") {
      expect(sessionUpdate.session.adapterType).toBe("grok-acp");
      expect(sessionUpdate.session.providerMeta?.acp).toMatchObject({
        acpSessionId: "grok-session-1",
        authMethodId: "xai.api_key",
      });
    }
    expect(text).toBe("hello from grok");
    expect(methodLog).toContain("argv:--no-auto-update agent stdio");
    expect(methodLog).toContain("xai:adapter-scout-xai-key");
    expect(methodLog).toContain("initialize\nauthenticate:xai.api_key\nsession/new\n");
    expect(methodLog).toContain("prompt:say hi");

    await adapter.shutdown();
  });
});
