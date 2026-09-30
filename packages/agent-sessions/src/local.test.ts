import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Adapter, AdapterConfig, AgentSessionStreamEvent } from "./protocol/index";
import { SessionRegistry } from "./registry";
import { completeLocalAgentTurn, createLocalAgentClient, waitForTurnEnd } from "./local/index";

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

// The ACP adapter's interrupt() emits turn:end("stopped") synchronously —
// reproducing it here exercises the settle-before-interrupt ordering that
// decides which error reaches the caller.
class InterruptStopsTurnAdapter implements Adapter {
  readonly type = "test";
  readonly session;
  interruptCount = 0;
  /** Runs after the synchronous turn:end("stopped") emit — lets a test abort
   * reentrantly from inside interrupt(). */
  onInterrupt: (() => void) | undefined;
  /** When true, send() ends the turn completed instead of leaving it open. */
  completesOnSend = false;
  /** When set, send() surfaces the provider stop reason and fails the turn. */
  failStopReason: string | undefined;
  private eventListeners = new Set<(event: AgentSessionStreamEvent) => void>();

  constructor(config: AdapterConfig) {
    this.session = {
      id: config.sessionId,
      name: config.name ?? config.sessionId,
      adapterType: this.type,
      status: "connecting" as const,
      cwd: config.cwd,
    };
  }

  async start(): Promise<void> {
    this.session.status = "active";
  }

  send(): void {
    if (this.failStopReason) {
      this.session.providerMeta = { acp: { lastStopReason: this.failStopReason } };
      this.emit({ event: "session:update", session: { ...this.session } });
      this.emit({
        event: "turn:end",
        sessionId: this.session.id,
        turnId: "turn-1",
        status: "failed",
      });
      return;
    }
    if (this.completesOnSend) {
      this.emit({
        event: "turn:end",
        sessionId: this.session.id,
        turnId: "turn-1",
        status: "completed",
      });
    }
  }

  interrupt(): void {
    this.interruptCount += 1;
    this.emit({
      event: "turn:end",
      sessionId: this.session.id,
      turnId: "turn-1",
      status: "stopped",
    });
    this.onInterrupt?.();
  }

  async shutdown(): Promise<void> {
    this.session.status = "closed";
  }

  on(event: "event" | "error", listener: ((event: AgentSessionStreamEvent) => void) | ((error: Error) => void)): void {
    if (event === "event") {
      this.eventListeners.add(listener as (event: AgentSessionStreamEvent) => void);
    }
  }

  off(event: "event" | "error", listener: ((event: AgentSessionStreamEvent) => void) | ((error: Error) => void)): void {
    if (event === "event") {
      this.eventListeners.delete(listener as (event: AgentSessionStreamEvent) => void);
    }
  }

  private emit(event: AgentSessionStreamEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

describe("waitForTurnEnd failure reasons", () => {
  async function interruptibleSession(): Promise<{ registry: SessionRegistry; sessionId: string; adapter: InterruptStopsTurnAdapter }> {
    let adapter!: InterruptStopsTurnAdapter;
    const registry = new SessionRegistry({
      adapters: { test: (config) => (adapter = new InterruptStopsTurnAdapter(config)) },
    });
    const session = await registry.createSession("test", { sessionId: "s" });
    return { registry, sessionId: session.id, adapter };
  }

  test("a turn that ends normally resolves with the turn id", async () => {
    const { registry, sessionId, adapter } = await interruptibleSession();
    adapter.completesOnSend = true;
    await expect(waitForTurnEnd({
      registry,
      sessionId,
      text: "hi",
      timeoutMs: 60_000,
    })).resolves.toBe("turn-1");
    expect(adapter.interruptCount).toBe(0);
    await registry.shutdown();
  });

  test("a second interrupt after settlement does not overwrite the rejection", async () => {
    const { registry, sessionId, adapter } = await interruptibleSession();
    const controller = new AbortController();
    const pending = waitForTurnEnd({
      registry,
      sessionId,
      text: "hi",
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    // Abort first — its settle and interrupt win. A second interrupt reaching
    // the adapter afterwards emits another turn:end("stopped"); the settled
    // rejection must not change.
    controller.abort();
    await expect(pending).rejects.toThrow("Local agent turn aborted.");
    registry.interrupt(sessionId);
    expect(adapter.interruptCount).toBe(2);
    await registry.shutdown();
  });

  test("an abort arriving reentrantly inside interrupt does not overwrite the timeout", async () => {
    const { registry, sessionId, adapter } = await interruptibleSession();
    const controller = new AbortController();
    adapter.onInterrupt = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    await expect(waitForTurnEnd({
      registry,
      sessionId,
      text: "hi",
      timeoutMs: 25,
      signal: controller.signal,
    })).rejects.toThrow("Timed out waiting for local agent turn after 25ms.");
    // timeout interrupt + the reentrant abort's interrupt
    expect(adapter.interruptCount).toBe(2);
    await registry.shutdown();
  });

  test("a turn failed by a non-completing stop reason says why", async () => {
    const { registry, sessionId, adapter } = await interruptibleSession();
    adapter.failStopReason = "refusal";
    await expect(waitForTurnEnd({
      registry,
      sessionId,
      text: "hi",
      timeoutMs: 60_000,
    })).rejects.toThrow("Local agent turn failed (refusal).");
    await registry.shutdown();
  });

  test("a turn that hits timeoutMs rejects with the timeout reason, not the interrupt one", async () => {
    const { registry, sessionId } = await interruptibleSession();
    await expect(waitForTurnEnd({
      registry,
      sessionId,
      text: "hi",
      timeoutMs: 25,
    })).rejects.toThrow("Timed out waiting for local agent turn after 25ms.");
    await registry.shutdown();
  });

  test("an aborted turn rejects with the abort reason, not the interrupt one", async () => {
    const { registry, sessionId } = await interruptibleSession();
    const controller = new AbortController();
    const pending = waitForTurnEnd({
      registry,
      sessionId,
      text: "hi",
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("Local agent turn aborted.");
    await registry.shutdown();
  });
});
