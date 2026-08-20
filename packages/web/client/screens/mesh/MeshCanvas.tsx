import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Canvas } from "@hudsonkit/canvas";
import type { Agent, MeshStatus } from "../../lib/types.ts";
import {
  useMeshViewStore,
  toggleMachineCollapse,
  setMachinePosition,
  toggleMachineVisibility,
  type MeshDensity,
} from "../../lib/mesh-view-store.ts";
import { normalizeAgentState } from "../../lib/agent-state.ts";
import { stateColor } from "../../lib/colors.ts";
import { timeAgo } from "../../lib/time.ts";
import { useScout } from "../../scout/Provider.tsx";
import { useAgentHoverCard } from "../../components/useAgentHoverCard.tsx";
import { bucketAgentsByMachine, type HostFacts, type MachineBucket } from "../../lib/mesh-buckets.ts";
// FloatingMachinesTool removed — the rack now lives in MeshLeftPanel.

type TileBindings = ReturnType<ReturnType<typeof useAgentHoverCard>["bind"]>;

type Pos = { x: number; y: number };

type CanvasState = { pan: Pos; scale: number };
type CanvasAction =
  | { type: "pan"; delta: Pos }
  | { type: "zoom"; factor: number; mx: number; my: number; cx: number; cy: number };

function canvasReducer(state: CanvasState, action: CanvasAction): CanvasState {
  if (action.type === "pan") {
    return { ...state, pan: { x: state.pan.x + action.delta.x, y: state.pan.y + action.delta.y } };
  }
  if (action.type === "zoom") {
    const newScale = Math.max(0.25, Math.min(4, state.scale * action.factor));
    const { mx, my, cx, cy } = action;
    const worldX = (mx - cx) / state.scale - state.pan.x;
    const worldY = (my - cy) / state.scale - state.pan.y;
    return { scale: newScale, pan: { x: (mx - cx) / newScale - worldX, y: (my - cy) / newScale - worldY } };
  }
  return state;
}

const CANVAS_STORAGE_KEY = "openscout.mesh.canvas.viewport.v1";

