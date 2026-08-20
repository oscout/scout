import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";

import { sanitizeUploadName } from "./relay.ts";
import { startProcessParentWatchdog } from "./process-parent-watchdog.ts";
import {
  attachSession,
  createSession,
  destroy,
  detachSession,
  resizeSession,
  send,
  sessionOwnsSocket,
  sessions,
  verifyReconnectToken,
  writeSession,
} from "./terminal-relay-session.ts";
import type {
  ClientMessage,
  RelaySocket,
  Session,
} from "./terminal-relay-session.ts";

process.title = "scout-relay";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as any;

// The relay spawns login-shell PTYs; it must never inherit the web server's LAN
// bind (OPENSCOUT_WEB_HOST). Bind loopback unless an operator explicitly opts a
// specific host in via OPENSCOUT_WEB_TERMINAL_RELAY_HOST.
const hostname =
  process.env.OPENSCOUT_WEB_TERMINAL_RELAY_HOST?.trim()
  || "127.0.0.1";
const port = Number.parseInt(
  process.env.OPENSCOUT_WEB_TERMINAL_RELAY_PORT?.trim() || "3201",
  10,
);
const parentWatchdog = startProcessParentWatchdog(
  process.env.OPENSCOUT_WEB_RELAY_PARENT_PID,
);
const UPLOAD_DIR = "/tmp/scout-uploads";

type PendingCommand = {
  command: string;
  cwd?: string | null;
  agentId?: string | null;
};

type TerminalAckMessage = {
  type: "terminal:ack";
  seq?: number;
};

type RelayClientMessage = ClientMessage | TerminalAckMessage;

const OUTPUT_BATCH_INTERVAL_MS = 8;
const OUTPUT_BATCH_DRAIN_CONTINUE_MS = 1;
const OUTPUT_BATCH_CHUNK_CHARS = 16 * 1024;
const OUTPUT_BATCH_MAX_WRITES = 2;
const OUTPUT_IN_FLIGHT_HIGH_WATER_CHARS = 512 * 1024;
const OUTPUT_IN_FLIGHT_LOW_WATER_CHARS = 256 * 1024;
const OUTPUT_PENDING_MAX_CHARS = 2 * 1024 * 1024;
const OUTPUT_BACKLOG_WARNING =
  "\x18\x1b[0m\r\n[OpenScout skipped terminal output because the relay backlog exceeded 2 MB.]\r\n";

type OutputAck = {
  seq: number;
  chars: number;
};

function disableGeneratedSessionFlowControl<T extends ClientMessage>(msg: T): T {
  // OpenScout's node relay wraps the generated session with FlowControlledRelaySocket.
  // Keep ACK sequencing in that outer layer so client ACKs do not have to satisfy
  // two independent flow-control queues.
  return { ...msg, clientCapabilities: [] };
}

class FlowControlledRelaySocket implements RelaySocket {
  private session: Session | null = null;
  private pendingOutput = "";
  private pendingFlush: ReturnType<typeof setTimeout> | null = null;
  private nextSeq = 1;
  private unacked: OutputAck[] = [];
  private unackedChars = 0;
  private ptyPaused = false;
  private droppedBacklog = false;

  constructor(private readonly ws: any) {}

  get readyState(): number {
    return this.ws.readyState;
  }

  bindSession(session: Session): void {
    this.session = session;
  }

  send(data: string | Buffer): void {
    if (Buffer.isBuffer(data)) {
      this.sendRaw(data);
      return;
    }
    const message = parseServerMessage(data);
    if (message?.type === "terminal:data" && typeof message.data === "string") {
      this.enqueueOutput(message.data);
      return;
    }
    if (message?.type === "session:exit") {
      this.flushOutput({ ignoreBackpressure: true });
    }
    this.sendRaw(data);
  }

  handleAck(seq: number | undefined): void {
    if (typeof seq !== "number" || !Number.isFinite(seq)) {
      return;
    }
    while (this.unacked.length > 0 && this.unacked[0]!.seq <= seq) {
      const acked = this.unacked.shift()!;
      this.unackedChars = Math.max(0, this.unackedChars - acked.chars);
    }
    if (this.ptyPaused && this.unackedChars < OUTPUT_IN_FLIGHT_LOW_WATER_CHARS) {
      this.resumePty();
    }
    if (this.pendingOutput.length > 0) {
      this.scheduleFlush(OUTPUT_BATCH_DRAIN_CONTINUE_MS);
    }
  }

