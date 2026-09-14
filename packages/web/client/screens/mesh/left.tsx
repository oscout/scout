import { useMemo, useRef } from "react";
import {
  useMeshViewStore,
  toggleMachineVisibility,
  clearMachinePosition,
  setMeshQuery,
  toggleAgentStateFilter,
  toggleTreeFullMachine,
  setMeshSelection,
  requestScrollToMachine,
  soloMachine,
  showAllMachines,
  type AgentStateToken,
} from "../../lib/mesh-view-store.ts";
import { useScout } from "../../scout/Provider.tsx";
import { normalizeAgentState } from "../../lib/agent-state.ts";
import { bucketAgentsByMachine, type MachineBucket } from "../../lib/mesh-buckets.ts";
import { hasFleetActiveAskForAgent, type FleetActiveAskIndex } from "../../lib/fleet-active-asks.ts";
import { useFleetActiveAsks } from "../../lib/use-fleet-active-asks.ts";
import { RailRow } from "../../scout/slots/RailRow.tsx";
import { NodeMenu, nodeMenuRowProps, type NodeMenuHandle } from "./NodeMenu.tsx";
import { buildNodeMenuActions } from "./node-actions.ts";
import { machineChildren, machineRowMeta } from "./machine-children.ts";
import { loadMeshNodeState, refreshMeshNodeState } from "../../lib/mesh-node-state.ts";
import { useMeshNodeState } from "../../lib/use-mesh-node-state.ts";
import { FleetSearch } from "../../scout/slots/FleetSearch.tsx";
import { FleetFilterPills } from "../../scout/slots/FleetFilterPills.tsx";
import { openAgent } from "../../scout/slots/openAgent.ts";
import type { Agent } from "../../lib/types.ts";
import "../../scout/slots/ctx-panel.css";
import "../../scout/slots/mesh-nav-panel.css";

const COMPACT_LIMIT = 10;

function tokenForAgent(a: Agent): AgentStateToken {
  return normalizeAgentState(a.state);
}

/**
 * One machine in the rail.
 *
 * Every machine gets the same menu — this broker, a mesh peer, a tailnet-only
 * device — reachable by right-click, by the ⋯ button, and by Shift+F10 from
 * the keyboard. The counts come from what that node reported about itself when
 * it has reported anything, and fall back to the agents we can place on it,
 * never to a made-up zero.
 */
function MachineNode({
  bucket,
  active,
  hidden,
  anyHidden,
  positioned,
  full,
  selectedId,
  selectedType,
  activeAsks,
  onSelect,
  onFocus,
  onSelectAgent,
  onToggleFull,
}: {
  bucket: MachineBucket;
  active: boolean;
  hidden: boolean;
  anyHidden: boolean;
  positioned: boolean;
  full: boolean;
  selectedId: string | null;
  selectedType: string | null;
  activeAsks: FleetActiveAskIndex;
  /** Show this machine's state in the inspector. */
  onSelect: (machineId: string) => void;
  /** Show only this machine on the map. */
  onFocus: (machineId: string) => void;
  onSelectAgent: (agent: Agent) => void;
  onToggleFull: (machineId: string) => void;
}) {
  const menu = useRef<NodeMenuHandle | null>(null);
  const entry = useMeshNodeState(bucket.machineId);
  const view = entry?.view ?? null;

  const actions = buildNodeMenuActions({
    machineId: bucket.machineId,
    machineLabel: bucket.machineLabel,
    nodeId: bucket.node?.nodeId ?? null,
    brokerUrl: bucket.node?.brokerUrl ?? view?.node?.brokerUrl ?? null,
    hidden,
    anyHidden,
    positioned,
    canCopy: typeof navigator !== "undefined" && Boolean(navigator.clipboard),
    checking: entry?.loading ?? false,
    on: {
      select: (id) => onSelect(id),
      refresh: (id) => void refreshMeshNodeState(id),
      focus: (id) => onFocus(id),
      toggleHidden: (id) => toggleMachineVisibility(id),
      showAll: () => showAllMachines(),
      clearPosition: (id) => clearMachinePosition(id),
      copy: (text) => void navigator.clipboard?.writeText(text),
    },
  });

  const children = machineChildren(bucket, view);
  const visible = full ? children : children.slice(0, COMPACT_LIMIT);
  const overflow = children.length - visible.length;

  return (
    <div className="mesh-nav-machine">
      <RailRow
        name={bucket.machineLabel}
        meta={machineRowMeta(bucket, view, entry?.loading ?? false)}
        tone="neutral"
        active={active}
        onClick={() => onSelect(bucket.machineId)}
        onPointerEnter={() => { if (!entry) void loadMeshNodeState(bucket.machineId, { deep: false }); }}
        title={`${bucket.machineLabel} — click to see what is running here`}
        actions={(
          <NodeMenu
            ref={menu}
            machineLabel={bucket.machineLabel}
            actions={actions}
            className="mesh-nav-menu-btn"
          />
        )}
        {...nodeMenuRowProps(menu)}
      />
      {visible.map((child) => (
        <RailRow
          key={child.key}
          name={child.name}
          meta={child.meta}
          tone={child.tone}
          depth={1}
          active={selectedId === child.selectId && selectedType === "agent"}
          unread={child.agent ? hasFleetActiveAskForAgent(activeAsks, child.agent.id) : false}
          onClick={child.agent ? () => onSelectAgent(child.agent!) : undefined}
          title={child.title}
        />
      ))}
      {!full && overflow > 0 && (
        <RailRow
          name={`see ${overflow} more`}
          depth={1}
          tone="neutral"
          onClick={() => onToggleFull(bucket.machineId)}
          title="Show all agents on this machine"
        />
      )}
      {full && children.length > COMPACT_LIMIT && (
        <RailRow
          name="see less"
          depth={1}
          tone="neutral"
          onClick={() => onToggleFull(bucket.machineId)}
          title="Show recent agents only"
        />
      )}
    </div>
  );
}

