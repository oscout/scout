import "./agent-floor.css";

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

import { HarnessMark } from "../../components/HarnessMark.tsx";
import { agentSpriteProps, SpriteAvatar } from "../../components/SpriteAvatar.tsx";
import { normalizeAgentState } from "../../lib/agent-state.ts";
import { laneSnippetText, observeEventWallMs } from "../../lib/lane-observe.ts";
import { timeAgo } from "../../lib/time.ts";
import type { ObserveEvent } from "../../lib/types.ts";
import { SessionObserve } from "../sessions/SessionObserve.tsx";
import {
  isAgentLaneLive,
  lanePrimaryLabel,
  type AgentLane,
} from "./agent-lanes-model.ts";
import {
  publishLaneFocusId,
  publishLaneRoster,
  setFloorLedgerHandlers,
  type LaneRosterEntry,
} from "./lane-roster-store.ts";

/**
 * AgentFloorView — the "floor" lane treatment, shared across surfaces. An
 * isometric plane where each agent keeps a LANE strip stacked along the
 * isometric Y and the other axis is TIME, anchored to wall-clock five-minute
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
/** Minted (static) slots behind the live one — 6 × 5m = 30 min of past. */
const MINTED_SLOTS = 6;
const TOTAL_SLOTS = MINTED_SLOTS + 1;
const SLOT_MAX_BLOCKS = 8;
const MAX_FLOOR_LANES = 8;
const STRIP_BLOCKS = 10;
const FLOOR_TRACE_WINDOW_MS = 30 * 60_000;
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

const LANE_PITCH = 164;
const STACK_SIZE = 56;
const STACK_STEP = 14;
const BLOCK_H = 12;
const SLAB_SIZE = 66;
const SLAB_H = 7;
const PAD_SIZE = 96;
const PAD_H = 12;
const BUCKET_DEPTH = 88;
const FRONT_APRON = 150;
const BACK_MARGIN = 48;
const EDGE_MARGIN = 24;
const MIN_PLANE_D = 480;
const FLAG_LIFT = 38;

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

