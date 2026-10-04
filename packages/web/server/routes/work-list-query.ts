/** The most ids one `/api/work?ids=` read accepts; extras are dropped. */
export const MAX_WORK_LIST_IDS = 250;

const WORK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type WorkListOptions = {
  agentId?: string;
  conversationId?: string;
  ids?: string[];
  activeOnly: boolean;
  limit?: number;
};

/**
 * `GET /api/work` query → `queryWorkItems` options, or null when the answer
 * is known to be empty.
 *
 * `ids=a,b,c` is a bounded batch read of known work ids (the desktop
 * companion). It reads done work too unless `active` says otherwise, since a
 * caller tracking known ids wants their current state, whatever it is. When
 * `ids` was given but none is valid, the result is empty: dropping the
 * filter would answer with unrelated active work.
 */
export function workListOptions(query: (name: string) => string | undefined): WorkListOptions | null {
  const rawIds = (query("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const ids = rawIds.filter((id) => WORK_ID_PATTERN.test(id)).slice(0, MAX_WORK_LIST_IDS);
  if (rawIds.length > 0 && ids.length === 0) return null;
  const active = query("active");
  const rawLimit = Number(query("limit") || Number.NaN);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_WORK_LIST_IDS, Math.max(1, Math.floor(rawLimit)))
    : undefined;
  return {
    agentId: query("agentId") || undefined,
    conversationId: query("conversationId") || undefined,
    ids: ids.length > 0 ? ids : undefined,
    activeOnly: active !== undefined ? active !== "false" : ids.length === 0,
    limit: limit ?? (ids.length > 0 ? ids.length : undefined),
  };
}
