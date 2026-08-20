import type { AgentLaneHorizonKey } from "./agent-lanes-model.ts";

export type LaneDeckProfileId =
  | "web.ops"
  | "macos.lanes"
  | "hud.tail"
  | "web.embed";

export type LaneDeckProfileDefaults = Pick<
  LaneDeckState,
  "defaultLaneWidth" | "showAutoLanes" | "defaultHorizon"
>;

export type AgentLaneWidthTier = "sm" | "md" | "lg";

export const AGENT_LANE_WIDTH_TIERS: Readonly<Record<AgentLaneWidthTier, number>> = {
  sm: 408,
  md: 512,
  lg: 616,
};

export const AGENT_LANE_WIDTH_MIN = 240;
export const AGENT_LANE_WIDTH_MAX = 640;
export const AGENT_LANE_WIDTH_SNAP_PX = 24;

export type LaneDeckZone = "pinned_left" | "main" | "pinned_right";

export type LaneDefKind = "session" | "harness" | "project" | "attention";

export type LaneDef = {
  id: string;
  kind: LaneDefKind;
  title: string;
  sessionId?: string;
  harness?: string;
  projectPath?: string;
};

export type LaneSlot = {
  id: string;
  laneDefId: string;
  zone: LaneDeckZone;
  position: number;
  width?: AgentLaneWidthTier | number;
};

export type LaneDeckState = {
  version: 1;
  profileId: string;
  defaultLaneWidth: AgentLaneWidthTier;
  defaultHorizon?: AgentLaneHorizonKey;
  laneWidths: Record<string, AgentLaneWidthTier | number>;
  laneDefs: LaneDef[];
  slots: LaneSlot[];
  showAutoLanes: boolean;
  updatedAt: number;
};

const LANE_DECK_STORAGE_PREFIX = "openscout:lane-deck:v1";
const LANE_DECK_PROFILE_SET = new Set<LaneDeckProfileId>([
  "web.ops",
  "macos.lanes",
  "hud.tail",
  "web.embed",
]);
const LANE_WIDTH_TIER_SET = new Set<AgentLaneWidthTier>(["sm", "md", "lg"]);
const LANE_ZONE_ORDER: LaneDeckZone[] = ["pinned_left", "main", "pinned_right"];

const SCOUT_PROFILE_DEFAULTS: Record<LaneDeckProfileId, LaneDeckProfileDefaults> = {
  "web.ops": { defaultLaneWidth: "lg", showAutoLanes: true },
  "macos.lanes": { defaultLaneWidth: "md", showAutoLanes: true },
  "hud.tail": { defaultLaneWidth: "sm", showAutoLanes: true, defaultHorizon: "30m" },
  "web.embed": { defaultLaneWidth: "md", showAutoLanes: true },
};

const FALLBACK_PROFILE_DEFAULTS: LaneDeckProfileDefaults = SCOUT_PROFILE_DEFAULTS["web.ops"];

function resolveProfileDefaults(profileId: string): LaneDeckProfileDefaults {
  if (isLaneDeckProfileId(profileId)) return SCOUT_PROFILE_DEFAULTS[profileId];
  return FALLBACK_PROFILE_DEFAULTS;
}

const ZONE_RANK: Record<LaneDeckZone, number> = {
  pinned_left: 0,
  main: 1,
  pinned_right: 2,
};

export function isLaneDeckProfileId(value: string): value is LaneDeckProfileId {
  return LANE_DECK_PROFILE_SET.has(value as LaneDeckProfileId);
}

/** Infer deck profile from URL hints (embed, ops paths, ?profile=). Callers with a
 *  known profile (e.g. instrument lanes) should pass `profileId` explicitly. */
export function readLaneDeckProfileId(search = window.location.search, pathname = window.location.pathname): LaneDeckProfileId {
  const params = new URLSearchParams(search);
  const rawProfile = params.get("profile")?.trim().toLowerCase();
  if (rawProfile && isLaneDeckProfileId(rawProfile)) return rawProfile;

  const embed = params.get("embed")?.trim().toLowerCase();
  if (embed === "hud") return "hud.tail";
  if (embed === "app") return "macos.lanes";

  if (pathname.includes("/lanes/embed")) return "web.embed";
  if (pathname.includes("/ops/lanes")) return "web.ops";
  return "web.ops";
}

export function readDefaultLaneWidthTier(search = window.location.search): AgentLaneWidthTier {
  const params = new URLSearchParams(search);
  const raw = (params.get("lanes") ?? params.get("size"))?.trim().toLowerCase();
  if (raw && LANE_WIDTH_TIER_SET.has(raw as AgentLaneWidthTier)) {
    return raw as AgentLaneWidthTier;
  }
  return "lg";
}

