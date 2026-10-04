import { useCallback, useEffect, useState } from "react";
import {
  companionHostAvailable,
  onCompanionState,
  readCompanionState,
  type CompanionHostState,
} from "../../lib/companion-host.ts";

export type CompanionHostHandle = {
  /** Whether the page runs inside the Scout app with a companion bridge. */
  available: boolean;
  /** Null until the first read or push arrives. */
  state: CompanionHostState | null;
  /** The last bridge failure; cleared by the next state the host sends. */
  error: string | null;
  /** Read the state again, after a failure. */
  retry: () => void;
  /** Take a state a bridge call returned; clears the error. */
  apply: (state: CompanionHostState) => void;
  /** Record a failed bridge call. */
  fail: (cause: unknown) => void;
  /** A bridge call that returns no state worked; clears the error. */
  clearError: () => void;
};

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The Mac app's companion state for one page: a first read, then pushes.
 * Shared by the companion page and the work page's controls, so a failed
 * first read is visible and retryable everywhere instead of leaving a
 * control disabled for good.
 */
export function useCompanionHostState(): CompanionHostHandle {
  const [available] = useState(companionHostAvailable);
  const [state, setState] = useState<CompanionHostState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const apply = useCallback((next: CompanionHostState) => {
    setState(next);
    setError(null);
  }, []);
  const fail = useCallback((cause: unknown) => setError(message(cause)), []);
  const clearError = useCallback(() => setError(null), []);
  const retry = useCallback(() => {
    setError(null);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    readCompanionState()
      .then((next) => { if (!cancelled) apply(next); })
      .catch((cause) => { if (!cancelled) fail(cause); });
    const stop = onCompanionState(apply);
    return () => {
      cancelled = true;
      stop();
    };
  }, [available, attempt, apply, fail]);

  return { available, state, error, retry, apply, fail, clearError };
}
