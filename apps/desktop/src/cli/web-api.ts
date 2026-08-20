import { resolveHost, resolveWebPort } from "@openscout/runtime/local-config";

import type { ScoutCommandContext } from "./context.ts";
import { ScoutCliError } from "./errors.ts";

const SCOUT_WEB_AUTH_COOKIE = "openscout_web_session";
const SCOUT_WEB_BOOTSTRAP_PATH = "/api/bootstrap.js";
const LOOPBACK_IPV4_HOST_PATTERN = /^127(?:\.\d{1,3}){3}$/u;

export function resolveScoutWebApiBaseUrl(env: NodeJS.ProcessEnv): string {
  const configured = env.OPENSCOUT_WEB_URL?.trim() || env.SCOUT_WEB_URL?.trim();
  if (configured) return configured.replace(/\/+$/u, "");
  return `http://${resolveHost()}:${resolveWebPort()}`;
}

export async function readScoutWebJson<T>(
  context: ScoutCommandContext,
  path: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const baseUrl = resolveScoutWebApiBaseUrl(context.env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(path, baseUrl);
  const headers = new Headers({ accept: "application/json" });
  const authToken = context.env.OPENSCOUT_WEB_AUTH_TOKEN?.trim();
  if (authToken) {
    headers.set("authorization", `Bearer ${authToken}`);
  }

  let response = await fetchImpl(url, { headers });
  if (response.status === 401 && !authToken) {
    const cookie = await readLocalScoutWebAuthCookie(fetchImpl, url);
    if (cookie) {
      headers.set("cookie", cookie);
      response = await fetchImpl(url, { headers });
    }
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`.trim();
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim()) detail = body.error.trim();
    } catch {
      // Keep the HTTP status detail.
    }
    throw new ScoutCliError(`Scout web API request failed: ${detail}`);
  }
  return await response.json() as T;
}

async function readLocalScoutWebAuthCookie(
  fetchImpl: typeof fetch,
  requestUrl: URL,
): Promise<string | null> {
  if (!isLoopbackScoutWebUrl(requestUrl)) return null;

  try {
    const response = await fetchImpl(new URL(SCOUT_WEB_BOOTSTRAP_PATH, requestUrl), {
      headers: { accept: "application/javascript" },
    });
    await response.text();
    if (!response.ok) return null;
    return scoutWebCookieFromSetCookie(response.headers.get("set-cookie"));
  } catch {
    // Let the actual API request surface the normal connection/auth error.
    return null;
  }
}

function isLoopbackScoutWebUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return hostname === "localhost"
    || hostname === "0.0.0.0"
    || hostname === "::1"
    || LOOPBACK_IPV4_HOST_PATTERN.test(hostname);
}

function scoutWebCookieFromSetCookie(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(new RegExp(`(?:^|,\\s*)${SCOUT_WEB_AUTH_COOKIE}=([^;,\\r\\n]+)`, "u"));
  return match?.[1]
    ? `${SCOUT_WEB_AUTH_COOKIE}=${match[1]}`
    : null;
}