export function resolveLaneWidthPx(
  width: AgentLaneWidthTier | number | undefined,
  fallback: AgentLaneWidthTier,
): number {
  if (typeof width === "number" && Number.isFinite(width)) {
    return Math.min(AGENT_LANE_WIDTH_MAX, Math.max(AGENT_LANE_WIDTH_MIN, Math.round(width)));
  }
  const tier = typeof width === "string" && LANE_WIDTH_TIER_SET.has(width) ? width : fallback;
  return AGENT_LANE_WIDTH_TIERS[tier];
}

export function snapLaneWidthPx(px: number): { px: number; tier: AgentLaneWidthTier | null } {
  const clamped = Math.min(AGENT_LANE_WIDTH_MAX, Math.max(AGENT_LANE_WIDTH_MIN, Math.round(px)));
  let closest: AgentLaneWidthTier | null = null;
  let minDistance = Number.POSITIVE_INFINITY;
  for (const [tier, value] of Object.entries(AGENT_LANE_WIDTH_TIERS) as Array<[AgentLaneWidthTier, number]>) {
    const distance = Math.abs(value - clamped);
    if (distance < minDistance) {
      minDistance = distance;
      closest = tier;
    }
  }
  if (closest && minDistance <= AGENT_LANE_WIDTH_SNAP_PX) {
    return { px: AGENT_LANE_WIDTH_TIERS[closest], tier: closest };
  }
  return { px: clamped, tier: null };
}

export function widthTierLabel(width: AgentLaneWidthTier | number | undefined, fallback: AgentLaneWidthTier): string {
  if (typeof width === "number" && Number.isFinite(width)) return `${Math.round(width)}px`;
  const tier = typeof width === "string" && LANE_WIDTH_TIER_SET.has(width) ? width : fallback;
  return tier.toUpperCase();
}

/** Create a lane deck with explicit defaults — generic primitive for dependents. */
export function createLaneDeck(
  profileId: string,
  defaultLaneWidth: AgentLaneWidthTier | undefined,
  defaults: LaneDeckProfileDefaults,
): LaneDeckState {
  return {
    version: 1,
    profileId,
    defaultLaneWidth: defaultLaneWidth ?? defaults.defaultLaneWidth,
    defaultHorizon: defaults.defaultHorizon,
    laneWidths: {},
    laneDefs: [],
    slots: [],
    showAutoLanes: defaults.showAutoLanes,
    updatedAt: Date.now(),
  };
}

export function createDefaultLaneDeck(
  profileId: string,
  defaultLaneWidth?: AgentLaneWidthTier,
): LaneDeckState {
  const defaults = resolveProfileDefaults(profileId);
  return createLaneDeck(profileId, defaultLaneWidth, defaults);
}

function normalizeLaneWidth(value: unknown): AgentLaneWidthTier | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && LANE_WIDTH_TIER_SET.has(value as AgentLaneWidthTier)) {
    return value as AgentLaneWidthTier;
  }
  return undefined;
}

function normalizeLaneDef(raw: unknown): LaneDef | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<LaneDef>;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  if (value.kind !== "session" && value.kind !== "harness" && value.kind !== "project" && value.kind !== "attention") {
    return null;
  }
  if (typeof value.title !== "string" || !value.title.trim()) return null;
  return {
    id: value.id.trim(),
    kind: value.kind,
    title: value.title.trim(),
    sessionId: typeof value.sessionId === "string" ? value.sessionId.trim() : undefined,
    harness: typeof value.harness === "string" ? value.harness.trim() : undefined,
    projectPath: typeof value.projectPath === "string" ? value.projectPath.trim() : undefined,
  };
}

function normalizeLaneSlot(raw: unknown): LaneSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<LaneSlot>;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  if (typeof value.laneDefId !== "string" || !value.laneDefId.trim()) return null;
  if (value.zone !== "pinned_left" && value.zone !== "main" && value.zone !== "pinned_right") return null;
  if (typeof value.position !== "number" || !Number.isFinite(value.position)) return null;
  return {
    id: value.id.trim(),
    laneDefId: value.laneDefId.trim(),
    zone: value.zone,
    position: value.position,
    width: normalizeLaneWidth(value.width),
  };
}

