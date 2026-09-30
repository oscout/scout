import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gunzip } from "node:zlib";
import { closeServer, listenTcp } from "../broker-server-lifecycle.js";
import { decodeOtlpRequest, encodeOtlpResponse, OtlpDecodeError, type OtlpEncoding } from "./codec.js";
import { OTLP_HOST, otlpBaseUrl, otlpPaths, resolveOtlpLimits, resolveOtlpPort, type OtlpLimits } from "./config.js";
import { renderInspectionPage } from "./inspection-page.js";
import { buildInspectionView } from "./inspection-view.js";
import { sanitizeOtlpRequest, type OtlpObservation, type OtlpSignal } from "./sanitize.js";
import { OtlpObservationStore } from "./store.js";

export type OtlpReceiverOptions = {
  databasePath: string;
  port?: number;
  limits?: Partial<OtlpLimits>;
  now?: () => number;
};

class RequestFailure extends Error {
  constructor(readonly status: number) { super("OTLP request rejected"); }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

function localRequest(request: IncomingMessage): boolean {
  if (request.headers.origin !== undefined) return false;
  const host = request.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) return false;
  const port = /:(\d+)$/.exec(host)?.[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
}

function readBody(request: IncomingMessage, limits: OtlpLimits): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: RequestFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, bytes));
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxWireBytes) finish(new RequestFailure(413));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAborted = () => finish(new RequestFailure(400));
    const onError = () => finish(new RequestFailure(400));
    const timer = setTimeout(() => finish(new RequestFailure(408)), limits.requestTimeoutMs);
    timer.unref();
    request.on("data", onData).once("end", onEnd).once("aborted", onAborted).once("error", onError);
    if (Number(request.headers["content-length"]) > limits.maxWireBytes) finish(new RequestFailure(413));
  });
}

