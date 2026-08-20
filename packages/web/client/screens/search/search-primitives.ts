import type { KnowledgeFacetValue, KnowledgeStatus } from "../../lib/knowledge-search.ts";

/**
 * Shape of `/api/knowledge/search-primitives`. Mirrors the server response
 * so the search surface can render the chip row without a parallel type.
 */
export type SearchPrimitivesResponse = {
  facets: KnowledgeFacetValue[];
  params: {
    facets: string[];
    genericFacetPrefixes: string[];
    ranges: string[];
    collections: string[];
    sourceKinds: string[];
  };
  status: KnowledgeStatus;
};
