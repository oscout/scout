import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { connect as connectHttp2 } from "node:http2";
import { createPrivateKey, sign as signWithKey } from "node:crypto";
import { dirname, join } from "node:path";

import { resolveOpenScoutSupportPaths } from "./support-paths.js";

export type MobilePushPlatform = "ios";
export type MobilePushEnvironment = "development" | "production";
export type MobilePushAuthorizationStatus =
  | "notDetermined"
  | "denied"
  | "authorized"
  | "provisional"
  | "ephemeral";

export type MobilePushRegistration = {
  id: string;
  deviceId: string;
  platform: MobilePushPlatform;
  appBundleId: string;
  apnsEnvironment: MobilePushEnvironment;
  pushToken: string;
  authorizationStatus: MobilePushAuthorizationStatus;
  appVersion: string | null;
  buildNumber: string | null;
  deviceModel: string | null;
  systemVersion: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SyncMobilePushRegistrationInput = {
  deviceId: string;
  platform: MobilePushPlatform;
  appBundleId: string;
  apnsEnvironment: MobilePushEnvironment;
  authorizationStatus: MobilePushAuthorizationStatus;
  pushToken?: string | null;
  appVersion?: string | null;
  buildNumber?: string | null;
  deviceModel?: string | null;
  systemVersion?: string | null;
};

export type SyncMobilePushRegistrationResult = {
  ok: true;
  registered: boolean;
  removed: boolean;
  token: string | null;
};

export type MobilePushAlert = {
  title: string;
  body: string;
  sound?: string | null;
  urgency?: "interrupt" | "badge" | "silent";
  threadId?: string | null;
  payload?: Record<string, unknown>;
};

type MobilePushRegistrationRow = {
  id: string;
  device_id: string;
  platform: MobilePushPlatform;
  app_bundle_id: string;
  apns_environment: MobilePushEnvironment;
  push_token: string;
  authorization_status: MobilePushAuthorizationStatus;
  app_version: string | null;
  build_number: string | null;
  device_model: string | null;
  system_version: string | null;
  created_at: number;
  updated_at: number;
};

type ApnsSendOutcome = {
  delivered: boolean;
  skipped: boolean;
  status: number | null;
  apnsId: string | null;
  reason: string | null;
};

export type MobilePushBroadcastResult = {
  attemptedCount: number;
  deliveredCount: number;
  skippedCount: number;
  failedCount: number;
  configMissing: boolean;
  rateLimited?: boolean;
  retryAfterSeconds?: number | null;
  rateLimitWindow?: string | null;
  failures: Array<{
    deviceId: string;
    tokenSuffix: string;
    status: number | null;
    reason: string | null;
  }>;
};

type PushRelayConfig = {
  url: string;
  sessionToken: string;
  meshId: string | null;
};

const MOBILE_PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS mobile_push_registrations (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_bundle_id TEXT NOT NULL,
  apns_environment TEXT NOT NULL,
  push_token TEXT NOT NULL,
  authorization_status TEXT NOT NULL,
  app_version TEXT,
  build_number TEXT,
  device_model TEXT,
  system_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_push_registrations_device_bundle_env
  ON mobile_push_registrations (device_id, platform, app_bundle_id, apns_environment);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_push_registrations_push_token
  ON mobile_push_registrations (push_token);
CREATE INDEX IF NOT EXISTS idx_mobile_push_registrations_device_updated_at
  ON mobile_push_registrations (device_id, updated_at DESC);
`;

let dbHandle: Database | null = null;
let dbPath: string | null = null;

type CachedApnsJwt = {
  cacheKey: string;
  token: string;
  expiresAt: number;
};

let cachedApnsJwt: CachedApnsJwt | null = null;

function resolveControlPlaneDbPath(): string {
  return join(resolveOpenScoutSupportPaths().controlHome, "control-plane.sqlite");
}

function ensureMobilePushSchema(database: Database): void {
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec(MOBILE_PUSH_SCHEMA);
}

function writeDb(): Database {
  const nextPath = resolveControlPlaneDbPath();
  if (dbHandle && dbPath !== nextPath) {
    dbHandle.close();
    dbHandle = null;
  }
  if (!dbHandle) {
    mkdirSync(dirname(nextPath), { recursive: true });
    dbHandle = new Database(nextPath, { create: true });
    dbPath = nextPath;
    ensureMobilePushSchema(dbHandle);
  }
  return dbHandle;
}

export function closeMobilePushDb(): void {
  dbHandle?.close();
  dbHandle = null;
  dbPath = null;
}

function normalizeToken(token: string): string {
  return token
    .trim()
    .replace(/[<>\s]/g, "")
    .toLowerCase();
}

function pushAllowed(status: MobilePushAuthorizationStatus): boolean {
  switch (status) {
    case "authorized":
    case "provisional":
    case "ephemeral":
      return true;
    case "denied":
    case "notDetermined":
      return false;
  }
}

function resolvePushRelayConfig(): PushRelayConfig | null {
  const url = process.env.OPENSCOUT_PUSH_RELAY_URL?.trim();
  const sessionToken = process.env.OPENSCOUT_PUSH_RELAY_SESSION?.trim();
  if (!url || !sessionToken) return null;
  return {
    url: url.replace(/\/+$/g, ""),
    sessionToken,
    meshId: process.env.OPENSCOUT_PUSH_RELAY_MESH_ID?.trim() || null,
  };
}

function relayAuthHeader(sessionToken: string): string {
  return sessionToken.startsWith("osn_session_")
    ? `Bearer ${sessionToken}`
    : `Bearer osn_session_${sessionToken}`;
}

async function fetchPushRelay(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const config = resolvePushRelayConfig();
  if (!config) throw new Error("push relay is not configured");
  const init: RequestInit = {
    method,
    headers: {
      authorization: relayAuthHeader(config.sessionToken),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return fetch(`${config.url}${path}`, init);
}

async function syncPushRelayRegistration(
  input: SyncMobilePushRegistrationInput,
): Promise<void> {
  const config = resolvePushRelayConfig();
  if (!config) return;
  const pushToken = input.pushToken?.trim() ? normalizeToken(input.pushToken) : null;
  const response = await fetchPushRelay("POST", "/v1/push/devices/register", {
    meshId: config.meshId ?? undefined,
    deviceId: input.deviceId,
    platform: input.platform,
    appBundleId: input.appBundleId,
    apnsEnvironment: input.apnsEnvironment,
    authorizationStatus: input.authorizationStatus,
    pushToken,
    appVersion: input.appVersion ?? null,
    buildNumber: input.buildNumber ?? null,
    deviceModel: input.deviceModel ?? null,
    systemVersion: input.systemVersion ?? null,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`push relay registration failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
  }
}

