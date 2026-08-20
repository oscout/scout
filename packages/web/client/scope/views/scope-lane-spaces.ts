export type ScopeLaneSpaceOrient = "row" | "column";

export type ScopeLaneSpace = {
  ids: string[];
  orient: ScopeLaneSpaceOrient;
};

import { scopeStorageKey } from "../../../shared/scope-integration.js";

export const SCOPE_LANE_SPACES_STORAGE_KEY = scopeStorageKey("lane-spaces");
export const SCOPE_LANE_STACK_MIN = 2;
export const SCOPE_LANE_STACK_MAX_LIMIT = 6;
export const SCOPE_LANE_STACK_DEFAULT = 4;

export function coerceLaneStackMax(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return SCOPE_LANE_STACK_DEFAULT;
  return Math.min(
    SCOPE_LANE_STACK_MAX_LIMIT,
    Math.max(SCOPE_LANE_STACK_MIN, Math.round(number)),
  );
}

export function coerceLaneSpace(raw: unknown): ScopeLaneSpace {
  if (Array.isArray(raw)) {
    const ids = raw.filter((id): id is string => typeof id === "string");
    return { ids, orient: "row" };
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as ScopeLaneSpace).ids)) {
    const entry = raw as ScopeLaneSpace;
    const ids = entry.ids.filter((id): id is string => typeof id === "string");
    return { ids, orient: entry.orient === "column" ? "column" : "row" };
  }
  return { ids: [], orient: "row" };
}

export function flatLaneSpaceIds(spaces: ScopeLaneSpace[]): string[] {
  return spaces.flatMap((space) => coerceLaneSpace(space).ids);
}

export function normalizeLaneSpaces(
  spaces: ScopeLaneSpace[],
  laneIds: string[],
  stackMax = SCOPE_LANE_STACK_DEFAULT,
): ScopeLaneSpace[] {
  const known = new Set(laneIds);
  const seen = new Set<string>();
  const next: ScopeLaneSpace[] = [];

  for (const raw of spaces) {
    const space = coerceLaneSpace(raw);
    const ids = space.ids.filter((id) => known.has(id) && !seen.has(id));
    ids.forEach((id) => seen.add(id));
    if (!ids.length) continue;
    const orient = ids.length === 1 ? "row" : space.orient;
    const cap = orient === "column" ? stackMax : 4;
    next.push({ ids: ids.slice(0, cap), orient });
  }

  for (const id of laneIds) {
    if (!seen.has(id)) {
      next.push({ ids: [id], orient: "row" });
      seen.add(id);
    }
  }

  return next;
}

export function buildLaneSpaces(
  laneIds: string[],
  storedSpaces: ScopeLaneSpace[],
  stackMax = SCOPE_LANE_STACK_DEFAULT,
): ScopeLaneSpace[] {
  if (storedSpaces.length) {
    return normalizeLaneSpaces(storedSpaces, laneIds, stackMax);
  }
  return laneIds.map((id) => ({ ids: [id], orient: "row" as const }));
}

export function removeAgentFromSpaces(spaces: ScopeLaneSpace[], agentId: string): ScopeLaneSpace[] {
  return spaces
    .map((raw) => {
      const space = coerceLaneSpace(raw);
      const ids = space.ids.filter((id) => id !== agentId);
      if (!ids.length) return null;
      return { ids, orient: ids.length === 1 ? "row" as const : space.orient };
    })
    .filter((space): space is ScopeLaneSpace => space !== null);
}

export function applySpaceReorder(
  spaces: ScopeLaneSpace[],
  fromId: string,
  targetSlotIndex: number,
  before: boolean,
): ScopeLaneSpace[] {
  const next = removeAgentFromSpaces(spaces, fromId);
  const insertAt = Math.min(before ? targetSlotIndex : targetSlotIndex + 1, next.length);
  next.splice(insertAt, 0, { ids: [fromId], orient: "row" });
  return next;
}

export function applySpaceStack(
  spaces: ScopeLaneSpace[],
  fromId: string,
  targetSlotIndex: number,
  stackBand: number,
  stackMax = SCOPE_LANE_STACK_DEFAULT,
): ScopeLaneSpace[] {
  const next = removeAgentFromSpaces(spaces, fromId);
  const current = coerceLaneSpace(next[targetSlotIndex] ?? { ids: [], orient: "row" });
  const ids = [...current.ids];
  const insertAt = Math.min(Math.max(0, stackBand), ids.length);
  ids.splice(insertAt, 0, fromId);
  const stacked = ids.slice(0, stackMax);
  next[targetSlotIndex] = {
    ids: stacked,
    orient: stacked.length > 1 ? "column" : "row",
  };
  return next;
}

export function stackBandLabel(band: number, stackMax: number): string {
  if (stackMax <= 2) return band === 0 ? "stack above" : "stack below";
  if (band === 0) return "stack top";
  if (band === stackMax - 1) return "stack bottom";
  if (stackMax === 3) return "stack middle";
  if (stackMax === 4 && band === 1) return "stack upper";
  if (stackMax === 4 && band === 2) return "stack lower";
  return `stack ${band + 1}`;
}

export function readStoredLaneSpaces(): ScopeLaneSpace[] {
  try {
    const raw = sessionStorage.getItem(SCOPE_LANE_SPACES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(coerceLaneSpace).filter((space) => space.ids.length > 0);
  } catch {
    return [];
  }
}

export function writeStoredLaneSpaces(spaces: ScopeLaneSpace[]): void {
  try {
    if (!spaces.length) {
      sessionStorage.removeItem(SCOPE_LANE_SPACES_STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(SCOPE_LANE_SPACES_STORAGE_KEY, JSON.stringify(spaces));
  } catch {
    // ignore storage failures
  }
}