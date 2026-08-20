import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { completeLocalAgentTurn, createLocalAgentClient } from "./local/index";

function readFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...readFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

describe("agent-sessions local embed API", () => {
  test("exports the local turn entry points", () => {
    expect(typeof completeLocalAgentTurn).toBe("function");
    expect(typeof createLocalAgentClient).toBe("function");
  });

  test("rejects unsupported harness and transport pairings before launch", async () => {
    await expect(completeLocalAgentTurn({
      harness: "pi",
      transport: "grok_acp",
      cwd: process.cwd(),
      input: "hello",
    })).rejects.toThrow("does not support transport grok_acp");

    await expect(completeLocalAgentTurn({
      harness: "codex",
      transport: "grok_acp",
      cwd: process.cwd(),
      input: "hello",
    })).rejects.toThrow("does not support transport grok_acp");
  });

  test("can create a lazy warm Codex app-server client without broker fields", async () => {
    const reuseKey = `local-codex-${crypto.randomUUID()}`;
    const client = await createLocalAgentClient({
      harness: "codex",
      transport: "codex_app_server",
      cwd: process.cwd(),
      warmth: "lazy",
      reuseKey,
    });

    await client.close();
    rmSync(join(homedir(), ".scout", "local", "codex", reuseKey), { recursive: true, force: true });
  });

  test("keeps broker-shaped terms out of the local subpath", () => {
    const localDirectory = join(import.meta.dir, "local");
    const source = readFiles(localDirectory)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    for (const forbidden of [
      "conversation" + "Id",
      "flight" + "Id",
      "Scout" + "Reply" + "Context",
      "@openscout/" + "runtime",
      "cards",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
