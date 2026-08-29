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
