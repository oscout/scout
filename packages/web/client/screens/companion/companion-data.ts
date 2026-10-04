/**
 * The companion page's reads and the bookkeeping around them, kept out of the
 * component so they can be tested without a DOM. `fetcher` defaults to the
 * app's `api()`; tests pass their own.
 */

import { api } from "../../lib/api.ts";
import { COMPANION_MAX_PINS, isCompanionId, type CompanionMode, type CompanionPin } from "../../lib/companion-host.ts";
import type { AgentObservePayload, FollowTarget, WorkDetail, WorkItem } from "../../lib/types.ts";
import { MAX_VISIBLE_CARDS, sessionHistory, type CompanionLine } from "./companion-model.ts";

export type Fetcher = <T>(path: string) => Promise<T>;

export type PinSnapshot =
  | { status: "loading" }
  | { status: "ready"; detail: WorkDetail; harnessSessionId: string | null; history: CompanionLine[] }
  | { status: "missing"; reason: string };

export const EXPANDED_STORAGE_KEY = "scout:companion:expanded:v1";
/** Ids per summary request, so a 200-pin read keeps its URLs short. */
export const SUMMARY_BATCH = 100;

/** `/embed/companion?workIds=a,b` — a read-only browser preview when no Mac host is attached. */
export function previewPins(workIds: string | undefined): CompanionPin[] {
  return (workIds ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(isCompanionId)
    .slice(0, COMPANION_MAX_PINS)
    .map((workId) => ({ workId }));
}

/** The list-row reads for a known set of work ids, at most SUMMARY_BATCH per URL. */
export function summaryPaths(ids: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < ids.length; index += SUMMARY_BATCH) {
    const batch = ids.slice(index, index + SUMMARY_BATCH);
    paths.push(`/api/work?active=false&limit=${batch.length}&ids=${batch.map(encodeURIComponent).join(",")}`);
  }
  return paths;
}

/** One bounded read for a known set of work ids: list rows, no timeline. */
export async function loadSummaries(ids: readonly string[], fetcher: Fetcher = api): Promise<WorkItem[]> {
  const results = await Promise.all(summaryPaths(ids).map((path) => fetcher<WorkItem[]>(path)));
  return results.flat();
}

/** Which pins get full detail: the stack's top cards, or on the edge the
 *  figure being looked at plus the first few. */
export function detailIdsFor(ids: readonly string[], mode: CompanionMode, selected: string | null): string[] {
  const base = ids.slice(0, MAX_VISIBLE_CARDS);
  if (mode !== "edge" || !selected || !ids.includes(selected) || base.includes(selected)) return base;
  return [...base, selected];
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readExpanded(storage: StorageLike | null = defaultStorage()): Set<string> {
  try {
    const raw = storage?.getItem(EXPANDED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter(isCompanionId) : []);
  } catch {
    return new Set();
  }
}

export function writeExpanded(ids: ReadonlySet<string>, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Expansion is a per-viewer convenience; losing it is harmless.
  }
}

/** The `/api/follow` query for a work item — the same ids the work page's tail link uses. */
export function followQuery(detail: WorkDetail): string | null {
  const ask = detail.primaryInvocation;
  const ids: Record<string, string | null | undefined> = {
    workId: detail.id,
    flightId: ask?.flightId,
    invocationId: ask?.invocationId,
    conversationId: ask?.conversationId ?? detail.conversationId,
    sessionId: ask?.resolvedSessionId ?? ask?.targetSessionId,
    targetAgentId: ask?.targetAgentId ?? detail.ownerId,
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(ids)) if (value) params.set(key, value);
  // A bare workId resolves no session; skip the round trip.
  return [...params.keys()].length > 1 ? params.toString() : null;
}

/** The work id a cached follow query belongs to, for pruning. */
export function followQueryWorkId(query: string): string | null {
  return new URLSearchParams(query).get("workId");
}

/**
 * Full detail for one pin: the work, its harness session (cached once
 * resolved), and the session's recent history. A 404 is "missing", not a
 * failure; any other detail error is thrown so the caller can mark it stale.
 */
export async function loadPin(
  workId: string,
  followCache: Map<string, string | null>,
  fetcher: Fetcher = api,
): Promise<PinSnapshot> {
  let detail: WorkDetail;
  try {
    detail = await fetcher<WorkDetail>(`/api/work/${encodeURIComponent(workId)}`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/404|not found/i.test(message)) return { status: "missing", reason: "This work item is not on this broker." };
    throw cause;
  }
  const query = followQuery(detail);
  let harnessSessionId: string | null = null;
  if (query) {
    if (followCache.has(query)) {
      harnessSessionId = followCache.get(query) ?? null;
    } else {
      try {
        const target = await fetcher<FollowTarget>(`/api/follow?${query}`);
        harnessSessionId = target.harnessSessionId?.trim() || null;
      } catch {
        harnessSessionId = null;
      }
      // Only a resolved session is cached; an unresolved one is asked again.
      if (harnessSessionId) followCache.set(query, harnessSessionId);
    }
  }
  let history: CompanionLine[] = [];
  const ref = detail.primaryInvocation?.resolvedSessionId ?? detail.primaryInvocation?.targetSessionId ?? harnessSessionId;
  if (ref) {
    try {
      const result = await fetcher<{ observe?: AgentObservePayload }>(`/api/session-ref/${encodeURIComponent(ref)}`);
      if (result.observe?.sessionId && (!harnessSessionId || result.observe.sessionId === harnessSessionId)) {
        harnessSessionId = result.observe.sessionId;
        history = sessionHistory(result.observe);
      }
    } catch {
      // The live tail remains usable when historical observation is unavailable.
    }
  }
  return { status: "ready", detail, harnessSessionId, history };
}

/**
 * The surfacing rows per agent after one round of agent reads. A read that
 * failed keeps that agent's last good rows; agents no longer read are
 * dropped, so the set never grows past the agents being read.
 */
export function mergeSurfaceRows(
  previous: ReadonlyMap<string, readonly WorkItem[]>,
  results: readonly { agentId: string; rows: readonly WorkItem[] | null }[],
): Map<string, WorkItem[]> {
  const next = new Map<string, WorkItem[]>();
  for (const { agentId, rows } of results) {
    const kept = rows ?? previous.get(agentId);
    if (kept) next.set(agentId, [...kept]);
  }
  return next;
}

/** Drop keys not in `keep`, in place. Returns whether anything was removed. */
export function pruneKeys(target: Map<string, unknown> | Set<string>, keep: ReadonlySet<string>): boolean {
  let removed = false;
  for (const key of [...target.keys()]) {
    if (keep.has(key)) continue;
    target.delete(key);
    removed = true;
  }
  return removed;
}
