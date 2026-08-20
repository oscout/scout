import {
  ATTENTION_LANE_DEF_ID,
  compareLaneZones,
  resolveLaneWidthPx,
  sortLaneSlots,
  type AgentLaneWidthTier,
  type LaneDeckState,
  type LaneDeckZone,
  type LaneDef,
  type LaneSlot,
} from "./lane-deck.ts";
import {
  isAgentLaneLive,
  lanePrimaryLabel,
  type AgentLane,
} from "./agent-lanes-model.ts";

export type ResolvedLaneColumn = {
  key: string;
  lane: AgentLane;
  widthPx: number;
  zone: LaneDeckZone;
  position: number;
  slotId?: string;
  laneDefId?: string;
  isPinned: boolean;
};

export type LaneDeckLayout = {
  pinnedLeft: ResolvedLaneColumn[];
  main: ResolvedLaneColumn[];
  pinnedRight: ResolvedLaneColumn[];
  flat: ResolvedLaneColumn[];
};

type LaneDeckLayoutInput = {
  autoLanes: AgentLane[];
  deck: LaneDeckState;
  defaultWidthTier: AgentLaneWidthTier;
};

function pathLeaf(value: string): string | null {
  const leaf = value.trim().replace(/\/+$/u, "").split(/[\\/]/u).filter(Boolean).pop();
  return leaf?.trim() || null;
}

function slugValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function matchesAnyFilter(candidates: Array<string | null | undefined>, filter: string | null): boolean {
  if (!filter) return true;
  const filterSlug = slugValue(filter);
  return candidates.some((candidate) => {
    const raw = candidate?.trim();
    if (!raw) return false;
    const normalized = raw.toLowerCase();
    const leaf = pathLeaf(raw);
    return normalized === filter
      || slugValue(raw) === filterSlug
      || Boolean(leaf && (leaf.toLowerCase() === filter || slugValue(leaf) === filterSlug));
  });
}

export function laneMatchesHarness(lane: AgentLane, harness: string | null | undefined): boolean {
  const filter = harness?.trim().toLowerCase() || null;
  const { agent, facts, source } = lane;
  return matchesAnyFilter(
    [agent.harness, agent.definitionId, facts?.attribution, source],
    filter,
  );
}

export function laneMatchesProject(lane: AgentLane, projectPath: string | null | undefined): boolean {
  const filter = projectPath?.trim().toLowerCase() || null;
  const { agent, facts, source } = lane;
  return matchesAnyFilter(
    [agent.project, agent.projectRoot, agent.cwd, facts?.cwd, lanePrimaryLabel(agent, source)],
    filter,
  );
}

export function laneNeedsAttention(lane: AgentLane): boolean {
  return lane.current || isAgentLaneLive(lane.observe);
}

function laneWidthFor(
  deck: LaneDeckState,
  lane: AgentLane,
  slot: LaneSlot | undefined,
  defaultWidthTier: AgentLaneWidthTier,
): number {
  return resolveLaneWidthPx(
    slot?.width ?? deck.laneWidths[lane.id],
    defaultWidthTier ?? deck.defaultLaneWidth,
  );
}

function lanesForDef(def: LaneDef, autoLanes: AgentLane[]): AgentLane[] {
  switch (def.kind) {
    case "session":
      return autoLanes.filter((lane) => lane.id === def.sessionId);
    case "harness":
      return autoLanes.filter((lane) => laneMatchesHarness(lane, def.harness));
    case "project":
      return autoLanes.filter((lane) => laneMatchesProject(lane, def.projectPath));
    case "attention":
      return autoLanes.filter((lane) => laneNeedsAttention(lane));
    default:
      return [];
  }
}

function pushColumn(
  bucket: ResolvedLaneColumn[],
  assigned: Set<string>,
  input: {
    lane: AgentLane;
    zone: LaneDeckZone;
    position: number;
    widthPx: number;
    slot?: LaneSlot;
    laneDef?: LaneDef;
  },
): void {
  if (assigned.has(input.lane.id)) return;
  assigned.add(input.lane.id);
  bucket.push({
    key: input.slot ? `${input.slot.id}:${input.lane.id}` : input.lane.id,
    lane: input.lane,
    widthPx: input.widthPx,
    zone: input.zone,
    position: input.position,
    slotId: input.slot?.id,
    laneDefId: input.laneDef?.id,
    isPinned: input.zone !== "main",
  });
}

function sortColumns(columns: ResolvedLaneColumn[]): ResolvedLaneColumn[] {
  return [...columns].sort((left, right) => {
    const zoneDelta = compareLaneZones(left.zone, right.zone);
    if (zoneDelta !== 0) return zoneDelta;
    if (left.position !== right.position) return left.position - right.position;
    return left.lane.id.localeCompare(right.lane.id);
  });
}

export function resolveLaneDeckLayout(input: LaneDeckLayoutInput): LaneDeckLayout {
  const { autoLanes, deck, defaultWidthTier } = input;
  const assigned = new Set<string>();
  const pinnedLeft: ResolvedLaneColumn[] = [];
  const main: ResolvedLaneColumn[] = [];
  const pinnedRight: ResolvedLaneColumn[] = [];
  const defById = new Map(deck.laneDefs.map((entry) => [entry.id, entry]));

  for (const slot of sortLaneSlots(deck.slots)) {
    const def = defById.get(slot.laneDefId);
    if (!def) continue;
    const matches = lanesForDef(def, autoLanes);
    const bucket = slot.zone === "pinned_left"
      ? pinnedLeft
      : slot.zone === "pinned_right"
        ? pinnedRight
        : main;
    for (const lane of matches) {
      pushColumn(bucket, assigned, {
        lane,
        zone: slot.zone,
        position: slot.position,
        widthPx: laneWidthFor(deck, lane, slot, defaultWidthTier),
        slot,
        laneDef: def,
      });
    }
  }

  if (deck.showAutoLanes) {
    let position = 0;
    for (const lane of autoLanes) {
      if (assigned.has(lane.id)) continue;
      pushColumn(main, assigned, {
        lane,
        zone: "main",
        position,
        widthPx: laneWidthFor(deck, lane, undefined, defaultWidthTier),
      });
      position += 1;
    }
  }

  const sortedPinnedLeft = sortColumns(pinnedLeft);
  const sortedMain = sortColumns(main);
  const sortedPinnedRight = sortColumns(pinnedRight);
  return {
    pinnedLeft: sortedPinnedLeft,
    main: sortedMain,
    pinnedRight: sortedPinnedRight,
    flat: [...sortedPinnedLeft, ...sortedMain, ...sortedPinnedRight],
  };
}

export function hasAttentionLane(deck: LaneDeckState): boolean {
  return deck.slots.some((slot) => slot.laneDefId === ATTENTION_LANE_DEF_ID);
}

export function hasHarnessLane(deck: LaneDeckState, harness: string): boolean {
  const id = `harness:${slugValue(harness)}`;
  return deck.slots.some((slot) => slot.laneDefId === id);
}