async function decompress(body: Buffer, encoding: string | undefined, limit: number): Promise<Buffer> {
  if (!encoding || encoding === "identity") {
    if (body.length > limit) throw new RequestFailure(413);
    return body;
  }
  return new Promise((resolve, reject) => {
    gunzip(body, { maxOutputLength: limit }, (error, result) => {
      if (error) reject(new RequestFailure((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? 413 : 400));
      else resolve(result);
    });
  });
}

export async function startOtlpReceiver(options: OtlpReceiverOptions) {
  const limits = resolveOtlpLimits(options.limits);
  const port = resolveOtlpPort(options.port, true);
  if (!options.databasePath) throw new Error("OTLP database path required");
  const now = options.now ?? Date.now;
  const store = new OtlpObservationStore(options.databasePath, limits, now);
  const queue: { record: OtlpObservation; bytes: number }[] = [];
  const perResource = new Map<string, number>();
  let queuedBytes = 0;
  let active = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const counters = {
    accepted: { traces: 0, logs: 0, metrics: 0 }, rejected: { traces: 0, logs: 0, metrics: 0 },
    invalidRequests: 0, persistenceFailures: 0, persistenceLost: 0, cleanupFailures: 0,
  };
  const drain = (count: number) => {
    const batch = queue.splice(0, count);
    if (!batch.length) return;
    for (const item of batch) {
      queuedBytes -= item.bytes;
      const left = perResource.get(item.record.resourceKey)! - 1;
      if (left === 0) perResource.delete(item.record.resourceKey);
      else perResource.set(item.record.resourceKey, left);
    }
    try { store.append(batch.map((item) => item.record)); }
    catch { counters.persistenceFailures += 1; counters.persistenceLost += batch.length; }
  };
  const flush = async () => { while (queue.length) drain(limits.flushBatchSize); };
  const status = () => ({
    mode: "inspection-only", durableAcknowledgement: false, closing,
    ...structuredClone(counters), queue: { items: queue.length, bytes: queuedBytes, resources: perResource.size },
    inFlightRequests: active, store: store.status(),
  });
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      counters.invalidRequests += 1;
      if (response.destroyed || response.writableEnded) return;
      const code = error instanceof RequestFailure ? error.status : error instanceof OtlpDecodeError ? 400 : 500;
      response.setHeader("Connection", "close");
      if (code === 503) response.setHeader("Retry-After", "1");
      sendJson(response, code, { error: "OTLP request rejected" });
      request.resume();
    });
  });
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.requestTimeoutMs;
  server.keepAliveTimeout = 1000;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!localRequest(request)) throw new RequestFailure(403);
    if (closing) throw new RequestFailure(503);
    const url = new URL(request.url ?? "/", otlpBaseUrl(port));
    if (url.pathname === otlpPaths.inspector) {
      if (request.method !== "GET") throw new RequestFailure(405);
      const view = buildInspectionView(store.recent(500), status(), url.searchParams.get("session") ?? undefined, now(), limits.ttlMs);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(renderInspectionPage(view));
      return;
    }
    if (url.pathname === otlpPaths.favicon) {
      if (request.method !== "GET") throw new RequestFailure(405);
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (url.pathname === otlpPaths.health || url.pathname === otlpPaths.observations) {
      if (request.method !== "GET") throw new RequestFailure(405);
      const value = url.pathname === otlpPaths.health ? status() : store.recent(Number(url.searchParams.get("limit") ?? 100));
      sendJson(response, 200, value);
      return;
    }
    const signal = (["traces", "logs", "metrics"] as const).find((key) => otlpPaths[key] === url.pathname);
    if (!signal) throw new RequestFailure(404);
    if (request.method !== "POST") throw new RequestFailure(405);
    const encoding = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (encoding !== "application/json" && encoding !== "application/x-protobuf") throw new RequestFailure(415);
    const compression = request.headers["content-encoding"]?.trim().toLowerCase();
    if (compression && compression !== "gzip" && compression !== "identity") throw new RequestFailure(415);
    if (active >= limits.maxConcurrentRequests) throw new RequestFailure(503);
    active += 1;
    try {
      const wire = await readBody(request, limits);
      const bytes = await decompress(wire, compression, limits.maxDecodedBytes);
      if (closing) throw new RequestFailure(503);
      const decoded = decodeOtlpRequest(signal, bytes, encoding, limits.maxDepth);
      const sanitized = sanitizeOtlpRequest(signal, decoded, now(), limits);
      let rejected = sanitized.rejected;
      for (const record of sanitized.observations) {
        const bytes = Buffer.byteLength(JSON.stringify(record));
        const pending = perResource.get(record.resourceKey) ?? 0;
        if (queue.length >= limits.maxQueueItems || queuedBytes + bytes > limits.maxQueueBytes
          || pending >= limits.maxResourceQueueItems) { rejected += 1; continue; }
        queue.push({ record, bytes });
        queuedBytes += bytes;
        perResource.set(record.resourceKey, pending + 1);
      }
      counters.accepted[signal] += sanitized.total - rejected;
      counters.rejected[signal] += rejected;
      response.writeHead(200, { "Content-Type": encoding, "Cache-Control": "no-store" });
      response.end(encodeOtlpResponse(signal, encoding as OtlpEncoding, rejected));
    } finally { active -= 1; }
  }

  try { await listenTcp(server, { host: OTLP_HOST, port }); }
  catch (error) { store.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") { await closeServer(server); store.close(); throw new Error("Missing OTLP listener address"); }
  const flushTimer = setInterval(() => drain(limits.flushBatchSize), limits.flushIntervalMs);
  flushTimer.unref();
  const cleanupTimer = setInterval(() => {
    try { store.cleanup(); } catch { counters.cleanupFailures += 1; }
  }, Math.min(limits.ttlMs, 60_000));
  cleanupTimer.unref();

  return {
    url: otlpBaseUrl(address.port), flush, status,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(flushTimer);
      clearInterval(cleanupTimer);
      closePromise = (async () => {
        await closeServer(server, Math.min(limits.requestTimeoutMs, 1000));
        await flush();
        store.close();
      })();
      return closePromise;
    },
  };
}
