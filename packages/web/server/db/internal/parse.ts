/**
 * Small value parsers used across the read-side queries. Lifted from
 * db-queries.ts as part of SCO-031 Phase A.
 */

import { EPOCH_MILLISECONDS_FLOOR, epochMs } from "@openscout/protocol";

export function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function jsonBoolean(value: number | string | null | undefined): boolean {
  return value === 1 || value === "1" || value === "true";
}

/**
 * The broker annotates a dispatch attempt when the requester stops waiting for
 * a synchronous result (`requesterTimedOut` / `timeoutScope: requester_wait`).
 * The agent may still be running, but the operator's turn is no longer live,
 * so it must not present as an active "working" ask.
 */
export function isRequesterWaitTimeoutMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata) return false;
  if (metadata["requesterTimedOut"] === true) return true;
  return metadata["timeoutScope"] === "requester_wait";
}

export function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export { EPOCH_MILLISECONDS_FLOOR };

export function coerceNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeTimestampMs(value: number | string | null | undefined): number | null {
  return epochMs(value);
}