async function broadcastPushRelayAlert(alert: MobilePushAlert): Promise<MobilePushBroadcastResult> {
  const config = resolvePushRelayConfig();
  if (!config) {
    return {
      attemptedCount: 0,
      deliveredCount: 0,
      skippedCount: 0,
      failedCount: 0,
      configMissing: true,
      failures: [],
    };
  }
  const opaquePayload = opaqueMobilePushPayload(alert.payload);
  const itemId = opaquePayload.itemId ?? opaquePayload.messageId;
  const response = await fetchPushRelay("POST", "/v1/push", {
    meshId: config.meshId ?? undefined,
    itemId,
    kind: opaquePayload.kind,
    urgency: alert.urgency ?? (alert.sound ? "interrupt" : "silent"),
    payload: {
      destination: "inbox",
      ...opaquePayload,
      ...(itemId ? { itemId } : {}),
    },
  });
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const window = response.headers.get("x-ratelimit-window");
    const detail = await response.text().catch(() => "");
    return {
      attemptedCount: 0,
      deliveredCount: 0,
      skippedCount: 0,
      failedCount: 1,
      configMissing: false,
      rateLimited: true,
      retryAfterSeconds: retryAfter ? Number.parseInt(retryAfter, 10) || null : null,
      rateLimitWindow: window,
      failures: [{
        deviceId: "push-relay",
        tokenSuffix: "relay",
        status: 429,
        reason: detail || `HTTP 429 (window=${window ?? "unknown"})`,
      }],
    };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      attemptedCount: 0,
      deliveredCount: 0,
      skippedCount: 0,
      failedCount: 1,
      configMissing: false,
      failures: [{
        deviceId: "push-relay",
        tokenSuffix: "relay",
        status: response.status,
        reason: detail || `HTTP ${response.status}`,
      }],
    };
  }
  const payload = await response.json().catch(() => ({})) as {
    attemptedCount?: number;
    deliveredCount?: number;
    failedCount?: number;
    failures?: Array<{ deviceId?: string; status?: number | null; reason?: string | null }>;
  };
  const failures = (payload.failures ?? []).map((failure) => ({
    deviceId: failure.deviceId ?? "unknown",
    tokenSuffix: "relay",
    status: failure.status ?? null,
    reason: failure.reason ?? null,
  }));
  return {
    attemptedCount: payload.attemptedCount ?? 0,
    deliveredCount: payload.deliveredCount ?? 0,
    skippedCount: 0,
    failedCount: payload.failedCount ?? failures.length,
    configMissing: false,
    failures,
  };
}

