/**
 * Repo identity for grouping agents that run in side checkouts of the same
 * repository. Results are cached per project root, including negative probes,
 * so the frequently-polled agents endpoint does not repeatedly shell out.
 */

import { gitRemoteGetUrlOrigin } from "@openscout/runtime/system-probes";

// A repository's origin is effectively configuration, not live activity. Keep
// the value for long enough that ordinary roster polling cannot turn into a
// periodic process storm.
const REPO_KEY_TTL_MS = 10 * 60_000;
const REPO_KEY_PROBE_CONCURRENCY = 4;

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
const queuedRepoKeyRoots: string[] = [];
const queuedRepoKeyRootSet = new Set<string>();
let activeRepoKeyProbes = 0;

async function probeRepoKey(root: string): Promise<string | null> {
  const remote = await gitRemoteGetUrlOrigin(root).catch(() => null);
  return normalizeGitRemoteUrl(remote);
}

function refreshRepoKeyForRoot(root: string): Promise<string | null> {
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

export function resolveRepoKeyForRoot(root: string): Promise<string | null> {
  const cached = repoKeyCache.get(root);
  if (cached && Date.now() - cached.at < REPO_KEY_TTL_MS) {
    return Promise.resolve(cached.key);
  }
  return refreshRepoKeyForRoot(root);
}

function drainRepoKeyProbeQueue(): void {
  while (activeRepoKeyProbes < REPO_KEY_PROBE_CONCURRENCY) {
    const root = queuedRepoKeyRoots.shift();
    if (!root) return;
    queuedRepoKeyRootSet.delete(root);
    activeRepoKeyProbes += 1;
    void refreshRepoKeyForRoot(root)
      .catch(() => null)
      .finally(() => {
        activeRepoKeyProbes -= 1;
        drainRepoKeyProbeQueue();
      });
  }
}

function scheduleRepoKeyProbe(root: string): void {
  if (repoKeyInFlight.has(root) || queuedRepoKeyRootSet.has(root)) return;
  queuedRepoKeyRootSet.add(root);
  queuedRepoKeyRoots.push(root);
  drainRepoKeyProbeQueue();
}

/**
 * Return the last known repo identities without holding a roster response open
 * for git. Missing and expired roots are refreshed in a four-wide background
 * queue; stale values remain usable while that refresh runs.
 */
export function cachedRepoKeysByRoot(
  roots: Iterable<string>,
): Map<string, string | null> {
  const now = Date.now();
  const distinct = [...new Set(roots)];
  const result = new Map<string, string | null>();
  for (const root of distinct) {
    const cached = repoKeyCache.get(root);
    result.set(root, cached?.key ?? null);
    if (!cached || now - cached.at >= REPO_KEY_TTL_MS) {
      scheduleRepoKeyProbe(root);
    }
  }
  return result;
}

export async function resolveRepoKeysByRoot(
  roots: Iterable<string>,
): Promise<Map<string, string | null>> {
  const distinct = [...new Set(roots)];
  const keys = await Promise.all(distinct.map((root) => resolveRepoKeyForRoot(root)));
  return new Map(distinct.map((root, index) => [root, keys[index] ?? null]));
}
