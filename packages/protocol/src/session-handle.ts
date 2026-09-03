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
