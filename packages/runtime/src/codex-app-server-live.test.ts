import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, test } from "bun:test";

type JsonRpcMessage = {
  id?: string | number;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: number | string;
    message?: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type TurnStartedNotification = {
  threadId: string;
  turn: {
    id: string;
  };
};

type TurnCompletedNotification = {
  threadId: string;
  turn: {
    id: string;
    status: "completed" | "failed" | "interrupted" | "inProgress";
    error?: {
      message?: string;
      additionalDetails?: string | null;
    } | null;
  };
};

type ItemCompletedNotification = {
  threadId: string;
  turnId: string;
  item?: {
    type?: string;
    text?: string;
  };
};

type ThreadResumeResult = {
  thread: {
    id: string;
    path?: string | null;
    cwd?: string | null;
  };
};

class CodexLiveJsonRpcClient {
  private readonly socket: any;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: JsonRpcMessage[] = [];

  private constructor(socket: any) {
    this.socket = socket;
  }

  static async connect(url: string, timeoutMs = 5_000): Promise<CodexLiveJsonRpcClient> {
    const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => any }).WebSocket;
    if (!WebSocketCtor) {
      throw new Error("Global WebSocket is unavailable in this runtime.");
    }

    const socket = new WebSocketCtor(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out connecting to Codex app-server at ${url}.`));
      }, timeoutMs);

      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error(`Unable to connect to Codex app-server at ${url}.`));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
    });

    const client = new CodexLiveJsonRpcClient(socket);
    client.installHandlers();
    return client;
  }

  private installHandlers(): void {
    this.socket.addEventListener("message", (event: { data?: unknown }) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data ?? "");
      let payload: JsonRpcMessage;
      try {
        payload = JSON.parse(raw) as JsonRpcMessage;
      } catch {
        return;
      }

      if (typeof payload.id === "number") {
        const request = this.pending.get(payload.id);
        if (!request) {
          return;
        }
        this.pending.delete(payload.id);
        clearTimeout(request.timeout);
        if (payload.error) {
          request.reject(new Error(payload.error.message || `Codex app-server request ${payload.id} failed.`));
          return;
        }
        request.resolve(payload.result);
        return;
      }

      if (typeof payload.method === "string") {
        this.notifications.push(payload);
      }
    });

    const rejectPending = (message: string) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error(message));
      }
      this.pending.clear();
    };

    this.socket.addEventListener("close", () => {
      rejectPending("Codex app-server connection closed.");
    });
    this.socket.addEventListener("error", () => {
      rejectPending("Codex app-server transport error.");
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "openscout-live-test",
        title: "OpenScout Live JSON-RPC Test",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
  }

  request<T>(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (this.socket.readyState !== this.socket.OPEN) {
      return Promise.reject(new Error("Codex app-server is not connected."));
    }

    const id = this.nextRequestId++;
    const payload = {
      id,
      jsonrpc: "2.0",
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server response to ${method}.`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.socket.send(JSON.stringify(payload));
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      throw new Error("Codex app-server is not connected.");
    }
    const payload = params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method };
    this.socket.send(JSON.stringify(payload));
  }

  async waitForNotification<T extends JsonRpcMessage>(
    predicate: (message: JsonRpcMessage) => message is T,
    timeoutMs = 60_000,
  ): Promise<T> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const match = this.notifications.find(predicate);
      if (match) {
        return match;
      }
      await delay(50);
    }
    throw new Error(`Timed out waiting for Codex app-server notification after ${timeoutMs}ms.`);
  }

  close(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Codex live JSON-RPC client closed."));
    }
    this.pending.clear();

    if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
      this.socket.close();
    }
  }
}

async function waitForRolloutToken(path: string, token: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const body = readFileSync(path, "utf8");
      if (body.includes(token)) {
        return;
      }
    } catch {
      // Retry until the rollout file becomes readable.
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for rollout file ${path} to include ${token}.`);
}

function isTurnStartedFor(threadId: string) {
  return (message: JsonRpcMessage): message is JsonRpcMessage & { params: TurnStartedNotification } =>
    message.method === "turn/started"
    && typeof message.params?.threadId === "string"
    && message.params.threadId === threadId
    && typeof (message.params.turn as Record<string, unknown> | undefined)?.id === "string";
}

function isTurnCompletedFor(threadId: string, turnId: string) {
  return (message: JsonRpcMessage): message is JsonRpcMessage & { params: TurnCompletedNotification } =>
    message.method === "turn/completed"
    && typeof message.params?.threadId === "string"
    && message.params.threadId === threadId
    && typeof (message.params.turn as Record<string, unknown> | undefined)?.id === "string"
    && ((message.params.turn as Record<string, unknown>).id === turnId);
}

function isAgentMessageCompletionFor(threadId: string, turnId: string) {
  return (message: JsonRpcMessage): message is JsonRpcMessage & { params: ItemCompletedNotification } =>
    message.method === "item/completed"
    && typeof message.params?.threadId === "string"
    && message.params.threadId === threadId
    && typeof message.params?.turnId === "string"
    && message.params.turnId === turnId
    && typeof (message.params.item as Record<string, unknown> | undefined)?.type === "string"
    && (message.params.item as Record<string, unknown>).type === "agentMessage";
}

const liveUrl = process.env.OPENSCOUT_CODEX_APP_SERVER_URL?.trim();
const liveThreadId = process.env.OPENSCOUT_CODEX_THREAD_ID?.trim();
const liveCwd = process.env.OPENSCOUT_CODEX_LIVE_CWD?.trim() || process.cwd();
const runLiveTest = Boolean(liveUrl && liveThreadId);
const liveTest = runLiveTest ? test : test.skip;

describe("Codex app-server live JSON-RPC", () => {
  liveTest("resumes the target thread and writes a turn into the live rollout", async () => {
    const client = await CodexLiveJsonRpcClient.connect(liveUrl!);
    try {
      await client.initialize();

      const resumed = await client.request<ThreadResumeResult>("thread/resume", {
        threadId: liveThreadId!,
        cwd: liveCwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        persistExtendedHistory: true,
      });

      expect(resumed.thread.id).toBe(liveThreadId);

      const token = `LIVE_JSON_RPC_${randomUUID()}`;
      await client.request("turn/start", {
        threadId: liveThreadId!,
        cwd: liveCwd,
        input: [
          {
            type: "text",
            text: `Live JSON-RPC test. Reply with exactly ${token}`,
            text_elements: [],
          },
        ],
      });

      const started = await client.waitForNotification(isTurnStartedFor(liveThreadId!));
      const turnId = started.params.turn.id;
      const completed = await client.waitForNotification(isTurnCompletedFor(liveThreadId!, turnId));
      expect(completed.params.turn.status).toBe("completed");

      const finalMessage = await client.waitForNotification(isAgentMessageCompletionFor(liveThreadId!, turnId));
      expect(finalMessage.params.item?.text).toContain(token);

      if (typeof resumed.thread.path === "string" && resumed.thread.path.trim().length > 0) {
        await waitForRolloutToken(resumed.thread.path, token);
      }
    } finally {
      client.close();
    }
  }, 90_000);
});
