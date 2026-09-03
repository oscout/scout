import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export const DEFAULT_RELAY_AGENT_REGISTRY_HASH_BACKSTOP_MS = 60_000;

type RegistryFileMetadata = {
  dev?: number | bigint;
  ino?: number | bigint;
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs?: number | bigint;
};

type RelayAgentRegistrySignatureReaderOptions = {
  resolvePath: () => string;
  statFile?: (filePath: string) => Promise<RegistryFileMetadata>;
  readFileContents?: (filePath: string) => Promise<Uint8Array>;
  hashContents?: (contents: Uint8Array) => string;
  now?: () => number;
  hashBackstopMs?: number;
};

type CachedRegistrySignature =
  | {
    kind: "file";
    filePath: string;
    metadataIdentity: string;
    signature: string;
    hashedAtMs: number;
  }
  | {
    kind: "missing";
    filePath: string;
  };

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "ENOENT",
  );
}

function metadataIdentity(info: RegistryFileMetadata): string {
  // inode/device catch atomic replacements even when a writer preserves size
  // and timestamps. ctime is an additional guard for same-inode rewrites that
  // restore mtime, while the periodic content hash below covers coarse clocks.
  return [info.dev ?? "", info.ino ?? "", info.size, info.mtimeMs, info.ctimeMs ?? ""]
    .map(String)
    .join(":");
}

/**
 * Build the opaque signature consumed by BrokerLocalAgentSyncService.
 *
 * The registry is polled frequently, but normally changes rarely. A stat-only
 * metadata identity is therefore the fast path. Content is still hashed when
 * metadata changes and periodically as a correctness backstop for same-size
 * rewrites on filesystems with coarse timestamps.
 */
export function createRelayAgentRegistrySignatureReader(
  options: RelayAgentRegistrySignatureReaderOptions,
): () => Promise<string | null> {
  const statFile = options.statFile ?? ((filePath: string) => stat(filePath));
  const readFileContents = options.readFileContents ?? ((filePath: string) => readFile(filePath));
  const hashContents = options.hashContents
    ?? ((contents: Uint8Array) => createHash("sha256").update(contents).digest("base64url"));
  const now = options.now ?? Date.now;
  const hashBackstopMs = Math.max(
    0,
    options.hashBackstopMs ?? DEFAULT_RELAY_AGENT_REGISTRY_HASH_BACKSTOP_MS,
  );
  let cached: CachedRegistrySignature | null = null;

  return async (): Promise<string | null> => {
    const filePath = options.resolvePath();
    let info: RegistryFileMetadata;
    try {
      info = await statFile(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      cached = { kind: "missing", filePath };
      return null;
    }

    const identity = metadataIdentity(info);
    const checkedAtMs = now();
    const matchingCache = cached?.kind === "file"
      && cached.filePath === filePath
      && cached.metadataIdentity === identity
      ? cached
      : null;
    const backstopDue = matchingCache !== null
      && (
        checkedAtMs < matchingCache.hashedAtMs
        || checkedAtMs - matchingCache.hashedAtMs >= hashBackstopMs
      );

    if (matchingCache && !backstopDue) {
      return matchingCache.signature;
    }

    let contents: Uint8Array;
    try {
      contents = await readFileContents(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      cached = { kind: "missing", filePath };
      return null;
    }

    const hash = hashContents(contents);
    // BrokerLocalAgentSyncService compares this value across polls. Metadata
    // belongs only to the cache identity above: an atomic rewrite of identical
    // JSON must not look like a registry change and trigger a full fleet sync.
    const signature = `content-v1:${info.size}:${hash}`;
    cached = {
      kind: "file",
      filePath,
      metadataIdentity: identity,
      signature,
      hashedAtMs: checkedAtMs,
    };
    return signature;
  };
}
