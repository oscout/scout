import { describe, expect, test } from "bun:test";

import type { Adapter, AdapterConfig, AgentSessionStreamEvent } from "./protocol/index.ts";
import { SessionRegistry } from "./registry.ts";

class TestApprovalAdapter implements Adapter {
  readonly type = "test";
  readonly session;

  private eventListeners = new Set<(event: AgentSessionStreamEvent) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  readonly decisions: Array<{
    turnId: string;
    blockId: string;
    decision: "approve" | "deny";
    reason?: string;
  }> = [];

  constructor(private readonly config: AdapterConfig) {
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
    this.emit({
      event: "session:update",
      session: { ...this.session },
    });
  }

  send(): void {}

  interrupt(): void {}

  async shutdown(): Promise<void> {
    this.session.status = "closed";
  }

  decide(turnId: string, blockId: string, decision: "approve" | "deny", reason?: string): void {
    this.decisions.push({ turnId, blockId, decision, reason });
  }

  on(event: "event" | "error", listener: ((event: AgentSessionStreamEvent) => void) | ((error: Error) => void)): void {
    if (event === "event") {
      this.eventListeners.add(listener as (event: AgentSessionStreamEvent) => void);
      return;
    }

    this.errorListeners.add(listener as (error: Error) => void);
  }

  off(event: "event" | "error", listener: ((event: AgentSessionStreamEvent) => void) | ((error: Error) => void)): void {
    if (event === "event") {
      this.eventListeners.delete(listener as (event: AgentSessionStreamEvent) => void);
      return;
    }

    this.errorListeners.delete(listener as (error: Error) => void);
  }

