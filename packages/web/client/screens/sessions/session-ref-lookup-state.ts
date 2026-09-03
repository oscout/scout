export type SessionRefLookupState<T> = {
  sessionRef: string;
  lookup: T | null;
  loading: boolean;
  error: string | null;
};

export type SessionRefLookupCompletion<T> = {
  sessionRef: string;
  result:
    | { ok: true; lookup: T }
    | { ok: false; error: unknown };
};

export function sessionRefRefreshDelayMs(input: {
  nowMs: number;
  lastRefreshAtMs: number | null;
  debounceMs: number;
  minimumIntervalMs: number;
}): number {
  const debounceMs = Math.max(0, input.debounceMs);
  const minimumIntervalMs = Math.max(debounceMs, input.minimumIntervalMs);
  if (input.lastRefreshAtMs === null) return debounceMs;

  const elapsedMs = Math.max(0, input.nowMs - input.lastRefreshAtMs);
  return Math.max(debounceMs, minimumIntervalMs - elapsedMs);
}

type SessionRefInvalidationEvent = {
  kind: string;
  payload?: unknown;
};

function comparableSessionRefs(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return [];
  const routeMatch = /^session:[^:]+:(.+)$/u.exec(normalized);
  const routeRef = routeMatch?.[1] ?? normalized;
  const leaf = routeRef.split(/[\\/]/u).filter(Boolean).at(-1) ?? routeRef;
  const bare = leaf.endsWith(".jsonl") ? leaf.slice(0, -".jsonl".length) : leaf;
  return [...new Set([normalized, routeRef, leaf, bare])];
}

export function sessionRefsMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  const leftRefs = new Set(comparableSessionRefs(left));
  return comparableSessionRefs(right).some((candidate) => leftRefs.has(candidate));
}

function payloadReferencesSession(
  value: unknown,
  refs: readonly string[],
  depth = 0,
): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === "string") {
    return refs.some((ref) => sessionRefsMatch(value, ref));
  }
  if (Array.isArray(value)) {
    return value.some((entry) => payloadReferencesSession(entry, refs, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .some((entry) => payloadReferencesSession(entry, refs, depth + 1));
  }
  return false;
}

/**
 * Broker events are invalidation hints, not a reason to reload every open
 * session. Reconcile on subscription (unknown), then only when the event
 * payload actually names this conversation, endpoint, agent, or provider ref.
 */
export function brokerEventMayAffectSessionRef(
  event: SessionRefInvalidationEvent,
  refs: readonly (string | null | undefined)[],
): boolean {
  if (event.kind === "unknown") return true;
  const normalizedRefs = refs.filter((ref): ref is string => Boolean(ref?.trim()));
  return normalizedRefs.length > 0
    && payloadReferencesSession(event.payload, normalizedRefs);
}

/** Never expose data loaded for a route that is no longer active. */
export function activeSessionRefLookupState<T>(
  state: SessionRefLookupState<T>,
  sessionRef: string,
): SessionRefLookupState<T> {
  if (state.sessionRef === sessionRef) return state;
  return {
    sessionRef,
    lookup: null,
    loading: true,
    error: null,
  };
}

/**
 * Let requests finish for the shared GET cache, but commit only the newest one.
 * Aborting here would also abort callers sharing api()'s in-flight GET.
 */
export function createSessionRefLookupCoordinator<T>(
  load: (sessionRef: string) => Promise<T>,
  complete: (completion: SessionRefLookupCompletion<T>) => void,
): {
  request: (sessionRef: string) => Promise<void>;
  invalidate: () => void;
} {
  let generation = 0;

  return {
    async request(sessionRef) {
      const requestGeneration = ++generation;
      try {
        const lookup = await load(sessionRef);
        if (requestGeneration !== generation) return;
        complete({ sessionRef, result: { ok: true, lookup } });
      } catch (error) {
        if (requestGeneration !== generation) return;
        complete({ sessionRef, result: { ok: false, error } });
      }
    },
    invalidate() {
      generation += 1;
    },
  };
}
