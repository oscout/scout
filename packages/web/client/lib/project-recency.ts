/**
 * Which projects the operator actually starts work in, most recent first.
 *
 * The New Chat composer used to fall back to `projects[0]` of an
 * alphabetically sorted inventory whenever route context was absent and the
 * server's cwd sat outside every known root — so a fresh task kept landing on
 * whichever project happens to sort first, which is not a fact about anyone's
 * work. This is the missing signal: a small most-recently-used list of roots,
 * written on an explicit pick (never on a default the composer chose itself,
 * which would make the default self-confirming).
 *
 * Device-local on purpose. "Where I was last working" is a property of the
 * seat, not of the fleet, and it must survive a reload without a round trip.
 */

const STORAGE_KEY = "openscout.project-recency.v1";
/** Deep enough to cover a working set, short enough to stay a *recent* list. */
const LIMIT = 12;

function normalizeRoot(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > 1 ? trimmed.replace(/\/+$/u, "") : trimmed;
}

/** Most-recently-picked project roots, newest first. */
export function readRecentProjectRoots(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const roots: string[] = [];
    for (const entry of parsed) {
      const root = typeof entry === "string" ? normalizeRoot(entry) : null;
      if (root && !roots.includes(root)) roots.push(root);
    }
    return roots.slice(0, LIMIT);
  } catch {
    return [];
  }
}

/**
 * Record an explicit pick. Returns the new list so a caller can update state
 * without a second read.
 */
export function rememberProjectRoot(value: string | null | undefined): string[] {
  const root = normalizeRoot(value);
  if (!root) return readRecentProjectRoots();
  const next = [root, ...readRecentProjectRoots().filter((entry) => entry !== root)]
    .slice(0, LIMIT);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage may be unavailable */
    }
  }
  return next;
}
