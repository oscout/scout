/**
 * Repo identity for grouping agents that run in side checkouts of the same
 * repository. Results are cached per project root, including negative probes,
 * so the frequently-polled agents endpoint does not repeatedly shell out.
 */

import { gitRemoteGetUrlOrigin } from "@openscout/runtime/system-probes";

const REPO_KEY_TTL_MS = 60_000;

/** Normalize SSH and URL remotes to one `host/org/repo` identity. */
export function normalizeGitRemoteUrl(remote: string | null | undefined): string | null {
  const trimmed = remote?.trim() ?? "";
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return canonicalRepoKey(url.hostname, url.pathname);
    } catch {
      return null;
    }
  }
  const scpLike = /^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/.exec(trimmed);
  return scpLike ? canonicalRepoKey(scpLike[1]!, scpLike[2]!) : null;
}

function canonicalRepoKey(host: string, path: string): string | null {
  const cleaned = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!host.trim() || !cleaned) return null;
  return `${host.trim().toLowerCase()}/${cleaned}`;
}

const repoKeyCache = new Map<string, { at: number; key: string | null }>();
const repoKeyInFlight = new Map<string, Promise<string | null>>();

async function probeRepoKey(root: string): Promise<string | null> {
  const remote = await gitRemoteGetUrlOrigin(root).catch(() => null);
  return normalizeGitRemoteUrl(remote);
}

export function resolveRepoKeyForRoot(root: string): Promise<string | null> {
  const cached = repoKeyCache.get(root);
  if (cached && Date.now() - cached.at < REPO_KEY_TTL_MS) {
    return Promise.resolve(cached.key);
  }
  const inFlight = repoKeyInFlight.get(root);
  if (inFlight) return inFlight;
  const promise = probeRepoKey(root)
    .then((key) => {
      repoKeyCache.set(root, { at: Date.now(), key });
      return key;
    })
    .finally(() => {
      if (repoKeyInFlight.get(root) === promise) repoKeyInFlight.delete(root);
    });
  repoKeyInFlight.set(root, promise);
  return promise;
}

export async function resolveRepoKeysByRoot(
  roots: Iterable<string>,
): Promise<Map<string, string | null>> {
  const distinct = [...new Set(roots)];
  const keys = await Promise.all(distinct.map((root) => resolveRepoKeyForRoot(root)));
  return new Map(distinct.map((root, index) => [root, keys[index] ?? null]));
}
