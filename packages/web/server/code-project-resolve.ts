import { basename } from "node:path";

/**
 * Slug matching for /code/<project> deep links against the canonical project
 * inventory. Repo-watch only registers checkouts with live agent/endpoint
 * activity, so a cold or quiet project must still resolve here — the inventory
 * is the "known local checkout" authority the deep-link contract promises.
 */

export type CodeProjectCandidate = {
  displayName: string;
  projectRoot: string;
};

/** Same normalization the web client applies to project names in /code URLs. */
export function codeProjectSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/**
 * Resolve a slug to one inventory project. Folder-name matches outrank
 * display-name matches (the URL is built from the folder), and among equal
 * matches the shortest root wins so primary checkouts beat derived worktrees
 * (e.g. ~/dev/openscout over ~/.codex/worktrees/4f8f/openscout).
 */
export function matchCodeProjectBySlug<T extends CodeProjectCandidate>(
  inventory: readonly T[],
  slug: string,
): T | null {
  const needle = codeProjectSlug(slug);
  if (!needle) return null;
  const byRootName = inventory.filter(
    (project) => codeProjectSlug(basename(project.projectRoot)) === needle,
  );
  const pool = byRootName.length > 0
    ? byRootName
    : inventory.filter((project) => codeProjectSlug(project.displayName) === needle);
  if (pool.length === 0) return null;
  return [...pool].sort(
    (left, right) => left.projectRoot.length - right.projectRoot.length
      || left.projectRoot.localeCompare(right.projectRoot),
  )[0] ?? null;
}
