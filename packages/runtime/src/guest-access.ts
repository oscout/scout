import { createPublicKey, randomBytes } from "node:crypto";

import { nodeKeyId } from "./node-identity.js";
import type { ControlPlaneSqliteTransactionalDatabase } from "./sqlite-adapter.js";

/**
 * Scout guest access (docs/proposals/scout-tailscale.md): a separately
 * enrolled client key, such as a cloud assistant using Scout Tailscale, with a
 * narrow owner-approved grant on this broker. Guests are never mesh peers:
 * their keys live only in `guest_grants`, never in `trusted_peers`, and they
 * never hold an `observe` or `control` tier. Grants are installed and revoked
 * only by a local (loopback) owner action; a hosted service cannot mint one.
 */

export const GUEST_PROTOCOL_VERSION = "scout-guest/1";
export const GUEST_GRANT_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const GUEST_GRANT_MAX_TARGETS = 50;
export const GUEST_ASK_MAX_TASK_BYTES = 32 * 1024;
export const GUEST_ASK_MAX_WAIT_MS = 20_000;

export const GUEST_GRANTS_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS guest_grants (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  label TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  allowed_targets_json TEXT NOT NULL,
  owner_handle TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_grants_request ON guest_grants (request_id);
CREATE INDEX IF NOT EXISTS idx_guest_grants_key ON guest_grants (key_id);
`;

export type GuestGrantRecord = {
  id: string;
  /** hosted pairing request id; the local idempotency key for installation */
  requestId: string;
  keyId: string;
  publicKey: string;
  label: string;
  /** broker actor the guest speaks as; derived here, never from requests */
  actorId: string;
  allowedTargets: string[];
  ownerHandle: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
};

export type GuestGrantStatus = "active" | "expired" | "revoked";

export function guestGrantStatus(grant: GuestGrantRecord, now: number): GuestGrantStatus {
  if (grant.revokedAt !== null) return "revoked";
  return grant.expiresAt <= now ? "expired" : "active";
}

export class GuestAccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "GuestAccessError";
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,80}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

/** Ed25519 SPKI DER (base64) only; returns the canonical encoding and key ID. */
export function normalizeGuestPublicKey(value: unknown): { publicKey: string; keyId: string } {
  if (typeof value !== "string" || value.length > 200) {
    throw new GuestAccessError("invalid_public_key", "clientPublicKey must be a base64 Ed25519 SPKI key");
  }
  let der: Buffer;
  try {
    const key = createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    der = key.export({ format: "der", type: "spki" });
  } catch {
    throw new GuestAccessError("invalid_public_key", "clientPublicKey must be a base64 Ed25519 SPKI key");
  }
  const publicKey = der.toString("base64");
  return { publicKey, keyId: nodeKeyId(publicKey) };
}

export function guestActorId(keyId: string): string {
  return `guest.${keyId}`;
}

export type GuestGrantInstallInput = {
  requestId: unknown;
  clientPublicKey: unknown;
  label: unknown;
  allowedTargets: unknown;
  ownerHandle?: unknown;
  expiresAt?: unknown;
};

export function parseGuestGrantInstall(input: GuestGrantInstallInput, now: number): {
  requestId: string;
  publicKey: string;
  keyId: string;
  label: string;
  allowedTargets: string[];
  ownerHandle: string | null;
  expiresAt: number;
} {
  if (!input || typeof input !== "object") {
    throw new GuestAccessError("invalid_request", "expected a JSON object");
  }
  const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new GuestAccessError("invalid_request", "requestId must be 1-80 letters, digits, or dashes");
  }
  const { publicKey, keyId } = normalizeGuestPublicKey(input.clientPublicKey);
  const label = typeof input.label === "string" ? input.label.trim().slice(0, 80) : "";
  if (!label) throw new GuestAccessError("invalid_request", "label is required");
  if (!Array.isArray(input.allowedTargets) || input.allowedTargets.length === 0
    || input.allowedTargets.length > GUEST_GRANT_MAX_TARGETS) {
    throw new GuestAccessError("invalid_request", `allowedTargets must list 1-${GUEST_GRANT_MAX_TARGETS} agent ids`);
  }
  const allowedTargets = [...new Set(input.allowedTargets.map((target) => {
    if (typeof target !== "string" || !AGENT_ID_PATTERN.test(target.trim())) {
      throw new GuestAccessError("invalid_request", "allowedTargets must be exact agent ids");
    }
    return target.trim();
  }))].sort();
  let ownerHandle: string | null = null;
  if (input.ownerHandle !== undefined && input.ownerHandle !== null) {
    if (typeof input.ownerHandle !== "string" || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(input.ownerHandle)) {
      throw new GuestAccessError("invalid_request", "ownerHandle must be a profile handle");
    }
    ownerHandle = input.ownerHandle;
  }
  let expiresAt = now + GUEST_GRANT_MAX_TTL_MS;
  if (input.expiresAt !== undefined) {
    if (typeof input.expiresAt !== "number" || !Number.isFinite(input.expiresAt) || input.expiresAt <= now) {
      throw new GuestAccessError("invalid_request", "expiresAt must be a future epoch millisecond time");
    }
    expiresAt = Math.min(input.expiresAt, expiresAt);
  }
  return { requestId, publicKey, keyId, label, allowedTargets, ownerHandle, expiresAt };
}

type GuestGrantRow = {
  id: string;
  request_id: string;
  key_id: string;
  public_key: string;
  label: string;
  actor_id: string;
  allowed_targets_json: string;
  owner_handle: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
};

function fromRow(row: GuestGrantRow): GuestGrantRecord {
  let allowedTargets: string[] = [];
  try {
    const parsed = JSON.parse(row.allowed_targets_json) as unknown;
    if (Array.isArray(parsed)) allowedTargets = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    allowedTargets = [];
  }
  return {
    id: row.id,
    requestId: row.request_id,
    keyId: row.key_id,
    publicKey: row.public_key,
    label: row.label,
    actorId: row.actor_id,
    allowedTargets,
    ownerHandle: row.owner_handle,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Durable guest grants in the broker's control-plane database. The table is
 * additive and created on first use as well as by migration, so an older
 * build simply never reads it.
 */
export class GuestGrantStore {
  private ready = false;

  constructor(
    private readonly db: ControlPlaneSqliteTransactionalDatabase,
    private readonly isPeerKey: (keyId: string) => boolean = () => false,
  ) {}

  private ensure(): void {
    if (this.ready) return;
    this.db.exec(GUEST_GRANTS_SQLITE_SCHEMA);
    this.ready = true;
  }

  /**
   * Install (or idempotently re-confirm) a grant for one pairing request.
   * The same request id with the same key and scope returns the existing
   * grant, so an app retry after a lost response is safe. A different key or
   * scope, or a revoked request, is a conflict: re-approval needs a new
   * pairing request.
   */
  install(input: GuestGrantInstallInput, now: number = Date.now()): { grant: GuestGrantRecord; created: boolean } {
    this.ensure();
    const parsed = parseGuestGrantInstall(input, now);
    if (this.isPeerKey(parsed.keyId)) {
      throw new GuestAccessError("key_in_use", "this key is reserved for another mesh credential type and cannot be a guest", 409);
    }
    const run = this.db.transaction((): { grant: GuestGrantRecord; created: boolean } => {
      const existing = this.db.query<GuestGrantRow>("SELECT * FROM guest_grants WHERE request_id = ?1")
        .get(parsed.requestId) as GuestGrantRow | null;
      if (existing) {
        const grant = fromRow(existing);
        // Immutable binding: key, scope, owner, and label must all match.
        // Expiry is fixed at first install; a retry never extends it.
        if (grant.keyId !== parsed.keyId
          || JSON.stringify(grant.allowedTargets) !== JSON.stringify(parsed.allowedTargets)
          || grant.ownerHandle !== parsed.ownerHandle
          || grant.label !== parsed.label) {
          throw new GuestAccessError("request_conflict", "this request already has a different grant", 409);
        }
        if (grant.revokedAt !== null) {
          throw new GuestAccessError("grant_revoked", "this request's grant was revoked; start a new request", 409);
        }
        return { grant, created: false };
      }
      const active = this.db.query<GuestGrantRow>(
        "SELECT * FROM guest_grants WHERE key_id = ?1 AND revoked_at IS NULL AND expires_at > ?2",
      ).get(parsed.keyId, now) as GuestGrantRow | null;
      if (active) {
        throw new GuestAccessError("key_in_use", "this client key already holds an active grant", 409);
      }
      const grant: GuestGrantRecord = {
        id: `gg_${randomBytes(8).toString("hex")}`,
        requestId: parsed.requestId,
        keyId: parsed.keyId,
        publicKey: parsed.publicKey,
        label: parsed.label,
        // Canonical coordination identity is the full key ID, so distinct
        // keys can never merge; the label is display-only.
        actorId: guestActorId(parsed.keyId),
        allowedTargets: parsed.allowedTargets,
        ownerHandle: parsed.ownerHandle,
        createdAt: now,
        expiresAt: parsed.expiresAt,
        revokedAt: null,
        lastUsedAt: null,
      };
      this.db.query(
        `INSERT INTO guest_grants (id, request_id, key_id, public_key, label, actor_id,
          allowed_targets_json, owner_handle, created_at, expires_at, revoked_at, last_used_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL)`,
      ).run(
        grant.id, grant.requestId, grant.keyId, grant.publicKey, grant.label, grant.actorId,
        JSON.stringify(grant.allowedTargets), grant.ownerHandle, grant.createdAt, grant.expiresAt,
      );
      return { grant, created: true };
    });
    return run();
  }

  knownKey(keyId: string): boolean {
    this.ensure();
    return Boolean(this.db.query("SELECT id FROM guest_grants WHERE key_id = ?1 LIMIT 1").get(keyId));
  }

  /** The one active grant for a signing key, or undefined. */
  activeByKeyId(keyId: string, now: number = Date.now()): GuestGrantRecord | undefined {
    this.ensure();
    const row = this.db.query<GuestGrantRow>(
      "SELECT * FROM guest_grants WHERE key_id = ?1 AND revoked_at IS NULL AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1",
    ).get(keyId, now) as GuestGrantRow | null;
    return row ? fromRow(row) : undefined;
  }

  byId(id: string): GuestGrantRecord | undefined {
    this.ensure();
    const row = this.db.query<GuestGrantRow>("SELECT * FROM guest_grants WHERE id = ?1").get(id) as GuestGrantRow | null;
    return row ? fromRow(row) : undefined;
  }

  byRequestId(requestId: string): GuestGrantRecord | undefined {
    this.ensure();
    const row = this.db.query<GuestGrantRow>("SELECT * FROM guest_grants WHERE request_id = ?1")
      .get(requestId) as GuestGrantRow | null;
    return row ? fromRow(row) : undefined;
  }

  list(): GuestGrantRecord[] {
    this.ensure();
    const rows = this.db.query<GuestGrantRow>("SELECT * FROM guest_grants ORDER BY created_at DESC LIMIT 500")
      .all() as GuestGrantRow[];
    return rows.map(fromRow);
  }

  /** Idempotent: returns the grant with its (first) revocation time. */
  revoke(selector: { grantId?: string; requestId?: string }, now: number = Date.now()): GuestGrantRecord | undefined {
    this.ensure();
    const grant = selector.grantId ? this.byId(selector.grantId)
      : selector.requestId ? this.byRequestId(selector.requestId) : undefined;
    if (!grant) return undefined;
    this.db.query("UPDATE guest_grants SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2").run(now, grant.id);
    return this.byId(grant.id);
  }

  touch(grantId: string, now: number = Date.now()): void {
    this.ensure();
    this.db.query("UPDATE guest_grants SET last_used_at = ?1 WHERE id = ?2").run(now, grantId);
  }
}

/** Invocation ids are namespaced by grant, so one guest can never address another's ask. */
export function guestInvocationId(grantId: string, requestId: string): string {
  return `guest-${grantId}-${requestId}`;
}

export const GUEST_ASK_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