/** Deserialize persisted lane-deck JSON with explicit defaults — generic primitive. */
export function deserializeLaneDeck(
  raw: unknown,
  profileId: string,
  fallbackWidth: AgentLaneWidthTier,
  defaults: LaneDeckProfileDefaults,
): LaneDeckState {
  if (!raw || typeof raw !== "object") {
    return createLaneDeck(profileId, fallbackWidth, defaults);
  }
  const value = raw as Partial<LaneDeckState>;
  const laneDefs = Array.isArray(value.laneDefs)
    ? value.laneDefs.map(normalizeLaneDef).filter((entry): entry is LaneDef => entry !== null)
    : [];
  const slots = Array.isArray(value.slots)
    ? value.slots.map(normalizeLaneSlot).filter((entry): entry is LaneSlot => entry !== null)
    : [];
  const laneWidths: Record<string, AgentLaneWidthTier | number> = {};
  if (value.laneWidths && typeof value.laneWidths === "object") {
    for (const [laneId, width] of Object.entries(value.laneWidths)) {
      const normalized = normalizeLaneWidth(width);
      if (normalized !== undefined) laneWidths[laneId] = normalized;
    }
  }
  const defaultLaneWidth = normalizeLaneWidth(value.defaultLaneWidth) as AgentLaneWidthTier | undefined;
  return {
    version: 1,
    profileId,
    defaultLaneWidth: (typeof defaultLaneWidth === "string" ? defaultLaneWidth : undefined)
      ?? fallbackWidth
      ?? defaults.defaultLaneWidth,
    defaultHorizon: typeof value.defaultHorizon === "string" ? value.defaultHorizon as AgentLaneHorizonKey : defaults.defaultHorizon,
    laneWidths,
    laneDefs,
    slots,
    showAutoLanes: typeof value.showAutoLanes === "boolean" ? value.showAutoLanes : defaults.showAutoLanes,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
  };
}

function normalizeDeck(
  raw: unknown,
  profileId: string,
  fallbackWidth: AgentLaneWidthTier,
): LaneDeckState {
  return deserializeLaneDeck(raw, profileId, fallbackWidth, resolveProfileDefaults(profileId));
}

export function loadLaneDeck(
  profileId: string,
  fallbackWidth?: AgentLaneWidthTier,
): LaneDeckState {
  const defaults = resolveProfileDefaults(profileId);
  const widthFallback = fallbackWidth ?? defaults.defaultLaneWidth;
  try {
    const raw = localStorage.getItem(`${LANE_DECK_STORAGE_PREFIX}:${profileId}`);
    if (!raw) return createDefaultLaneDeck(profileId, widthFallback);
    return normalizeDeck(JSON.parse(raw), profileId, widthFallback);
  } catch {
    return createDefaultLaneDeck(profileId, widthFallback);
  }
}

export function saveLaneDeck(deck: LaneDeckState): void {
  try {
    localStorage.setItem(
      `${LANE_DECK_STORAGE_PREFIX}:${deck.profileId}`,
      JSON.stringify({ ...deck, updatedAt: Date.now() }),
    );
  } catch {
    // ignore storage failures
  }
}

export function sortLaneSlots(slots: LaneSlot[]): LaneSlot[] {
  return [...slots].sort((left, right) => {
    const zoneDelta = ZONE_RANK[left.zone] - ZONE_RANK[right.zone];
    if (zoneDelta !== 0) return zoneDelta;
    return left.position - right.position;
  });
}

export function compareLaneZones(left: LaneDeckZone, right: LaneDeckZone): number {
  return ZONE_RANK[left] - ZONE_RANK[right];
}

export function laneZoneLabel(zone: LaneDeckZone): string {
  switch (zone) {
    case "pinned_left":
      return "Pinned";
    case "pinned_right":
      return "Pinned right";
    default:
      return "Main";
  }
}