function loadPersistedCanvas(): CanvasState {
  const fallback: CanvasState = { pan: { x: 0, y: 0 }, scale: 1 };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.sessionStorage.getItem(CANVAS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.scale === "number" &&
      parsed.pan &&
      typeof parsed.pan.x === "number" &&
      typeof parsed.pan.y === "number"
    ) {
      return { pan: { x: parsed.pan.x, y: parsed.pan.y }, scale: parsed.scale };
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function shortHost(s?: string | null): string {
  if (!s) return "";
  return s.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].split(".")[0] || s.slice(0, 8);
}

type AgentCluster = {
  key: string;
  label: string;
  instances: Agent[];
};

function clusterKey(agent: Agent): { key: string; label: string } {
  const raw =
    (agent.name && agent.name.trim()) ||
    (agent.handle && agent.handle.trim()) ||
    (agent.harness && agent.harness.trim()) ||
    "agent";
  return { key: raw.toLowerCase(), label: raw };
}

function groupAgentsByName(agents: Agent[]): AgentCluster[] {
  const byKey = new Map<string, AgentCluster>();
  for (const agent of agents) {
    const { key, label } = clusterKey(agent);
    let cluster = byKey.get(key);
    if (!cluster) {
      cluster = { key, label, instances: [] };
      byKey.set(key, cluster);
    }
    cluster.instances.push(agent);
  }
  // Stable order: alphabetical by label, total instance count as tiebreaker.
  // Working/ready state never reorders clusters, so the map doesn't reshuffle on refresh.
  return Array.from(byKey.values())
    .map((c) => {
      c.instances.sort((a, b) => {
        const byId = a.id.localeCompare(b.id);
        return byId;
      });
      return c;
    })
    .sort((a, b) => {
      const byLabel = a.label.localeCompare(b.label);
      if (byLabel !== 0) return byLabel;
      return b.instances.length - a.instances.length;
    });
}

type DensityMetrics = {
  density: MeshDensity;
  instanceW: number;
  instanceH: number;
  stepX: number;
  stepY: number;
  clusterPadX: number;
  clusterPadY: number;
  labelH: number;
  clusterGap: number;
};

function densityMetrics(density: MeshDensity): DensityMetrics {
  switch (density) {
    case "compact":
      return { density, instanceW: 138, instanceH: 32, stepX: 144, stepY: 38, clusterPadX: 12, clusterPadY: 12, labelH: 22, clusterGap: 16 };
    case "spacious":
      return { density, instanceW: 260, instanceH: 68, stepX: 268, stepY: 76, clusterPadX: 14, clusterPadY: 14, labelH: 26, clusterGap: 16 };
    default:
      return { density: "comfortable", instanceW: 210, instanceH: 52, stepX: 218, stepY: 60, clusterPadX: 12, clusterPadY: 12, labelH: 24, clusterGap: 14 };
  }
}

type ClusterLayout = {
  cluster: AgentCluster;
  x: number;
  y: number;
  width: number;
  height: number;
  cols: number;
};

function chooseCols(count: number, targetAspect: number): number {
  // targetAspect = width / height. Want cols/rows ≈ targetAspect for a single cluster.
  // cols * rows >= count, cols = sqrt(count * targetAspect).
  return Math.max(1, Math.round(Math.sqrt(count * targetAspect)));
}

function packClusters(
  clusters: AgentCluster[],
  m: DensityMetrics,
  viewportAspect: number,
): ClusterLayout[] {
  if (clusters.length === 0) return [];

  // Per-cluster size: cols proportional to sqrt(count) with viewport aspect bias.
  const sized = clusters.map((c) => {
    const count = c.instances.length;
    const cols = chooseCols(count, Math.max(0.6, Math.min(viewportAspect, 2.0)));
    const rows = Math.ceil(count / cols);
    const innerW = cols * m.stepX - (m.stepX - m.instanceW);
    const innerH = rows * m.stepY - (m.stepY - m.instanceH);
    return {
      cluster: c,
      cols,
      width: innerW + m.clusterPadX * 2,
      height: innerH + m.clusterPadY * 2 + m.labelH,
    };
  });

  // Choose canvas target width to roughly match viewport aspect after wrapping.
  const totalArea = sized.reduce((acc, s) => acc + s.width * s.height, 0);
  const targetWidth = Math.max(
    Math.max(...sized.map((s) => s.width)),
    Math.sqrt(totalArea * viewportAspect),
  );

  const gap = m.clusterGap;
  const placed: ClusterLayout[] = [];
  let rowX = 0;
  let rowY = 0;
  let rowH = 0;

  for (const s of sized) {
    if (rowX > 0 && rowX + s.width > targetWidth) {
      rowY += rowH + gap;
      rowX = 0;
      rowH = 0;
    }
    placed.push({
      cluster: s.cluster,
      x: rowX,
      y: rowY,
      width: s.width,
      height: s.height,
      cols: s.cols,
    });
    rowX += s.width + gap;
    rowH = Math.max(rowH, s.height);
  }

  // Re-center on origin.
  const minX = Math.min(...placed.map((r) => r.x));
  const maxX = Math.max(...placed.map((r) => r.x + r.width));
  const minY = Math.min(...placed.map((r) => r.y));
  const maxY = Math.max(...placed.map((r) => r.y + r.height));
  const dx = -((minX + maxX) / 2);
  const dy = -((minY + maxY) / 2);
  return placed.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
}

function instanceCoord(index: number, cols: number, m: DensityMetrics): Pos {
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    x: m.clusterPadX + col * m.stepX,
    y: m.labelH + m.clusterPadY + row * m.stepY,
  };
}

function harnessModel(agent: Agent): string {
  const h = agent.harness?.trim();
  const m = agent.model?.trim();
  if (h && m) return `${h}/${m}`;
  return h || m || "—";
}

function cwdBranch(agent: Agent): string {
  const project = agent.project?.trim();
  const branch = agent.branch?.trim();
  if (project && branch) return `${project}/${branch}`;
  return project || branch || "—";
}

function cwdFull(agent: Agent): string {
  return agent.cwd || agent.projectRoot || "—";
}

function SpecRow({ label, value, path }: { label: string; value: string; path?: boolean }) {
  return (
    <span className="mesh-sheet-row">
      <span className="mesh-sheet-row-label">{label}</span>
      <span className={`mesh-sheet-row-value${path ? " mesh-sheet-row-value--path" : ""}`} title={value}>{value}</span>
    </span>
  );
}

function OpenBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="mesh-sheet-open"
      title="Open agent view"
      aria-label="Open agent view"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      ↗
    </button>
  );
}

