import { useSyncExternalStore } from "react";
import type { AgentDisplayState } from "../../lib/agent-state.ts";

/**
 * One deck lane, projected to the plain display data the lanes-mode left rail
 * needs — no model helpers required downstream. The deck publishes these in the
 * exact order it renders its columns (pinned-left → main → pinned-right), so the
 * rail is a 1:1 mirror of the strip on screen rather than a re-derived roster
 * that can drift in count/order from what the user is actually looking at.
 */
export type LaneRosterEntry = {
  /** Deck column anchor — matches the `data-lane-id` the column renders. */
  id: string;
  /** Column title (lanePrimaryLabel). */
  label: string;
  /** Hover/status text (laneStatusLabel), typically the harness. */
  statusLabel: string;
  /** Dot tone, normalized the same way the card derives its working state. */
  tone: AgentDisplayState;
  /**
   * Registered agent id for the profile fallback. Absent for native/terminal
   * lanes with no scout agent — their column is the only place to land, so a
   * missing column is a no-op rather than a broken navigate.
   */
  agentId?: string;
  /** Last substantive activity (lane.lastActiveAt) for the row's time meta. */
  updatedAt?: number;
  /** Rich floor-ledger projection — present when the floor layout publishes. */
  floor?: LaneRosterFloorEntry;
};

/** The floor's per-lane ledger row: action line + activity strip + counts. */
export type LaneRosterFloorEntry = {
  live: boolean;
  harness: string | null;
  actionGlyph: string;
  actionLabel: string;
  actionMeta: string;
  strip: Array<"tool" | "edit" | "msg">;
  countsLabel: string;
};

let roster: LaneRosterEntry[] | null = null;
const listeners = new Set<() => void>();

function floorEntriesEqual(
  a: LaneRosterFloorEntry | undefined,
  b: LaneRosterFloorEntry | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.live === b.live
    && a.harness === b.harness
    && a.actionGlyph === b.actionGlyph
    && a.actionLabel === b.actionLabel
    && a.actionMeta === b.actionMeta
    && a.countsLabel === b.countsLabel
    && a.strip.length === b.strip.length
    && a.strip.every((kind, index) => kind === b.strip[index]);
}

function entriesEqual(a: LaneRosterEntry, b: LaneRosterEntry): boolean {
  return a.id === b.id
    && a.label === b.label
    && a.statusLabel === b.statusLabel
    && a.tone === b.tone
    && a.agentId === b.agentId
    && a.updatedAt === b.updatedAt
    && floorEntriesEqual(a.floor, b.floor);
}

function rostersEqual(a: LaneRosterEntry[] | null, b: LaneRosterEntry[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.every((entry, index) => entriesEqual(entry, b[index]));
}

/**
 * Deck → rail publish. Keeps the stored reference stable when the projection is
 * unchanged so `useSyncExternalStore` neither churns nor loops; only re-emits
 * when a lane's label/tone/order/activity actually moves. Pass `null` on unmount
 * so a stale roster never lingers after the deck leaves the view.
 */
export function publishLaneRoster(next: LaneRosterEntry[] | null): void {
  if (rostersEqual(roster, next)) return;
  roster = next;
  for (const listener of listeners) listener();
}

export function subscribeLaneRoster(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLaneRosterSnapshot(): LaneRosterEntry[] | null {
  return roster;
}

/**
 * Rail hook: the deck's rendered roster, or `null` when no deck has published
 * yet (rail mounted a beat before the deck settled, or the deck has unmounted).
 */
export function useLaneRoster(): LaneRosterEntry[] | null {
  return useSyncExternalStore(subscribeLaneRoster, getLaneRosterSnapshot, getLaneRosterSnapshot);
}

/* ── Floor ↔ rail linkage ──────────────────────────────────────────────────
 * The floor is the source of truth for which lane is emphasized (hover or
 * pin); it publishes the focused lane id so rail rows can highlight, and
 * registers handlers the rail calls on row hover/select. Handlers are read at
 * event time, so mount order between rail and floor doesn't matter. */

let focusedLaneId: string | null = null;
const focusListeners = new Set<() => void>();

export function publishLaneFocusId(next: string | null): void {
  if (focusedLaneId === next) return;
  focusedLaneId = next;
  for (const listener of focusListeners) listener();
}

function subscribeLaneFocusId(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

function getLaneFocusIdSnapshot(): string | null {
  return focusedLaneId;
}

export function useLaneFocusId(): string | null {
  return useSyncExternalStore(subscribeLaneFocusId, getLaneFocusIdSnapshot, getLaneFocusIdSnapshot);
}

export type FloorLedgerHandlers = {
  onHover: (laneId: string | null) => void;
  onSelect: (laneId: string) => void;
};

let floorLedgerHandlers: FloorLedgerHandlers | null = null;

export function setFloorLedgerHandlers(next: FloorLedgerHandlers | null): void {
  floorLedgerHandlers = next;
}

export function getFloorLedgerHandlers(): FloorLedgerHandlers | null {
  return floorLedgerHandlers;
}
