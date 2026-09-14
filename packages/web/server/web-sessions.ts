import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ScoutWebSessionAuthority } from "./server-core.ts";

const SESSION_TOKEN_PREFIX = "sws_";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_STORED_SESSIONS = 200;
const STORE_VERSION = 1;
export const SCOUT_WEB_SESSION_STORE_MAX_BYTES = 256 * 1024;
const MAX_SESSION_LABEL_LENGTH = 256;

export const SCOUT_WEB_SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

type StoredWebSession = {
  tokenHash: string;
  label?: string;
  createdAt: number;
  expiresAt: number;
};

type WebSessionStoreFile = {
  version: number;
  sessions: StoredWebSession[];
};

export type ScoutWebSessionStore = ScoutWebSessionAuthority & {
  revoke: (token: string) => void;
  size: () => number;
};

/**
 * Where minted browser sessions persist. Test runs without an explicit support
 * directory stay memory-only so `bun test` never touches the operator's real
 * session file (mirrors resolveWebAuthToken's test guard).
 */
export function resolveScoutWebSessionStorePath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (process.env.NODE_ENV === "test" && !env.OPENSCOUT_SUPPORT_DIRECTORY) {
    return null;
  }
  const supportDirectory = env.OPENSCOUT_SUPPORT_DIRECTORY
    ?? join(homedir(), "Library", "Application Support", "OpenScout");
  return join(supportDirectory, "runtime", "web-sessions.json");
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function loadStoredSessions(path: string | null): StoredWebSession[] {
  if (!path) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    // Bound the read itself, including files growing after open/stat. Never
    // parse or retain a whole unbounded persisted file before enforcing caps.
    const bytes = Buffer.alloc(SCOUT_WEB_SESSION_STORE_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > SCOUT_WEB_SESSION_STORE_MAX_BYTES) return [];
    const parsed = JSON.parse(bytes.subarray(0, length).toString("utf8")) as Partial<WebSessionStoreFile> | null;
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.sessions)) return [];
    return parsed.sessions.filter((entry): entry is StoredWebSession =>
      Boolean(entry)
      && typeof entry.tokenHash === "string" && /^[a-f0-9]{64}$/.test(entry.tokenHash)
      && Number.isFinite(entry.createdAt) && Number.isFinite(entry.expiresAt)
      && entry.expiresAt > entry.createdAt
      && (entry.label === undefined || (typeof entry.label === "string" && entry.label.length <= MAX_SESSION_LABEL_LENGTH)),
    );
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Mints and validates the browser session tokens carried by the
 * openscout_web_session cookie. Tokens are random, stored hashed, expire
 * after {@link SCOUT_WEB_SESSION_MAX_AGE_SECONDS}, and are revocable — the
 * cookie never carries the operator token itself.
 */
export function createScoutWebSessionStore(options: {
  path?: string | null;
  ttlMs?: number;
  maxSessions?: number;
  now?: () => number;
} = {}): ScoutWebSessionStore {
  const path = options.path === undefined ? resolveScoutWebSessionStorePath() : options.path;
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const maxSessions = options.maxSessions ?? MAX_STORED_SESSIONS;
  const now = options.now ?? Date.now;

  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxSessions) || maxSessions < 1) {
    throw new Error("Session TTL and capacity must be positive finite values");
  }

  const prune = (records: StoredWebSession[]): StoredWebSession[] => {
    const cutoff = now();
    const retained = records.filter((entry) => entry.expiresAt > cutoff);
    if (retained.length > maxSessions) {
      retained.sort((a, b) => a.createdAt - b.createdAt);
      return retained.slice(retained.length - maxSessions);
    }
    return retained;
  };
  let sessions = prune(loadStoredSessions(path));

  const persist = (next: StoredWebSession[]) => {
    if (!path) return;
    const body = JSON.stringify(
      { version: STORE_VERSION, sessions: next } satisfies WebSessionStoreFile,
      null,
      2,
    ) + "\n";
    if (Buffer.byteLength(body, "utf8") > SCOUT_WEB_SESSION_STORE_MAX_BYTES) {
      throw new Error("Session store exceeds its persisted byte limit");
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  };

  const publish = (next: StoredWebSession[]) => {
    // A failed write must not claim a durable mint/revoke, including after a
    // restart. Memory-only stores intentionally have no persistence boundary.
    persist(next);
    sessions = next;
  };

  return {
    mint: (meta) => {
      const token = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      if (meta?.label !== undefined && meta.label.length > MAX_SESSION_LABEL_LENGTH) {
        throw new Error("Session label exceeds its length limit");
      }
      const createdAt = now();
      publish(prune([...sessions, {
        tokenHash: hashSessionToken(token),
        ...(meta?.label ? { label: meta.label } : {}),
        createdAt,
        expiresAt: createdAt + ttlMs,
      }]));
      return token;
    },
    validate: (token) => {
      if (!token.startsWith(SESSION_TOKEN_PREFIX)) return false;
      const tokenHash = hashSessionToken(token);
      const cutoff = now();
      return sessions.some((entry) => entry.tokenHash === tokenHash && entry.expiresAt > cutoff);
    },
    revoke: (token) => {
      const tokenHash = hashSessionToken(token);
      const before = sessions.length;
      const next = sessions.filter((entry) => entry.tokenHash !== tokenHash);
      if (next.length !== before) publish(next);
    },
    size: () => {
      sessions = prune(sessions);
      return sessions.length;
    },
  };
}
