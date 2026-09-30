import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Byte transports underneath the one Codex app-server JSON-RPC client.
 *
 * - `spawned`: Scout launches `codex app-server` and speaks newline-delimited
 *   JSON over the child's stdio. Scout owns that process.
 * - `attached`: Scout connects to an app-server that is already running (the
 *   Codex daemon's control socket) and speaks one JSON-RPC message per
 *   WebSocket text frame over a unix socket. Scout never owns that process:
 *   closing only disconnects.
 */
export type CodexAppServerConnectionMode = "spawned" | "attached";

export type CodexAppServerConnectionConfig =
  | { mode: "spawn" }
  | { mode: "attach"; socketPath?: string };

export type CodexAppServerConnectionClose = {
  exitCode: number | null;
  signal: string | null;
  error?: Error;
};

export type CodexAppServerConnectionHandlers = {
  onMessage(text: string): void;
  onClose(close: CodexAppServerConnectionClose): void;
  /** Raw stdout/stderr bytes for spawned servers (logging only). */
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
  /** Payloads that could not be framed as a message (logging only). */
  onUnparsable?(detail: string): void;
};

export interface CodexAppServerConnection {
  readonly mode: CodexAppServerConnectionMode;
  /** Child pid for spawned servers; always null for attached servers. */
  readonly pid: number | null;
  readonly socketPath: string | null;
  isOpen(): boolean;
  /** Send one serialized JSON-RPC message. */
  send(text: string): void;
  /**
   * Spawned: SIGTERM, then SIGKILL after a grace period.
   * Attached: WebSocket close + socket end. Never signals the server.
   */
  close(): Promise<void>;
  /** Drop handlers without closing (used when the session is abandoned). */
  detach(): void;
}

export function defaultCodexAppServerControlSocketPath(home = homedir()): string {
  return join(home, ".codex", "app-server-control", "app-server-control.sock");
}

export function resolveCodexAppServerConnectionConfig(
  config: CodexAppServerConnectionConfig | undefined,
): { mode: "spawn" } | { mode: "attach"; socketPath: string } {
  if (config?.mode === "attach") {
    return {
      mode: "attach",
      socketPath: config.socketPath?.trim() || defaultCodexAppServerControlSocketPath(),
    };
  }
  return { mode: "spawn" };
}

// ---------------------------------------------------------------------------
// Spawned: newline-delimited JSON over child stdio
// ---------------------------------------------------------------------------

export function spawnCodexAppServerStdioConnection(input: {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  handlers: CodexAppServerConnectionHandlers;
}): CodexAppServerConnection {
  const child: ChildProcessWithoutNullStreams = spawn(input.executable, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let handlers: CodexAppServerConnectionHandlers | null = input.handlers;
  let lineBuffer = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    handlers?.onStdout?.(chunk);
    lineBuffer += chunk;
    while (true) {
      const newlineIndex = lineBuffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line) handlers?.onMessage(line);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    handlers?.onStderr?.(chunk);
  });
  child.once("error", (error) => {
    handlers?.onClose({ exitCode: null, signal: null, error });
  });
  child.once("exit", (code, signal) => {
    handlers?.onClose({ exitCode: code, signal });
  });

  return {
    mode: "spawned",
    get pid() {
      return child.pid ?? null;
    },
    socketPath: null,
    isOpen: () => !child.killed && child.exitCode === null,
    send(text: string) {
      if (child.killed || child.exitCode !== null) {
        throw new Error("Codex app-server process is not running.");
      }
      child.stdin.write(`${text}\n`);
    },
    async close() {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    },
    detach() {
      handlers = null;
      child.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
    },
  };
}

// ---------------------------------------------------------------------------
// Attached: WebSocket (RFC 6455) over a unix socket
// ---------------------------------------------------------------------------

const WS_OP_CONTINUATION = 0x0;
const WS_OP_TEXT = 0x1;
const WS_OP_BINARY = 0x2;
const WS_OP_CLOSE = 0x8;
const WS_OP_PING = 0x9;
const WS_OP_PONG = 0xa;

