/**
 * Repo Watch — selection bridge.
 *
 * The worktree CONTEXT panel lives in the app's global right Inspector rail
 * (see `scout/inspector/ReposInspector.tsx`), but the expensive `/api/repo-watch`
 * scan is owned by `ReposScreen`. Rather than re-fetch the snapshot in the rail
 * (slow, and prone to drifting out of sync with the table), `ReposScreen`
 * publishes its current selection here and the rail subscribes. Mirrors the
 * `scout:ops-detail` content→inspector handoff, but typed and module-local.
 */

import { useEffect, useState } from "react";
import type { Tone } from "./ui.ts";
import type { RepoWatchProject, RepoWatchWorktree } from "./types.ts";

export type RepoWatchSelection = {
  worktree: RepoWatchWorktree | null;
  project: RepoWatchProject | null;
  generatedAt: number;
  tone: Tone;
};

const EMPTY: RepoWatchSelection = {
  worktree: null,
  project: null,
  generatedAt: 0,
  tone: "warm",
};

let current: RepoWatchSelection = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Push the latest table selection to any mounted Repos inspector. */
export function publishRepoWatchSelection(next: RepoWatchSelection) {
  current = next;
  emit();
}

/** Drop the published selection (call on ReposScreen unmount). */
export function clearRepoWatchSelection() {
  if (current === EMPTY) return;
  current = EMPTY;
  emit();
}

/** Subscribe the inspector rail to the live selection. */
export function useRepoWatchSelection(): RepoWatchSelection {
  const [state, setState] = useState<RepoWatchSelection>(() => current);
  useEffect(() => {
    // Re-sync in case a publish landed between render and effect.
    setState(current);
    const listener = () => setState(current);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}