  emit(event: AgentSessionStreamEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}

describe("SessionRegistry", () => {
  test("shuts down and removes an adapter whose startup fails", async () => {
    let adapter: TestApprovalAdapter | undefined;
    let shutdownCalled = false;
    const registry = new SessionRegistry({
      adapters: {
        test: (config) => {
          adapter = new TestApprovalAdapter(config);
          adapter.start = async () => {
            throw new Error("startup rejected");
          };
          adapter.shutdown = async () => {
            shutdownCalled = true;
            adapter!.session.status = "closed";
          };
          return adapter;
        },
      },
    });

    await expect(registry.createSession("test", {
      sessionId: "failed-session",
    })).rejects.toThrow("startup rejected");

    expect(shutdownCalled).toBe(true);
    expect(registry.listSessions()).toEqual([]);
    expect(registry.getSessionSnapshot("failed-session")).toBeNull();
    expect(registry.currentSeq("failed-session")).toBe(0);
  });

  test("rejects stale approval decisions before invoking the adapter", async () => {
    let adapter: TestApprovalAdapter | undefined;

    const registry = new SessionRegistry({
      adapters: {
        test: (config) => {
          adapter = new TestApprovalAdapter(config);
          return adapter;
        },
      },
    });

    const session = await registry.createSession("test", {
      sessionId: "session-1",
      name: "Test Session",
    });

    adapter!.emit({
      event: "turn:start",
      sessionId: session.id,
      turn: {
        id: "turn-1",
        sessionId: session.id,
        status: "started",
        startedAt: new Date(0).toISOString(),
        blocks: [],
      },
    });

    adapter!.emit({
      event: "block:start",
      sessionId: session.id,
      turnId: "turn-1",
      block: {
        id: "block-1",
        turnId: "turn-1",
        type: "action",
        status: "streaming",
        index: 0,
        action: {
          kind: "tool_call",
          toolName: "test-tool",
          toolCallId: "tool-call-1",
          status: "awaiting_approval",
          output: "",
          approval: {
            version: 2,
            description: "Need approval",
            risk: "medium",
          },
        },
      },
    });

    expect(() =>
      registry.decide({
        sessionId: session.id,
        turnId: "turn-1",
        blockId: "block-1",
        version: 1,
        decision: "approve",
      }),
    ).toThrow("Stale approval version");

    expect(adapter!.decisions).toHaveLength(0);
  });

  test("forwards approval decisions when the version matches the current snapshot", async () => {
    let adapter: TestApprovalAdapter | undefined;

    const registry = new SessionRegistry({
      adapters: {
        test: (config) => {
          adapter = new TestApprovalAdapter(config);
          return adapter;
        },
      },
    });

    const session = await registry.createSession("test", {
      sessionId: "session-1",
      name: "Test Session",
    });

    adapter!.emit({
      event: "turn:start",
      sessionId: session.id,
      turn: {
        id: "turn-1",
        sessionId: session.id,
        status: "started",
        startedAt: new Date(0).toISOString(),
        blocks: [],
      },
    });

    adapter!.emit({
      event: "block:start",
      sessionId: session.id,
      turnId: "turn-1",
      block: {
        id: "block-1",
        turnId: "turn-1",
        type: "action",
        status: "streaming",
        index: 0,
        action: {
          kind: "tool_call",
          toolName: "test-tool",
          toolCallId: "tool-call-1",
          status: "awaiting_approval",
          output: "",
          approval: {
            version: 2,
            description: "Need approval",
            risk: "medium",
          },
        },
      },
    });

    registry.decide({
      sessionId: session.id,
      turnId: "turn-1",
      blockId: "block-1",
      version: 2,
      decision: "approve",
      reason: "looks good",
    });

    expect(adapter!.decisions).toEqual([
      { turnId: "turn-1", blockId: "block-1", decision: "approve", reason: "looks good" },
    ]);

    adapter!.emit({
      event: "block:action:status",
      sessionId: session.id,
      turnId: "turn-1",
      blockId: "block-1",
      status: "running",
    });
    expect(() => registry.decide({
      sessionId: session.id,
      turnId: "turn-1",
      blockId: "block-1",
      version: 2,
      decision: "approve",
    })).toThrow("Stale approval version");
    expect(adapter!.decisions).toHaveLength(1);
  });

  test("buffers replay independently per session", async () => {
    const adapters = new Map<string, TestApprovalAdapter>();
    const registry = new SessionRegistry({
      adapters: {
        test: (config) => {
          const adapter = new TestApprovalAdapter(config);
          adapters.set(config.sessionId, adapter);
          return adapter;
        },
      },
    });

    const first = await registry.createSession("test", {
      sessionId: "session-1",
      name: "First",
    });
    const second = await registry.createSession("test", {
      sessionId: "session-2",
      name: "Second",
    });

    const firstAdapter = adapters.get(first.id);
    const secondAdapter = adapters.get(second.id);
    expect(firstAdapter).toBeDefined();
    expect(secondAdapter).toBeDefined();

    firstAdapter!.emit({
      event: "turn:start",
      sessionId: first.id,
      turn: {
        id: "turn-first-1",
        sessionId: first.id,
        status: "started",
        startedAt: new Date(1).toISOString(),
        blocks: [],
      },
    });
    secondAdapter!.emit({
      event: "turn:start",
      sessionId: second.id,
      turn: {
        id: "turn-second-1",
        sessionId: second.id,
        status: "started",
        startedAt: new Date(2).toISOString(),
        blocks: [],
      },
    });
    firstAdapter!.emit({
      event: "turn:end",
      sessionId: first.id,
      turnId: "turn-first-1",
      status: "completed",
    });

    expect(registry.currentSeq(first.id)).toBe(3);
    expect(registry.currentSeq(second.id)).toBe(2);
    expect(registry.oldestBufferedSeq(first.id)).toBe(1);
    expect(registry.oldestBufferedSeq(second.id)).toBe(1);

    expect(registry.replay(first.id, 0).map((event) => event.event.event)).toEqual([
      "session:update",
      "turn:start",
      "turn:end",
    ]);
    expect(registry.replay(second.id, 0).map((event) => event.event.event)).toEqual([
      "session:update",
      "turn:start",
    ]);
    expect(registry.replay(second.id, 1).map((event) => event.event.event)).toEqual([
      "turn:start",
    ]);
  });
});