  dispose(): void {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
    this.pendingOutput = "";
    this.unacked = [];
    this.unackedChars = 0;
    this.resumePty();
    this.session = null;
  }

  private enqueueOutput(data: string): void {
    if (!data) {
      return;
    }
    this.pendingOutput += data;
    if (this.pendingOutput.length > OUTPUT_PENDING_MAX_CHARS) {
      this.pendingOutput = OUTPUT_BACKLOG_WARNING + this.pendingOutput.slice(-OUTPUT_PENDING_MAX_CHARS);
      if (!this.droppedBacklog) {
        console.warn("[relay] terminal output backlog exceeded 2 MB; keeping only the newest output");
        this.droppedBacklog = true;
      }
    }
    this.scheduleFlush(OUTPUT_BATCH_INTERVAL_MS);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.pendingFlush || this.pendingOutput.length === 0) {
      return;
    }
    this.pendingFlush = setTimeout(() => {
      this.pendingFlush = null;
      this.flushOutput();
    }, delayMs);
  }

  private flushOutput(options: { ignoreBackpressure?: boolean } = {}): void {
    if (this.pendingOutput.length === 0 || this.readyState !== 1) {
      return;
    }
    let writes = 0;
    while (this.pendingOutput.length > 0 && writes < OUTPUT_BATCH_MAX_WRITES) {
      if (!options.ignoreBackpressure && this.unackedChars >= OUTPUT_IN_FLIGHT_HIGH_WATER_CHARS) {
        this.pausePty();
        return;
      }
      const chunk = this.pendingOutput.slice(0, OUTPUT_BATCH_CHUNK_CHARS);
      this.pendingOutput = this.pendingOutput.slice(chunk.length);
      const seq = this.nextSeq++;
      this.unacked.push({ seq, chars: chunk.length });
      this.unackedChars += chunk.length;
      this.sendRaw(JSON.stringify({ type: "terminal:data", data: chunk, seq, chars: chunk.length }));
      writes++;
    }
    if (!options.ignoreBackpressure && this.unackedChars >= OUTPUT_IN_FLIGHT_HIGH_WATER_CHARS) {
      this.pausePty();
      return;
    }
    if (this.pendingOutput.length > 0) {
      this.scheduleFlush(OUTPUT_BATCH_DRAIN_CONTINUE_MS);
    } else {
      this.droppedBacklog = false;
    }
  }

  private pausePty(): void {
    if (this.ptyPaused || !this.session || this.session.exited) {
      return;
    }
    try {
      this.session.pty.pause();
      this.ptyPaused = true;
    } catch (error) {
      console.warn("[relay] Failed to pause PTY for terminal flow control:", error);
    }
  }

  private resumePty(): void {
    if (!this.ptyPaused || !this.session || this.session.exited) {
      this.ptyPaused = false;
      return;
    }
    try {
      this.session.pty.resume();
    } catch (error) {
      console.warn("[relay] Failed to resume PTY for terminal flow control:", error);
    } finally {
      this.ptyPaused = false;
    }
  }

  private sendRaw(data: string | Buffer): void {
    if (this.ws.readyState === 1) {
      this.ws.send(data);
    }
  }
}

function sessionMatchesSurface(
  session: Session,
  backend: string | undefined,
  sessionName: string | undefined,
): boolean {
  if (!backend || !sessionName || session.backend !== backend) return false;
  return session.tmuxSession === sessionName
    || session.zellijSession === sessionName
    || session.herdrSession === sessionName;
}

let pendingCommand: PendingCommand | null = null;

function queueTerminalCommand(input: PendingCommand): void {
  if (!input.cwd) {
    for (const [, session] of sessions) {
      if (writeSession(session, input.command + "\n")) {
        return;
      }
    }
  }
  pendingCommand = input;
}

function drainPendingCommand(): PendingCommand | null {
  const command = pendingCommand;
  pendingCommand = null;
  return command;
}