function AgentSpec({
  agent,
  onOpen,
  bindings,
  active,
}: {
  agent: Agent;
  onOpen: () => void;
  bindings: TileBindings | null;
  active: boolean;
}) {
  const state = normalizeAgentState(agent.state);
  const isOrganic = agent.agentClass === "organic";
  const time = agent.updatedAt ? timeAgo(agent.updatedAt) : "";
  const primary = harnessModel(agent);
  const secondary = cwdBranch(agent);
  return (
    <div
      {...(bindings ?? {})}
      className={`mesh-instance-spec mesh-instance-spec--${state}${isOrganic ? " mesh-instance-spec--organic" : ""}${active ? " mesh-instance--active" : ""}`}
      style={{ "--state-stripe": stateColor(agent.state) } as React.CSSProperties}
      title={`${primary} — ${secondary}`}
    >
      <span className="mesh-instance-spec-row">
        <span className="mesh-instance-spec-primary">{primary}</span>
        {time && <span className="mesh-instance-spec-time">{time}</span>}
      </span>
      <span className="mesh-instance-spec-row">
        <span className="mesh-instance-spec-secondary">{secondary}</span>
        <OpenBtn onClick={onOpen} />
      </span>
    </div>
  );
}

function AgentChip({
  agent,
  onOpen,
  bindings,
  active,
}: {
  agent: Agent;
  onOpen: () => void;
  bindings: TileBindings | null;
  active: boolean;
}) {
  const state = normalizeAgentState(agent.state);
  const isOrganic = agent.agentClass === "organic";
  const time = agent.updatedAt ? timeAgo(agent.updatedAt) : "—";
  const identity = `${harnessModel(agent)} · ${cwdBranch(agent)}`;
  return (
    <div
      {...(bindings ?? {})}
      className={`mesh-instance-sheet mesh-instance-sheet--${state}${isOrganic ? " mesh-instance-sheet--organic" : ""}${active ? " mesh-instance--active" : ""}`}
      style={{ "--state-stripe": stateColor(agent.state) } as React.CSSProperties}
      title={`${identity}\n${cwdFull(agent)}`}
    >
      <span className="mesh-sheet-line mesh-sheet-line--head">
        <span className="mesh-sheet-id">{identity}</span>
        <span className="mesh-sheet-time">{time}</span>
        <OpenBtn onClick={onOpen} />
      </span>
      <span className="mesh-sheet-line">
        <span className="mesh-sheet-path">{cwdFull(agent)}</span>
        <span className="mesh-sheet-ctx"><span className="mesh-sheet-ctx-label">CTX</span> —</span>
      </span>
    </div>
  );
}

function AgentCard({
  agent,
  onOpen,
  bindings,
  active,
}: {
  agent: Agent;
  onOpen: () => void;
  bindings: TileBindings | null;
  active: boolean;
}) {
  const state = normalizeAgentState(agent.state);
  const isOrganic = agent.agentClass === "organic";
  const time = agent.updatedAt ? timeAgo(agent.updatedAt) : "—";
  const identity = `${harnessModel(agent)} · ${cwdBranch(agent)}`;
  const agentClass = agent.agentClass?.trim();
  return (
    <div
      {...(bindings ?? {})}
      className={`mesh-instance-sheet mesh-instance-sheet--spacious mesh-instance-sheet--${state}${isOrganic ? " mesh-instance-sheet--organic" : ""}${active ? " mesh-instance--active" : ""}`}
      style={{ "--state-stripe": stateColor(agent.state) } as React.CSSProperties}
      title={`${identity}\n${cwdFull(agent)}`}
    >
      <span className="mesh-sheet-line mesh-sheet-line--head">
        <span className="mesh-sheet-id">{identity}</span>
        <span className="mesh-sheet-time">{time}</span>
        <OpenBtn onClick={onOpen} />
      </span>
      <span className="mesh-sheet-line">
        <span className="mesh-sheet-path">{cwdFull(agent)}</span>
      </span>
      <span className="mesh-sheet-line">
        <span className="mesh-sheet-ctx"><span className="mesh-sheet-ctx-label">CTX</span> —</span>
        {agentClass && <span className="mesh-sheet-tag">{agentClass}</span>}
      </span>
    </div>
  );
}

