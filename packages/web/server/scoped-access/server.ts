import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep, extname } from "node:path";
import { GatewayError, exactFields, record, loadGatewayCredentials, verifyGatewayPassword, type GatewayConfig, type GatewayUserConfig } from "./config.ts";
import { createGatewayBroker, type GatewayBroker } from "./broker-client.ts";
import type { GatewayManagement, GatewayPreparedAction } from "./manage.ts";

type Session = { user?: GatewayUserConfig; principalId?: string; csrf: string; expiresAt: number; createdAt: number; lastActiveAt: number };
type Preview = { sessionId: string; action: GatewayPreparedAction; expiresAt: number };
const token = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const dummyPassword = `scrypt-v1:${"0".repeat(32)}:${"0".repeat(128)}`;
const securityHeaders = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
  "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
async function bodyJson(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) throw new GatewayError(415, "json_required");
  if (request.headers.has("content-encoding") || Number(request.headers.get("content-length") ?? 0) > 262144) throw new GatewayError(413, "body_too_large");
  if (!request.body) throw new GatewayError(400, "json_required");
  const reader = request.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reading = (async () => { while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > 262144) throw new GatewayError(413, "body_too_large"); chunks.push(item.value); } })();
    await Promise.race([reading, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new GatewayError(408, "body_timeout")), 5000); })]);
    try { return record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { throw new GatewayError(400, "invalid_json"); }
  } finally { if (timer) clearTimeout(timer); await reader.cancel().catch(() => {}); }
}
function strictRpc(input: Record<string, unknown>): void {
  const allowed: Record<string, string[]> = {
    whoami: [], discover: [], "network.status": ["offset"], "work.list": [], "access.preview": ["artifact"],
    result: ["requestId", "workId"], message: ["requestId", "target", "body"], request: ["requestId", "target", "body"],
  };
  if (typeof input.operation !== "string" || !Object.hasOwn(allowed, input.operation)) throw new GatewayError(400, "unsupported_operation");
  exactFields(input, ["operation", ...allowed[input.operation]!]);
  if (input.operation === "network.status" && input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0 || Number(input.offset) > 100_000)) throw new GatewayError(400, "invalid_offset");
  if (input.operation === "access.preview" && (!input.artifact || record(input.artifact).kind !== "delegation" || typeof record(input.artifact).signature !== "string")) throw new GatewayError(400, "signed_delegation_required");
  if (["message", "request"].includes(input.operation)) {
    if (typeof input.target !== "string" || !input.target || typeof input.body !== "string" || !input.body.trim() || Buffer.byteLength(input.body) > 32768
      || typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(input.requestId)) throw new GatewayError(400, "invalid_work_request");
  }
  if (input.operation === "result") {
    if ((typeof input.requestId === "string") === (typeof input.workId === "string") || (input.requestId !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(String(input.requestId)))
      || (input.workId !== undefined && !/^[A-Za-z0-9._:-]{1,200}$/.test(String(input.workId)))) throw new GatewayError(400, "one_result_identifier_required");
  }
}
export function createScopedAccessGateway(config: GatewayConfig, options: { staticRoot: string; broker?: GatewayBroker; manage?: GatewayManagement; now?: () => number } ) {
  const broker = options.broker ?? createGatewayBroker(config), now = options.now ?? Date.now;
  const origin = new URL(config.origin), secure = origin.protocol === "https:";
  if (!secure) throw new GatewayError(500, "dedicated_https_cookie_hostname_required");
  const cookieName = "__Host-scout-access";
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, { count: number; until: number }>();
  const failures = new Map<string, { count: number; retryAt: number; until: number }>();
  const previews = new Map<string, Preview>();
  let loginInFlight = 0;
  const cookie = (value: string, age: number) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
  function prune() {
    for (const [id, session] of sessions) if (session.expiresAt <= now() || session.lastActiveAt + config.idleTtlSeconds * 1000 <= now()) sessions.delete(id);
    for (const [id, preview] of previews) if (preview.expiresAt <= now() || !sessions.has(preview.sessionId)) previews.delete(id);
    for (const [id, entry] of failures) if (entry.until <= now()) failures.delete(id);
    for (const [id, entry] of attempts) if (entry.until <= now()) attempts.delete(id);
  }
  function current(request: Request): { id: string; session: Session } | undefined {
    const matches = (request.headers.get("cookie") ?? "").split(";").map((v) => v.trim()).filter((value) => value.startsWith(`${cookieName}=`));
    if (matches.length !== 1) return;
    const value = matches[0]!.slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return;
    const id = digest(value), session = sessions.get(id);
    return session && session.expiresAt > now() ? { id, session } : undefined;
  }
  function rateLimit(peer: string, bucket = "password", account?: string) {
    for (const id of [`${bucket}:global`, `${bucket}:peer:${digest(peer)}`, ...(account === undefined ? [] : [`${bucket}:account:${digest(account)}`])]) {
      const entry = attempts.get(id) ?? { count: 0, until: now() + 60_000 };
      entry.count++;
      if (!attempts.has(id) && attempts.size >= 3000) throw new GatewayError(429, "authentication_rate_limited");
      attempts.set(id, entry);
      const limit = id.endsWith(":global") ? 100 : bucket === "bootstrap" ? 20 : 10;
      if (entry.count > limit) throw new GatewayError(429, "authentication_rate_limited");
    }
  }
  async function passwordCheck(peer: string, login: string, password: unknown, user?: GatewayUserConfig) {
    rateLimit(peer, "password", login);
    const id = digest(login), failure = failures.get(id);
    if ((failure && failure.retryAt > now()) || loginInFlight >= 4) throw new GatewayError(429, "authentication_rate_limited");
    loginInFlight++;
    try {
      const valid = typeof password === "string" && await verifyGatewayPassword(password, user?.passwordHash ?? dummyPassword);
      if (!valid || !user) {
        const count = (failure?.count ?? 0) + 1;
        if (failures.size < 1000 || failures.has(id)) failures.set(id, { count, retryAt: now() + Math.min(60_000, 1000 * 2 ** Math.min(count - 1, 6)), until: now() + 15 * 60_000 });
        throw new GatewayError(401, "invalid_login");
      }
      failures.delete(id);
    } finally { loginInFlight--; }
  }
  const sessionView = (session: Session) => session.user ? ({ authenticated: true, user: { login: session.user.login, principalId: session.principalId, canSign: Boolean(session.user.principalFile) }, csrf: session.csrf, expiresAt: session.expiresAt }) : ({ authenticated: false, csrf: session.csrf });
  function checkCsrf(request: Request, auth: ReturnType<typeof current>) {
    const supplied = request.headers.get("x-scout-csrf") ?? "";
    if (!auth || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || supplied.length !== auth.session.csrf.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(auth.session.csrf))) throw new GatewayError(403, "csrf_required");
  }
  async function staticResponse(pathname: string): Promise<Response> {
    let path: string;
    try { path = decodeURIComponent(pathname); } catch { throw new GatewayError(404, "not_found"); }
    if (path.includes("\\") || path.includes("\0") || path.split("/").includes("..")) throw new GatewayError(404, "not_found");
    const file = path === "/" || path === "/access" ? "index.html" : path === "/favicon.ico" ? "favicon.ico" : path.startsWith("/assets/") ? path.slice(1) : undefined;
    if (!file) throw new GatewayError(404, "not_found");
    const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };
    if (!mime[extname(file)] || (extname(file) === ".html" && file !== "index.html")) throw new GatewayError(404, "not_found");
    try {
      const root = await realpath(options.staticRoot);
      const uid = process.getuid?.(), rootInfo = await stat(root);
      if (uid === undefined || !rootInfo.isDirectory() || rootInfo.uid !== uid || (rootInfo.mode & 0o022) !== 0) throw new Error();
      const absolute = await realpath(file === "index.html" ? join(root, "scoped-access", "index.html") : resolve(root, file)).catch(async (error) => {
        if (file !== "index.html") throw error;
        return realpath(join(root, "index.html"));
      });
      if (!absolute.startsWith(root + sep)) throw new Error();
      // HTML/JS and their directories are authentication TCB: another OS user
      // must not replace a script and capture passwords or session-bound CSRF.
      for (let parent = dirname(absolute); parent !== root; parent = dirname(parent)) {
        const info = await stat(parent);
        if (!parent.startsWith(root + sep) || !info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) throw new Error();
      }
      const info = await stat(absolute);
      if (!info.isFile() || info.uid !== uid || (info.mode & 0o022) !== 0 || info.size > 20 * 1024 * 1024) throw new Error();
      return new Response(await readFile(absolute), { headers: { "content-type": mime[extname(file)]!, "cache-control": "no-store" } });
    } catch { throw new GatewayError(404, "not_found"); }
  }
  async function handle(request: Request, peerAddress: string): Promise<Response> {
    prune();
    const url = new URL(request.url);
    if (url.origin !== origin.origin || request.headers.get("host") !== origin.host || (request.headers.has("origin") && request.headers.get("origin") !== origin.origin)
      || ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "")) throw new GatewayError(403, "origin_not_allowed");
    if (request.headers.has("upgrade")) throw new GatewayError(403, "upgrades_not_supported");
    if (url.search || !["GET", "POST"].includes(request.method)) throw new GatewayError(405, "method_not_allowed");
    if (!url.pathname.startsWith("/api/access/")) {
      if (request.method !== "GET") throw new GatewayError(404, "not_found");
      return staticResponse(url.pathname);
    }
    const auth = current(request);
    if (url.pathname === "/api/access/session" && request.method === "GET") {
      if (auth) { auth.session.lastActiveAt = now(); return json(sessionView(auth.session)); }
      rateLimit(peerAddress, "bootstrap");
      if ([...sessions.values()].filter((s) => !s.user).length >= 200) throw new GatewayError(429, "session_limit");
      const value = token(), session: Session = { csrf: token(), createdAt: now(), lastActiveAt: now(), expiresAt: now() + 5 * 60_000 };
      sessions.set(digest(value), session);
      return json(sessionView(session), 200, { "set-cookie": cookie(value, 300) });
    }
    if (request.method !== "POST") throw new GatewayError(404, "not_found");
    if (request.headers.get("origin") !== origin.origin) throw new GatewayError(403, "origin_required");
    // Login has the same synchronizer-token requirement as all other writes.
    checkCsrf(request, auth);
    const body = await bodyJson(request);
    if (url.pathname === "/api/access/login") {
      exactFields(body, ["login", "password"]);
      if (typeof body.login !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(body.login)) throw new GatewayError(401, "invalid_login");
      const user = config.users.find((value) => value.login === body.login);
      await passwordCheck(peerAddress, body.login, body.password, user);
      let credentials;
      try {
        credentials = loadGatewayCredentials(user!, config.audience, now());
        const status = record(await broker.call(user!, { operation: "network.status" }));
        if (record(record(status.viewer).principal).id !== credentials.delegation.principalId || record(status.network).id !== credentials.delegation.networkId
          || (credentials.principal && (credentials.principal.principal.id === credentials.delegation.networkId || (status.policy && record(record(status.policy).root).id === credentials.principal.principal.id)))) throw new Error();
      } catch { throw new GatewayError(401, "invalid_login"); }
      if ([...sessions.values()].filter((s) => s.user).length >= 500 || [...sessions.values()].filter((s) => s.user?.login === user!.login).length >= 5) throw new GatewayError(429, "session_limit");
      sessions.delete(auth!.id);
      const value = token(), expiresAt = Math.min(now() + config.sessionTtlSeconds * 1000, credentials.delegation.expiresAt);
      const session: Session = { user: user!, principalId: credentials.delegation.principalId, csrf: token(), createdAt: now(), lastActiveAt: now(), expiresAt };
      sessions.set(digest(value), session);
      return json(sessionView(session), 200, { "set-cookie": cookie(value, Math.max(0, Math.floor((expiresAt - now()) / 1000))) });
    }
    if (!auth?.session.user) throw new GatewayError(401, "login_required");
    const user = auth.session.user;
    auth.session.lastActiveAt = now();
    if (url.pathname === "/api/access/logout") {
      exactFields(body, []); sessions.delete(auth.id);
      for (const [id, preview] of previews) if (preview.sessionId === auth.id) previews.delete(id);
      return json({ authenticated: false }, 200, { "set-cookie": cookie("", 0) });
    }
    const credentials = loadGatewayCredentials(user, config.audience, now());
    if (credentials.delegation.principalId !== auth.session.principalId) { sessions.delete(auth.id); throw new GatewayError(401, "login_required"); }
    auth.session.expiresAt = Math.min(auth.session.expiresAt, credentials.delegation.expiresAt);
    if (url.pathname === "/api/access/rpc") { strictRpc(body); return json(await broker.call(user, body)); }
    if (url.pathname === "/api/access/manage/preview") {
      if (!options.manage) throw new GatewayError(403, "management_unavailable");
      if ([...previews.values()].filter((p) => p.sessionId === auth.id).length >= 5 || previews.size >= 500) throw new GatewayError(429, "preview_limit");
      const action = await options.manage.prepare(user, body), previewId = token(), expiresAt = Math.min(now() + 60_000, auth.session.expiresAt);
      previews.set(digest(previewId), { action, sessionId: auth.id, expiresAt });
      return json({ previewId, artifact: action.artifact, audience: action.audience, expiresAt, warnings: action.warnings });
    }
    if (url.pathname === "/api/access/manage") {
      exactFields(body, ["previewId", "password"]);
      if (!options.manage || typeof body.previewId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.previewId)) throw new GatewayError(400, "preview_required");
      const id = digest(body.previewId), preview = previews.get(id);
      if (!preview || preview.sessionId !== auth.id || preview.expiresAt <= now()) throw new GatewayError(409, "preview_expired_or_used");
      previews.delete(id); // Every attempt consumes the exact public preview.
      await passwordCheck(peerAddress, user.login, body.password, user);
      return json(await options.manage.execute(user, preview.action));
    }
    throw new GatewayError(404, "not_found");
  }
  return {
    async fetch(request: Request, peerAddress = "unknown"): Promise<Response> {
      let response: Response;
      try { response = await handle(request, peerAddress); }
      catch (error) { response = json({ error: error instanceof GatewayError ? error.code : "gateway_request_failed" }, error instanceof GatewayError ? error.status : 500); }
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
      if (secure) headers.set("strict-transport-security", "max-age=31536000");
      return new Response(response.body, { status: response.status, headers });
    },
    close() { sessions.clear(); attempts.clear(); failures.clear(); previews.clear(); broker.close(); },
  };
}
