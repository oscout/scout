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
  const executablePath = join(baseDirectory, `fake-opencode-${crypto.randomUUID()}`);
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

// Mirrors the real agent: OpenCode keeps advertising `opencode-login` even once
// credentials are cached, so the log proves whether we called authenticate.
const FAKE_OPENCODE = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const methodLogPath = process.env.METHOD_LOG;
appendFileSync(methodLogPath, \`argv:\${process.argv.slice(2).join(" ")}\\n\`);
appendFileSync(methodLogPath, \`config:\${process.env.OPENCODE_CONFIG_CONTENT ?? ""}\\n\`);
appendFileSync(methodLogPath, \`apikey:\${process.env.OPENCODE_API_KEY ?? ""}\\n\`);
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
          sessionCapabilities: { close: {}, resume: {}, fork: {}, list: {} },
          loadSession: true
        },
        agentInfo: { name: "OpenCode", version: "test" },
        authMethods: [{ id: "opencode-login", name: "Login with opencode" }]
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
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "ses_opencode_1" } }));
    continue;
  }
  if (method === "session/prompt") {
    console.log(JSON.stringify({
      jsonrpc: "2.0", method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from opencode" } }
      }
    }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }));
    continue;
  }
  if (method === "session/close") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  }
}
`;

describe("OpencodeAcpAdapter", () => {
  test("launches opencode acp without authenticating and reports an opencode-acp session", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-opencode-acp-adapter-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");
    const executable = writeFakeAcpExecutable(tempRoot, FAKE_OPENCODE);

    const sessionId = `opencode-test-${crypto.randomUUID()}`;
    const adapter = createAdapter({
      sessionId,
      name: "OpenCode",
      cwd: tempRoot,
      env: { METHOD_LOG: methodLogPath },
      options: {
        command: executable,
        useKeychain: false,
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
      expect(sessionUpdate.session.adapterType).toBe("opencode-acp");
      expect(sessionUpdate.session.providerMeta?.acp).toMatchObject({
        acpSessionId: "ses_opencode_1",
      });
    }
    expect(text).toBe("hello from opencode");
    expect(methodLog).toContain("argv:acp");
    // The advertised login method is an instruction to run the CLI, not an
    // in-band flow, so a logged-in install must go straight to session/new.
    expect(methodLog).toContain("initialize\nsession/new\n");
    expect(methodLog).not.toContain("authenticate");
    // No model requested means no config overlay, so the user's own config wins.
    expect(methodLog).toContain("config:\n");
    // useKeychain:false keeps this hermetic — no real credential is consulted.
    expect(methodLog).toContain("apikey:\n");

    await adapter.shutdown();
  });

  test("passes a requested model through as a config overlay", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-opencode-acp-model-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");
    const executable = writeFakeAcpExecutable(tempRoot, FAKE_OPENCODE);

    const sessionId = `opencode-model-${crypto.randomUUID()}`;
    const adapter = createAdapter({
      sessionId,
      name: "OpenCode",
      cwd: tempRoot,
      env: { METHOD_LOG: methodLogPath },
      options: {
        command: executable,
        useKeychain: false,
        // A bare catalog id should be qualified against OpenCode Zen.
        model: "glm-5.2",
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        promptTimeoutMs: 2_000,
      },
    });

    await adapter.start();
    const methodLog = readFileSync(methodLogPath, "utf8");
    expect(methodLog).toContain(`config:${JSON.stringify({ model: "opencode/glm-5.2" })}`);

    await adapter.shutdown();
  });

  test("bridges SCOUT_OPENCODE_API_KEY to the name OpenCode reads", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-opencode-acp-key-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");
    const executable = writeFakeAcpExecutable(tempRoot, FAKE_OPENCODE);

    const adapter = createAdapter({
      sessionId: `opencode-key-${crypto.randomUUID()}`,
      name: "OpenCode",
      cwd: tempRoot,
      env: { METHOD_LOG: methodLogPath, SCOUT_OPENCODE_API_KEY: "scout-side-key" },
      options: {
        command: executable,
        useKeychain: false,
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        promptTimeoutMs: 2_000,
      },
    });

    await adapter.start();
    expect(readFileSync(methodLogPath, "utf8")).toContain("apikey:scout-side-key");

    await adapter.shutdown();
  });

  test("does not override an explicit OPENCODE_API_KEY", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-opencode-acp-key-explicit-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");
    const executable = writeFakeAcpExecutable(tempRoot, FAKE_OPENCODE);

    const adapter = createAdapter({
      sessionId: `opencode-key-explicit-${crypto.randomUUID()}`,
      name: "OpenCode",
      cwd: tempRoot,
      env: {
        METHOD_LOG: methodLogPath,
        OPENCODE_API_KEY: "vendor-native-key",
        SCOUT_OPENCODE_API_KEY: "scout-side-key",
      },
      options: {
        command: executable,
        useKeychain: false,
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        promptTimeoutMs: 2_000,
      },
    });

    await adapter.start();
    expect(readFileSync(methodLogPath, "utf8")).toContain("apikey:vendor-native-key");

    await adapter.shutdown();
  });

  test("falls back to the keychain when no env var carries the key", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-opencode-acp-keychain-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");
    const executable = writeFakeAcpExecutable(tempRoot, FAKE_OPENCODE);

    // Stand in for the `secret` CLI documented in docs/local-secrets.md.
    const fakeSecret = join(tempRoot, "secret");
    writeFileSync(
      fakeSecret,
      `#!/bin/bash\nif [ "$1" = "get" ] && [ "$2" = "SCOUT_OPENCODE_API_KEY" ]; then echo "keychain-key"; exit 0; fi\nexit 1\n`,
      "utf8",
    );
    chmodSync(fakeSecret, 0o755);

    // Point at the stub explicitly. PATH games are not enough — spawnSync would
    // still find the real `secret` CLI and leak a live credential into the log.
    const adapter = createAdapter({
      sessionId: `opencode-keychain-${crypto.randomUUID()}`,
      name: "OpenCode",
      cwd: tempRoot,
      env: { METHOD_LOG: methodLogPath },
      options: {
        command: executable,
        secretCommand: fakeSecret,
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        promptTimeoutMs: 2_000,
      },
    });

    await adapter.start();
    expect(readFileSync(methodLogPath, "utf8")).toContain("apikey:keychain-key");
    await adapter.shutdown();
  });

  test("leaves an already-qualified model id untouched", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openscout-opencode-acp-qualified-"));
    tempPaths.add(tempRoot);
    const methodLogPath = join(tempRoot, "methods.log");
    const executable = writeFakeAcpExecutable(tempRoot, FAKE_OPENCODE);

    const adapter = createAdapter({
      sessionId: `opencode-qualified-${crypto.randomUUID()}`,
      name: "OpenCode",
      cwd: tempRoot,
      env: { METHOD_LOG: methodLogPath },
      options: {
        command: executable,
        useKeychain: false,
        model: "xai/grok-4.5",
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        promptTimeoutMs: 2_000,
      },
    });

    await adapter.start();
    const methodLog = readFileSync(methodLogPath, "utf8");
    expect(methodLog).toContain(`config:${JSON.stringify({ model: "xai/grok-4.5" })}`);

    await adapter.shutdown();
  });
});
