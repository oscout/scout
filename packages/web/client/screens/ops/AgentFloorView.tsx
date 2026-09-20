import { AgentAdventures } from "./AgentAdventures.tsx";
import { SharedWorkFloor } from "./SharedWorkFloor.tsx";
import { FloorReplay } from "./FloorReplay.tsx";
import { floorDeskOrder } from "./floor-memory.ts";
import { FloorTacticalHUD } from "./FloorTacticalHUD.tsx";
import { FloorResourcesSheet, type FloorResourceView } from "./FloorResourcesSheet.tsx";
import "./agent-floor.css";
import { FLOOR_ROOMS } from "./agent-floor-world-layout.ts";
import { FloorContextSheet } from "./FloorContextSheet.tsx";
import { AgentFloorWorld, FLOOR_WORLD_WIDTH, FLOOR_WORLD_HEIGHT } from "./AgentFloorWorld.tsx";
import { floorActorState, type FloorActorStation } from "./agent-floor-actor.ts";
import { floorCharacterName } from "./floor-character-name.ts";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { Terminal, FileCode2, MessageSquare, CircleDot } from "lucide-react";
import { HarnessMark } from "../../components/HarnessMark.tsx";
import { agentSpriteProps, SpriteAvatar } from "../../components/SpriteAvatar.tsx";
import { normalizeAgentState } from "../../lib/agent-state.ts";
import { laneSnippetText, observeEventWallMs } from "../../lib/lane-observe.ts";
import { timeAgo } from "../../lib/time.ts";
import type { ObserveEvent } from "../../lib/types.ts";
import { SessionObserve } from "../sessions/SessionObserve.tsx";
import {
  lanePrimaryLabel,
  type AgentLane,
} from "./agent-lanes-model.ts";
import {
  publishLaneFocusId,
  publishLaneRoster,
  setFloorLedgerHandlers,
  type LaneRosterEntry,
} from "./lane-roster-store.ts";
import { publishRecapFocus } from "../../lib/session-recap-lanes.ts";

/**
 * AgentFloorView — the "floor" lane treatment, shared across surfaces. A
 * tactical plane where each agent keeps a working area stacked along the
 * vertical axis and the other axis is TIME, anchored to wall-clock five-minute
 * slots: the leading slot is live; behind it, slots are MINTED — once their
 * five minutes pass they sit still until the next mint boundary.
 *
 * Reading model: compact FLAGS stay in-scene; the DOCK below the plane is the
 * reading surface — at rest it carries the fleet summary, and the focused
 * lane's glanceable signals (momentum, cadence, signature, activity mix)
 * while you hover. CLICKING pins the dock to that lane (click again for the full
 * timeline, Esc releases). Hovering a tower projects that slot's window
 * readout in-scene. Lane order matches the ledger top-to-bottom: recency seeds
 * the initial order, then existing agents hold position while newcomers append.
 *
 * The ledger lives in one of two places: embedded beside the plane (default,
 * used by the scope surface), or published into the host app's left rail via
 * lane-roster-store when `railLedger` is set (the ops surface) — rows render
 * compact there and stay hover-linked through the store.
 *
 * Theming: the component paints entirely from `--floor-*` inputs, which
 * default to the app-global tokens (`--bg`, `--ink`, `--dim`, `--accent`,
 * `--green`) in agent-floor.css — so it follows light/dark automatically.
 * A host surface with its own palette (e.g. the Scope instrument) reskins it
 * by overriding those inputs, not by touching the component.
 */

const BUCKET_MS = 5 * 60_000;
/** Minted (static) slots behind the live one — 3 × 5m = 15 min of past. */
const MINTED_SLOTS = 3;
const TOTAL_SLOTS = MINTED_SLOTS + 1;
const SLOT_MAX_BLOCKS = 8;
const MAX_FLOOR_LANES = 8;
const STRIP_BLOCKS = 10;
const FLOOR_TRACE_WINDOW_MS = 15 * 60_000;
const FLOOR_ZOOM_MIN = 0.65;
const FLOOR_ZOOM_MAX = 1.45;
const FLOOR_ZOOM_STEP = 0.1;
const FLOOR_PAN_X_MAX = 360;
const FLOOR_PAN_Y_MAX = 260;

function clampFloorZoom(value: number): number {
  return Math.round(Math.min(FLOOR_ZOOM_MAX, Math.max(FLOOR_ZOOM_MIN, value)) * 100) / 100;
}

function clampFloorPan(value: number, limit: number): number {
  return Math.round(Math.min(limit, Math.max(-limit, value)));
}

const LANE_PITCH = 128;
const STACK_SIZE = 34;
const STACK_STEP = 14;
const BLOCK_H = 12;
const SLAB_SIZE = 44;
const SLAB_H = 7;
const BUCKET_DEPTH = 58;
const FRONT_APRON = 440;
const BACK_MARGIN = 48;
const EDGE_MARGIN = 24;
const MIN_PLANE_D = 480;

/** Which plane edge history drifts toward ("now" sits on the other side). */
type FloorOrientation = "past-left" | "past-right";

const FLOOR_ORIENT_STORAGE_KEY = "openscout:agent-floor-orient";
const FLOOR_LANE_ORDER_STORAGE_KEY = "openscout:agent-floor-lane-order";

function readStoredOrientation(): FloorOrientation {
  try {
    const stored = localStorage.getItem(FLOOR_ORIENT_STORAGE_KEY);
    if (stored === "past-left" || stored === "past-right") return stored;
  } catch {
    // ignore storage failures
  }
  return "past-left";
}