const OPAQUE_MOBILE_PUSH_PAYLOAD_KEYS = [
  "itemId",
  "kind",
  "signalKind",
  "messageId",
  "conversationId",
  "sessionId",
  "turnId",
  "blockId",
  "requestId",
  "flightId",
  "invocationId",
  "workId",
] as const;

function opaqueMobilePushPayload(
  payload: Record<string, unknown> | undefined,
): Partial<Record<(typeof OPAQUE_MOBILE_PUSH_PAYLOAD_KEYS)[number], string>> {
  return Object.fromEntries(
    OPAQUE_MOBILE_PUSH_PAYLOAD_KEYS.flatMap((key) => {
      const value = payload?.[key];
      return typeof value === "string" && value.trim()
        ? [[key, value.trim()] as const]
        : [];
    }),
  ) as Partial<Record<(typeof OPAQUE_MOBILE_PUSH_PAYLOAD_KEYS)[number], string>>;
}

function tokenSuffix(token: string): string {
  return token.length <= 8 ? token : token.slice(-8);
}

function rowToRegistration(row: MobilePushRegistrationRow): MobilePushRegistration {
  return {
    id: row.id,
    deviceId: row.device_id,
    platform: row.platform,
    appBundleId: row.app_bundle_id,
    apnsEnvironment: row.apns_environment,
    pushToken: row.push_token,
    authorizationStatus: row.authorization_status,
    appVersion: row.app_version,
    buildNumber: row.build_number,
    deviceModel: row.device_model,
    systemVersion: row.system_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function syncMobilePushRegistration(
  input: SyncMobilePushRegistrationInput,
): SyncMobilePushRegistrationResult {
  const database = writeDb();
  const now = Date.now();
  const deviceId = input.deviceId.trim();
  const platform = input.platform;
  const appBundleId = input.appBundleId.trim();
  const apnsEnvironment = input.apnsEnvironment;
  const authorizationStatus = input.authorizationStatus;
  const pushToken = input.pushToken?.trim() ? normalizeToken(input.pushToken) : null;

  if (!deviceId || !appBundleId) {
    throw new Error("deviceId and appBundleId are required");
  }

  if (!pushAllowed(authorizationStatus)) {
    database.query(
      `DELETE FROM mobile_push_registrations
       WHERE device_id = ?1
         AND platform = ?2
         AND app_bundle_id = ?3
         AND apns_environment = ?4`,
    ).run(deviceId, platform, appBundleId, apnsEnvironment);
    return { ok: true, registered: false, removed: true, token: null };
  }

  if (!pushToken) {
    return { ok: true, registered: false, removed: false, token: null };
  }

  database.query(
    `DELETE FROM mobile_push_registrations
     WHERE push_token = ?1
       AND NOT (
         device_id = ?2
         AND platform = ?3
         AND app_bundle_id = ?4
         AND apns_environment = ?5
       )`,
  ).run(pushToken, deviceId, platform, appBundleId, apnsEnvironment);

  const existing = database.query(
    `SELECT id, created_at
     FROM mobile_push_registrations
     WHERE device_id = ?1
       AND platform = ?2
       AND app_bundle_id = ?3
       AND apns_environment = ?4
     LIMIT 1`,
  ).get(deviceId, platform, appBundleId, apnsEnvironment) as
    | { id: string; created_at: number }
    | null;

  const id = existing?.id
    ?? `push-${deviceId}-${platform}-${appBundleId}-${apnsEnvironment}`.replace(/[^a-zA-Z0-9._-]+/g, "-");

  database.query(
    `INSERT INTO mobile_push_registrations (
       id,
       device_id,
       platform,
       app_bundle_id,
       apns_environment,
       push_token,
       authorization_status,
       app_version,
       build_number,
       device_model,
       system_version,
       created_at,
       updated_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
     )
     ON CONFLICT(device_id, platform, app_bundle_id, apns_environment)
     DO UPDATE SET
       push_token = excluded.push_token,
       authorization_status = excluded.authorization_status,
       app_version = excluded.app_version,
       build_number = excluded.build_number,
       device_model = excluded.device_model,
       system_version = excluded.system_version,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    deviceId,
    platform,
    appBundleId,
    apnsEnvironment,
    pushToken,
    authorizationStatus,
    input.appVersion?.trim() || null,
    input.buildNumber?.trim() || null,
    input.deviceModel?.trim() || null,
    input.systemVersion?.trim() || null,
    existing?.created_at ?? now,
    now,
  );

  return { ok: true, registered: true, removed: false, token: pushToken };
}

export async function syncMobilePushRegistrationWithRelay(
  input: SyncMobilePushRegistrationInput,
): Promise<SyncMobilePushRegistrationResult & { relayConfigured: boolean }> {
  const result = syncMobilePushRegistration(input);
  if (!resolvePushRelayConfig()) {
    return { ...result, relayConfigured: false };
  }
  await syncPushRelayRegistration({
    ...input,
    pushToken: result.token,
  });
  return { ...result, relayConfigured: true };
}

export function listMobilePushRegistrations(
  filters?: {
    deviceId?: string;
    platform?: MobilePushPlatform;
  },
): MobilePushRegistration[] {
  const database = writeDb();
  const where: string[] = [];
  const params: Array<string> = [];

  if (filters?.deviceId?.trim()) {
    where.push(`device_id = ?${params.length + 1}`);
    params.push(filters.deviceId.trim());
  }

  if (filters?.platform?.trim()) {
    where.push(`platform = ?${params.length + 1}`);
    params.push(filters.platform.trim());
  }

  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = database.query(
    `SELECT *
     FROM mobile_push_registrations
     ${clause}
     ORDER BY updated_at DESC, id ASC`,
  ).all(...params) as MobilePushRegistrationRow[];

  return rows.map(rowToRegistration);
}

export function listActiveMobilePushRegistrations(): MobilePushRegistration[] {
  return listMobilePushRegistrations().filter((registration) =>
    pushAllowed(registration.authorizationStatus)
      && registration.pushToken.trim().length > 0
  );
}

export function deleteMobilePushRegistrationByToken(pushToken: string): void {
  const token = normalizeToken(pushToken);
  if (!token) {
    return;
  }
  writeDb().query(
    `DELETE FROM mobile_push_registrations WHERE push_token = ?1`,
  ).run(token);
}

function base64UrlEncode(input: string | ArrayLike<number>): string {
  const buffer = typeof input === "string"
    ? Buffer.from(input, "utf8")
    : Buffer.from(Array.from(input));
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

type ApnsCredentials = {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
};

function loadApnsCredentials(): ApnsCredentials | null {
  const teamId = process.env.OPENSCOUT_APNS_TEAM_ID?.trim();
  const keyId = process.env.OPENSCOUT_APNS_KEY_ID?.trim();
  const inlinePem = process.env.OPENSCOUT_APNS_PRIVATE_KEY?.trim();
  const inlineBase64 = process.env.OPENSCOUT_APNS_PRIVATE_KEY_BASE64?.trim();
  const path = process.env.OPENSCOUT_APNS_PRIVATE_KEY_PATH?.trim();

  let privateKeyPem = inlinePem ?? null;
  if (!privateKeyPem && inlineBase64) {
    privateKeyPem = Buffer.from(inlineBase64, "base64").toString("utf8");
  }
  if (!privateKeyPem && path) {
    privateKeyPem = readFileSync(path, "utf8");
  }

  if (!teamId || !keyId || !privateKeyPem) {
    return null;
  }

  return {
    teamId,
    keyId,
    privateKeyPem,
  };
}

function apnsJwt(credentials: ApnsCredentials): string {
  const cacheKey = [
    credentials.teamId,
    credentials.keyId,
    credentials.privateKeyPem,
  ].join("\u0000");
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (cachedApnsJwt && cachedApnsJwt.cacheKey === cacheKey && cachedApnsJwt.expiresAt > nowSeconds) {
    return cachedApnsJwt.token;
  }

  const header = base64UrlEncode(JSON.stringify({
    alg: "ES256",
    kid: credentials.keyId,
  }));
  const claims = base64UrlEncode(JSON.stringify({
    iss: credentials.teamId,
    iat: nowSeconds,
  }));
  const unsignedToken = `${header}.${claims}`;
  const privateKey = createPrivateKey(credentials.privateKeyPem);
  const signature = signWithKey("sha256", new TextEncoder().encode(unsignedToken), privateKey);
  const token = `${unsignedToken}.${base64UrlEncode(signature)}`;

  cachedApnsJwt = {
    cacheKey,
    token,
    expiresAt: nowSeconds + (50 * 60),
  };

  return token;
}

async function sendApnsAlertToRegistration(
  registration: MobilePushRegistration,
  alert: MobilePushAlert,
): Promise<ApnsSendOutcome> {
  const credentials = loadApnsCredentials();
  if (!credentials) {
    return {
      delivered: false,
      skipped: true,
      status: null,
      apnsId: null,
      reason: "missing_credentials",
    };
  }

  const authority = registration.apnsEnvironment === "production"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
  const jwt = apnsJwt(credentials);
  const payload = JSON.stringify({
    aps: {
      alert: {
        title: alert.title,
        body: alert.body,
      },
      ...(alert.sound ? { sound: alert.sound } : {}),
      ...(alert.threadId ? { "thread-id": alert.threadId } : {}),
    },
    ...(alert.payload ? { scout: alert.payload } : {}),
  });

  return new Promise<ApnsSendOutcome>((resolve, reject) => {
    const client = connectHttp2(authority);

    client.once("error", reject);

    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${registration.pushToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": registration.appBundleId,
      "apns-push-type": "alert",
      "apns-priority": alert.urgency === "silent" ? "5" : "10",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload).toString(),
    });

    let status: number | null = null;
    let apnsId: string | null = null;
    const chunks: string[] = [];

    request.setEncoding("utf8");

    request.on("response", (headers) => {
      const responseStatus = headers[":status"];
      status = typeof responseStatus === "number" ? responseStatus : Number(responseStatus ?? 0);
      apnsId = typeof headers["apns-id"] === "string" ? headers["apns-id"] : null;
    });

    request.on("data", (chunk: string) => {
      chunks.push(chunk);
    });

    request.on("end", () => {
      client.close();
      const rawBody = chunks.join("");
      let reason: string | null = null;

      if (rawBody.trim().length > 0) {
        try {
          const parsed = JSON.parse(rawBody) as { reason?: string };
          reason = parsed.reason?.trim() || null;
        } catch {
          reason = rawBody.trim();
        }
      }

      if (status === 200) {
        resolve({
          delivered: true,
          skipped: false,
          status,
          apnsId,
          reason: null,
        });
        return;
      }

      if (reason === "BadDeviceToken" || reason === "Unregistered") {
        deleteMobilePushRegistrationByToken(registration.pushToken);
      }

      resolve({
        delivered: false,
        skipped: false,
        status,
        apnsId,
        reason,
      });
    });

    request.on("error", (error) => {
      client.close();
      reject(error);
    });

    request.end(payload);
  });
}

export async function broadcastApnsAlertToActiveMobileDevices(
  alert: MobilePushAlert,
): Promise<MobilePushBroadcastResult> {
  if (resolvePushRelayConfig()) {
    return broadcastPushRelayAlert(alert);
  }

  const registrations = listActiveMobilePushRegistrations();
  let deliveredCount = 0;
  let skippedCount = 0;
  let configMissing = false;
  const failures: MobilePushBroadcastResult["failures"] = [];

  for (const registration of registrations) {
    try {
      const outcome = await sendApnsAlertToRegistration(registration, alert);
      if (outcome.delivered) {
        deliveredCount += 1;
        continue;
      }
      if (outcome.skipped) {
        skippedCount += 1;
        if (outcome.reason === "missing_credentials") {
          configMissing = true;
        }
        continue;
      }
      failures.push({
        deviceId: registration.deviceId,
        tokenSuffix: tokenSuffix(registration.pushToken),
        status: outcome.status,
        reason: outcome.reason,
      });
    } catch (error) {
      failures.push({
        deviceId: registration.deviceId,
        tokenSuffix: tokenSuffix(registration.pushToken),
        status: null,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    attemptedCount: registrations.length,
    deliveredCount,
    skippedCount,
    failedCount: failures.length,
    configMissing,
    failures,
  };
}