/** Encode one WebSocket frame. Client frames must be masked (RFC 6455 §5.3). */
export function encodeWebSocketFrame(
  opcode: number,
  payload: Uint8Array,
  options: { mask?: boolean; maskKey?: Uint8Array } = {},
): Buffer {
  const mask = options.mask ?? true;
  const length = payload.length;
  const header: number[] = [0x80 | (opcode & 0x0f)];
  const maskBit = mask ? 0x80 : 0;
  if (length < 126) {
    header.push(maskBit | length);
  } else if (length < 0x10000) {
    header.push(maskBit | 126, (length >>> 8) & 0xff, length & 0xff);
  } else {
    header.push(maskBit | 127, 0, 0, 0, 0,
      (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
  }
  const maskKey = mask ? (options.maskKey ?? randomBytes(4)) : null;
  const out = Buffer.alloc(header.length + (maskKey ? 4 : 0) + length);
  out.set(header, 0);
  let offset = header.length;
  if (maskKey) {
    out.set(maskKey.subarray(0, 4), offset);
    offset += 4;
    for (let index = 0; index < length; index += 1) {
      out[offset + index] = payload[index]! ^ maskKey[index % 4]!;
    }
  } else {
    out.set(payload, offset);
  }
  return out;
}

export type WebSocketFrame = { fin: boolean; opcode: number; payload: Buffer };

/**
 * Incremental frame decoder. Feed raw bytes; complete frames come back in
 * order and partial frames stay buffered until the rest arrives.
 */
export class WebSocketFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): WebSocketFrame[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: WebSocketFrame[] = [];
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) break;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("WebSocket frame too large");
        }
        length = Number(big);
        offset = 10;
      }
      const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) break;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (maskKey) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index]! ^ maskKey[index % 4]!;
        }
      }
      frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
      this.buffer = this.buffer.subarray(offset + length);
    }
    return frames;
  }
}

