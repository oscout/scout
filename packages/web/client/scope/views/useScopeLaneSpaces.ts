import { useCallback, useEffect, useMemo, useState } from "react";

import type { ResolvedLaneColumn } from "../../screens/ops/lane-deck-layout.ts";
import {
  applySpaceReorder,
  applySpaceStack,
  buildLaneSpaces,
  coerceLaneStackMax,
  readStoredLaneSpaces,
  type ScopeLaneSpace,
  SCOPE_LANE_STACK_DEFAULT,
  writeStoredLaneSpaces,
} from "./scope-lane-spaces.ts";

export function useScopeLaneSpaces(columns: ResolvedLaneColumn[], stackMax = SCOPE_LANE_STACK_DEFAULT) {
  const laneIds = useMemo(() => columns.map((column) => column.lane.id), [columns]);
  const columnById = useMemo(
    () => new Map(columns.map((column) => [column.lane.id, column])),
    [columns],
  );

  const [storedSpaces, setStoredSpaces] = useState<ScopeLaneSpace[]>(() => readStoredLaneSpaces());
  const [manualLayout, setManualLayout] = useState(() => storedSpaces.length > 0);

  const spaces = useMemo(
    () => (manualLayout
      ? buildLaneSpaces(laneIds, storedSpaces, stackMax)
      : buildLaneSpaces(laneIds, [], stackMax)),
    [laneIds, manualLayout, stackMax, storedSpaces],
  );

  useEffect(() => {
    if (!manualLayout) return;
    writeStoredLaneSpaces(spaces);
  }, [manualLayout, spaces]);

  const commitSpaces = useCallback((next: ScopeLaneSpace[]) => {
    setManualLayout(true);
    setStoredSpaces(next);
  }, []);

  const reorderLane = useCallback((fromId: string, targetSlotIndex: number, before: boolean) => {
    commitSpaces(applySpaceReorder(spaces, fromId, targetSlotIndex, before));
  }, [commitSpaces, spaces]);

  const stackLane = useCallback((
    fromId: string,
    targetSlotIndex: number,
    stackBand: number,
    max = stackMax,
  ) => {
    commitSpaces(applySpaceStack(spaces, fromId, targetSlotIndex, stackBand, max));
  }, [commitSpaces, spaces, stackMax]);

  const resolvedSpaces = useMemo(
    () => spaces.map((space) => ({
      space,
      columns: space.ids
        .map((id) => columnById.get(id))
        .filter((column): column is ResolvedLaneColumn => column !== undefined),
    })).filter((entry) => entry.columns.length > 0),
    [columnById, spaces],
  );

  const flatColumns = useMemo(
    () => resolvedSpaces.flatMap((entry) => entry.columns),
    [resolvedSpaces],
  );

  return {
    spaces,
    resolvedSpaces,
    flatColumns,
    reorderLane,
    stackLane,
    stackMax: coerceLaneStackMax(stackMax),
  };
}