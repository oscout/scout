/* Persisted tree state per root: the surface renders instantly from the last
   visit (stale) and re-fetches visible directories in the background; loadDir
   replaces one directory's entries at a time, which is the reconciliation.
   localStorage because the native embed reloads the page on section switches —
   in-memory caches don't survive that. */

export type StoredDirEntry = { name: string; path: string; kind: "file" | "directory" };

export type StoredTree = {
  entries: Record<string, StoredDirEntry[]>;
  expanded: string[];
  selectedFile: string | null;
  savedAt: number;
};

const TREE_KEY_PREFIX = "openscout.code.tree:";
const LAST_ROOT_KEY = "openscout.code.lastRoot";
const RECENT_ROOTS_KEY = "openscout.code.recentRoots";
/** Cap the MRU so the chip strip stays scannable. */
export const RECENT_ROOTS_LIMIT = 8;

export function readStoredTree(root: string): StoredTree | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TREE_KEY_PREFIX + root);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredTree;
    if (!parsed || typeof parsed.entries !== "object" || !Array.isArray(parsed.expanded)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredTree(root: string, tree: {
  entries: Map<string, StoredDirEntry[]>;
  expanded: ReadonlySet<string>;
  selectedFile: string | null;
}): void {
  if (typeof window === "undefined") return;
  // Persist only the directories that are actually visible (root + expanded) —
  // bounds the payload no matter how much of a repo was browsed.
  const keep: Record<string, StoredDirEntry[]> = {};
  for (const dir of [root, ...tree.expanded]) {
    const entries = tree.entries.get(dir);
    if (entries) keep[dir] = entries;
  }
  try {
    window.localStorage.setItem(TREE_KEY_PREFIX + root, JSON.stringify({
      entries: keep,
      expanded: [...tree.expanded],
      selectedFile: tree.selectedFile,
      savedAt: Date.now(),
    } satisfies StoredTree));
  } catch {
    // Quota or private mode — persistence is best-effort.
  }
}

export function readLastRoot(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_ROOT_KEY);
  } catch {
    return null;
  }
}

/** Most-recently-used worktree roots for the code browser project picker. */
export function readRecentRoots(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_ROOTS_KEY);
    if (!raw) {
      // Migrate the older single last-root key into the list on first read.
      const last = window.localStorage.getItem(LAST_ROOT_KEY);
      return last ? [last] : [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

export function writeLastRoot(root: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_ROOT_KEY, root);
    const previous = readRecentRoots().filter((entry) => entry !== root);
    const next = [root, ...previous].slice(0, RECENT_ROOTS_LIMIT);
    window.localStorage.setItem(RECENT_ROOTS_KEY, JSON.stringify(next));
  } catch {
    // Best-effort.
  }
}
