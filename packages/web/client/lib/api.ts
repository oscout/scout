type ApiTextResponse = {
  text: string;
  contentType: string | null;
};

const inFlightGets = new Map<string, Promise<ApiTextResponse>>();
const settledGets = new Map<string, { response: ApiTextResponse; receivedAt: number }>();
const MAX_SETTLED_GETS = 32;

function formatResponsePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "empty body";
  return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized;
}

function parseApiResponse<T>(path: string, text: string, contentType: string | null): T {
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    const label = contentType?.trim() || "non-JSON";
    throw new Error(`Expected JSON from ${path} but received ${label}: ${formatResponsePreview(text)}`);
  }
}

function normalizeHeaders(headers?: HeadersInit): string {
  if (!headers) return "";
  return JSON.stringify([...new Headers(headers).entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function requestKey(path: string, init?: RequestInit): string {
  const method = (init?.method ?? "GET").toUpperCase();
  return `${method}:${path}:${normalizeHeaders(init?.headers)}`;
}

async function fetchApiText(path: string, init?: RequestInit): Promise<ApiTextResponse> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text || `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text);
      if (body?.error) message = body.error;
    } catch {
      /* plain text */
    }
    throw new Error(message);
  }
  return {
    text: await res.text(),
    contentType: res.headers.get("content-type"),
  };
}

export function clearApiGetCache(): void {
  inFlightGets.clear();
  settledGets.clear();
}

function rememberSettledGet(key: string, response: ApiTextResponse): void {
  settledGets.delete(key);
  settledGets.set(key, { response, receivedAt: Date.now() });
  while (settledGets.size > MAX_SETTLED_GETS) {
    const oldestKey = settledGets.keys().next().value;
    if (typeof oldestKey !== "string") break;
    settledGets.delete(oldestKey);
  }
}

/**
 * Synchronously read a recent successful GET response. Route components use
 * this to paint their last-known data on remount while their normal background
 * refresh runs; writes and regular api() reads never consume stale data.
 */
export function peekApiGet<T>(path: string, maxAgeMs: number, init?: RequestInit): T | null {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" || init?.body || maxAgeMs <= 0) return null;
  const cached = settledGets.get(requestKey(path, init));
  if (!cached || Date.now() - cached.receivedAt > maxAgeMs) return null;
  return parseApiResponse<T>(path, cached.response.text, cached.response.contentType);
}

/** Typed fetch wrapper for Scout API endpoints. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const dedupeGet = method === "GET" && !init?.body;

  if (!dedupeGet) {
    const response = await fetchApiText(path, init);
    return parseApiResponse<T>(path, response.text, response.contentType);
  }

  const key = requestKey(path, init);
  const existing = inFlightGets.get(key);
  if (existing) {
    const response = await existing;
    rememberSettledGet(key, response);
    return parseApiResponse<T>(path, response.text, response.contentType);
  }

  const request = fetchApiText(path, init);
  inFlightGets.set(key, request);

  try {
    const response = await request;
    rememberSettledGet(key, response);
    return parseApiResponse<T>(path, response.text, response.contentType);
  } finally {
    inFlightGets.delete(key);
  }
}
