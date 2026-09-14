/**
 * Pure geometry and grammar for the Replay outpost.
 *
 * No imports, by design. The sibling `.tsx` pulls in React and
 * `agent-adventures-model.ts`, which reaches `lib/observe.ts` and takes bun
 * test's loader down with it. Everything here is structural, so the rules that
 * actually broke in practice — the agent running on the spot, walking off the
 * edge of the painting, facing backwards after a scrub — stay testable.
 */

export type ReplayKind =
  | "start" | "think" | "read" | "edit" | "tool" | "message" | "wait" | "end" | "stopped";

/** Named for what the painting holds at that point, not for a place we invented. */
export type ReplayDistrict = "domes" | "biodome" | "hangar";

export type ReplayViewport = { stageWidth: number; panoramaWidth: number };

export type SpritePhase = "travel" | "land" | "work";
export type SpriteAction = "run" | "jump" | "land" | "idle";

/**
 * What the agent is doing, in the words a reader of a trace would use.
 *
 * The live model labels these as places — Trailhead, Field library, Tool shed.
 * That asks the reader to translate "Tool shed" back into "ran a command" on
 * every row. The world carries the play; the labels carry the work.
 */
export const ACTIVITY: Record<ReplayKind, string> = {
  start: "Starting",
  think: "Thinking",
  read: "Reading",
  edit: "Editing",
  tool: "Running",
  message: "Handing off",
  wait: "Waiting",
  end: "Turn complete",
  stopped: "Interrupted",
};

/** Fractions across the panorama: habitat domes, biodome, machine hangar. */
export const DISTRICT_ANCHOR: Record<ReplayDistrict, number> = {
  domes: 0.16,
  biodome: 0.46,
  hangar: 0.84,
};

export const DISTRICT_OF: Record<ReplayKind, ReplayDistrict> = {
  start: "domes",
  end: "domes",
  stopped: "domes",
  wait: "domes",
  message: "domes",
  think: "biodome",
  read: "biodome",
  edit: "hangar",
  tool: "hangar",
};

/** Native size of `adventure-habitats-v1.png`. */
export const PANORAMA_RATIO = 2172 / 724;
/**
 * Where the agent stands, and where the painting is cut.
 *
 * Measured off the plate rather than eyeballed: the graded road runs source
 * y 443-507 of 724, and y=507 is the strongest horizontal edge in the whole
 * image — the cut, below which everything is already subsurface.
 */
export const ROAD_TOP_FRACTION = 443 / 724;
export const CUT_FRACTION = 507 / 724;
export const STANDING_FRACTION = 491 / 724;

export const SPRITE_SIZE = 150;
/** Spread of successive stops inside one district. */
export const GROUND_SPREAD = 70;
/** Pixels per millisecond. Ground speed is what must stay constant, not travel time. */
export const GROUND_SPEED = 0.9;
export const TRAVEL_MS_MIN = 110;
export const TRAVEL_MS_MAX = 900;

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * The camera anchors to the DISTRICT, never to the agent.
 *
 * Tracking the agent cancels his motion exactly — at `stageWidth / 2 - worldX`
 * the on-screen position is always the middle of the stage, so he runs on the
 * spot and only the painting moves. That is the same failure as pinning him
 * there deliberately, and it is what the original view did.
 */
export function cameraFor(district: ReplayDistrict, view: ReplayViewport): number {
  const anchor = DISTRICT_ANCHOR[district] * view.panoramaWidth;
  return clamp(view.stageWidth / 2 - anchor, Math.min(0, view.stageWidth - view.panoramaWidth), 0);
}

/**
 * Ground positions for a run, in panorama coordinates.
 *
 * Successive visits to a district walk back and forth across it so two stops in
 * a row can never share a footprint — a hashed offset collides often enough to
 * leave the agent standing still through a beat he is supposed to be running.
 * Positions are then clamped so the sprite never leaves the stage.
 */