function webSocketUpgradeRequest(key: string): string {
  return [
    "GET / HTTP/1.1",
    "Host: localhost",
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${key}`,
    "",
    "",
  ].join("\r\n");
}

/**
 * Connect to a running app-server over its unix control socket and complete
 * the WebSocket upgrade. Resolves once `101 Switching Protocols` arrives.
 */
export async function connectCodexAppServerSocket(input: {
  socketPath: string;
  handlers: CodexAppServerConnectionHandlers;
  connectTimeoutMs?: number;
}): Promise<CodexAppServerConnection> {
  const socketPath = input.socketPath;
  let handlers: CodexAppServerConnectionHandlers | null = input.handlers;
  const decoder = new WebSocketFrameDecoder();
  let upgraded = false;
  let open = false;
  let closeReported = false;
  let closeSent = false;
  let handshake = Buffer.alloc(0);
  let fragments: Buffer[] = [];

  const socket: Socket = connect({ path: socketPath });

  const reportClose = (close: CodexAppServerConnectionClose) => {
    open = false;
    if (closeReported) return;
    closeReported = true;
    handlers?.onClose(close);
  };

  const writeFrame = (opcode: number, payload: Uint8Array) => {
    socket.write(encodeWebSocketFrame(opcode, payload, { mask: true }));
  };

  const handleFrames = (chunk: Buffer) => {
    let frames: WebSocketFrame[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      reportClose({ exitCode: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) });
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === WS_OP_PING) {
        writeFrame(WS_OP_PONG, frame.payload);
        continue;
      }
      if (frame.opcode === WS_OP_PONG) continue;
      if (frame.opcode === WS_OP_CLOSE) {
        if (!closeSent) {
          closeSent = true;
          writeFrame(WS_OP_CLOSE, frame.payload.subarray(0, 2));
        }
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString("utf8") : "";
        reportClose({
          exitCode: code,
          signal: null,
          error: new Error(`Codex app-server closed the socket${code !== null ? ` (${code}${reason ? `: ${reason}` : ""})` : ""}.`),
        });
        socket.end();
        return;
      }
      if (frame.opcode === WS_OP_TEXT || frame.opcode === WS_OP_BINARY || frame.opcode === WS_OP_CONTINUATION) {
        fragments.push(frame.payload);
        if (!frame.fin) continue;
        const text = Buffer.concat(fragments).toString("utf8");
        fragments = [];
        if (text.trim()) handlers?.onMessage(text);
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    const timeoutMs = input.connectTimeoutMs ?? 10_000;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out after ${timeoutMs}ms attaching to Codex app-server at ${socketPath}.`));
    }, timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.once("connect", () => {
      socket.write(webSocketUpgradeRequest(randomBytes(16).toString("base64")));
    });
    socket.on("data", (chunk: Buffer) => {
      if (upgraded) {
        handleFrames(chunk);
        return;
      }
      handshake = Buffer.concat([handshake, chunk]);
      const headerEnd = handshake.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const head = handshake.subarray(0, headerEnd).toString("latin1");
      const statusLine = head.split("\r\n", 1)[0] ?? "";
      if (!/^HTTP\/1\.1 101\b/.test(statusLine)) {
        fail(new Error(`Codex app-server at ${socketPath} refused the WebSocket upgrade: ${statusLine || "no status line"}`));
        return;
      }
      upgraded = true;
      open = true;
      clearTimeout(timer);
      const rest = handshake.subarray(headerEnd + 4);
      handshake = Buffer.alloc(0);
      resolve();
      if (rest.length > 0) handleFrames(rest);
    });
    socket.once("error", (error) => {
      if (!upgraded) {
        fail(new Error(`Could not attach to Codex app-server at ${socketPath}: ${error.message}`));
        return;
      }
      reportClose({ exitCode: null, signal: null, error });
    });
    socket.once("close", () => {
      if (!upgraded) {
        fail(new Error(`Codex app-server at ${socketPath} closed the connection before the WebSocket upgrade.`));
        return;
      }
      reportClose({ exitCode: null, signal: null, error: new Error(`Codex app-server socket ${socketPath} closed.`) });
    });
  });

  return {
    mode: "attached",
    pid: null,
    socketPath,
    isOpen: () => open && !socket.destroyed,
    send(text: string) {
      if (!open || socket.destroyed) {
        throw new Error(`Codex app-server socket ${socketPath} is not connected.`);
      }
      writeFrame(WS_OP_TEXT, Buffer.from(text, "utf8"));
    },
    async close() {
      if (socket.destroyed) return;
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      if (open && !closeSent) {
        closeSent = true;
        const status = Buffer.alloc(2);
        status.writeUInt16BE(1000, 0);
        try {
          writeFrame(WS_OP_CLOSE, status);
        } catch {
          // Socket already gone.
        }
      }
      open = false;
      socket.end();
      const timer = setTimeout(() => socket.destroy(), 500);
      await closed;
      clearTimeout(timer);
    },
    detach() {
      handlers = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Daemon identity
// ---------------------------------------------------------------------------

export type CodexAppServerDaemonVersion = {
  status: string | null;
  socketPath: string | null;
  appServerVersion: string | null;
  cliVersion: string | null;
};

export function parseCodexAppServerDaemonVersion(output: string): CodexAppServerDaemonVersion | null {
  const line = output.split("\n").map((entry) => entry.trim()).find((entry) => entry.startsWith("{"));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
    return {
      status: text(parsed.status),
      socketPath: text(parsed.socketPath),
      appServerVersion: text(parsed.appServerVersion),
      cliVersion: text(parsed.cliVersion),
    };
  } catch {
    return null;
  }
}

/**
 * Read-only `codex app-server daemon version`. Best effort: resolves null on
 * any failure or after the timeout. Never starts, updates or restarts the
 * daemon.
 */
export function readCodexAppServerDaemonVersion(input: {
  executable: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<CodexAppServerDaemonVersion | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (value: CodexAppServerDaemonVersion | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(input.executable, ["app-server", "daemon", "version"], {
        env: input.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, input.timeoutMs ?? 5_000);
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", () => finish(null));
    child.once("exit", () => finish(parseCodexAppServerDaemonVersion(output)));
  });
}