export function createSlotId(): string {
  return `slot:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function slugValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function laneDefIdForSession(laneId: string): string {
  return `session:${laneId}`;
}

export function laneDefIdForHarness(harness: string): string {
  return `harness:${slugValue(harness)}`;
}

export function laneDefIdForProject(projectPath: string): string {
  return `project:${slugValue(projectPath)}`;
}

export const ATTENTION_LANE_DEF_ID = "attention:needs-input";

export function nextLaneSlotPosition(slots: LaneSlot[], zone: LaneDeckZone): number {
  const zoneSlots = slots.filter((slot) => slot.zone === zone);
  if (zoneSlots.length === 0) return 0;
  return Math.max(...zoneSlots.map((slot) => slot.position)) + 1;
}

export function upsertLaneDef(deck: LaneDeckState, laneDef: LaneDef): LaneDeckState {
  const existing = deck.laneDefs.some((entry) => entry.id === laneDef.id);
  return {
    ...deck,
    laneDefs: existing
      ? deck.laneDefs.map((entry) => (entry.id === laneDef.id ? laneDef : entry))
      : [...deck.laneDefs, laneDef],
  };
}

export function upsertLaneSlot(deck: LaneDeckState, slot: LaneSlot): LaneDeckState {
  const existing = deck.slots.some((entry) => entry.id === slot.id);
  return {
    ...deck,
    slots: existing
      ? deck.slots.map((entry) => (entry.id === slot.id ? slot : entry))
      : [...deck.slots, slot],
  };
}

export function removeLaneSlotsForDef(deck: LaneDeckState, laneDefId: string): LaneDeckState {
  return {
    ...deck,
    slots: deck.slots.filter((slot) => slot.laneDefId !== laneDefId),
  };
}

export function removeSessionPin(deck: LaneDeckState, laneId: string): LaneDeckState {
  const laneDefId = laneDefIdForSession(laneId);
  return {
    ...removeLaneSlotsForDef(deck, laneDefId),
    laneDefs: deck.laneDefs.filter((entry) => entry.id !== laneDefId),
  };
}

export function isLanePinned(deck: LaneDeckState, laneId: string): boolean {
  const laneDefId = laneDefIdForSession(laneId);
  return deck.slots.some((slot) => slot.laneDefId === laneDefId && slot.zone !== "main");
}

export function lanePinnedZone(deck: LaneDeckState, laneId: string): LaneDeckZone | null {
  const laneDefId = laneDefIdForSession(laneId);
  const slot = deck.slots.find((entry) => entry.laneDefId === laneDefId);
  if (!slot || slot.zone === "main") return null;
  return slot.zone;
}

export function pinSessionLane(
  deck: LaneDeckState,
  input: { laneId: string; title: string; zone?: LaneDeckZone; width?: AgentLaneWidthTier | number },
): LaneDeckState {
  const zone = input.zone ?? "pinned_left";
  const laneDefId = laneDefIdForSession(input.laneId);
  const withoutExisting = removeSessionPin(deck, input.laneId);
  const withDef = upsertLaneDef(withoutExisting, {
    id: laneDefId,
    kind: "session",
    title: input.title,
    sessionId: input.laneId,
  });
  return upsertLaneSlot(withDef, {
    id: createSlotId(),
    laneDefId,
    zone,
    position: nextLaneSlotPosition(withDef.slots, zone),
    width: input.width,
  });
}

export function addFilterLane(
  deck: LaneDeckState,
  input: {
    kind: Exclude<LaneDefKind, "session">;
    title: string;
    harness?: string;
    projectPath?: string;
    zone?: LaneDeckZone;
    width?: AgentLaneWidthTier | number;
  },
): LaneDeckState {
  const zone = input.zone ?? "pinned_left";
  const laneDefId = input.kind === "attention"
    ? ATTENTION_LANE_DEF_ID
    : input.kind === "harness" && input.harness
      ? laneDefIdForHarness(input.harness)
      : input.kind === "project" && input.projectPath
        ? laneDefIdForProject(input.projectPath)
        : `${input.kind}:${slugValue(input.title)}`;
  const withoutExisting = removeLaneSlotsForDef(deck, laneDefId);
  const withDef = upsertLaneDef(withoutExisting, {
    id: laneDefId,
    kind: input.kind,
    title: input.title,
    harness: input.harness,
    projectPath: input.projectPath,
  });
  return upsertLaneSlot(withDef, {
    id: createSlotId(),
    laneDefId,
    zone,
    position: nextLaneSlotPosition(withDef.slots, zone),
    width: input.width,
  });
}

export function setLaneWidthOverride(
  deck: LaneDeckState,
  laneId: string,
  width: AgentLaneWidthTier | number,
): LaneDeckState {
  return {
    ...deck,
    laneWidths: {
      ...deck.laneWidths,
      [laneId]: width,
    },
    updatedAt: Date.now(),
  };
}

export function setDefaultLaneWidth(
  deck: LaneDeckState,
  width: AgentLaneWidthTier,
): LaneDeckState {
  return {
    ...deck,
    defaultLaneWidth: width,
    updatedAt: Date.now(),
  };
}

export function clearPinnedLanes(deck: LaneDeckState): LaneDeckState {
  const pinnedDefIds = new Set(
    deck.slots
      .filter((slot) => slot.zone !== "main")
      .map((slot) => slot.laneDefId),
  );
  return {
    ...deck,
    slots: deck.slots.filter((slot) => slot.zone === "main"),
    laneDefs: deck.laneDefs.filter((entry) => !pinnedDefIds.has(entry.id)),
  };
}

export function laneDeckZones(): LaneDeckZone[] {
  return [...LANE_ZONE_ORDER];
}