export function layoutGround(kinds: readonly ReplayKind[], view: ReplayViewport): number[] {
  const visits = new Map<ReplayDistrict, number>();
  const half = SPRITE_SIZE / 2;
  return kinds.map((kind) => {
    const district = DISTRICT_OF[kind];
    const visit = (visits.get(district) ?? 0) + 1;
    visits.set(district, visit);
    const camera = cameraFor(district, view);
    const centre = DISTRICT_ANCHOR[district] * view.panoramaWidth;
    const spread = ((visit % 5) - 2) * GROUND_SPREAD;
    return clamp(centre + spread, half - camera, view.stageWidth - half - camera);
  });
}

/** Where a ground position lands on the stage, once the camera is applied. */
export function screenX(worldX: number, district: ReplayDistrict, view: ReplayViewport): number {
  return worldX + cameraFor(district, view);
}

/**
 * Distance sets the travel clock.
 *
 * A fixed duration makes a 70px step and a 760px sprint take the same time, so
 * the run cycle — which plays at a fixed frame rate — skates through one and
 * crawls through the other.
 */
export function travelMs(fromX: number, toX: number, speed: number): number {
  const distance = Math.abs(toX - fromX);
  return clamp(distance / GROUND_SPEED, TRAVEL_MS_MIN, TRAVEL_MS_MAX) / Math.max(0.25, speed);
}

/**
 * Which way he is pointed, from where he ACTUALLY is.
 *
 * Deriving this from the preceding stop instead describes a move he never made
 * whenever the ridge is scrubbed across several stops, and he sprints one way
 * while facing the other.
 */
export function facesLeft(fromX: number, toX: number): boolean {
  return toX < fromX;
}

/** A stop is two beats: travel to it, then work at it. */
export function spriteAction(phase: SpritePhase, checkpoint: boolean): SpriteAction {
  if (phase === "travel") return checkpoint ? "jump" : "run";
  if (phase === "land") return "land";
  return "idle";
}

/** Bar height on the ridge: how much of the run this stop actually was. */
export function ridgeWeight(input: { checkpoint: boolean; routine: boolean }): number {
  if (input.checkpoint) return 1;
  return input.routine ? 0.32 : 0.64;
}

/* ---------------------------------------------------------------------------
 * Bubbles
 *
 * Two of the nine kinds are not facts about a step — they are the agent's own
 * words. A thinking trace is what he is saying to himself; a message is what he
 * is saying to someone else. Those belong over his head, in the shape the whole
 * world already reads without a label: a thought bubble and a speech bubble.
 *
 * Everything else — a path, a command, an exit code — is data about the step
 * and stays in the caption at his feet, where a long path can run wide without
 * crowding him.
 * ------------------------------------------------------------------------- */

export type ReplayBubble = "thought" | "speech";

export function bubbleFor(kind: ReplayKind): ReplayBubble | null {
  if (kind === "think") return "thought";
  if (kind === "message") return "speech";
  return null;
}

/** A beat speaks or it reports. Never both — that says the same thing twice. */
export function showsCaption(kind: ReplayKind): boolean {
  return bubbleFor(kind) === null;
}

/** Gap between the top of his head and the underside of the bubble. */
export const BUBBLE_GAP = 14;
/** Line box, vertical padding, and tail height of a bubble, in px. */
export const BUBBLE_LINE = 19;
export const BUBBLE_PAD = 22;
export const BUBBLE_TAIL = 12;
export const BUBBLE_MAX_LINES = 3;

/** Sky left above his head once he is standing on the road. */
export function bubbleHeadroom(stageHeight: number, standY: number): number {
  return Math.max(0, stageHeight - standY - SPRITE_SIZE - BUBBLE_GAP);
}

/**
 * How many lines the bubble may run to before it clips.
 *
 * The bubble is clamped to what the sky can hold rather than to a guessed
 * constant, so a short stage crops the prose instead of pushing the bubble off
 * the top of the world. The log below the ground always carries the full text.
 */
export function bubbleLines(headroom: number): number {
  const room = headroom - BUBBLE_PAD - BUBBLE_TAIL;
  return clamp(Math.floor(room / BUBBLE_LINE), 1, BUBBLE_MAX_LINES);
}
