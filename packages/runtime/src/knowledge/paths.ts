import { join, normalize, sep } from "node:path";

import { resolveOpenScoutSupportPaths } from "../support-paths.js";

export interface OpenScoutKnowledgePaths {
  knowledgeRoot: string;
  qmdRoot: string;
  sqlitePath: string;
}

export function resolveOpenScoutKnowledgePaths(): OpenScoutKnowledgePaths {
  const supportPaths = resolveOpenScoutSupportPaths();
  return {
    knowledgeRoot: supportPaths.knowledgeDirectory,
    qmdRoot: supportPaths.knowledgeQmdDirectory,
    sqlitePath: supportPaths.knowledgeSqlitePath,
  };
}

function safeCollectionSegments(collectionId: string): string[] {
  const segments = collectionId
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    throw new Error("collectionId must contain at least one path segment");
  }

  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.includes("\0")) {
      throw new Error(`invalid collectionId segment: ${segment}`);
    }
  }

  return segments;
}

export function knowledgeCollectionQmdPath(collectionId: string): string {
  const paths = resolveOpenScoutKnowledgePaths();
  const out = join(paths.qmdRoot, ...safeCollectionSegments(collectionId));
  const normalizedRoot = normalize(paths.qmdRoot);
  const normalizedOut = normalize(out);
  if (normalizedOut !== normalizedRoot && !normalizedOut.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`collectionId escapes QMD root: ${collectionId}`);
  }
  return out;
}
