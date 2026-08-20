import type {
  RepoDiffFile,
  RepoDiffLayer,
  RepoDiffLayerKind,
} from "./types.ts";
import type {
  RepoDiffCacheRecord,
  RepoDiffCacheRead,
} from "./cache.ts";

export const DEFAULT_LAYERS: RepoDiffLayerKind[] = ["branch", "unstaged", "staged"];

export const LAYER_LABELS: Record<RepoDiffLayerKind, string> = {
  unstaged: "Unstaged",
  staged: "Staged",
  branch: "Branch",
};

export const STATUS_GLYPH: Record<RepoDiffFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  conflict: "!",
  unknown: "?",
};

export type FetchPhase = "loading" | "ready" | "error";
export type PierrePhase = "loading" | "ready" | "error";
export type DiffLayout = "unified" | "split";

export type SnapshotFreshness = {
  fetchedAt: number;
  cacheHit: boolean;
  refreshing: boolean;
  refreshError: string | null;
};

export type SnapshotLoadOptions = {
  force?: boolean;
  preserveCurrent?: boolean;
};

export function fileDisplayPath(file: RepoDiffFile): string {
  return file.newPath ?? file.oldPath ?? "(unknown)";
}

export function splitPath(p: string): { name: string; dir: string } {
  const parts = p.split("/");
  const name = parts[parts.length - 1] || p;
  const dir = parts.slice(0, -1).join("/");
  return { name, dir };
}

export function fileKey(file: RepoDiffFile, index: number): string {
  return `${file.oldPath ?? ""}→${file.newPath ?? ""}#${index}`;
}

export function layerChurn(layer: RepoDiffLayer): { add: number; del: number } {
  return layer.files.reduce(
    (acc, f) => ({
      add: acc.add + (f.additions ?? 0),
      del: acc.del + (f.deletions ?? 0),
    }),
    { add: 0, del: 0 },
  );
}

export function freshnessFromCache(
  cached: RepoDiffCacheRead,
  refreshing: boolean,
  refreshError: string | null = null,
): SnapshotFreshness {
  return {
    fetchedAt: cached.fetchedAt,
    cacheHit: true,
    refreshing,
    refreshError,
  };
}

export function freshnessFromRecord(
  record: RepoDiffCacheRecord,
  refreshing: boolean,
): SnapshotFreshness {
  return {
    fetchedAt: record.fetchedAt,
    cacheHit: record.cacheHit,
    refreshing,
    refreshError: null,
  };
}