function ClusterRegion({
  layout,
  metrics,
  onAgentOpen,
  bindFor,
  activeId,
}: {
  layout: ClusterLayout;
  metrics: DensityMetrics;
  onAgentOpen: (agent: Agent) => void;
  bindFor: (agentId: string) => TileBindings | null;
  activeId: string | null;
}) {
  const { cluster, x, y, width, height, cols } = layout;
  const counts = useMemo(() => {
    const acc = { working: 0, ready: 0, notReady: 0 };
    for (const agent of cluster.instances) {
      const state = normalizeAgentState(agent.state);
      if (state === "in_turn" || state === "in_flight") acc.working += 1;
      else if (state === "callable") acc.ready += 1;
      else acc.notReady += 1;
    }
    return acc;
  }, [cluster.instances]);

  return (
    <div
      className="mesh-cluster"
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        height,
      }}
    >
      <div className="mesh-cluster-header" style={{ height: metrics.labelH }}>
        <span className="mesh-cluster-name">{cluster.label}</span>
        <span className="mesh-cluster-count">{cluster.instances.length}</span>
        <span className="mesh-cluster-states">
          {counts.working > 0 && (
            <span className="mesh-cluster-state mesh-cluster-state--working">
              <span className="mesh-cluster-state-dot" />
              {counts.working}
            </span>
          )}
          {counts.ready > 0 && (
            <span className="mesh-cluster-state mesh-cluster-state--available">
              <span className="mesh-cluster-state-dot" />
              {counts.ready}
            </span>
          )}
          {counts.notReady > 0 && (
            <span className="mesh-cluster-state mesh-cluster-state--offline">
              <span className="mesh-cluster-state-dot" />
              {counts.notReady}
            </span>
          )}
        </span>
      </div>
      {cluster.instances.map((agent, i) => {
        const coord = instanceCoord(i, cols, metrics);
        return (
          <div
            key={agent.id}
            style={{
              position: "absolute",
              left: coord.x,
              top: coord.y,
              width: metrics.instanceW,
              height: metrics.instanceH,
            }}
          >
            {metrics.density === "compact" ? (
              <AgentSpec
                agent={agent}
                onOpen={() => onAgentOpen(agent)}
                bindings={bindFor(agent.id)}
                active={activeId === agent.id}
              />
            ) : metrics.density === "spacious" ? (
              <AgentCard
                agent={agent}
                onOpen={() => onAgentOpen(agent)}
                bindings={bindFor(agent.id)}
                active={activeId === agent.id}
              />
            ) : (
              <AgentChip
                agent={agent}
                onOpen={() => onAgentOpen(agent)}
                bindings={bindFor(agent.id)}
                active={activeId === agent.id}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// bucketAgentsByMachine, HostFacts, MachineBucket are imported from lib/mesh-buckets

type MachineSectionLayout = {
  machineId: string;
  machineLabel: string;
  reachability: MachineBucket["reachability"];
  online: boolean;
  agentCount: number;
  workingCount: number;
  availableCount: number;
  offlineCount: number;
  dominantState: "working" | "available" | "offline";
  host?: HostFacts;
  collapsed: boolean;
  /** True when this section is rendering as a small ghost (hidden via rack, or unreachable). */
  ghost: boolean;
  /** True when the manual override placed this section. */
  pinned: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  headerHeight: number;
  /** Total chrome height (header + spec strip when collapsed). */
  chromeHeight: number;
  layouts: ClusterLayout[];
};

const MACHINE_HEADER_HEIGHT = 34;
const MACHINE_SPEC_HEAD_HEIGHT = 22;
const MACHINE_SPEC_ROW_HEIGHT = 22;
const MACHINE_SPEC_FOOT_HEIGHT = 6;
const MACHINE_SECTION_GAP = 28;
const MACHINE_BODY_PAD_TOP = 10;
const MACHINE_BODY_PAD_X = 12;
const MIN_SECTION_WIDTH = 380;
const GHOST_WIDTH = 240;
const GHOST_HEIGHT = 38;

function packMachineSections(
  buckets: MachineBucket[],
  hiddenIds: ReadonlySet<string>,
  collapsedIds: ReadonlySet<string>,
  positions: Readonly<Record<string, { x: number; y: number }>>,
  m: DensityMetrics,
  viewportAspect: number,
): MachineSectionLayout[] {
  const sections: MachineSectionLayout[] = [];

  // Split into auto-flow (no manual override) and pinned (manual override).
  const autoBuckets: MachineBucket[] = [];
  const pinnedBuckets: MachineBucket[] = [];
  for (const b of buckets) {
    if (positions[b.machineId]) pinnedBuckets.push(b);
    else autoBuckets.push(b);
  }

  // Auto-flow vertical stack (pre-centering).
  let cursorY = 0;
  let widest = MIN_SECTION_WIDTH;

  const buildSection = (
    bucket: MachineBucket,
    pinned: boolean,
  ): MachineSectionLayout => {
    const hidden = hiddenIds.has(bucket.machineId);
    const ghost = hidden || !bucket.online;
    const collapsed = collapsedIds.has(bucket.machineId);

    // State breakdown
    let workingCount = 0;
    let availableCount = 0;
    let offlineCount = 0;
    for (const a of bucket.agents) {
      const s = normalizeAgentState(a.state);
      if (s === "in_turn" || s === "in_flight") workingCount += 1;
      else if (s === "callable") availableCount += 1;
      else offlineCount += 1;
    }
    const dominantState: "working" | "available" | "offline" =
      !bucket.online
        ? "offline"
        : workingCount > 0
          ? "working"
          : availableCount > 0
            ? "available"
            : "offline";

    if (ghost) {
      return {
        machineId: bucket.machineId,
        machineLabel: bucket.machineLabel,
        reachability: bucket.reachability,
        online: bucket.online,
        agentCount: bucket.agents.length,
        workingCount,
        availableCount,
        offlineCount,
        dominantState,
        host: bucket.host,
        collapsed: false,
        ghost: true,
        pinned,
        x: 0,
        y: 0,
        width: GHOST_WIDTH,
        height: GHOST_HEIGHT,
        headerHeight: GHOST_HEIGHT,
        chromeHeight: GHOST_HEIGHT,
        layouts: [],
      };
    }

    const clusters = collapsed ? [] : groupAgentsByName(bucket.agents);
    const innerLayouts = collapsed ? [] : packClusters(clusters, m, viewportAspect);

    // Spec sheet is the MINIMIZED view: visible only when the section is collapsed.
    // Structure: state strip (3 cells: working / ready / total) above param rows.
    const specBucket: MachineBucket = bucket;
    const rowCount = collapsed ? countSpecRows(specBucket, workingCount, availableCount, offlineCount) : 0;
    const specBlockHeight = collapsed
      ? MACHINE_STATE_STRIP_HEIGHT + rowCount * MACHINE_SPEC_ROW_HEIGHT + MACHINE_SPEC_FOOT_HEIGHT
      : 0;
    const chromeHeight = MACHINE_HEADER_HEIGHT + specBlockHeight;

    let bodyW = 0;
    let bodyH = 0;
    if (!collapsed && innerLayouts.length > 0) {
      const minX = Math.min(...innerLayouts.map((l) => l.x));
      const maxX = Math.max(...innerLayouts.map((l) => l.x + l.width));
      const minY = Math.min(...innerLayouts.map((l) => l.y));
      const maxY = Math.max(...innerLayouts.map((l) => l.y + l.height));
      bodyW = maxX - minX;
      bodyH = maxY - minY;
      const dx = -minX + MACHINE_BODY_PAD_X;
      const dy = -minY + chromeHeight + MACHINE_BODY_PAD_TOP;
      for (const l of innerLayouts) {
        l.x += dx;
        l.y += dy;
      }
    }

    const sectionWidth = Math.max(MIN_SECTION_WIDTH, bodyW + MACHINE_BODY_PAD_X * 2);
    const sectionHeight = collapsed
      ? chromeHeight
      : chromeHeight + MACHINE_BODY_PAD_TOP + bodyH + MACHINE_BODY_PAD_X;

    return {
      machineId: bucket.machineId,
      machineLabel: bucket.machineLabel,
      reachability: bucket.reachability,
      online: bucket.online,
      agentCount: bucket.agents.length,
      workingCount,
      availableCount,
      offlineCount,
      dominantState,
      host: bucket.host,
      collapsed,
      ghost: false,
      pinned,
      x: 0,
      y: 0,
      width: sectionWidth,
      height: sectionHeight,
      headerHeight: MACHINE_HEADER_HEIGHT,
      chromeHeight,
      layouts: innerLayouts,
    };
  };

  for (const bucket of autoBuckets) {
    const section = buildSection(bucket, false);
    section.x = 0;
    section.y = cursorY;
    sections.push(section);
    widest = Math.max(widest, section.width);
    cursorY += section.height + MACHINE_SECTION_GAP;
  }

  // Auto-flow centering: all auto sections share the widest width so headers align,
  // and the whole auto-flow block is centered on the origin.
  const totalAutoHeight = Math.max(0, cursorY - MACHINE_SECTION_GAP);
  const autoOffsetX = -widest / 2;
  const autoOffsetY = -totalAutoHeight / 2;
  for (const s of sections) {
    if (!s.ghost) s.width = widest;
    s.x = autoOffsetX;
    s.y += autoOffsetY;
  }

  // Pinned sections: respect user-placed (x, y) verbatim, no centering, no width-normalize.
  for (const bucket of pinnedBuckets) {
    const section = buildSection(bucket, true);
    const pos = positions[bucket.machineId]!;
    section.x = pos.x;
    section.y = pos.y;
    sections.push(section);
  }

  return sections;
}

// HostFrame is intentionally removed — each machine renders its own section header.

function MachineSectionView({
  section,
  metrics,
  onAgentOpen,
  bindFor,
  activeId,
  onHeaderPointerDown,
  onHeaderClick,
  onGhostActivate,
}: {
  section: MachineSectionLayout;
  metrics: DensityMetrics;
  onAgentOpen: (agent: Agent) => void;
  bindFor: (agentId: string) => TileBindings | null;
  activeId: string | null;
  onHeaderPointerDown: (event: React.PointerEvent, section: MachineSectionLayout) => void;
  onHeaderClick: (machineId: string) => void;
  onGhostActivate: (machineId: string) => void;
}) {
  const reachabilityLabel =
    section.reachability === "this"
      ? "this node"
      : section.reachability === "peer"
        ? "peer"
        : section.reachability === "tailnet"
          ? "tailnet"
          : "";

  const stamp = !section.online
    ? "unreachable"
    : section.agentCount === 0
      ? "idle"
      : "standby";

  if (section.ghost) {
    return (
      <div
        data-machine-id={section.machineId}
        className="mesh-machine-ghost"
        style={{
          position: "absolute",
          left: section.x,
          top: section.y,
          width: section.width,
          height: section.height,
          pointerEvents: "all",
        }}
        title={`${section.machineLabel} · ${stamp} — click to show`}
      >
        <button
          type="button"
          className="mesh-machine-ghost-body"
          onPointerDown={(e) => onHeaderPointerDown(e, section)}
          onClick={() => onGhostActivate(section.machineId)}
        >
          <span className="mesh-machine-ghost-led" aria-hidden />
          <span className="mesh-machine-ghost-name">{section.machineLabel}</span>
          <span className="mesh-machine-ghost-stamp">{stamp}</span>
          {reachabilityLabel && (
            <span
              className={`mesh-machine-chip mesh-machine-chip--${section.reachability} mesh-machine-chip--ghost`}
            >
              {reachabilityLabel}
            </span>
          )}
          <span className="mesh-machine-ghost-counts">
            <span className="mesh-machine-count">{section.agentCount}</span>
            {section.workingCount > 0 && (
              <span className="mesh-machine-count mesh-machine-count--working">
                {section.workingCount}W
              </span>
            )}
          </span>
        </button>
      </div>
    );
  }

  const specRows = section.collapsed ? buildSpecRows(section) : [];

  return (
    <div
      data-machine-id={section.machineId}
      className={`mesh-machine-section${section.collapsed ? " mesh-machine-section--collapsed" : ""}${section.pinned ? " mesh-machine-section--pinned" : ""}`}
      style={{
        position: "absolute",
        left: section.x,
        top: section.y,
        width: section.width,
        height: section.height,
        pointerEvents: "all",
      }}
    >
      <button
        type="button"
        className="mesh-machine-header"
        style={{ height: section.headerHeight }}
        onPointerDown={(e) => onHeaderPointerDown(e, section)}
        onClick={() => onHeaderClick(section.machineId)}
        aria-expanded={!section.collapsed}
      >
        <span
          className={`mesh-machine-led mesh-machine-led--${section.dominantState}`}
          style={{ color: stateColor(section.dominantState) }}
          aria-hidden
        />
        <span className="mesh-machine-caret" aria-hidden>
          {section.collapsed ? "▸" : "▾"}
        </span>
        <span className="mesh-machine-grip" aria-hidden>
          ⠿
        </span>
        <span className="mesh-machine-name">{section.machineLabel}</span>
        {reachabilityLabel && (
          <span
            className={`mesh-machine-chip mesh-machine-chip--${section.reachability}`}
          >
            {reachabilityLabel}
          </span>
        )}
      </button>
      {section.collapsed && (
        <div className="mesh-machine-spec">
          <div className="mesh-machine-state-strip" style={{ height: MACHINE_STATE_STRIP_HEIGHT }}>
            <div className="mesh-machine-state-cell mesh-machine-state-cell--working">
              <span className="mesh-machine-state-num">{section.workingCount}</span>
              <span className="mesh-machine-state-label">working</span>
            </div>
            <div className="mesh-machine-state-cell">
              <span className="mesh-machine-state-num">{section.availableCount}</span>
              <span className="mesh-machine-state-label">ready</span>
            </div>
            <div className="mesh-machine-state-cell">
              <span className="mesh-machine-state-num">{section.agentCount}</span>
              <span className="mesh-machine-state-label">total</span>
            </div>
          </div>
          {specRows.map((row) => (
            <div
              key={row.label}
              className="mesh-machine-spec-row"
              style={{ height: MACHINE_SPEC_ROW_HEIGHT }}
            >
              <span className="mesh-machine-spec-label">{row.label}</span>
              <span className="mesh-machine-spec-value" title={row.value}>
                {row.value}
              </span>
            </div>
          ))}
        </div>
      )}
      {!section.collapsed &&
        section.layouts.map((layout) => (
          <ClusterRegion
            key={layout.cluster.key}
            layout={layout}
            metrics={metrics}
            onAgentOpen={onAgentOpen}
            bindFor={bindFor}
            activeId={activeId}
          />
        ))}
    </div>
  );
}

type SpecRow = {
  label: string;
  value: string;
};

function buildSpecRows(section: MachineSectionLayout): SpecRow[] {
  const host = section.host;
  return [
    { label: "os", value: host?.os ?? "—" },
    { label: "arch", value: host?.arch ?? "—" },
    { label: "cpu", value: host?.cpuCores ? `${host.cpuCores}c` : "—" },
    { label: "ram", value: host?.memoryGb ? `${host.memoryGb} G` : "—" },
    { label: "disk", value: host?.storageCapacityGb ? `${host.storageCapacityGb} G` : "—" },
    { label: "network", value: host?.network ?? "—" },
    { label: "scout", value: host?.scoutVersion ? `v${host.scoutVersion}` : "—" },
  ];
}

const MACHINE_SPEC_ROWS = 7; // os, arch, cpu, ram, disk, network, scout
const MACHINE_STATE_STRIP_HEIGHT = 54;

function countSpecRows(
  _bucket: MachineBucket,
  _workingCount: number,
  _availableCount: number,
  _offlineCount: number,
): number {
  return MACHINE_SPEC_ROWS;
}

export function MeshCanvas({ mesh, agents = [] }: { mesh: MeshStatus; agents?: Agent[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [canvas, dispatch] = useReducer(canvasReducer, undefined, loadPersistedCanvas);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(
        CANVAS_STORAGE_KEY,
        JSON.stringify({ pan: canvas.pan, scale: canvas.scale }),
      );
    } catch {
      /* ignore */
    }
  }, [canvas.pan, canvas.scale]);
  const { density, query, agentStateFilters, hiddenMachineIds, collapsedMachineIds, scrollTargetMachineId } = useMeshViewStore();
  const { navigate } = useScout();

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const rect = el.getBoundingClientRect();
      dispatch({ type: "zoom", factor, mx: e.clientX - rect.left, my: e.clientY - rect.top, cx: rect.width / 2, cy: rect.height / 2 });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const { machinePositions } = useMeshViewStore();
  const metrics = useMemo(() => densityMetrics(density), [density]);
  const filteredAgents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return agents.filter((a) => {
      const state = normalizeAgentState(a.state);
      const token = state;
      if (!agentStateFilters.has(token)) return false;
      if (!needle) return true;
      const hay = `${a.name ?? ""} ${a.handle ?? ""} ${a.harness ?? ""} ${a.project ?? ""} ${a.branch ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [agents, query, agentStateFilters]);

  const machineBuckets = useMemo(
    () => bucketAgentsByMachine(filteredAgents, mesh),
    [filteredAgents, mesh],
  );

  const viewportAspect = size.w > 0 && size.h > 0 ? size.w / size.h : 1.6;
  const machineSections = useMemo(
    () =>
      packMachineSections(
        machineBuckets,
        hiddenMachineIds,
        collapsedMachineIds,
        machinePositions,
        metrics,
        viewportAspect,
      ),
    [machineBuckets, hiddenMachineIds, collapsedMachineIds, machinePositions, metrics, viewportAspect],
  );

  // Drag state — drives the in-flight pointer drag for a machine header.
  const dragRef = useRef<{
    machineId: string;
    startClientX: number;
    startClientY: number;
    startSectionX: number;
    startSectionY: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);
  const [dragOverride, setDragOverride] = useState<{ machineId: string; x: number; y: number } | null>(null);

  const handleHeaderPointerDown = useCallback(
    (e: React.PointerEvent, section: MachineSectionLayout) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      dragRef.current = {
        machineId: section.machineId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startSectionX: section.x,
        startSectionY: section.y,
        pointerId: e.pointerId,
        moved: false,
      };
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dxScreen = e.clientX - drag.startClientX;
      const dyScreen = e.clientY - drag.startClientY;
      if (!drag.moved && Math.hypot(dxScreen, dyScreen) < 4) return;
      drag.moved = true;
      // Convert screen delta into world delta via current canvas scale.
      const dx = dxScreen / canvas.scale;
      const dy = dyScreen / canvas.scale;
      setDragOverride({
        machineId: drag.machineId,
        x: drag.startSectionX + dx,
        y: drag.startSectionY + dy,
      });
    };
    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      if (drag.moved) {
        const dx = (e.clientX - drag.startClientX) / canvas.scale;
        const dy = (e.clientY - drag.startClientY) / canvas.scale;
        setMachinePosition(drag.machineId, {
          x: drag.startSectionX + dx,
          y: drag.startSectionY + dy,
        });
      }
      setDragOverride(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [canvas.scale]);

  // Block header click after a drag so it doesn't fire toggleCollapse on release.
  const wasDraggedRef = useRef(false);
  useEffect(() => {
    if (dragOverride) wasDraggedRef.current = true;
    else {
      // Clear shortly after release so a fresh click can fire toggle.
      const t = setTimeout(() => { wasDraggedRef.current = false; }, 50);
      return () => clearTimeout(t);
    }
  }, [dragOverride]);

  const handleGhostActivate = useCallback((machineId: string) => {
    if (wasDraggedRef.current) return;
    toggleMachineVisibility(machineId);
  }, []);

  const handleHeaderClick = useCallback((machineId: string) => {
    if (wasDraggedRef.current) return;
    toggleMachineCollapse(machineId);
  }, []);

  // Merge drag override into the rendered sections.
  const renderedSections = useMemo(() => {
    if (!dragOverride) return machineSections;
    return machineSections.map((s) =>
      s.machineId === dragOverride.machineId
        ? { ...s, x: dragOverride.x, y: dragOverride.y, pinned: true }
        : s,
    );
  }, [machineSections, dragOverride]);

  // When the rail asks us to scroll to a machine, pan the canvas so the section header is in view.
  useEffect(() => {
    if (!scrollTargetMachineId) return;
    const section = renderedSections.find((s) => s.machineId === scrollTargetMachineId);
    if (!section) return;
    // Bring the section header roughly to the top-third of the viewport.
    dispatch({
      type: "pan",
      delta: {
        x: -section.x - canvas.pan.x - section.width / 2,
        y: -section.y - canvas.pan.y + size.h / 4 - MACHINE_HEADER_HEIGHT,
      },
    });
  }, [scrollTargetMachineId, renderedSections, canvas.pan.x, canvas.pan.y, size.h]);

  const handleAgentOpen = useCallback(
    (agent: Agent) => {
      if (agent.agentClass === "organic") return;
      navigate({ view: "agents-v2", agentId: agent.id });
    },
    [navigate],
  );

  const hoverableAgents = useMemo(
    () => filteredAgents.filter((a) => a.agentClass !== "organic"),
    [filteredAgents],
  );
  const hoverableIds = useMemo(() => hoverableAgents.map((a) => a.id), [hoverableAgents]);

  const hover = useAgentHoverCard({
    agents: hoverableAgents,
    orderedIds: hoverableIds,
    navigate,
    selectMode: "preview",
  });

  const bindFor = useCallback(
    (agentId: string): TileBindings | null => {
      if (!hoverableIds.includes(agentId)) return null;
      return hover.bind(agentId);
    },
    [hover, hoverableIds],
  );
  const activeId = hover.activeAgent?.id ?? null;

  const { pan, scale } = canvas;
  const cx = size.w / 2;
  const cy = size.h / 2;

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      {size.w > 0 && (
        <Canvas
          panOffset={pan}
          scale={scale}
          onPan={(delta) => dispatch({ type: "pan", delta })}
          gridOpacity={0.7}
        />
      )}

      {/* World-space content */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          transform: `translate(${cx}px, ${cy}px) translate(${pan.x * scale}px, ${pan.y * scale}px) scale(${scale})`,
          transformOrigin: "0 0",
          pointerEvents: "none",
        }}
      >
        {renderedSections.length === 0 ? (
          <div
            style={{
              position: "absolute",
              left: -120,
              top: -20,
              width: 240,
              textAlign: "center",
              pointerEvents: "none",
            }}
          >
            <div className="mesh-empty-pill">no machines visible</div>
          </div>
        ) : (
          renderedSections.map((section) => (
            <MachineSectionView
              key={section.machineId}
              section={section}
              metrics={metrics}
              onAgentOpen={handleAgentOpen}
              bindFor={bindFor}
              activeId={activeId}
              onHeaderPointerDown={handleHeaderPointerDown}
              onHeaderClick={handleHeaderClick}
              onGhostActivate={handleGhostActivate}
            />
          ))
        )}
      </div>

      {/* Zoom hint */}
      <div className="mesh-canvas-hint">scroll to zoom · drag to pan</div>

      {hover.card}
    </div>
  );
}
