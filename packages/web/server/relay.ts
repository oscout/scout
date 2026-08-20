import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

const UPLOAD_DIR = "/tmp/scout-uploads";

/**
 * Reduce an untrusted upload filename to a single safe path segment. Strips any
 * directory components so a name like "../../etc/authorized_keys" cannot escape
 * UPLOAD_DIR, and rejects names that resolve to nothing usable. Returns null if
 * the name is unsafe.
 */
export function sanitizeUploadName(name: string): string | null {
  const base = basename(name).trim();
  if (!base || base === "." || base === ".." || base.includes("/") || base.includes("\\")) {
    return null;
  }
  return base;
}

export async function handleRelayUpload(req: Request): Promise<Response> {
  const { name, data } = (await req.json()) as { name: string; data: string };
  if (!name || !data) {
    return Response.json({ error: "Missing name or data" }, { status: 400 });
  }

  const safeName = sanitizeUploadName(name);
  if (!safeName) {
    return Response.json({ error: "Invalid name" }, { status: 400 });
  }

  await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  const filepath = join(UPLOAD_DIR, `${randomUUID()}-${safeName}`);
  await writeFile(filepath, Buffer.from(data, "base64"), { mode: 0o600 });
  return Response.json({ path: filepath });
}

type RelayProxySocket = {
  readyState: number;
  send(data: string | Buffer | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  data: RelayWSData;
};

type UpstreamPayload = string | Buffer | ArrayBuffer | Uint8Array;

export interface RelayWSData {
  upstream: WebSocket | null;
  pending: UpstreamPayload[];
  upstreamProtocol: string | null;
  upstreamUrl: string | null;
  upstreamAttempts?: number;
  upstreamRetryTimer?: ReturnType<typeof setTimeout>;
}

function flushPending(ws: RelayProxySocket) {
  const upstream = ws.data.upstream;
  if (!upstream || upstream.readyState !== WebSocket.OPEN) {
    return;
  }
  for (const payload of ws.data.pending) {
    upstream.send(payload);
  }
  ws.data.pending.length = 0;
}

function forwardToClient(
  ws: RelayProxySocket,
  data: string | ArrayBuffer | Uint8Array | Blob,
) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  if (typeof data === "string") {
    ws.send(data);
    return;
  }
  if (data instanceof Blob) {
    void data.arrayBuffer().then((buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer);
      }
    }).catch(() => {});
    return;
  }
  ws.send(data);
}

const UPSTREAM_CONNECT_MAX_ATTEMPTS = 8;
const UPSTREAM_CONNECT_RETRY_MS = 250;

function clearUpstreamRetry(ws: RelayProxySocket) {
  const timer = ws.data.upstreamRetryTimer;
  if (timer) {
    clearTimeout(timer);
    ws.data.upstreamRetryTimer = undefined;
  }
}

function closeRelayClient(ws: RelayProxySocket, code?: number, reason?: string) {
  clearUpstreamRetry(ws);
  ws.data.pending.length = 0;
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(code, reason);
  }
}

function connectRelayUpstream(ws: RelayProxySocket) {
  const targetUrl = ws.data.upstreamUrl;
  if (!targetUrl) {
    closeRelayClient(ws, 1011, "Missing relay upstream");
    return;
  }

  const upstream = ws.data.upstreamProtocol
    ? new WebSocket(targetUrl, ws.data.upstreamProtocol)
    : new WebSocket(targetUrl);
  upstream.binaryType = "arraybuffer";
  ws.data.upstream = upstream;
  let upstreamOpened = false;

  upstream.onopen = () => {
    upstreamOpened = true;
    ws.data.upstreamAttempts = 0;
    flushPending(ws);
  };

  upstream.onmessage = (event) => {
    forwardToClient(ws, event.data);
  };

  const handleUpstreamDisconnect = () => {
    if (ws.data.upstream !== upstream) {
      return;
    }
    ws.data.upstream = null;
    if (upstreamOpened) {
      closeRelayClient(ws);
      return;
    }
    if (ws.data.upstreamRetryTimer) {
      return;
    }
    const attempts = (ws.data.upstreamAttempts ?? 0) + 1;
    ws.data.upstreamAttempts = attempts;
    if (attempts >= UPSTREAM_CONNECT_MAX_ATTEMPTS) {
      closeRelayClient(ws);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
      return;
    }
    ws.data.upstreamRetryTimer = setTimeout(() => {
      ws.data.upstreamRetryTimer = undefined;
      connectRelayUpstream(ws);
    }, UPSTREAM_CONNECT_RETRY_MS);
  };

  upstream.onerror = handleUpstreamDisconnect;
  upstream.onclose = handleUpstreamDisconnect;
}

export function createRelayWebSocketProxy() {
  return {
    open(ws: RelayProxySocket) {
      ws.data.pending = [];
      ws.data.upstreamAttempts = 0;
      connectRelayUpstream(ws);
    },

    message(
      ws: RelayProxySocket,
      raw: string | Buffer,
    ) {
      const upstream = ws.data.upstream;
      const payload = raw as UpstreamPayload;

      if (!upstream || upstream.readyState === WebSocket.CONNECTING) {
        ws.data.pending.push(payload);
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(payload);
      }
    },

    close(ws: RelayProxySocket) {
      clearUpstreamRetry(ws);
      const upstream = ws.data.upstream;
      ws.data.upstream = null;
      ws.data.pending.length = 0;
      ws.data.upstreamProtocol = null;
      ws.data.upstreamUrl = null;
      ws.data.upstreamAttempts = undefined;
      if (!upstream) {
        return;
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    },
  };
}
