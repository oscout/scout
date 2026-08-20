import { useEffect, useMemo, useState } from "react";
import {
  clearRouteMachineScope,
  routeMachineId,
  setRouteMachineScope,
} from "../../lib/router.ts";
import { timeAgo } from "../../lib/time.ts";
import { HARNESS_HUE } from "../../lib/agent-identity.ts";
import type { Route, WebMeshOpsHost, WebMeshOpsItem } from "../../lib/types.ts";
import { isScoutDevToolsAvailable } from "../../lib/use-scout-dev-flags.ts";
import type { useScout } from "../../scout/Provider.tsx";
import {
  MESH_OPS_TRIAGE_LABEL,
  MESH_OPS_TRIAGE_ORDER,
  familyOf,
  itemActivityAt,
  itemIsNewSince,
  readMeshOpsLastLookAt,
  setMeshOpsAttnFilter,
  setMeshOpsGroupBy,
  setMeshOpsSelection,
  setMeshOpsUnattributedOnly,
  stampMeshOpsLastLookAt,
  toggleMeshOpsLabFlag,
  triageOf,
  useMeshOpsViewStore,
  type MeshOpsGroupBy,
  type MeshOpsLabFlags,
  type MeshOpsTriage,
} from "../../lib/mesh-ops-view-store.ts";
import { useMeshOpsItems } from "./use-mesh-ops-items.ts";
import "../../scout/slots/ctx-panel.css";
import "./mesh-ops.css";

type Navigate = ReturnType<typeof useScout>["navigate"];
type MeshOpsRoute = Extract<Route, { view: "mesh-ops" }>;

const GROUP_BY_OPTIONS: Array<{ id: MeshOpsGroupBy; label: string }> = [
  { id: "family", label: "family" },
  { id: "host", label: "host" },
];

const LAB_OPTIONS: Array<{ key: keyof MeshOpsLabFlags; label: string }> = [
  { key: "lastLook", label: "last-look divider" },
  { key: "routeStrip", label: "route strip" },
  { key: "compact", label: "compact rows" },
  { key: "relays", label: "relay sessions" },
  { key: "simulateHosts", label: "simulate hosts" },
];

/**
 * Dev-only multi-host preview ("simulate hosts" lab toggle): families hash
 * deterministically onto synthetic machines, slot 0 keeps the real host, so
 * the host strip and row host labels can be exercised with one machine up.
 */
const SIM_HOST_POOL: Array<{ nodeId: string; label: string }> = [
  { nodeId: "sim:studio-tower", label: "studio-tower" },
  { nodeId: "sim:gpu-box", label: "gpu-box" },
  { nodeId: "sim:cloud-eu-1", label: "cloud-eu-1" },
];

