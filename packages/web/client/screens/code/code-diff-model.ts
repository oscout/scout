import type {
  RepoDiffLayer,
  RepoDiffLayerKind,
} from "../../scout/repo-diff/types.ts";

export const FILE_DIFF_LAYERS: RepoDiffLayerKind[] = ["unstaged", "staged", "branch"];

function pathParts(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts;
}

/** Return a safe repo-relative path only when `file` is strictly inside root. */
export function relativeFilePath(root: string, file: string): string | null {
  const rootParts = pathParts(root);
  const fileParts = pathParts(file);
  if (!rootParts || !fileParts || fileParts.length <= rootParts.length) return null;
  if (rootParts.some((segment, index) => fileParts[index] !== segment)) return null;
  return fileParts.slice(rootParts.length).join("/");
}

/** Exact identity check for a path-filtered layer. Never fall back to files[0]. */
export function diffFileIndex(layer: RepoDiffLayer, relativePath: string): number {
  return layer.files.findIndex(
    (file) => file.newPath === relativePath || file.oldPath === relativePath,
  );
}

export function firstChangedLayer(
  layers: readonly RepoDiffLayer[],
  relativePath: string,
): RepoDiffLayerKind | null {
  return layers.find((layer) => diffFileIndex(layer, relativePath) >= 0)?.kind ?? null;
}