export function MeshLeft() {
  const { agents, navigate } = useScout();
  const {
    meshSnapshot,
    selectedId,
    selectedType,
    query,
    agentStateFilters,
    hiddenMachineIds,
    treeFullMachineIds,
    machinePositions,
  } = useMeshViewStore();
  const activeAsks = useFleetActiveAsks();

  const buckets = useMemo<MachineBucket[]>(
    () => (meshSnapshot ? bucketAgentsByMachine(agents, meshSnapshot) : []),
    [agents, meshSnapshot],
  );

  const filteredBuckets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return buckets
      .filter((b) => !hiddenMachineIds.has(b.machineId))
      .map((b) => {
        const agentsHere = b.agents.filter((a) => {
          if (!agentStateFilters.has(tokenForAgent(a))) return false;
          if (!needle) return true;
          const hay = `${a.name ?? ""} ${a.project ?? ""} ${a.branch ?? ""} ${a.harness ?? ""}`.toLowerCase();
          return hay.includes(needle);
        });
        return { ...b, agents: agentsHere };
      });
  }, [buckets, query, agentStateFilters, hiddenMachineIds]);

  const groups = useMemo(() => {
    const map = new Map<string, MachineBucket[]>([
      ["this", []],
      ["peer", []],
      ["tailnet", []],
    ]);
    for (const b of filteredBuckets) {
      const key = b.reachability === "this" ? "this" : b.reachability === "peer" ? "peer" : "tailnet";
      map.get(key)?.push(b);
    }
    return map;
  }, [filteredBuckets]);

  if (!meshSnapshot) {
    return (
      <div className="ctx-panel ctx-panel--empty">
        <div className="ctx-panel-empty-state">
          <div className="ctx-panel-empty-hint">Loading mesh…</div>
        </div>
      </div>
    );
  }

  // Clicking a machine shows what is on it. Narrowing the map to it alone is
  // a separate, explicit action, so neither is a side effect of the other.
  const selectMachine = (id: string) => {
    setMeshSelection(id, "node");
    requestScrollToMachine(id);
  };

  const focusMachine = (id: string) => {
    soloMachine(id, buckets.map((b) => b.machineId));
    setMeshSelection(id, "node");
    requestScrollToMachine(id);
  };

  const hiddenCount = hiddenMachineIds.size;
  const totalMachines = buckets.length;

  const selectAgent = (a: Agent) => {
    setMeshSelection(a.id, "agent");
    const machineId = a.authorityNodeId ?? a.homeNodeId;
    if (machineId) requestScrollToMachine(machineId);
    openAgent(navigate, a, { from: "mesh-tree", returnTo: { view: "mesh" } });
  };

  const renderGroup = (label: string, items: MachineBucket[]) => {
    if (items.length === 0) return null;
    return (
      <section key={label} className="mesh-nav-group">
        <div className="mesh-nav-group-label">{label}</div>
        {items.map((b) => (
          <MachineNode
            key={b.machineId}
            bucket={b}
            active={selectedId === b.machineId && selectedType === "node"}
            hidden={hiddenMachineIds.has(b.machineId)}
            anyHidden={hiddenCount > 0}
            positioned={b.machineId in machinePositions}
            full={treeFullMachineIds.has(b.machineId)}
            selectedId={selectedId}
            selectedType={selectedType}
            activeAsks={activeAsks}
            onSelect={selectMachine}
            onFocus={focusMachine}
            onSelectAgent={selectAgent}
            onToggleFull={toggleTreeFullMachine}
          />
        ))}
      </section>
    );
  };

  return (
    <div className="ctx-panel mesh-nav">
      <div className="mesh-nav-head">
        <FleetSearch
          value={query}
          onChange={setMeshQuery}
          placeholder="Find machines or agents…"
        />
        <FleetFilterPills active={agentStateFilters} onToggle={toggleAgentStateFilter} />
        {hiddenCount > 0 && hiddenCount < totalMachines && (
          <button
            type="button"
            className="mesh-nav-focus-chip"
            onClick={showAllMachines}
            title="Show all machines"
          >
            <span className="mesh-nav-focus-chip-label">
              focused · {totalMachines - hiddenCount}/{totalMachines}
            </span>
            <span className="mesh-nav-focus-chip-clear" aria-hidden>×</span>
          </button>
        )}
      </div>

      <div className="mesh-nav-tree">
        {renderGroup("this host", groups.get("this") ?? [])}
        {renderGroup("peers", groups.get("peer") ?? [])}
        {renderGroup("tailnet", groups.get("tailnet") ?? [])}
      </div>

    </div>
  );
}
