/**
 * A broker-owned, opaque pointer to one concrete harness context.
 *
 * The token carries no agent, profile, project, harness, or node semantics.
 * Those facts belong to the broker's resolution record and may change without
 * changing the public address grammar.
 */
export type ScoutSessionHandle = `sess.${string}`;

export const SCOUT_SESSION_HANDLE_PREFIX = "sess." as const;
export const SCOUT_SESSION_ADDRESS_PREFIX = "session:" as const;

// Current broker projections use 20 lowercase hex characters. Accept a wider
// URL-safe token alphabet so the encoding can evolve without changing callers.
export const SCOUT_CANONICAL_SESSION_HANDLE_PATTERN = /^sess\.[A-Za-z0-9_-]{10,64}$/;

export function isScoutSessionHandle(
  value: string | null | undefined,
): value is ScoutSessionHandle {
  return typeof value === "string"
    && SCOUT_CANONICAL_SESSION_HANDLE_PATTERN.test(value);
}

export function parseScoutSessionAddress(
  value: string | null | undefined,
): ScoutSessionHandle | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const handle = trimmed.startsWith(SCOUT_SESSION_ADDRESS_PREFIX)
    ? trimmed.slice(SCOUT_SESSION_ADDRESS_PREFIX.length)
    : trimmed;
  return isScoutSessionHandle(handle) ? handle : null;
}

export function formatScoutSessionAddress(handle: ScoutSessionHandle): string {
  return `${SCOUT_SESSION_ADDRESS_PREFIX}${handle}`;
}

/**
 * Email-like session address: `sess.<token>@<host>`.
 *
 * The local part is the exact harness conversation (the opaque broker handle);
 * the domain is the stable broker authority that owns it — a mesh node's
 * stable qualifier, never a network address. It is derived for every known
 * session, so first contact needs no agent card. Addressability says nothing
 * about reachability: resolving an address may still report the session as
 * offline, ended, or on a host this broker cannot reach.
 *
 * `session:sess.<token>@<host>` is the typed form; a bare `sess.<token>@<host>`
 * is accepted wherever a route target is. Only canonical `sess.*` handles take
 * a host; legacy native session ids keep their existing grammar untouched.
 */
export interface ScoutSessionHostAddress {
  handle: ScoutSessionHandle;
  host: string;
}

/** Normalized host label: lowercase DNS-ish label, no `.local`, no trailing dot. */
export function normalizeScoutSessionHost(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

const SCOUT_SESSION_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

export function parseScoutSessionHostAddress(
  value: string | null | undefined,
): ScoutSessionHostAddress | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const bare = trimmed.startsWith(SCOUT_SESSION_ADDRESS_PREFIX)
    ? trimmed.slice(SCOUT_SESSION_ADDRESS_PREFIX.length)
    : trimmed;
  const at = bare.indexOf("@");
  if (at <= 0 || at !== bare.lastIndexOf("@")) return null;
  const handle = bare.slice(0, at);
  const host = normalizeScoutSessionHost(bare.slice(at + 1));
  if (!isScoutSessionHandle(handle) || !SCOUT_SESSION_HOST_PATTERN.test(host)) return null;
  return { handle, host };
}

export function formatScoutSessionHostAddress(address: ScoutSessionHostAddress): string {
  return `${address.handle}@${normalizeScoutSessionHost(address.host)}`;
}

/** The node facts a host label is derived from (a subset of NodeDefinition). */
export interface ScoutSessionHostNode {
  id: string;
  meshId?: string;
  name?: string;
  hostName?: string;
}

/**
 * Derive the stable host label for a mesh node. Node ids are minted as
 * `<stable-qualifier>-<mesh>`, so stripping the mesh suffix yields the
 * persisted machine qualifier; display names are a fallback only.
 */
export function scoutSessionHostForNode(node: ScoutSessionHostNode): string {
  const id = normalizeScoutSessionHost(node.id);
  const mesh = normalizeScoutSessionHost(node.meshId);
  if (mesh && id.endsWith(`-${mesh}`) && id.length > mesh.length + 1) {
    return id.slice(0, -(mesh.length + 1));
  }
  return normalizeScoutSessionHost(node.name) || normalizeScoutSessionHost(node.hostName) || id;
}

/** True when `host` names this node by its derived label, id, name, or host name. */
export function scoutNodeMatchesSessionHost(node: ScoutSessionHostNode, host: string): boolean {
  const wanted = normalizeScoutSessionHost(host);
  if (!wanted) return false;
  return [
    scoutSessionHostForNode(node),
    normalizeScoutSessionHost(node.id),
    normalizeScoutSessionHost(node.name),
    normalizeScoutSessionHost(node.hostName),
  ].includes(wanted);
}
