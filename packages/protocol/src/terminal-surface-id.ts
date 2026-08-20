/**
 * Terminal surface identity.
 *
 * A surface id is an opaque token that names one materialized terminal surface:
 * a host session (and optionally a pane) on a host backend, on a node. It is
 * the durable handle a saved workspace cell, a deep link, or a route alias
 * holds onto.
 *
 * Two rules make it durable, and both are the point of this module:
 *
 * 1. Identity comes from (node, backend, host session, pane) — never from the
 *    display name. Renaming a session used to change its Scout id, because ids
 *    were `sha1(name)`.
 * 2. There is exactly ONE constructor ({@link formatTerminalSurfaceId}) and ONE
 *    parser ({@link parseTerminalSurfaceId}). Nothing else may split a surface
 *    id on a separator. Four different separator conventions had grown across
 *    the server, the web client, and the macOS app, each with its own
 *    assumptions about which characters could appear in a session name; the
 *    only reason they worked was an unrelated validator that happened to
 *    exclude `:`.
 *
 * The token is opaque to consumers but not to this module: it encodes its parts
 * so a server can resolve one without a lookup table, and so a client that
 * receives an id it has never seen can still be routed. Legacy `backend:name`
 * keys parse too, so persisted workspaces and in-flight URLs keep working.
 */

/** Backends with first-class protocol support. */
export type TerminalBackend = "tmux" | "zellij";

/**
 * Any terminal host Scout can address. {@link TerminalBackend} is the subset the
 * protocol types name explicitly; adapters may register further hosts (herdr,
 * ssh, host-control) without a protocol change.
 */
export type TerminalHostId = TerminalBackend | (string & {});

/** The parts a surface id is built from. */
export type TerminalSurfaceAddress = {
  /** Host adapter that owns the surface. */
  backend: TerminalHostId;
  /** Backend-native session name. Mutable display metadata, not identity on its own. */
  hostSession: string;
  /** Pane or tab within the host session, when the host addresses one. */
  paneId?: string | null;
  /** Scout node the surface lives on. Null/absent means the local node. */
  nodeId?: string | null;
};

/** Opaque surface handle. Never split, slice, or interpolate into a pattern. */
export type TerminalSurfaceId = string;

const SURFACE_ID_PREFIX = "srf1.";
/** Legacy `backend:sessionName` keys, still written by older clients and links. */
const LEGACY_SURFACE_KEY = /^(?<backend>[A-Za-z][A-Za-z0-9_-]*):(?<hostSession>.+)$/u;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function isTerminalSurfaceId(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(SURFACE_ID_PREFIX);
}

/**
 * Build the surface id for an address. Deterministic: the same address always
 * yields the same id, on any node, in any process, so two writers converge on
 * one row instead of forking one.
 */
export function formatTerminalSurfaceId(address: TerminalSurfaceAddress): TerminalSurfaceId {
  const backend = address.backend.trim();
  const hostSession = address.hostSession.trim();
  if (!backend || !hostSession) {
    throw new Error("a terminal surface id needs a backend and a host session");
  }
  const paneId = address.paneId?.trim() || null;
  const nodeId = address.nodeId?.trim() || null;
  return `${SURFACE_ID_PREFIX}${encodeBase64Url(JSON.stringify([nodeId, backend, hostSession, paneId]))}`;
}

/**
 * Resolve a surface id back to its address. Accepts the opaque form and the
 * legacy `backend:sessionName` key. Returns null for anything else rather than
 * guessing — a caller holding an unparseable handle must say so, not fabricate
 * a target.
 */
export function parseTerminalSurfaceId(
  value: string | null | undefined,
): TerminalSurfaceAddress | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith(SURFACE_ID_PREFIX)) {
    const decoded = decodeBase64Url(trimmed.slice(SURFACE_ID_PREFIX.length));
    if (decoded === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded) as unknown;
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || parsed.length < 3) return null;
    const [nodeId, backend, hostSession, paneId] = parsed as unknown[];
    if (typeof backend !== "string" || !backend.trim()) return null;
    if (typeof hostSession !== "string" || !hostSession.trim()) return null;
    return {
      backend: backend.trim(),
      hostSession: hostSession.trim(),
      paneId: typeof paneId === "string" && paneId.trim() ? paneId.trim() : null,
      nodeId: typeof nodeId === "string" && nodeId.trim() ? nodeId.trim() : null,
    };
  }

  const legacy = LEGACY_SURFACE_KEY.exec(trimmed);
  if (!legacy?.groups) return null;
  const hostSession = legacy.groups.hostSession!.trim();
  if (!hostSession) return null;
  return {
    backend: legacy.groups.backend!,
    hostSession,
    paneId: null,
    nodeId: null,
  };
}

/**
 * Compare two handles by what they address, not by how they were written, so a
 * legacy key and its opaque replacement resolve to the same tile.
 */
export function terminalSurfaceIdsEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftAddress = parseTerminalSurfaceId(left);
  const rightAddress = parseTerminalSurfaceId(right);
  if (!leftAddress || !rightAddress) return false;
  return leftAddress.backend === rightAddress.backend
    && leftAddress.hostSession === rightAddress.hostSession
    && (leftAddress.paneId ?? null) === (rightAddress.paneId ?? null)
    && (leftAddress.nodeId ?? null) === (rightAddress.nodeId ?? null);
}

/**
 * The legacy `backend:sessionName` key for an address. Kept so ids issued by
 * this build stay readable by clients that have not adopted the opaque form
 * (macOS, iOS). Delete once every surface reads {@link TerminalSurfaceId}.
 */
export function legacyTerminalSurfaceKey(address: TerminalSurfaceAddress): string {
  return `${address.backend}:${address.hostSession}`;
}

// Base64url over UTF-8, hand-rolled so this module runs unchanged in a browser
// bundle, a Bun server, and a Node relay without Buffer or atob/btoa.

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index]!;
    const byte1 = bytes[index + 1];
    const byte2 = bytes[index + 2];
    out += BASE64URL_ALPHABET[byte0 >> 2];
    out += BASE64URL_ALPHABET[((byte0 & 0b11) << 4) | ((byte1 ?? 0) >> 4)];
    if (byte1 === undefined) break;
    out += BASE64URL_ALPHABET[((byte1 & 0b1111) << 2) | ((byte2 ?? 0) >> 6)];
    if (byte2 === undefined) break;
    out += BASE64URL_ALPHABET[byte2 & 0b111111];
  }
  return out;
}

function decodeBase64Url(value: string): string | null {
  if (!value) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const index = BASE64URL_ALPHABET.indexOf(character);
    if (index < 0) return null;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}