function parseServerMessage(raw: string): Record<string, unknown> | null {
  try {
    const message = JSON.parse(raw);
    return typeof message?.type === "string" ? message as Record<string, unknown> : null;
  } catch {}
  return null;
}

function parseMessage(raw: string): RelayClientMessage | null {
  const message = parseServerMessage(raw);
  return message ? message as RelayClientMessage : null;
}

function setCors(res: import("node:http").ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readJson<T>(
  req: import("node:http").IncomingMessage,
): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}


const server = createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${hostname}:${port}`);

  if (req.method === "GET" && url.pathname === "/health") {
    let attachedSessions = 0;
    for (const session of sessions.values()) {
      if (session.ws) {
        attachedSessions += 1;
      }
    }
    writeJson(res, 200, {
      ok: true,
      surface: "openscout-terminal-relay",
      pid: process.pid,
      sessions: sessions.size,
      attachedSessions,
    });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/api/upload" || url.pathname === "/api/relay/upload")) {
    const body = await readJson<{ name?: string; data?: string }>(req);
    if (!body?.name || !body.data) {
      writeJson(res, 400, { error: "Missing name or data" });
      return;
    }
    const safeName = sanitizeUploadName(body.name);
    if (!safeName) {
      writeJson(res, 400, { error: "Invalid name" });
      return;
    }
    await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
    const filepath = join(UPLOAD_DIR, `${randomUUID()}-${safeName}`);
    await writeFile(filepath, Buffer.from(body.data, "base64"), { mode: 0o600 });
    writeJson(res, 200, { path: filepath });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/terminal/run") {
    const body = await readJson<PendingCommand>(req);
    const command = body?.command?.trim();
    if (!command) {
      writeJson(res, 400, { error: "missing command" });
      return;
    }
    queueTerminalCommand({
      command,
      cwd: body?.cwd?.trim() || null,
      agentId: body?.agentId?.trim() || null,
    });
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/terminal/session/destroy") {
    const body = await readJson<{ sessionId?: string }>(req);
    const sessionId = body?.sessionId?.trim();
    if (!sessionId) {
      writeJson(res, 400, { error: "missing sessionId" });
      return;
    }
    const existed = sessions.has(sessionId);
    if (existed) {
      destroy(sessionId);
    }
    writeJson(res, 200, { ok: true, destroyed: existed });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/terminal/session/destroy-surface") {
    const body = await readJson<{ backend?: string; sessionName?: string }>(req);
    const backend = body?.backend?.trim();
    const sessionName = body?.sessionName?.trim();
    if (!backend || !sessionName) {
      writeJson(res, 400, { error: "missing backend or sessionName" });
      return;
    }
    let destroyed = 0;
    for (const [id, session] of [...sessions]) {
      if (!sessionMatchesSurface(session, backend, sessionName)) continue;
      destroy(id);
      destroyed += 1;
    }
    writeJson(res, 200, { ok: true, destroyed });
    return;
  }

  writeJson(res, 404, { error: "Not found" });
});

// Reject any handshake that carries an Origin header. The only legitimate client
// is the co-located web server's proxy, which (as a server-side WebSocket client)
// sends no Origin; browsers always send one. This blocks a malicious page in the
// user's browser from opening ws://localhost:<relay> directly and spawning a PTY.
const wss = new WebSocketServer({
  server,
  verifyClient: (info: { origin?: string; req: import("node:http").IncomingMessage }) => {
    const origin = info.origin ?? info.req.headers.origin;
    return !origin;
  },
});

wss.on("connection", (ws: any) => {
  let sessionId: string | null = null;
  const relaySocket = new FlowControlledRelaySocket(ws);

  ws.on("message", (raw: Buffer | string) => {
    void (async () => {
    const msg = parseMessage(raw.toString());
    if (!msg) {
      return;
    }

    switch (msg.type) {
      case "session:init": {
        const pending = drainPendingCommand();
        if (sessionId) {
          const previous = sessions.get(sessionId);
          if (previous && sessionOwnsSocket(previous, relaySocket)) {
            detachSession(previous);
          }
        }
        const session = await createSession(
          relaySocket,
          disableGeneratedSessionFlowControl(pending?.cwd ? { ...msg, cwd: pending.cwd, agent: "shell" } : msg),
        );
        if (!session) {
          break;
        }
        relaySocket.bindSession(session);
        sessionId = session.id;
        send(ws, {
          type: "session:ready",
          sessionId: session.id,
          reconnectToken: session.reconnectToken,
          cols: session.cols,
          rows: session.rows,
        });
        if (pending) {
          setTimeout(() => writeSession(session, pending.command + "\n"), 400);
        }
        break;
      }

      case "session:reconnect": {
        const pending = drainPendingCommand();
        if (pending?.cwd) {
          if (sessionId) {
            const previous = sessions.get(sessionId);
            if (previous && sessionOwnsSocket(previous, relaySocket)) {
              detachSession(previous);
            }
          }
          const session = await createSession(relaySocket, {
            type: "session:init",
            cols: msg.cols ?? 80,
            rows: msg.rows ?? 24,
            cwd: pending.cwd,
            agent: "shell",
            clientCapabilities: [],
          });
          if (!session) {
            break;
          }
          relaySocket.bindSession(session);
          sessionId = session.id;
          send(ws, {
            type: "session:ready",
            sessionId: session.id,
            reconnectToken: session.reconnectToken,
            cols: session.cols,
            rows: session.rows,
          });
          setTimeout(() => writeSession(session, pending.command + "\n"), 400);
          break;
        }
        const existing = sessions.get(msg.sessionId);
        const requestedControlMode = msg.controlMode || "owner";
        const canReconnect = existing
          && !existing.exited
          && existing.controlMode !== "observe"
          && existing.controlMode === requestedControlMode
          && verifyReconnectToken(existing, msg.reconnectToken);
        if (canReconnect) {
          if (sessionId && sessionId !== msg.sessionId) {
            const previous = sessions.get(sessionId);
            if (previous && sessionOwnsSocket(previous, relaySocket)) {
              detachSession(previous);
            }
          }
          if (existing.ws && existing.ws !== relaySocket) {
            send(existing.ws, { type: "session:detached" });
          }
          sessionId = existing.id;
          relaySocket.bindSession(existing);
          await attachSession(existing, relaySocket, msg.cols, msg.rows, []);
          send(ws, {
            type: "session:ready",
            sessionId: existing.id,
            reconnectToken: existing.reconnectToken,
            reconnected: true,
            cols: existing.cols,
            rows: existing.rows,
          });
          if (pending) {
            setTimeout(() => writeSession(existing, pending.command + "\n"), 400);
          }
        } else {
          send(ws, { type: "session:expired", sessionId: msg.sessionId });
        }
        break;
      }

      case "terminal:ack": {
        relaySocket.handleAck(msg.seq);
        break;
      }

      case "terminal:input": {
        if (!sessionId) {
          return;
        }
        const session = sessions.get(sessionId);
        if (session && sessionOwnsSocket(session, relaySocket)) {
          writeSession(session, msg.data);
        }
        break;
      }

      case "terminal:resize": {
        if (!sessionId) {
          return;
        }
        const session = sessions.get(sessionId);
        if (session && sessionOwnsSocket(session, relaySocket)) {
          const cols = Math.max(msg.cols || 80, 20);
          const rows = Math.max(msg.rows || 24, 4);
          await resizeSession(session, cols, rows);
        }
        break;
      }
    }
    })().catch((error) => {
      console.error("[relay] message handler failed:", error);
    });
  });

  ws.on("close", () => {
    if (!sessionId) {
      return;
    }
    const session = sessions.get(sessionId);
    if (session && sessionOwnsSocket(session, relaySocket)) {
      detachSession(session);
    }
    relaySocket.dispose();
    sessionId = null;
  });

  ws.on("error", (err: Error) => {
    console.error("[relay] WebSocket error:", err.message);
    if (!sessionId) {
      return;
    }
    const session = sessions.get(sessionId);
    if (session && sessionOwnsSocket(session, relaySocket)) {
      detachSession(session);
    }
    relaySocket.dispose();
    sessionId = null;
  });
});

server.listen(port, hostname, () => {
  console.log(`[relay] Server listening on http://${hostname}:${port} (HTTP + WebSocket)`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (parentWatchdog) clearInterval(parentWatchdog);
  console.log("\n[relay] Shutting down...");
  for (const [id] of sessions) {
    destroy(id);
  }
  wss.close();
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