function readStoredLaneOrder(): string[] {
  try {
    const stored = JSON.parse(sessionStorage.getItem(FLOOR_LANE_ORDER_STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function fmtSlotClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

type FloorBlockKind = "tool" | "edit" | "msg";

type FloorSlot = {
  blocks: FloorBlockKind[];
  counts: Record<FloorBlockKind, number>;
  /** Tool name → call count, for the hover projection. */
  tools: Array<[string, number]>;
  total: number;
};

type FloorLaneSeries = {
  lane: AgentLane;
  live: boolean;
  /** Index 0 = the live slot, 1..MINTED_SLOTS = minted five-minute slots. */
  slots: FloorSlot[];
  counts: Record<FloorBlockKind, number>;
  /** Chronological last blocks for the ledger mini strip. */
  strip: FloorBlockKind[];
  lastLabel: string | null;
  lastAt: number | null;
};

const EDIT_TOOL_RE = /^(edit|multi_?edit|write|apply_?patch|patch_apply|str_?replace|notebook_?edit|create_file)/i;

function classifyObserveEvent(event: ObserveEvent): FloorBlockKind | null {
  if (event.kind === "tool") {
    if (event.diff || (event.tool && EDIT_TOOL_RE.test(event.tool.trim()))) return "edit";
    return "tool";
  }
  if (event.kind === "message" || event.kind === "ask") return "msg";
  return null;
}

function buildFloorLane(lane: AgentLane, periodStart: number, now: number): FloorLaneSeries {
  const sessionStart = lane.observe?.metadata?.session?.sessionStart;
  const counts: Record<FloorBlockKind, number> = { tool: 0, edit: 0, msg: 0 };
  const slots: Array<{
    blocks: FloorBlockKind[];
    counts: Record<FloorBlockKind, number>;
    tools: Map<string, number>;
    total: number;
  }> = Array.from({ length: TOTAL_SLOTS }, () => ({
    blocks: [],
    counts: { tool: 0, edit: 0, msg: 0 },
    tools: new Map(),
    total: 0,
  }));
  const timeline: Array<{ kind: FloorBlockKind; label: string; at: number | null }> = [];
  let last: { at: number | null; label: string } | null = null;

  for (const event of lane.observe?.events ?? []) {
    const kind = classifyObserveEvent(event);
    if (!kind) continue;
    const at = observeEventWallMs(event, sessionStart);
    // Wall-clock slot: 0 = the live period, k = the k-th minted five minutes.
    const slotIndex = at === null || at >= periodStart
      ? 0
      : Math.floor((periodStart - at) / BUCKET_MS) + 1;
    if (slotIndex >= TOTAL_SLOTS) continue;
    const slot = slots[slotIndex];
    slot.blocks.push(kind);
    slot.counts[kind] += 1;
    slot.total += 1;
    counts[kind] += 1;
    const toolName = kind === "msg" ? null : event.tool?.trim() || "tool";
    if (toolName) slot.tools.set(toolName, (slot.tools.get(toolName) ?? 0) + 1);
    timeline.push({
      kind,
      label: kind === "msg"
        ? laneSnippetText(event.text, 44, 1)
        : event.text.trim() || toolName || "tool",
      at,
    });
    last = {
      at,
      label: kind === "msg" ? "message" : event.tool?.trim() || "tool",
    };
  }

  return {
    lane,
    // Live status shares the actor projection, including attention and completion.
    live: floorActorState(lane, now).posture === "working",
    slots: slots.map((slot) => ({
      blocks: slot.blocks.slice(-SLOT_MAX_BLOCKS),
      counts: slot.counts,
      tools: [...slot.tools.entries()].sort((left, right) => right[1] - left[1]),
      total: slot.total,
    })),
    counts,
    strip: timeline.slice(-STRIP_BLOCKS).map((entry) => entry.kind),
    lastLabel: last?.label ?? null,
    lastAt: last?.at ?? (lane.lastActiveAt || null),
  };
}

function countsLabel(counts: Record<FloorBlockKind, number>): string {
  const part = (n: number, singular: string, plural: string) =>
    `${n} ${n === 1 ? singular : plural}`;
  return [
    part(counts.tool, "tool", "tools"),
    part(counts.edit, "edit", "edits"),
    part(counts.msg, "msg", "msgs"),
  ].join(" · ");
}

function restingLabelFor(series: FloorLaneSeries): string {
  // Registry state may claim "working" while nothing observable has landed —
  // say "quiet", not "idle", but never claim live work we can't show.
  return /^(working|active|running|in_turn|in_flight)/i.test(series.lane.agent.state ?? "")
    ? "quiet"
    : "idle";
}

function classifiedCount(counts: Record<FloorBlockKind, number>): number {
  return counts.tool + counts.edit + counts.msg;
}

function activityMixLabel(counts: Record<FloorBlockKind, number>): string {
  const total = classifiedCount(counts);
  if (total === 0) return "quiet";
  const ranked: Array<["tool-led" | "edit-heavy" | "conversation-led", number]> = [
    ["tool-led", counts.tool],
    ["edit-heavy", counts.edit],
    ["conversation-led", counts.msg],
  ];
  ranked.sort((left, right) => right[1] - left[1]);
  return ranked[0][1] === ranked[1][1] ? "balanced" : ranked[0][0];
}

function dominantTool(series: FloorLaneSeries): { value: string; detail: string } {
  const totals = new Map<string, number>();
  for (const slot of series.slots) {
    for (const [tool, count] of slot.tools) {
      totals.set(tool, (totals.get(tool) ?? 0) + count);
    }
  }
  const [top] = [...totals.entries()].sort((left, right) => right[1] - left[1]);
  return top
    ? { value: top[0], detail: `${top[1]} call${top[1] === 1 ? "" : "s"} · 15m` }
    : { value: "no tool pattern", detail: "messages and edits only" };
}

function momentumSignal(series: FloorLaneSeries): { value: string; detail: string } {
  const current = series.slots[0]?.total ?? 0;
  const prior = series.slots[1]?.total ?? 0;
  if (current === 0 && prior === 0) return { value: "quiet", detail: "no work in the last 10m" };
  if (current === 0) return { value: "paused", detail: `${prior} in the prior 5m` };
  if (prior === 0) return { value: "new burst", detail: `${current} in the current 5m` };
  if (current >= prior + 3) return { value: "building", detail: `${current} now · ${prior} prior` };
  if (prior >= current + 3) return { value: "easing", detail: `${current} now · ${prior} prior` };
  return { value: "steady", detail: `${current} now · ${prior} prior` };
}

function DockInsight({ label, value, detail, mix }: {
  label: string;
  value: string;
  detail: string;
  mix?: Record<FloorBlockKind, number>;
}) {
  const total = mix ? Math.max(1, classifiedCount(mix)) : 1;
  return (
    <span className="agent-floor__dock-insight">
      <span className="agent-floor__dock-insight-label">{label}</span>
      <span className="agent-floor__dock-insight-value">{value}</span>
      <span className="agent-floor__dock-insight-detail">{detail}</span>
      {mix ? (
        <span
          className="agent-floor__dock-mix"
          style={{
            "--mix-tool": `${(mix.tool / total) * 100}%`,
            "--mix-edit": `${((mix.tool + mix.edit) / total) * 100}%`,
          } as CSSProperties}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

function actionFieldsFor(series: FloorLaneSeries, now: number): {
  glyph: string;
  label: string;
  meta: string;
} {
  const lastAgo = series.lastAt ? timeAgo(series.lastAt, now) : null;
  return series.live
    ? { glyph: "▸", label: series.lastLabel ?? "working", meta: lastAgo ?? "now" }
    : { glyph: "⏸", label: restingLabelFor(series), meta: lastAgo ? `· ${lastAgo}` : "" };
}

function LaneActionLine({ series, now }: { series: FloorLaneSeries; now: number }) {
  const fields = actionFieldsFor(series, now);
  return series.live ? (
    <>
      <span className="agent-floor__card-run">{fields.glyph}</span>
      <span className="agent-floor__card-tool">{fields.label}</span>
      <span className="agent-floor__card-ago">{fields.meta}</span>
    </>
  ) : (
    <>
      <span className="agent-floor__card-pause">{fields.glyph}</span>
      <span className="agent-floor__card-idle">
        {fields.label}{fields.meta ? ` ${fields.meta}` : ""}
      </span>
    </>
  );
}

function IsoBlock({ kind, z, size = STACK_SIZE, faceH = BLOCK_H, pad, live }: {
  kind: FloorBlockKind | "head" | "pad";
  z: number;
  size?: number;
  faceH?: number;
  pad?: boolean;
  live?: boolean;
}) {
  return (
    <span
      className={`agent-floor__block is-${kind}${pad ? " is-pedestal" : ""}${live ? " is-live" : ""}`}
      style={{ "--z": `${z}px`, "--bs": `${size}px`, "--bh": `${faceH}px` } as CSSProperties}
      aria-hidden="true"
    >
      <span className="agent-floor__face is-left" />
      <span className="agent-floor__face is-right" />
      <span className="agent-floor__face is-top" />
    </span>
  );
}

/** Slab under a minted tower — its sides carry the tool/edit/msg mix. */
function SlotSlab({ slot }: { slot: FloorSlot }) {
  const total = Math.max(1, slot.total);
  const toolPct = (slot.counts.tool / total) * 100;
  const editPct = (slot.counts.edit / total) * 100;
  return (
    <span
      className="agent-floor__block agent-floor__slab"
      style={{
        "--z": "0px",
        "--bs": `${SLAB_SIZE}px`,
        "--bh": `${SLAB_H}px`,
        "--mix-a": `${toolPct.toFixed(1)}%`,
        "--mix-b": `${(toolPct + editPct).toFixed(1)}%`,
      } as CSSProperties}
      aria-hidden="true"
    >
      <span className="agent-floor__face is-left" />
      <span className="agent-floor__face is-right" />
      <span className="agent-floor__face is-top" />
    </span>
  );
}

function SlotPeek({ slot, slotIndex, periodStart }: {
  slot: FloorSlot;
  slotIndex: number;
  periodStart: number;
}) {
  const rangeLabel = slotIndex === 0
    ? `${fmtSlotClock(periodStart)} — now`
    : `${fmtSlotClock(periodStart - slotIndex * BUCKET_MS)} – ${fmtSlotClock(periodStart - (slotIndex - 1) * BUCKET_MS)}`;
  return (
    <span className="agent-floor__peek">
      <span className="agent-floor__peek-range">{rangeLabel}</span>
      <span className="agent-floor__peek-cols">
        <span className="agent-floor__peek-col">
          {slot.tools.slice(0, 3).map(([tool, count]) => (
            <span key={tool} className="agent-floor__peek-tool">
              {tool}{count > 1 ? ` ×${count}` : ""}
            </span>
          ))}
          {slot.tools.length === 0 ? (
            <span className="agent-floor__peek-tool is-empty">no tools</span>
          ) : null}
        </span>
        <span className="agent-floor__peek-col is-right">
          <span>{slot.counts.edit} edit{slot.counts.edit === 1 ? "" : "s"}</span>
          <span>{slot.counts.msg} msg{slot.counts.msg === 1 ? "" : "s"}</span>
        </span>
      </span>
    </span>
  );
}

function FloorLaneStrip({ series, index, planeW, flip, periodStart, now, focused, pinned, dimmed, peekSlot, onFocus, onPeek, onSelect }: {
  series: FloorLaneSeries;
  index: number;
  planeW: number;
  /** true = past accumulates to the RIGHT (pads on the left edge). */
  flip: boolean;
  periodStart: number;
  now: number;
  focused: boolean;
  pinned: boolean;
  dimmed: boolean;
  peekSlot: number | null;
  onFocus: (laneId: string | null) => void;
  onPeek: (laneId: string, slotIndex: number | null) => void;
  onSelect: (lane: AgentLane) => void;
}) {
  const { lane, live, slots } = series;
  const agent = lane.agent;
  const name = lanePrimaryLabel(agent, lane.source);
  const sprite = agentSpriteProps(agent);

  const stackY = (LANE_PITCH - SLAB_SIZE) / 2;
  const slotX = (slotIndex: number) => {
    const inset = (BUCKET_DEPTH - SLAB_SIZE) / 2;
    return flip
      ? FRONT_APRON + slotIndex * BUCKET_DEPTH + inset
      : planeW - FRONT_APRON - (slotIndex + 1) * BUCKET_DEPTH + inset;
  };
  const actor = floorActorState(lane, now);
  const stations: Array<{ id: FloorActorStation; label: string; x: number; y: number }> = [
    { id: "home", label: "READY", x: 55, y: 44 },
    { id: "tools", label: "TOOLS", x: 165, y: 44 },
    { id: "edit", label: "EDIT", x: 275, y: 44 },
    { id: "message", label: "COMMS", x: 380, y: 44 },
  ];
  const station = stations.find((entry) => entry.id === actor.station)!;
  const workX = flip ? 0 : planeW - FRONT_APRON;
  const actorX = workX + station.x;
  const actorY = station.y;
  const shortId = lane.id.replace(/[^a-zA-Z0-9]/g, "").slice(-5);
  const flagZ = 76;

  return (
    <button
      type="button"
      className={`agent-floor__lane${live ? " is-live" : ""}${index % 2 === 1 ? " is-alt" : ""}${focused ? " is-focus" : ""}${pinned ? " is-pinned" : ""}${dimmed ? " is-dim" : ""}`}
      style={{ left: 0, top: index * LANE_PITCH, width: planeW, height: LANE_PITCH }}
      onClick={() => onSelect(lane)}
      onMouseEnter={() => onFocus(lane.id)}
      onMouseLeave={() => {
        onFocus(null);
        onPeek(lane.id, null);
      }}
      onFocus={() => onFocus(lane.id)}
      onBlur={() => onFocus(null)}
      aria-label={`${name} ${agent.harness ?? ""} ${shortId} — ${actor.label} — ${pinned ? "open timeline" : "pin details"}`}
    >
      <span className="agent-floor__lane-strip" aria-hidden="true" />

      {slots.map((slot, slotIndex) => {
        if (slot.total === 0) return null;
        const peeking = focused && peekSlot === slotIndex;
        const stackTopZ = SLAB_H + 2 + slot.blocks.length * STACK_STEP;
        return (
          <span
            key={slotIndex}
            className={`agent-floor__stack${slotIndex === 0 ? " is-now" : " is-minted"}${peeking ? " is-peeking" : ""}`}
            style={{ left: slotX(slotIndex), top: stackY }}
            onMouseEnter={() => onPeek(lane.id, slotIndex)}
          >
            <SlotSlab slot={slot} />
            <span
              className="agent-floor__stack-blocks"
              style={{ left: (SLAB_SIZE - STACK_SIZE) / 2, top: (SLAB_SIZE - STACK_SIZE) / 2 }}
            >
              {slot.blocks.map((kind, blockIndex) => (
                <IsoBlock key={blockIndex} kind={kind} z={SLAB_H + 2 + blockIndex * STACK_STEP} />
              ))}
            </span>
            {peeking ? (
              <span
                className="agent-floor__bb agent-floor__peek-anchor"
                style={{
                  left: SLAB_SIZE / 2,
                  top: SLAB_SIZE / 2,
                  "--z": `${stackTopZ + 46}px`,
                } as CSSProperties}
              >
                <SlotPeek slot={slot} slotIndex={slotIndex} periodStart={periodStart} />
              </span>
            ) : null}
          </span>
        );
      })}

      <span className="agent-floor__work-zone" style={{ left: workX, width: FRONT_APRON }} aria-hidden="true">
        <span className="agent-floor__route" />
        {stations.map((entry) => (
          <span key={entry.id} className={`agent-floor__station${entry.id === actor.station ? " is-occupied" : ""}`}
            style={{ left: entry.x, top: entry.y }}>
            <span className="agent-floor__station-surface">
              {entry.id === "home" ? <CircleDot size={22} /> : entry.id === "tools" ? <Terminal size={22} /> : entry.id === "edit" ? <FileCode2 size={22} /> : <MessageSquare size={22} />}
            </span>
            <span className="agent-floor__bb agent-floor__station-label">{entry.label}</span>
          </span>
        ))}
      </span>
      <span className={`agent-floor__actor-position is-${actor.posture}${pinned || focused ? " is-selected" : ""}`}
        style={{ left: actorX, top: actorY }} data-station={actor.station}>
        <span className="agent-floor__selection-ring" />
        <span className="agent-floor__bb agent-floor__actor-body" style={{ "--z": "42px" } as CSSProperties}>
          <SpriteAvatar name={agent.name} size={56} hue={sprite.hue} tone={sprite.tone} glow={false} />
          {actor.posture === "attention" || actor.posture === "blocked" ? <span className="agent-floor__actor-alert">!</span> : null}
        </span>
      </span>
      <span className="agent-floor__bb agent-floor__flag-anchor agent-floor__unit-label"
        style={{ left: workX + 220, top: 91, "--z": `${flagZ}px` } as CSSProperties}>
        <span className={`agent-floor__flag${focused ? " is-focus" : ""}${pinned ? " is-pinned" : ""}`}>
          <span className="agent-floor__flag-name">{name}</span>
          <span className="agent-floor__unit-id">{agent.harness} · {shortId}</span>
          <span className={`agent-floor__unit-status is-${actor.posture}`}>{actor.label}</span>
        </span>
      </span>
    </button>
  );
}

/** Fixed-height reading surface: fleet summary at rest, then synthesized lane
 *  signals while hovering or pinned. Raw events stay in the timeline. */
function FloorDock({ focus, pinned, ledger, liveCount, now }: {
  focus: FloorLaneSeries | null;
  pinned: boolean;
  ledger: FloorLaneSeries[];
  liveCount: number;
  now: number;
}) {
  if (!focus) {
    const totals = ledger.reduce(
      (acc, entry) => {
        acc.tool += entry.counts.tool;
        acc.edit += entry.counts.edit;
        acc.msg += entry.counts.msg;
        return acc;
      },
      { tool: 0, edit: 0, msg: 0 },
    );
    const activeLanes = ledger.filter((entry) => classifiedCount(entry.counts) > 0).length;
    const hottest = [...ledger].sort(
      (left, right) => classifiedCount(right.counts) - classifiedCount(left.counts),
    )[0] ?? null;
    const hottestCount = hottest ? classifiedCount(hottest.counts) : 0;

    return (
      <div className="agent-floor__dock is-resting">
        <span className="agent-floor__dock-id agent-floor__dock-fleet">
          <span className="agent-floor__dock-id-copy">
            <span className="agent-floor__dock-title">fleet at a glance</span>
            <span>{ledger.length} lane{ledger.length === 1 ? "" : "s"} · {liveCount} live</span>
          </span>
        </span>
        <span className="agent-floor__dock-insights">
          <DockInsight
            label="coverage"
            value={`${activeLanes}/${ledger.length} lanes`}
            detail="showed work · 15m"
          />
          <DockInsight
            label="hottest lane"
            value={hottest ? lanePrimaryLabel(hottest.lane.agent, hottest.lane.source) : "none yet"}
            detail={hottest ? `${hottestCount} classified events` : "waiting for activity"}
          />
          <DockInsight
            label="throughput"
            value={`${classifiedCount(totals)} events`}
            detail="classified · 15m"
          />
          <DockInsight
            label="activity mix"
            value={activityMixLabel(totals)}
            detail={countsLabel(totals)}
            mix={totals}
          />
        </span>
      </div>
    );
  }

  const agent = focus.lane.agent;
  const sprite = agentSpriteProps(agent);
  const momentum = momentumSignal(focus);
  const toolSignature = dominantTool(focus);
  const activeWindows = focus.slots.filter((slot) => slot.total > 0).length;

  return (
    <div className={`agent-floor__dock${pinned ? " is-pinned" : ""}`}>
      <span className="agent-floor__dock-id">
        <SpriteAvatar name={agent.name} size={30} tile hue={sprite.hue} tone={sprite.tone} />
        <span className="agent-floor__dock-id-copy">
          <span className="agent-floor__dock-name">
            {lanePrimaryLabel(agent, focus.lane.source)}
            <HarnessMark harness={agent.harness} size={12} className="agent-floor__card-mark" />
            <span className={`agent-floor__card-dot${focus.live ? " is-live" : ""}`} />
            {pinned ? <span className="agent-floor__dock-lock">locked</span> : null}
          </span>
          <span className="agent-floor__dock-action">
            <LaneActionLine series={focus} now={now} />
          </span>
        </span>
      </span>

      <span className="agent-floor__dock-insights">
        <DockInsight label="momentum" value={momentum.value} detail={momentum.detail} />
        <DockInsight
          label="cadence"
          value={`${activeWindows}/${focus.slots.length} windows`}
          detail="active five-minute bands"
        />
        <DockInsight label="signature" value={toolSignature.value} detail={toolSignature.detail} />
        <DockInsight
          label="activity mix"
          value={activityMixLabel(focus.counts)}
          detail={countsLabel(focus.counts)}
          mix={focus.counts}
        />
      </span>
    </div>
  );
}

function FloorTracePanel({
  series,
  now,
  concise,
  onConciseChange,
  onClose,
  onOpenFull,
  operatorName,
}: {
  series: FloorLaneSeries;
  now: number;
  concise: boolean;
  onConciseChange: (value: boolean) => void;
  onClose: () => void;
  onOpenFull: () => void;
  /** Operator display name for the chat-style user-request head in the trace. */
  operatorName?: string;
}) {
  const { agent, observe, source } = series.lane;
  const name = lanePrimaryLabel(agent, source);

  return (
    <aside className="agent-floor__trace-panel" aria-label={`${name} selected lane trace`}>
      <button
        type="button"
        className="agent-floor__trace-close"
        onClick={onClose}
        aria-label="Close selected lane trace"
      >×</button>
      <div className="agent-floor__trace-body">
        {observe ? (
          <SessionObserve
            data={observe}
            agentId={source === "scout" ? agent.id : undefined}
            sessionId={agent.harnessSessionId}
            showRail={false}
            variant="lane"
            nowMs={now}
            traceWindowMs={FLOOR_TRACE_WINDOW_MS}
            traceWindowLabel="15m"
            laneCollapseTechnicalEvents={concise}
            onLaneCollapseTechnicalEventsChange={onConciseChange}
            laneOperatorName={operatorName}
            onLaneEventSelect={onOpenFull}
          />
        ) : (
          <div className="agent-floor__trace-empty">Waiting for trace activity…</div>
        )}
      </div>
    </aside>
  );
}

function FloorZoomControls({
  zoom,
  fit,
  onZoomChange,
  onReset,
}: {
  zoom: number;
  fit: boolean;
  onZoomChange: (value: number) => void;
  onReset: () => void;
}) {
  const percent = Math.round(zoom * 100);
  return (
    <div className="agent-floor__zoom" role="group" aria-label="Floor zoom">
      <button
        type="button"
        aria-label="Zoom out"
        disabled={zoom <= FLOOR_ZOOM_MIN}
        onClick={() => onZoomChange(clampFloorZoom(zoom - FLOOR_ZOOM_STEP))}
      >−</button>
      <button
        type="button"
        className="agent-floor__zoom-reset"
        aria-label="Reset floor zoom to fit"
        title="Reset zoom and position to automatic fit"
        onClick={onReset}
      >{fit ? "fit" : `${percent}%`}</button>
      <button
        type="button"
        aria-label="Zoom in"
        disabled={zoom >= FLOOR_ZOOM_MAX}
        onClick={() => onZoomChange(clampFloorZoom(zoom + FLOOR_ZOOM_STEP))}
      >+</button>
    </div>
  );
}

export function AgentFloorView({ lanes, now: suppliedNow, onOpenTrace, railLedger = false, operatorName }: {
  lanes: AgentLane[];
  now: number;
  onOpenTrace: (lane: AgentLane) => void;
  /** Publish the ledger into the host's left rail instead of embedding it. */
  railLedger?: boolean;
  /** Operator display name for the chat-style user-request head in the trace panel. */
  operatorName?: string;
}) {
  // Fresh feed renders can arrive while the host pauses its peripheral clock.
  const now = Math.max(suppliedNow, Date.now());
  const [resourceView, setResourceView] = useState<FloorResourceView | null>(null);
  const [motionPaused, setMotionPaused] = useState(false);
  const [sharedWork, setSharedWork] = useState(true);
  const [adventures, setAdventures] = useState(false);
  const [historyView, setHistoryView] = useState(false);
  const [contextRoom, setContextRoom] = useState<FloorActorStation | null>(null);
  const [requestedPage, setRequestedPage] = useState(0);

  const [orientation, setOrientation] = useState<FloorOrientation>(readStoredOrientation);
  const [focusLaneId, setFocusLaneId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ laneId: string; slot: number } | null>(null);
  const [traceConcise, setTraceConcise] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [laneOrder, setLaneOrder] = useState<string[]>(readStoredLaneOrder);
  const deskOrder = useMemo(() => floorDeskOrder(laneOrder, lanes.map((lane) => lane.id)), [laneOrder, lanes]);
  const pageCount = Math.max(1, Math.ceil(deskOrder.length / MAX_FLOOR_LANES));
  const floorPage = Math.min(requestedPage, pageCount - 1);
  const berths = Object.fromEntries(deskOrder.map((id, index) => [id, index % MAX_FLOOR_LANES]));
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number } | null>(null);
  const flip = orientation === "past-right";

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setViewportSize((current) => (
        current && Math.abs(current.w - rect.width) < 2 && Math.abs(current.h - rect.height) < 2
          ? current
          : { w: rect.width, h: rect.height }
      ));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const flipOrientation = useCallback(() => {
    setOrientation((current) => {
      const next: FloorOrientation = current === "past-left" ? "past-right" : "past-left";
      try {
        localStorage.setItem(FLOOR_ORIENT_STORAGE_KEY, next);
      } catch {
        // ignore storage failures
      }
      return next;
    });
  }, []);
  const handleFocus = useCallback((laneId: string | null) => {
    setFocusLaneId(laneId);
    if (laneId === null) setPeek(null);
  }, []);
  const handlePeek = useCallback((laneId: string, slot: number | null) => {
    setPeek(slot === null ? null : { laneId, slot });
  }, []);
  const selectLane = useCallback((lane: AgentLane) => {
    const laneIndex = deskOrder.indexOf(lane.id);
    if (laneIndex >= 0) setRequestedPage(Math.floor(laneIndex / MAX_FLOOR_LANES));
    setContextRoom(null);
    setResourceView(null);
    if (historyView && pinnedId === lane.id) onOpenTrace(lane);
    else setPinnedId(lane.id);
  }, [pinnedId, onOpenTrace, deskOrder, historyView]);

  const resetFloorView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);
  const handleViewportWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".agent-floor__trace-panel, .agent-floor__zoom, .floor-tactical, .shared-floor, .floor-replay")) return;
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) {
      setZoom((current) => clampFloorZoom(current - event.deltaY * 0.002));
      return;
    }
    setPan((current) => ({
      x: clampFloorPan(current.x - event.deltaX, FLOOR_PAN_X_MAX),
      y: clampFloorPan(current.y - event.deltaY, FLOOR_PAN_Y_MAX),
    }));
  }, []);
  const handleViewportPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.button !== 0 || target?.closest("button, .agent-floor__trace-panel, .floor-tactical, .shared-floor, .floor-replay")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }, [pan]);
  const handleViewportPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan({
      x: clampFloorPan(drag.panX + event.clientX - drag.startX, FLOOR_PAN_X_MAX),
      y: clampFloorPan(drag.panY + event.clientY - drag.startY, FLOOR_PAN_Y_MAX),
    });
  }, []);
  const stopViewportDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  }, []);

  useEffect(() => {
    if (pinnedId === null && contextRoom === null && resourceView === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setPinnedId(null); setContextRoom(null); setResourceView(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinnedId, contextRoom, resourceView]);

  // Slots anchor to wall-clock five-minute periods: minted towers hold still;
  // everything shifts one slot only when a new period mints.
  const periodStart = Math.floor(now / BUCKET_MS) * BUCKET_MS;

  const orderedLanes = useMemo(() => {
    const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));
    const known = laneOrder.flatMap((laneId) => {
      const lane = lanesById.get(laneId);
      return lane ? [lane] : [];
    });
    const knownIds = new Set(known.map((lane) => lane.id));
    const newcomers = lanes
      .filter((lane) => !knownIds.has(lane.id))
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
    return known.concat(newcomers);
  }, [lanes, laneOrder]);

  useEffect(() => {
    const nextOrder = deskOrder;
    setLaneOrder((current) => (
      current.length === nextOrder.length && current.every((laneId, index) => laneId === nextOrder[index])
        ? current
        : nextOrder
    ));
    try {
      sessionStorage.setItem(FLOOR_LANE_ORDER_STORAGE_KEY, JSON.stringify(nextOrder));
    } catch {
      // ignore storage failures
    }
  }, [deskOrder]);

  const { series, hidden, planeW, planeD, lanesStartY } = useMemo(() => {
    const built = orderedLanes.map((lane) => buildFloorLane(lane, periodStart, now));
    // Initial order is seeded by recency; after that, each agent holds its
    // physical lane while newly discovered agents join at the end.
    const pageIds = new Set(deskOrder.slice(floorPage * MAX_FLOOR_LANES, (floorPage + 1) * MAX_FLOOR_LANES));
    const shown = built.filter((entry) => pageIds.has(entry.lane.id));
    const stripsH = shown.length * LANE_PITCH;
    const depth = Math.max(MIN_PLANE_D, stripsH + EDGE_MARGIN * 2);
    return {
      series: shown,
      hidden: built.filter((entry) => !shown.includes(entry)),
      planeW: BACK_MARGIN + TOTAL_SLOTS * BUCKET_DEPTH + FRONT_APRON,
      planeD: depth,
      lanesStartY: (depth - stripsH) / 2,
    };
  }, [orderedLanes, deskOrder, periodStart, floorPage, now]);

  const ledger = useMemo(() => orderedLanes.map((lane) => buildFloorLane(lane, periodStart, now)), [orderedLanes, periodStart, now]);
  const liveCount = ledger.filter((entry) => entry.live).length;
  const effectiveFocus = focusLaneId ?? pinnedId;
  const focusSeries = effectiveFocus === null
    ? null
    : ledger.find((entry) => entry.lane.id === effectiveFocus) ?? null;
  const pinnedSeries = pinnedId === null
    ? null
    : ledger.find((entry) => entry.lane.id === pinnedId) ?? null;

  // A pinned lane can age out of the roster — release the pin with it.
  useEffect(() => {
    if (pinnedId !== null && !ledger.some((entry) => entry.lane.id === pinnedId)) {
      setPinnedId(null);
    }
  }, [ledger, pinnedId]);

  useEffect(() => {
    setTraceConcise(false);
  }, [pinnedId]);

  // Rail mode: the host's left rail is the ledger. Publish compact rows,
  // register the hover/select handlers rail rows call, and mirror the focus.
  useEffect(() => {
    if (!railLedger) return;
    const entries: LaneRosterEntry[] = ledger.map((entry) => {
      const fields = actionFieldsFor(entry, now);
      return {
        id: entry.lane.id,
        label: lanePrimaryLabel(entry.lane.agent, entry.lane.source),
        statusLabel: entry.lane.agent.harness?.trim() || "lane",
        tone: normalizeAgentState(entry.lane.agent.state, entry.lane.agent),
        updatedAt: entry.lane.lastActiveAt > 0 ? entry.lane.lastActiveAt : undefined,
        floor: {
          live: entry.live,
          harness: entry.lane.agent.harness,
          identity: floorCharacterName(entry.lane).label,
          project: entry.lane.agent.project?.trim() || null,
          actionGlyph: fields.glyph,
          actionLabel: fields.label,
          actionMeta: fields.meta,
          strip: entry.strip,
          countsLabel: countsLabel(entry.counts),
        },
      };
    });
    publishLaneRoster(entries);
  }, [railLedger, ledger, now]);

  useEffect(() => {
    if (!railLedger) return;
    setFloorLedgerHandlers({
      onHover: handleFocus,
      onSelect: (laneId) => {
        const entry = ledger.find((candidate) => candidate.lane.id === laneId);
        if (entry) selectLane(entry.lane);
      },
    });
    return () => setFloorLedgerHandlers(null);
  }, [railLedger, ledger, handleFocus, selectLane]);

  useEffect(() => {
    if (!railLedger) return;
    publishLaneFocusId(effectiveFocus);
    publishRecapFocus(effectiveFocus);
    return () => {
      publishLaneFocusId(null);
      publishRecapFocus(null);
    };
  }, [railLedger, effectiveFocus]);

  const seamX = (slotIndex: number) => (flip
    ? FRONT_APRON + slotIndex * BUCKET_DEPTH
    : planeW - FRONT_APRON - slotIndex * BUCKET_DEPTH);
  const ticksY = lanesStartY + series.length * LANE_PITCH + 26;

  // Fill whatever screen we're given: scale the whole scene so the projected
  // isometric footprint uses the viewport, growing on large displays and
  // shrinking instead of clipping on small ones.
  const stageFitScale = useMemo(() => {
    if (!viewportSize) return 1;
    const projectedW = (historyView ? planeW : FLOOR_WORLD_WIDTH) + 40;
    const projectedH = (historyView ? planeD : FLOOR_WORLD_HEIGHT) + 35;
    const fit = Math.min((viewportSize.w - 40) / projectedW, (viewportSize.h - 55) / projectedH);
    return Math.round(Math.min(1.6, Math.max(0.15, fit)) * 100) / 100;
  }, [viewportSize, planeW, planeD, historyView]);
  const stageScale = Math.round(stageFitScale * zoom * 100) / 100;

  return (
    <div
      className={`agent-floor is-tactical${railLedger ? " is-rail-ledger" : ""}`}
      data-live-count={liveCount}
      data-floor-orient={orientation}
    >
      <div className="agent-floor__body">
        {railLedger ? null : (
          <aside className="agent-floor__ledger" aria-label="Fleet ledger">
            <header className="agent-floor__ledger-head">
              <span className="agent-floor__ledger-title">fleet</span>
              <span className="agent-floor__ledger-meta">
                {ledger.length} lane{ledger.length === 1 ? "" : "s"} · {liveCount} live
              </span>
              <span className="agent-floor__ledger-trace">trace 15m</span>
            </header>
            <div className="agent-floor__ledger-rows">
              {ledger.map((entry) => {
                const agent = entry.lane.agent;
                const sprite = agentSpriteProps(agent);
                return (
                  <button
                    key={entry.lane.id}
                    type="button"
                    className={`agent-floor__ledger-row${effectiveFocus === entry.lane.id ? " is-focus" : ""}`}
                    onClick={() => selectLane(entry.lane)}
                    onMouseEnter={() => handleFocus(entry.lane.id)}
                    onMouseLeave={() => handleFocus(null)}
                  >
                    <span className="agent-floor__ledger-id">
                      <SpriteAvatar name={agent.name} size={18} tile hue={sprite.hue} tone={sprite.tone} />
                      <span className="agent-floor__ledger-name">
                        {lanePrimaryLabel(agent, entry.lane.source)}
                      </span>
                      <HarnessMark harness={agent.harness} size={11} className="agent-floor__card-mark" />
                      <span className={`agent-floor__card-dot${entry.live ? " is-live" : ""}`} />
                    </span>
                    <span className="agent-floor__ledger-tally">
                      <span className="agent-floor__ledger-strip">
                        {entry.strip.map((kind, blockIndex) => (
                          <span key={blockIndex} className={`agent-floor__ledger-cell is-${kind}`} />
                        ))}
                      </span>
                      <span className="agent-floor__ledger-counts">{countsLabel(entry.counts)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <footer className="agent-floor__ledger-foot">
              rows and flags are linked — hover to unroll, click to pin
            </footer>
          </aside>
        )}

        <div
          className={`agent-floor__viewport${pinnedSeries || contextRoom || resourceView ? " is-inspecting" : ""}${dragging ? " is-dragging" : ""}`}
          ref={viewportRef}
          onWheel={handleViewportWheel}
          onPointerDown={handleViewportPointerDown}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={stopViewportDrag}
          onPointerCancel={stopViewportDrag}
        >
          <div className="agent-floor__command-bar">
            {historyView || !sharedWork ? <strong>Operations floor</strong> : null}
            <div className="agent-floor__view-switch" role="group" aria-label="Floor view">
              <button type="button" aria-pressed={!historyView && !adventures} onClick={() => { setAdventures(false); setHistoryView(false); resetFloorView(); }}>World</button>
              <button type="button" aria-pressed={adventures} onClick={() => { setAdventures(true); setHistoryView(false); setContextRoom(null); setResourceView(null); resetFloorView(); }}>Replay</button>
              <button type="button" aria-pressed={historyView} onClick={() => { setAdventures(false); setHistoryView(true); setContextRoom(null); setResourceView(null); resetFloorView(); }}>History</button>
            </div>
            {!historyView && !adventures ? <button type="button" onClick={() => setSharedWork(!sharedWork)}>{sharedWork ? "Rooms" : "Shared map"}</button> : null}
            {!historyView && !adventures ? <div className="agent-floor__view-switch" aria-label="Floor resources">{(["artifacts", "branches", "terminals"] as const).map((view) => <button type="button" key={view} aria-pressed={resourceView === view} onClick={() => { setResourceView(view); setPinnedId(null); setContextRoom(null); }}>{view === "artifacts" ? "Artifacts" : view === "branches" ? "Branches" : "Terminals"}</button>)}</div> : null}
            {!historyView && !adventures && !sharedWork && deskOrder.length > lanes.length ? <button type="button" title="Release vacant desks and compact sectors" onClick={() => { setLaneOrder(orderedLanes.map((lane) => lane.id)); setRequestedPage(0); }}>Release {deskOrder.length - lanes.length} {deskOrder.length - lanes.length === 1 ? "desk" : "desks"}</button> : null}
            {!historyView && !adventures && !sharedWork && pageCount > 1 ? <span className="agent-floor__page-controls">
              <button type="button" aria-label="Previous floor sector" disabled={floorPage === 0} onClick={() => { setRequestedPage(floorPage - 1); setPinnedId(null); handleFocus(null); }}>←</button>
              Sector {floorPage + 1} / {pageCount}
              <button type="button" aria-label="Next floor sector" disabled={floorPage === pageCount - 1} onClick={() => { setRequestedPage(floorPage + 1); setPinnedId(null); handleFocus(null); }}>→</button>
            </span> : null}
          </div>
          {!historyView && !adventures && !sharedWork ? <FloorTacticalHUD berths={berths} allLanes={orderedLanes} lanes={series.map((entry) => entry.lane)} now={now} selectedId={effectiveFocus}
            sheetOpen={Boolean(pinnedSeries || contextRoom || resourceView)} motionPaused={motionPaused} onPause={() => setMotionPaused(!motionPaused)}
            onActor={(lane) => { selectLane(lane); setPan({ x: -100, y: 0 }); setZoom(1); }}
            onRoom={(room) => { setResourceView(null); setContextRoom(room); setPinnedId(null); handleFocus(null); }} /> : null}
          {!historyView && !adventures && resourceView ? <FloorResourcesSheet view={resourceView} lanes={orderedLanes} onView={setResourceView} onClose={() => setResourceView(null)} onActor={selectLane} /> : null}
          {!historyView && !adventures && sharedWork ? <SharedWorkFloor now={now} lanes={orderedLanes} onActor={selectLane} /> : null}
          {adventures ? <AgentAdventures lanes={orderedLanes} now={now} onActor={onOpenTrace} /> : null}
          {historyView ? <FloorReplay lanes={orderedLanes} now={now} onActor={selectLane} /> : null}
          {!historyView && !adventures && !sharedWork ? <FloorZoomControls
            zoom={zoom}
            fit={zoom === 1 && pan.x === 0 && pan.y === 0}
            onZoomChange={setZoom}
            onReset={resetFloorView}
          /> : null}
          <div
            className="agent-floor__stage"
            style={{ display: adventures || historyView || sharedWork ? "none" : undefined, transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${stageScale})` }}
          >
            {!historyView ? <AgentFloorWorld berths={berths} lanes={series.map((entry) => entry.lane)} now={now}
              motionPaused={motionPaused} selectedId={effectiveFocus} onFocus={handleFocus} onSelect={selectLane}
              onFocusRoom={(station, x, y) => {
                setResourceView(null);
                setContextRoom(station);
                setPinnedId(null);
                handleFocus(null);
                setZoom(FLOOR_ZOOM_MAX);
                setPan({ x: clampFloorPan((FLOOR_WORLD_WIDTH / 2 - x) * stageFitScale * FLOOR_ZOOM_MAX - 140, FLOOR_PAN_X_MAX),
                  y: clampFloorPan((FLOOR_WORLD_HEIGHT / 2 - y) * stageFitScale * FLOOR_ZOOM_MAX, FLOOR_PAN_Y_MAX) });
              }} /> : (
            <div
              className="agent-floor__field"
              style={{
                width: planeW,
                height: planeD,
                left: -planeW / 2,
                top: -planeD / 2,
              }}
            >
              <div className="agent-floor__plane" />

              {Array.from({ length: TOTAL_SLOTS + 1 }, (_, slotIndex) => (
                <div
                  key={slotIndex}
                  className={`agent-floor__seam${slotIndex === 0 ? " is-front" : ""}`}
                  style={{ left: seamX(slotIndex) }}
                />
              ))}
              {Array.from({ length: TOTAL_SLOTS + 1 }, (_, slotIndex) => (
                <div
                  key={slotIndex}
                  className={`agent-floor__bb agent-floor__tick${slotIndex === 0 ? " is-now" : ""}`}
                  style={{ left: seamX(slotIndex), top: ticksY }}
                >
                  {slotIndex === 0 ? (
                    <>
                      <span className="agent-floor__tick-pulse" />
                      <span>now</span>
                    </>
                  ) : (
                    fmtSlotClock(periodStart - (slotIndex - 1) * BUCKET_MS)
                  )}
                </div>
              ))}

              <div
                className="agent-floor__lanes"
                style={{ left: 0, top: lanesStartY }}
                data-focus={effectiveFocus !== null || undefined}
              >
                {series.map((entry, index) => (
                  <FloorLaneStrip
                    key={entry.lane.id}
                    series={entry}
                    index={index}
                    planeW={planeW}
                    flip={flip}
                    periodStart={periodStart}
                    now={now}
                    focused={effectiveFocus === entry.lane.id}
                    pinned={pinnedId === entry.lane.id}
                    dimmed={pinnedId === null && focusLaneId !== null && focusLaneId !== entry.lane.id}
                    peekSlot={peek?.laneId === entry.lane.id ? peek.slot : null}
                    onFocus={handleFocus}
                    onPeek={handlePeek}
                    onSelect={selectLane}
                  />
                ))}
              </div>

              {hidden.length > 0 ? (
                <div
                  className="agent-floor__bb agent-floor__chip"
                  style={{
                    left: flip ? FRONT_APRON / 2 : planeW - FRONT_APRON / 2,
                    top: ticksY + 30,
                  }}
                >
                  +{hidden.length} more in the ledger
                </div>
              ) : null}
            </div>
            )}
          </div>
          {!historyView && (pinnedSeries || contextRoom) ? (
            <FloorContextSheet key={pinnedSeries?.lane.id ?? contextRoom} lane={pinnedSeries?.lane ?? null} room={contextRoom}
              lanes={series.map((entry) => entry.lane)} allLanes={orderedLanes} now={now}
              onClose={() => { setPinnedId(null); setContextRoom(null); }}
              onSelectRoom={(station) => {
                setResourceView(null);
                setContextRoom(station);
                const room = FLOOR_ROOMS[station];
                setPan({ x: clampFloorPan((FLOOR_WORLD_WIDTH / 2 - room.x - 205) * stageFitScale * zoom - 140, FLOOR_PAN_X_MAX),
                  y: clampFloorPan((FLOOR_WORLD_HEIGHT / 2 - room.y - 132) * stageFitScale * zoom, FLOOR_PAN_Y_MAX) });
              }}
              onSelectLane={selectLane} onOpenTrace={onOpenTrace} />
          ) : pinnedSeries ? (
            <FloorTracePanel
              series={pinnedSeries}
              now={now}
              concise={traceConcise}
              onConciseChange={setTraceConcise}
              onClose={() => setPinnedId(null)}
              onOpenFull={() => onOpenTrace(pinnedSeries.lane)}
              operatorName={operatorName}
            />
          ) : null}
        </div>
      </div>

      {!adventures ? <FloorDock
        focus={focusSeries}
        pinned={pinnedId !== null && effectiveFocus === pinnedId}
        ledger={ledger}
        liveCount={liveCount}
        now={now}
      /> : null}

      <footer className="agent-floor__legend" style={{ display: adventures ? "none" : undefined }}>
        <span className="agent-floor__legend-item">
          <span className="agent-floor__legend-swatch is-tool" />tool call
        </span>
        <span className="agent-floor__legend-item">
          <span className="agent-floor__legend-swatch is-edit" />file edit
        </span>
        <span className="agent-floor__legend-item">
          <span className="agent-floor__legend-swatch is-msg" />message
        </span>
        <span className="agent-floor__legend-item">
          <span className="agent-floor__legend-pulse" />actors follow recent activity
        </span>
        <button
          type="button"
          className="agent-floor__legend-flip"
          hidden={!historyView}
          onClick={flipOrientation}
          title="Flip which side history accumulates on"
        >
          past {flip ? "→" : "←"}
        </button>
        <span className="agent-floor__legend-note">
          Rooms open their own sheets · actors open task details · History retains the trace
        </span>
      </footer>
    </div>
  );
}
