import type { KnowledgeHit, KnowledgeStatus } from "../../lib/knowledge-search.ts";
import {
  serializeSearchFiltersToParams,
  type SearchFilters,
} from "../../lib/knowledge-search.ts";
import type { SearchPrimitivesResponse } from "./search-primitives.ts";

/**
 * Session-scoped warm-start cache for the Knowledge Search screen — the same
 * role lib/mesh-view-store.ts plays for the mesh view. A remount paints the
 * last status/results/facets instantly and skips the POST re-index when this
 * session indexed recently; the screen still refreshes status in the
 * background. Only the screen reads it, and only at mount, so no subscription
 * machinery is needed.
 */
export type KnowledgeSearchSnapshot = {
  status: KnowledgeStatus | null;
  /** Hits from the last completed search this session. */
  results: KnowledgeHit[];
  /** Filter key (query + facets + window) that `results` answer. */
  lastFilterKey: string;
  /** Facet primitives fetched once the index was ready. */
  facets: SearchPrimitivesResponse | null;
  /** When the last POST /api/knowledge/sessions/index completed (epoch ms). */
  indexedAt: number | null;
};

/**
 * How long a completed index run suppresses the mount-time incremental
 * re-index. Long enough that hopping between screens never pays the POST
 * twice, short enough that transcripts written mid-session become searchable
 * on a later visit without a manual reindex.
 */
export const KNOWLEDGE_SEARCH_REINDEX_TTL_MS = 5 * 60_000;

/** Canonical identity for "these results answer these filters". */
export function knowledgeSearchFilterKey(filters: SearchFilters): string {
  return serializeSearchFiltersToParams(filters).toString();
}

let snapshot: KnowledgeSearchSnapshot = {
  status: null,
  results: [],
  lastFilterKey: "",
  facets: null,
  indexedAt: null,
};

export function getKnowledgeSearchSnapshot(): KnowledgeSearchSnapshot {
  return snapshot;
}

export function updateKnowledgeSearchSnapshot(
  patch: Partial<KnowledgeSearchSnapshot>,
): void {
  snapshot = { ...snapshot, ...patch };
}
