import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shutdownAllAcpAgentSessions } from "./acp-agent-invocation.js";
import { invokeOpencodeAcpAgent } from "./opencode-acp-invocation.js";

const originalOpencodeBin = process.env.OPENCODE_BIN;
const tempDirs = new Set<string>();

afterEach(async () => {
  await shutdownAllAcpAgentSessions();
  if (originalOpencodeBin === undefined) {
    delete process.env.OPENCODE_BIN;
  } else {
    process.env.OPENCODE_BIN = originalOpencodeBin;
  }
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "openscout-opencode-acp-invoke-"));
  tempDirs.add(directory);
  return directory;
}

/**
 * `turnBody` decides what the fake agent reports back for session/prompt,
 * letting a test reproduce OpenCode's silent provider-rejection shape.
 */
function writeFakeOpencode(directory: string, turnBody: string): string {
  const binDir = join(directory, "bin");
  mkdirSync(binDir, { recursive: true });
  const opencodePath = join(binDir, "opencode");
  writeFileSync(opencodePath, `#!/usr/bin/env bun
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const message = JSON.parse(line);
  const { id, method } = message;
  const params = message.params ?? {};

  if (method === "initialize") {
    console.log(JSON.stringify({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: {} }, loadSession: true },
        agentInfo: { name: "OpenCode", version: "test" },
        authMethods: [{ id: "opencode-login" }]
      }
    }));
    continue;
  }
  if (method === "session/new") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: "ses_fake_1" } }));
    continue;
  }
  if (method === "session/prompt") {
${turnBody}
    continue;
  }
  if (method === "session/close") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  }
}
`, "utf8");
  chmodSync(opencodePath, 0o755);
  return opencodePath;
}

// How OpenCode reports a rejected model: a clean end_turn, no text, no tokens.
const SILENT_REJECTION_TURN = `
    console.log(JSON.stringify({
      jsonrpc: "2.0", id,
      result: { stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
    }));`;

const NORMAL_TURN = `
    console.log(JSON.stringify({
      jsonrpc: "2.0", method: "session/update",
      params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "real answer" } }
      }
    }));
    console.log(JSON.stringify({
      jsonrpc: "2.0", id,
      result: { stopReason: "end_turn", usage: { inputTokens: 42, outputTokens: 3, totalTokens: 45 } }
    }));`;

describe("invokeOpencodeAcpAgent", () => {
  test("fails loudly when OpenCode reports an empty turn with no token spend", async () => {
    const directory = tempDir();
    process.env.OPENCODE_BIN = writeFakeOpencode(directory, SILENT_REJECTION_TURN);

    const invocation = invokeOpencodeAcpAgent({
      sessionId: "opencode-empty-turn",
      cwd: directory,
      prompt: "hello",
      adapterOptions: { model: "glm-5.2" },
    });

    // Surfacing this as an error is the whole point: an empty "success" would
    // look like a working provider that simply had nothing to say.
    await expect(invocation).rejects.toThrow(/empty turn without consuming any tokens/);
    await expect(invocation).rejects.toThrow(/glm-5\.2/);
    await expect(invocation).rejects.toThrow(/incompatible with OpenCode's ACP transport/);
    await expect(invocation).rejects.toThrow(/opencode run -m <model>/);
    await expect(invocation).rejects.not.toThrow(/payment method/);
  }, 30_000);

  test("returns the turn when OpenCode actually produced output", async () => {
    const directory = tempDir();
    process.env.OPENCODE_BIN = writeFakeOpencode(directory, NORMAL_TURN);

    const result = await invokeOpencodeAcpAgent({
      sessionId: "opencode-normal-turn",
      cwd: directory,
      prompt: "hello",
      adapterOptions: { model: "nemotron-3-ultra-free" },
    });

    expect(result.output).toContain("real answer");
    expect(result.sessionId).toBe("ses_fake_1");
    expect(result.usage?.totalTokens).toBe(45);
  }, 30_000);
});
