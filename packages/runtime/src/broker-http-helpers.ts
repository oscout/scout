import type { RuntimeHttpRequestLike, RuntimeHttpResponseLike } from "./portable-types.js";

import { A2A_JSON_RPC_CONTENT_TYPE } from "@openscout/protocol";
import type { z } from "zod";

import { ThreadWatchProtocolError } from "./thread-events.js";

const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

export class BrokerHttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrokerHttpRequestError";
  }
}

export function readRequestBody<T>(
  request: RuntimeHttpRequestLike,
  options: { maxBytes?: number; requireJsonContentType?: boolean } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const maxBytes = options.maxBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES;
    const contentType = request.headers?.["content-type"];
    const normalizedContentType = Array.isArray(contentType) ? contentType[0] : contentType;
    if (
      options.requireJsonContentType !== false
      && normalizedContentType
      && !/\b(json|.+\+json)\b/i.test(normalizedContentType)
    ) {
      reject(new BrokerHttpRequestError(415, "unsupported_media_type", "expected a JSON request body"));
      request.resume();
      return;
    }

    let receivedBytes = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      if (receivedBytes > maxBytes) {
        rejected = true;
        reject(new BrokerHttpRequestError(413, "request_entity_too_large", "request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (rejected) {
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve((raw ? JSON.parse(raw) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function formatZodPath(path: Array<PropertyKey>): string {
  return path.length > 0 ? path.map((part) => String(part)).join(".") : "body";
}

function formatZodIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, 5).map((issue) =>
    `${formatZodPath(issue.path)}: ${issue.message}`
  );
  const suffix = error.issues.length > issues.length
    ? `; ${error.issues.length - issues.length} more issue(s)`
    : "";
  return `${issues.join("; ")}${suffix}`;
}

export async function readValidatedRequestBody<T>(
  request: RuntimeHttpRequestLike,
  schema: z.ZodType<T>,
  options: { maxBytes?: number; requireJsonContentType?: boolean } = {},
): Promise<T> {
  const value = await readRequestBody<unknown>(request, options);
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BrokerHttpRequestError(
      400,
      "invalid_request",
      formatZodIssues(result.error),
    );
  }
  return result.data;
}

export function requestAbortSignal(request: RuntimeHttpRequestLike, response: RuntimeHttpResponseLike): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("Broker request aborted by caller"));
    }
  };
  request.on("aborted", abort);
  request.on("error", abort);
  response.on("close", () => {
    if (!response.writableEnded) {
      abort();
    }
  });
  return controller.signal;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Broker request aborted");
  }
}

export function json(response: RuntimeHttpResponseLike, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

export function a2aJson(
  response: RuntimeHttpResponseLike,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "cache-control": "no-cache",
    ...headers,
    "content-type": `${A2A_JSON_RPC_CONTENT_TYPE}; charset=utf-8`,
  });
  response.end(JSON.stringify(payload, null, 2));
}

export function jsonWithHeaders(
  response: RuntimeHttpResponseLike,
  status: number,
  payload: unknown,
  headers: Record<string, string>,
): void {
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload, null, 2));
}

export type ServerTimingMetric = {
  name: string;
  dur?: number;
  desc?: string;
};

const MAX_SERVER_TIMING_HEADER_LENGTH = 2048;
const TRUNCATED_SERVER_TIMING_HEADER = 'server-timing-truncated;desc="oversize"';

function serverTimingToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]+/g, "-") || "metric";
}

function serverTimingDescription(value: string): string {
  return value.replace(/["\\]/g, "");
}

export function serverTimingHeader(metrics: ServerTimingMetric[]): string {
  const header = metrics
    .filter((metric) => metric.name.trim())
    .map((metric) => {
      const parts = [serverTimingToken(metric.name)];
      if (metric.dur !== undefined && Number.isFinite(metric.dur)) {
        parts.push(`dur=${Math.max(0, metric.dur).toFixed(1)}`);
      }
      if (metric.desc?.trim()) {
        parts.push(`desc="${serverTimingDescription(metric.desc.trim())}"`);
      }
      return parts.join(";");
    })
    .join(", ");
  return header.length <= MAX_SERVER_TIMING_HEADER_LENGTH
    ? header
    : TRUNCATED_SERVER_TIMING_HEADER;
}

export function notFound(response: RuntimeHttpResponseLike): void {
  json(response, 404, { error: "not_found" });
}

export function badRequest(response: RuntimeHttpResponseLike, error: unknown): void {
  if (error instanceof BrokerHttpRequestError) {
    json(response, error.status, {
      error: error.code,
      detail: error.message,
    });
    return;
  }
  json(response, 400, {
    error: "bad_request",
    detail: error instanceof Error ? error.message : String(error),
  });
}

export function parseBooleanQueryParam(value: string | null | undefined): boolean | undefined {
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return undefined;
}

export function conflict(response: RuntimeHttpResponseLike, detail: string): void {
  json(response, 409, {
    error: "conflict",
    detail,
  });
}

export function threadWatchError(response: RuntimeHttpResponseLike, error: unknown): void {
  if (error instanceof ThreadWatchProtocolError) {
    json(response, error.status, error.body);
    return;
  }
  badRequest(response, error);
}

export function parseLimit(url: URL): number {
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  if (!Number.isFinite(limit) || limit <= 0) return 100;
  return Math.min(limit, 500);
}

export function parseSince(url: URL): number | null {
  const since = Number.parseInt(url.searchParams.get("since") ?? "", 10);
  if (!Number.isFinite(since) || since <= 0) {
    return null;
  }
  return since;
}
