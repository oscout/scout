import type { Context, Hono } from "hono";
import { serveStatic } from "hono/bun";

export type ScoutWebAssetMode = "vite-proxy" | "static";

const LOOPBACK_IPV4_HOST_PATTERN = /^127(?:\.\d{1,3}){3}$/;

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isTrustedLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "::1"
    || LOOPBACK_IPV4_HOST_PATTERN.test(normalized);
}

function isTrustedApiRequest(c: Context): boolean {
  const requestUrl = new URL(c.req.url);
  if (!isTrustedLoopbackHostname(requestUrl.hostname)) {
    return false;
  }

  const origin = c.req.header("origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (
        !isTrustedLoopbackHostname(originUrl.hostname)
        || originUrl.origin !== requestUrl.origin
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const fetchSite = c.req.header("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site" && fetchSite !== "none") {
    return false;
  }

  return true;
}

export function coalesce<T>(fn: () => Promise<T>, ttlMs = 2000): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  let cached: { value: T; expiresAt: number } | null = null;

  return () => {
    if (cached && Date.now() < cached.expiresAt) {
      return Promise.resolve(cached.value);
    }
    if (inflight) {
      return inflight;
    }

    inflight = fn()
      .then((value) => {
        cached = { value, expiresAt: Date.now() + ttlMs };
        inflight = null;
        return value;
      })
      .catch((error) => {
        inflight = null;
        throw error;
      });

    return inflight;
  };
}

export function createCachedSnapshot<T>(load: () => Promise<T>, ttlMs: number) {
  let inflight: Promise<T> | null = null;
  let cached: { value: T; expiresAt: number } | null = null;

  const refresh = async () => {
    if (inflight) {
      return inflight;
    }

    inflight = load()
      .then((value) => {
        cached = { value, expiresAt: Date.now() + ttlMs };
        inflight = null;
        return value;
      })
      .catch((error) => {
        inflight = null;
        throw error;
      });

    return inflight;
  };

  const get = async (options?: { force?: boolean }) => {
    const force = options?.force ?? false;
    if (!force && cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }

    if (!force && cached && inflight) {
      return cached.value;
    }

    if (!force && inflight) {
      return inflight;
    }

    return refresh();
  };

  const invalidate = () => {
    cached = null;
  };

  return {
    get,
    refresh,
    invalidate,
    peek: () => cached?.value ?? null,
  };
}

export function installScoutApiMiddleware(app: Hono, label = "api"): void {
  app.use("/api/*", async (c, next) => {
    if (!isTrustedApiRequest(c)) {
      return c.json({ error: "forbidden" }, 403);
    }

    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("X-Content-Type-Options", "nosniff");

    try {
      await next();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${label}] ${c.req.method} ${c.req.path} failed:`, message);
      return c.json({ error: message }, 500);
    }
  });
}

export function registerScoutWebAssets(
  app: Hono,
  options: {
    assetMode: ScoutWebAssetMode;
    staticRoot: string;
    viteDevUrl?: string;
    defaultViteUrl: string;
  },
): void {
  const viteUrl = options.viteDevUrl?.trim() || options.defaultViteUrl;

  if (options.assetMode === "vite-proxy") {
    app.all("/*", async (c) => {
      const target = new URL(c.req.path, viteUrl);
      target.search = new URL(c.req.url).search;
      const headers = new Headers(c.req.header());
      headers.delete("host");
      const res = await fetch(target.toString(), {
        method: c.req.method,
        headers,
        body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
      });
      return new Response(res.body, {
        status: res.status,
        headers: res.headers,
      });
    });
    return;
  }

  app.use("/*", serveStatic({ root: options.staticRoot }));
  app.get("/*", serveStatic({
    root: options.staticRoot,
    path: "index.html",
  }));
}

export async function relayEventStream(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const requestHeaders = new Headers(init?.headers);
  if (!requestHeaders.has("accept")) {
    requestHeaders.set("accept", "text/event-stream");
  }

  const upstream = await fetch(url, {
    ...init,
    headers: requestHeaders,
  });

  if (!upstream.ok || !upstream.body) {
    const contentType = upstream.headers.get("content-type") ?? "text/plain; charset=utf-8";
    const message = await upstream.text().catch(() => "Event stream unavailable");
    return new Response(message || "Event stream unavailable", {
      status: upstream.status || 502,
      statusText: upstream.statusText,
      headers: {
        "content-type": contentType,
        "cache-control": "no-cache, no-transform",
      },
    });
  }

  const responseHeaders = new Headers();
  responseHeaders.set("content-type", upstream.headers.get("content-type") ?? "text/event-stream");
  responseHeaders.set("cache-control", upstream.headers.get("cache-control") ?? "no-cache, no-transform");
  responseHeaders.set("connection", "keep-alive");
  responseHeaders.set("x-accel-buffering", "no");

  const reader = upstream.body.getReader();
  const clientSignal = init?.signal;
  const abortUpstream = () => {
    void reader.cancel().catch(() => {});
  };
  clientSignal?.addEventListener("abort", abortUpstream, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              controller.enqueue(value);
            }
          }
          controller.close();
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            controller.close();
            return;
          }
          controller.error(error);
        } finally {
          clientSignal?.removeEventListener("abort", abortUpstream);
          try {
            reader.releaseLock();
          } catch {
            // Reader may already be released after cancellation.
          }
        }
      };

      void pump();
    },
    cancel(reason) {
      clientSignal?.removeEventListener("abort", abortUpstream);
      return reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