function buildFloorLane(lane: AgentLane, periodStart: number): FloorLaneSeries {
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
  let classified = 0;
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
    classified += 1;
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
    // "Session ready" placeholder observes report as live without any real
    // work — require at least one classifiable event so dormant-but-registered
    // agents don't glow at the now edge.
    live: isAgentLaneLive(lane.observe) && classified > 0,
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
  const ranked = ([
    ["tool-led", counts.tool],
    ["edit-heavy", counts.edit],
    ["conversation-led", counts.msg],
  ] as const).sort((left, right) => right[1] - left[1]);
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
    ? { value: top[0], detail: `${top[1]} call${top[1] === 1 ? "" : "s"} · 30m` }
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

  const padX = flip
    ? (FRONT_APRON - PAD_SIZE) / 2
    : planeW - FRONT_APRON + (FRONT_APRON - PAD_SIZE) / 2;
  const padY = (LANE_PITCH - PAD_SIZE) / 2;
  const stackY = (LANE_PITCH - SLAB_SIZE) / 2;
  const slotX = (slotIndex: number) => {
    const inset = (BUCKET_DEPTH - SLAB_SIZE) / 2;
    return flip
      ? FRONT_APRON + slotIndex * BUCKET_DEPTH + inset
      : planeW - FRONT_APRON - (slotIndex + 1) * BUCKET_DEPTH + inset;
  };
  const flagZ = PAD_H + FLAG_LIFT + (index % 2) * 14;

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
      aria-label={pinned ? `${name} — open timeline` : `${name} — pin details`}
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

      <span className="agent-floor__pad" style={{ left: padX, top: padY }} aria-hidden="true">
        <span className="agent-floor__ground" />
        <IsoBlock kind="pad" z={0} size={PAD_SIZE} faceH={PAD_H} pad />
        {live ? <IsoBlock kind="head" z={PAD_H + 2} size={STACK_SIZE} faceH={BLOCK_H} live /> : null}
      </span>

      <span
        className="agent-floor__bb agent-floor__flag-anchor"
        style={{
          left: padX + PAD_SIZE / 2,
          top: padY + PAD_SIZE / 2,
          "--z": `${flagZ}px`,
        } as CSSProperties}
      >
        <span className={`agent-floor__flag${focused ? " is-focus" : ""}${pinned ? " is-pinned" : ""}`}>
          <SpriteAvatar name={agent.name} size={15} tile hue={sprite.hue} tone={sprite.tone} />
          <span className="agent-floor__flag-name">{name}</span>
          <span className="agent-floor__flag-action">
            <LaneActionLine series={series} now={now} />
          </span>
          <span className={`agent-floor__card-dot${live ? " is-live" : ""}`} />
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
            detail="showed work · 30m"
          />
          <DockInsight
            label="hottest lane"
            value={hottest ? lanePrimaryLabel(hottest.lane.agent, hottest.lane.source) : "none yet"}
            detail={hottest ? `${hottestCount} classified events` : "waiting for activity"}
          />
          <DockInsight
            label="throughput"
            value={`${classifiedCount(totals)} events`}
            detail="classified · 30m"
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
            traceWindowLabel="30m"
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

export function AgentFloorView({ lanes, now, onOpenTrace, railLedger = false, operatorName }: {
  lanes: AgentLane[];
  now: number;
  onOpenTrace: (lane: AgentLane) => void;
  /** Publish the ledger into the host's left rail instead of embedding it. */
  railLedger?: boolean;
  /** Operator display name for the chat-style user-request head in the trace panel. */
  operatorName?: string;
}) {
  const [orientation, setOrientation] = useState<FloorOrientation>(readStoredOrientation);
  const [focusLaneId, setFocusLaneId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [peek, setPeek] = useState<{ laneId: string; slot: number } | null>(null);
  const [traceConcise, setTraceConcise] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [laneOrder, setLaneOrder] = useState<string[]>(readStoredLaneOrder);
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
    if (pinnedId === lane.id) onOpenTrace(lane);
    else setPinnedId(lane.id);
  }, [pinnedId, onOpenTrace]);

  const resetFloorView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);
  const handleViewportWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".agent-floor__trace-panel, .agent-floor__zoom")) return;
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
    if (event.button !== 0 || target?.closest("button, .agent-floor__trace-panel")) return;
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
    if (pinnedId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPinnedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinnedId]);

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
    const nextOrder = orderedLanes.map((lane) => lane.id);
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
  }, [orderedLanes]);

  const { series, hidden, planeW, planeD, lanesStartY } = useMemo(() => {
    const built = orderedLanes.map((lane) => buildFloorLane(lane, periodStart));
    // Initial order is seeded by recency; after that, each agent holds its
    // physical lane while newly discovered agents join at the end.
    const shown = built.slice(0, MAX_FLOOR_LANES);
    const stripsH = shown.length * LANE_PITCH;
    const depth = Math.max(MIN_PLANE_D, stripsH + EDGE_MARGIN * 2);
    return {
      series: shown,
      hidden: built.slice(MAX_FLOOR_LANES),
      planeW: BACK_MARGIN + TOTAL_SLOTS * BUCKET_DEPTH + FRONT_APRON,
      planeD: depth,
      lanesStartY: (depth - stripsH) / 2,
    };
  }, [orderedLanes, periodStart]);

  const ledger = useMemo(() => series.concat(hidden), [series, hidden]);
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
    return () => publishLaneFocusId(null);
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
    const span = planeW + planeD;
    const projectedW = 0.708 * span + 60;
    const projectedH = 0.386 * span + 250;
    const fit = Math.min(viewportSize.w / projectedW, viewportSize.h / projectedH);
    return Math.round(Math.min(1.6, Math.max(0.7, fit)) * 100) / 100;
  }, [viewportSize, planeW, planeD]);
  const stageScale = Math.round(stageFitScale * zoom * 100) / 100;

  return (
    <div
      className={`agent-floor${railLedger ? " is-rail-ledger" : ""}`}
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
              <span className="agent-floor__ledger-trace">trace 30m</span>
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
          className={`agent-floor__viewport${pinnedSeries ? " is-inspecting" : ""}${dragging ? " is-dragging" : ""}`}
          ref={viewportRef}
          onWheel={handleViewportWheel}
          onPointerDown={handleViewportPointerDown}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={stopViewportDrag}
          onPointerCancel={stopViewportDrag}
        >
          <FloorZoomControls
            zoom={zoom}
            fit={zoom === 1 && pan.x === 0 && pan.y === 0}
            onZoomChange={setZoom}
            onReset={resetFloorView}
          />
          <div
            className="agent-floor__stage"
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${stageScale}) rotateX(57deg) rotateZ(45deg)` }}
          >
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
          </div>
          {pinnedSeries ? (
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

      <FloorDock
        focus={focusSeries}
        pinned={pinnedId !== null && effectiveFocus === pinnedId}
        ledger={ledger}
        liveCount={liveCount}
        now={now}
      />

      <footer className="agent-floor__legend">
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
          <span className="agent-floor__legend-pulse" />live — pad glows
        </span>
        <button
          type="button"
          className="agent-floor__legend-flip"
          onClick={flipOrientation}
          title="Flip which side history accumulates on"
        >
          past {flip ? "→" : "←"}
        </button>
        <span className="agent-floor__legend-note">
          Towers mint every 5 min · details land in the dock · click to pin, click again for the timeline
        </span>
      </footer>
    </div>
  );
}