function simSlotFor(family: string): number {
  let hash = 0;
  for (let i = 0; i < family.length; i++) {
    hash = (hash * 31 + family.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % (SIM_HOST_POOL.length + 1);
}

function groupKeyOf(item: WebMeshOpsItem, groupBy: MeshOpsGroupBy, now: number): string {
  if (groupBy === "family") return familyOf(item);
  if (groupBy === "host") return item.hostLabel ?? "unattributed";
  return MESH_OPS_TRIAGE_LABEL[triageOf(item, now)];
}

/** Harness dot — hue ← harness, the app's avatar convention (oklch). */
function harnessDotColor(harness: string): string {
  const hue = HARNESS_HUE[harness.trim().toLowerCase()];
  return hue === undefined ? "var(--dim)" : `oklch(0.65 0.14 ${hue})`;
}

function MeshOpsRow({
  item,
  selected,
  fresh,
  showHost,
  onSelect,
}: {
  item: WebMeshOpsItem;
  selected: boolean;
  fresh: boolean;
  showHost: boolean;
  onSelect: () => void;
}) {
  const attention = item.attention;
  const live = item.kind === "session" && item.session?.live === true;
  // The right-hand state word: attention outranks kind. Sessions read as
  // working/ended; work items keep their collaboration state verbatim.
  const stateWord =
    attention === "interrupt"
      ? "blocked"
      : item.kind === "session"
        ? live
          ? "working"
          : "ended"
        : item.state;
  const stateTone =
    attention === "interrupt"
      ? "danger"
      : attention === "badge" || item.state === "review"
        ? "warning"
        : live || item.state === "working"
          ? "accent"
          : "faint";
  // Dot: attention/live tones while anything is up; a hollow ring once the
  // row has gone quiet — the study's fresh/stale read.
  const dotTone =
    attention === "interrupt"
      ? " dot--danger dot--pulse"
      : attention === "badge"
        ? " dot--warning"
        : live
          ? " dot--working dot--pulse"
          : "";
  const hollow = attention === "silent" && !live;
  return (
    <button
      type="button"
      className={`mesh-ops-row${selected ? " mesh-ops-row--selected" : ""}`}
      data-kind={item.kind}
      data-fresh={fresh || undefined}
      onClick={onSelect}
    >
      <span
        className={`dot${dotTone}`}
        data-quiet={hollow || undefined}
        data-hollow={hollow || undefined}
        aria-hidden
      />
      <span className="mesh-ops-row-main">
        <span className="mesh-ops-row-title">{item.title}</span>
        <span className="mesh-ops-row-sub">
          {item.kind} · {familyOf(item)}
        </span>
      </span>
      <span className="mesh-ops-row-owner">
        {item.session && (
          <span
            className="mesh-ops-row-harness"
            style={{ background: harnessDotColor(item.session.harness) }}
            title={item.session.harness}
            aria-hidden
          />
        )}
        {item.ownerName && <span>@{item.ownerName}</span>}
      </span>
      <span className="mesh-ops-row-route">{showHost ? (item.hostLabel ?? "—") : ""}</span>
      <span className="mesh-ops-row-state">
        <span className="mesh-ops-row-state-word" data-tone={stateTone}>
          {attention === "badge" && item.state !== "review" ? "flagged" : stateWord}
        </span>
        <span className="mesh-ops-row-age">{timeAgo(itemActivityAt(item))}</span>
      </span>
    </button>
  );
}

function MeshOpsHostStrip({
  hosts,
  newCounts,
  unattributedCount,
  activeHostId,
  unattributedActive,
  onSelect,
  onSelectUnattributed,
}: {
  hosts: WebMeshOpsHost[];
  /** "What haven't I seen?" per machine — new-since-last-look counts. */
  newCounts: Map<string, number>;
  unattributedCount: number;
  activeHostId: string | null;
  unattributedActive: boolean;
  onSelect: (nodeId: string | null) => void;
  onSelectUnattributed: () => void;
}) {
  return (
    <div className="mesh-ops-hosts" role="group" aria-label="Hosts">
      <span className="mesh-ops-groupby-label">hosts</span>
      <button
        type="button"
        className={`mesh-ops-host${activeHostId === null && !unattributedActive ? " mesh-ops-host--active" : ""}`}
        onClick={() => onSelect(null)}
        title="Show items across all hosts"
      >
        all
      </button>
      {hosts.map((host) => {
        const fresh = newCounts.get(host.nodeId) ?? 0;
        return (
          <button
            key={host.nodeId}
            type="button"
            className={`mesh-ops-host${activeHostId === host.nodeId ? " mesh-ops-host--active" : ""}`}
            onClick={() => onSelect(activeHostId === host.nodeId ? null : host.nodeId)}
            title={host.hostName ?? host.label}
          >
            <span
              className={`dot${fresh > 0 ? " dot--warning" : host.liveSessionCount > 0 ? " dot--working" : ""}`}
              data-quiet={fresh === 0 && host.liveSessionCount === 0 ? true : undefined}
              aria-hidden
            />
            <span className="mesh-ops-host-name">{host.label}</span>
            {fresh > 0 && <span className="mesh-ops-host-new">{fresh} new</span>}
            <span className="mesh-ops-host-meta">
              {host.liveSessionCount > 0 ? `${host.liveSessionCount} live · ` : ""}
              {host.sessionCount}
            </span>
            {host.lastActivityAt !== null && (
              <span className="mesh-ops-host-age">{timeAgo(host.lastActivityAt)}</span>
            )}
          </button>
        );
      })}
      {unattributedCount > 0 && (
        <button
          type="button"
          className={`mesh-ops-host${unattributedActive ? " mesh-ops-host--active" : ""}`}
          onClick={onSelectUnattributed}
          title="Items with no venue host"
        >
          <span className="mesh-ops-host-name">unattributed</span>
          <span className="mesh-ops-host-meta">{unattributedCount}</span>
        </button>
      )}
    </div>
  );
}

function MeshOpsList({ route, navigate }: { route: MeshOpsRoute; navigate: Navigate }) {
  const machineId = routeMachineId(route);
  const { loading, error } = useMeshOpsItems(machineId);
  const {
    items,
    hosts,
    selectedItemId,
    groupBy,
    attnFilter,
    unattributedOnly,
    lab,
  } = useMeshOpsViewStore();
  const [devTools] = useState(() => isScoutDevToolsAvailable());
  const [lastLookAt] = useState(() => readMeshOpsLastLookAt());
  const [clockNow, setClockNow] = useState(() => Date.now());
  /** Per-group expansion of the collapsed ended-session tail. */
  const [expandedEnded, setExpandedEnded] = useState<Record<string, boolean>>({});
  /** Client-side host scope for the "simulate hosts" lab preview. */
  const [simHostFilter, setSimHostFilter] = useState<string | null>(null);

  // Deep links (`?itemId=`) drive the shared selection; returning to the
  // bare board clears an inspector selection left over from an item route.
  useEffect(() => {
    if (route.itemId && route.itemId !== selectedItemId) {
      setMeshOpsSelection(route.itemId);
    } else if (!route.itemId && selectedItemId !== null) {
      setMeshOpsSelection(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.itemId]);

  // Recency buckets and relative timestamps must advance even on a quiet
  // broker with no SSE traffic.
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Stamp the scan timestamp when the operator leaves the view.
  useEffect(() => () => stampMeshOpsLastLookAt(), []);

  const scopedItems = useMemo(() => {
    // Broker relay sessions are delivery machinery; hidden unless the lab
    // toggle is on so the board reads as the operator's named agents.
    const named = lab.relays
      ? items
      : items.filter((item) => item.kind !== "session" || item.session?.relay !== true);
    // "simulate hosts" dev preview: spread families across synthetic machines.
    const remapped = lab.simulateHosts
      ? named.map((item) => {
          const slot = simSlotFor(familyOf(item));
          if (slot === 0) return item;
          const host = SIM_HOST_POOL[slot - 1];
          return { ...item, hostNodeId: host.nodeId, hostLabel: host.label };
        })
      : named;
    return unattributedOnly ? remapped.filter((item) => item.hostNodeId === null) : remapped;
  }, [items, unattributedOnly, lab.relays, lab.simulateHosts]);

  // The active host scope: the route's machine scope in real mode (the server
  // pre-filters), the client-side sim filter in the simulated preview.
  const activeHostId = lab.simulateHosts ? simHostFilter : machineId;
  const hostItems = useMemo(
    () =>
      lab.simulateHosts && simHostFilter
        ? scopedItems.filter((item) => item.hostNodeId === simHostFilter)
        : scopedItems,
    [lab.simulateHosts, simHostFilter, scopedItems],
  );

  // Strip hosts: the server's node rollup in real mode; in the preview the
  // synthetic machines get client-derived counts so they read like real ones.
  const stripHosts = useMemo<WebMeshOpsHost[]>(() => {
    if (!lab.simulateHosts) return hosts;
    const simulated = SIM_HOST_POOL.map((slot) => {
      const here = scopedItems.filter((item) => item.hostNodeId === slot.nodeId);
      return {
        nodeId: slot.nodeId,
        label: slot.label,
        hostName: null,
        brokerUrl: null,
        tailnetName: null,
        lastSeenAt: null,
        registeredAt: null,
        sessionCount: here.filter((item) => item.kind === "session").length,
        liveSessionCount: here.filter((item) => item.kind === "session" && item.session?.live)
          .length,
        lastActivityAt: here.length > 0 ? Math.max(...here.map(itemActivityAt)) : null,
      };
    });
    return [...hosts, ...simulated];
  }, [lab.simulateHosts, hosts, scopedItems]);

  const unattributedCount = useMemo(
    () => scopedItems.filter((item) => item.hostNodeId === null).length,
    [scopedItems],
  );

  // "What haven't I seen?" per machine: new-since-last-look counts ride the
  // chips. Agnostic by construction — no priority heuristic to second-guess.
  const hostNewCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!lab.lastLook) return counts;
    for (const item of scopedItems) {
      if (!itemIsNewSince(item, lastLookAt) || !item.hostNodeId) continue;
      counts.set(item.hostNodeId, (counts.get(item.hostNodeId) ?? 0) + 1);
    }
    return counts;
  }, [scopedItems, lab.lastLook, lastLookAt]);

  const triageCounts = useMemo(() => {
    const counts: Record<MeshOpsTriage, number> = {
      active: 0,
      moving: 0,
      done: 0,
      archive: 0,
    };
    for (const item of hostItems) {
      counts[triageOf(item, clockNow)] += 1;
    }
    return counts;
  }, [hostItems, clockNow]);

  // The board always shows one triage tab: the explicit selection, else the
  // freshest bucket — the operator scans forward from what just moved.
  const activeTab: MeshOpsTriage = attnFilter ?? "active";

  const visibleItems = useMemo(() => {
    return hostItems.filter((item) => triageOf(item, clockNow) === activeTab);
  }, [hostItems, activeTab, clockNow]);

  // The host column only earns its space when the view spans machines; with a
  // single host in scope it is the same word on every row.
  const showHost = useMemo(
    () => new Set(visibleItems.map((item) => item.hostLabel).filter(Boolean)).size > 1,
    [visibleItems],
  );

  const isFresh = useMemo(
    () => (lab.lastLook ? (item: WebMeshOpsItem) => itemIsNewSince(item, lastLookAt) : () => false),
    [lab.lastLook, lastLookAt],
  );

  const groups = useMemo(() => {
    const byKey = new Map<string, WebMeshOpsItem[]>();
    for (const item of visibleItems) {
      const key = groupKeyOf(item, groupBy, clockNow);
      const list = byKey.get(key);
      if (list) {
        list.push(item);
      } else {
        byKey.set(key, [item]);
      }
    }
    const orderedKeys = groupBy === "attention"
      ? MESH_OPS_TRIAGE_ORDER.map((triage) => MESH_OPS_TRIAGE_LABEL[triage])
          .filter((label) => byKey.has(label))
      // Family/host groups rank new-first, then alive, then quiet — each
      // tier freshest-first — so dead families sink instead of burying live
      // ones (a family's latest activity may be an ended session).
      : [...byKey.entries()]
          .sort((left, right) => {
            const tier = (items: WebMeshOpsItem[]): number => {
              if (items.some(isFresh)) return 0;
              if (items.some((item) => triageOf(item, clockNow) === "moving")) return 1;
              return 2;
            };
            const tierDelta = tier(left[1]) - tier(right[1]);
            if (tierDelta !== 0) return tierDelta;
            return (
              Math.max(...right[1].map(itemActivityAt)) - Math.max(...left[1].map(itemActivityAt))
            );
          })
          .map(([key]) => key);
    return orderedKeys.map((key) => ({
      key,
      items: (byKey.get(key) ?? []).sort((left, right) => itemActivityAt(right) - itemActivityAt(left)),
    }));
  }, [visibleItems, groupBy, isFresh, clockNow]);

  const select = (item: WebMeshOpsItem) => {
    setMeshOpsSelection(item.id);
    navigate({ ...route, itemId: item.id });
  };

  // Host scoping shares the rail's mechanism: real hosts navigate the route's
  // machine scope (server-side filter, deep-linkable); the simulated preview
  // filters client-side since its machines only exist in this tab.
  const selectHost = (nodeId: string | null) => {
    if (lab.simulateHosts) {
      setSimHostFilter(nodeId);
      return;
    }
    setMeshOpsUnattributedOnly(false);
    navigate(nodeId ? setRouteMachineScope(route, nodeId) : clearRouteMachineScope(route));
  };

  const selectUnattributed = () => {
    if (unattributedOnly) {
      selectHost(null);
      return;
    }
    if (lab.simulateHosts) setSimHostFilter(null);
    navigate(clearRouteMachineScope(route));
    setMeshOpsUnattributedOnly(true);
  };

  return (
    <div className={`mesh-ops-list${lab.compact ? " mesh-ops-list--compact" : ""}${lab.lastLook ? " mesh-ops-list--lastlook" : ""}`}>
      <div className="mesh-ops-summary">
        <div className="mesh-ops-tabs" role="tablist" aria-label="Triage tabs">
          {MESH_OPS_TRIAGE_ORDER.map((triage) => (
            <button
              key={triage}
              type="button"
              role="tab"
              aria-selected={activeTab === triage}
              className={`mesh-ops-tab${activeTab === triage ? " mesh-ops-tab--active" : ""}`}
              onClick={() => setMeshOpsAttnFilter(activeTab === triage ? null : triage)}
            >
              <span
                className={`dot${
                  triage === "active" || triage === "moving" ? " dot--working" : ""
                }`}
                data-quiet={triage === "done" || triage === "archive" ? true : undefined}
                aria-hidden
              />
              {MESH_OPS_TRIAGE_LABEL[triage]}
              <span className="mesh-ops-tab-count">{triageCounts[triage]}</span>
            </button>
          ))}
        </div>
        <span className="mesh-ops-summary-spacer" />
        <span className="mesh-ops-groupby" role="group" aria-label="Group items by">
          <span className="mesh-ops-groupby-label">group</span>
          {GROUP_BY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`mesh-ops-groupby-option${groupBy === option.id ? " mesh-ops-groupby-option--active" : ""}`}
              aria-pressed={groupBy === option.id}
              onClick={() => setMeshOpsGroupBy(option.id)}
            >
              {option.label}
            </button>
          ))}
        </span>
      </div>

      <MeshOpsHostStrip
        hosts={stripHosts}
        newCounts={hostNewCounts}
        unattributedCount={unattributedCount}
        activeHostId={activeHostId}
        unattributedActive={unattributedOnly}
        onSelect={selectHost}
        onSelectUnattributed={selectUnattributed}
      />

      {error && <div className="ctx-panel-empty" data-tone="error">{error}</div>}
      {!error && loading && items.length === 0 && (
        <div className="ctx-panel-empty">Loading mesh ops…</div>
      )}
      {!error && !loading && visibleItems.length === 0 && (
        <div className="ctx-panel-empty">Nothing in {MESH_OPS_TRIAGE_LABEL[activeTab]}.</div>
      )}

      {groups.map((group) => {
        // In the recent tabs (active/moving) a just-ended row is signal
        // and renders directly; in done/archive the ended tail collapses
        // behind a per-group disclosure. Work items always render.
        const collapseEnded = activeTab === "done" || activeTab === "archive";
        const renderedItems = collapseEnded
          ? group.items.filter((item) => item.kind !== "session" || item.session?.live === true)
          : [...group.items];
        const endedItems = collapseEnded
          ? group.items.filter((item) => item.kind === "session" && item.session?.live !== true)
          : [];
        const endedShown = expandedEnded[group.key] === true;
        if (endedShown) {
          renderedItems.push(...endedItems);
        }
        // The divider lives between the last fresh row and the first stale
        // row of the first group that has both.
        const dividerIndex = lab.lastLook
          ? renderedItems.findIndex(
              (item, index) =>
                !isFresh(item) && renderedItems.slice(0, index).some((prior) => isFresh(prior)),
            )
          : -1;
        return (
          <div key={group.key} className="mesh-ops-group">
            <div className="mesh-ops-group-head">
              <span
                className={`dot${group.items.some(isFresh) ? " dot--warning" : ""}`}
                data-quiet={!group.items.some(isFresh) || undefined}
                aria-hidden
              />
              <span className="label-sm mesh-ops-group-name">{group.key}</span>
              <span className="mesh-ops-group-spacer" />
              {endedItems.length > 0 && (
                <button
                  type="button"
                  className="mesh-ops-group-more"
                  onClick={() => setExpandedEnded((prev) => ({ ...prev, [group.key]: !endedShown }))}
                >
                  {endedShown ? `hide ${endedItems.length} ended` : `+${endedItems.length} ended`}
                </button>
              )}
              <span className="mesh-ops-group-count">{group.items.length}</span>
            </div>
            {renderedItems.map((item, index) => (
              <div key={item.id}>
                {index === dividerIndex && (
                  <div className="mesh-ops-lastlook" role="separator">
                    <span className="mesh-ops-lastlook-rule" />
                    <span className="mesh-ops-lastlook-label">last look — above changed since you scanned</span>
                    <span className="mesh-ops-lastlook-rule" />
                  </div>
                )}
                <MeshOpsRow
                  item={item}
                  selected={item.id === selectedItemId}
                  fresh={isFresh(item)}
                  showHost={showHost}
                  onSelect={() => select(item)}
                />
              </div>
            ))}
          </div>
        );
      })}

      {devTools && (
        <div className="mesh-ops-lab">
          <span className="label-xs">lab</span>
          {LAB_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className="mesh-ops-lab-toggle"
              data-on={lab[option.key] || undefined}
              aria-pressed={lab[option.key]}
              onClick={() => toggleMeshOpsLabFlag(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MeshOpsContent({ route, navigate }: { route: Route; navigate: Navigate }) {
  if (route.view !== "mesh-ops") return null;
  return <MeshOpsList route={route} navigate={navigate} />;
}
